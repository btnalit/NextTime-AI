import { type ObservationCheck, type Role, getCapability } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import {
  type GateTarget,
  type GatekeeperClient,
  GatekeeperClientError,
  GatekeeperTimeoutError,
  gateRefusalOf,
} from '../../adapters/gatekeeper-client/index.js';
import {
  type ReconcileCheckAuditContext,
  type ReconcileCheckRow,
  claimReconcileCheck,
  deferReconcileCheck,
  getActionRequestForUpdateOrThrow,
  lockReconcileCheck,
  recordObservedReconciliation,
  settleReconcileCheck,
  shownAuditReason,
} from '../../governance/approval/index.js';
import { roleMayUseCapability } from '../../governance/capability/index.js';
import {
  getGatekeeper,
  getOrCreateGatekeeperServicePrincipal,
  getPublishedOperation,
  operationRecordDigest,
} from '../../governance/gatekeepers/index.js';
import {
  ObserveParamsCarryCredentialsError,
  redactSuspectedSecrets,
  reviewObserveParams,
} from '../../governance/redaction/index.js';
import {
  endActivity,
  evaluatePredicate,
  recordSourceObservation,
  startActivity,
} from '../../substrate/epistemic/index.js';
import {
  observeRefusal,
  readGatekeeperPlatformPolicy,
  readObserveExclusions,
} from '../gates/index.js';
import { resolveGateTarget } from '../gateway/gate-target.js';
import { getOrCreateGatekeeperSource } from '../gateway/observed-facts.js';
import { markGoalRunDue } from './advancer.js';
import { lockStepRuns } from './reads.js';
import { lockGoalRun } from './service.js';

/**
 * application/goal/reconcile-check (S11 GO3d; plan §4.7 "结果未知", scenario S4): the platform's
 * reconcile observation. An action of a goal step ended `failed` + `outcome_unknown` and the step
 * declared how to check it (`plan.ts` `reconcile`); the advance created the check
 * (`advance.ts`, `ensureReconcileCheck`) and holds the step `waiting(reconcile)` without pausing the
 * run. This module makes the observation and records what it showed:
 *
 *   - **satisfied** — the platform records `effect_seen` on the request
 *     (`recordObservedReconciliation`: a Decision nobody decided, resting on the Observation) and
 *     the check settles `seen`; the advance then counts the action as executed.
 *   - **unsatisfied or undetermined** — the check settles `not_seen` with the Observation as its
 *     evidence, and the next advance pauses the run `awaiting_reconcile` for a person. The platform
 *     never records `effect_absent`: an observation that does not show the effect may be early, or
 *     watch the wrong thing — only the direction that lets the step go on is the platform's.
 *   - **refused** (the requester may no longer observe through that gate, the gate or Operation is
 *     gone, the params carry a credential, the gate refused the call) — `unavailable`, and a person
 *     reconciles. A gate that did not answer (network, timeout, 5xx) is tried again with backoff,
 *     up to {@link DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS} attempts, then `unavailable`.
 *
 * **As the requester.** The observation is made for the request's requester, under the rule every
 * other observation is (`observe-access.ts`'s `observeRefusal`), with the requester's agent
 * exclusions applied — the check stands in for the requester's agent, so it reaches no gate their
 * agent could not — and their role still allowed to observe (R-35, `roleMayUseCapability`). No
 * Grant is needed, as for any observation. The gate call carries the published definition's digest
 * and the requester as `onBehalfOf`, like `observe_operation`'s.
 *
 * **When.** Only while the step waits on its reconcile in a `running` run: a paused run's checks
 * wait for the requester's resume. A check that can no longer matter settles `unavailable` without
 * a call — under a run that ended (completed, failed, cancelled: `goal_ended`), or of a step that
 * ended (revised away, skipped, cancelled: `step_ended`; the run pauses for a person over a
 * revised-away step's unknown action, `advance.ts`) — so no check reads "pending" forever.
 *
 * **How.** {@link runReconcileCheckTick} lists due checks across workspaces (a read with no
 * workspace context, like the advancer's claim), then per check: claims it in its own transaction
 * (`claimReconcileCheck`: single-flight, the attempt number grows, a lease covers the attempt),
 * reads what the call needs in a second, calls the gate outside any transaction, and settles in a
 * third — GoalRun, StepRuns, the request, then the check locked (the order every writer under a
 * goal takes), fenced on the check still `pending` at the claimed attempt; an attempt that lost
 * its claim (the lease ran out and another kernel took it, or a person's finding preempted it)
 * writes nothing. The settle records the Observation (an Activity `goal_reconcile_check` on the
 * Gatekeeper's Source: the request, the call, the predicate, the outcome and the result —
 * suspected secrets redacted, cut at {@link RECONCILE_RESULT_MAX_CHARS} — so the evidence answers
 * "why does the platform believe this"), judges the predicate on that redacted result (what the
 * platform keeps is what it proves from), writes the finding, settles the check and sets the run
 * due. No graph Facts are written from a reconcile observation: it answers one question about one
 * request, and its result mapping is the gate's business.
 */

/** How often the composition root runs {@link runReconcileCheckTick}. */
export const DEFAULT_RECONCILE_CHECK_INTERVAL_MS = 5000;
/** How long a claim holds a check: past the gate client's observe timeout with room to settle. */
export const DEFAULT_RECONCILE_CHECK_LEASE_MS = 120 * 1000;
/** Attempts after which a check whose gate never answered settles `unavailable`. */
export const DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS = 3;
/** Checks looked at per tick. */
export const DEFAULT_RECONCILE_CHECK_BATCH = 10;
/** The most characters of an observation's result kept in its evidence. */
export const RECONCILE_RESULT_MAX_CHARS = 8000;

const RECONCILE_ACTIVITY_KIND = 'goal_reconcile_check';
const ENDED_GOAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const ENDED_STEP_STATUSES = ['succeeded', 'superseded', 'cancelled', 'skipped'] as const;

/** Delay before attempt `attempt + 1` after attempt `attempt` got no answer: 30 s, doubling. */
export function defaultReconcileCheckBackoffMs(attempt: number): number {
  return 30_000 * 2 ** Math.max(0, attempt - 1);
}

export interface ReconcileCheckOptions {
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly limit?: number;
  readonly backoffMs?: (attempt: number) => number;
}

export interface ReconcileCheckDeps {
  readonly pool: PoolLike;
  readonly gatekeeperClient: Pick<GatekeeperClient, 'observe'>;
  readonly options?: ReconcileCheckOptions;
}

/** A due check, as the tick found it. */
export interface DueReconcileCheck {
  readonly workspaceId: string;
  readonly actionRequestId: string;
  readonly stepRunId: string;
  readonly goalRunId: string;
  /** The request's requester — whom the observation is for. */
  readonly requesterId: string;
  /** Why the check settles `unavailable` without a call — the run or the step ended — or `null`:
   *  the step waits on it in a running run. */
  readonly closedBy: 'goal_ended' | 'step_ended' | null;
}

export type ReconcileCheckOutcome =
  | 'seen'
  | 'not_seen'
  | 'unavailable'
  | 'preempted'
  | 'retry'
  /** Not claimed (another kernel has it, or it is no longer due), or the claim was lost. */
  | 'skipped';

/** Pending checks that are due and not leased, whose step waits on its reconcile in a running
 *  run — or whose run or step ended — oldest first. */
export async function listDueReconcileChecks(
  pool: PoolLike,
  limit = DEFAULT_RECONCILE_CHECK_BATCH,
): Promise<readonly DueReconcileCheck[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      workspace_id: string;
      action_request_id: string;
      step_run_id: string;
      goal_run_id: string;
      on_behalf_of: string;
      closed_by: 'goal_ended' | 'step_ended' | null;
    }>(
      `select c.workspace_id, c.action_request_id, a.step_run_id, s.goal_run_id, a.on_behalf_of,
              case when g.status = any($2::text[]) then 'goal_ended'
                   when s.status = any($3::text[]) then 'step_ended' end as closed_by
         from action_request_reconcile_checks c
         join action_requests a on a.workspace_id = c.workspace_id and a.id = c.action_request_id
         join step_runs s on s.workspace_id = a.workspace_id and s.id = a.step_run_id
         join goal_runs g on g.workspace_id = s.workspace_id and g.id = s.goal_run_id
        where c.status = 'pending' and c.next_attempt_at <= now()
          and (c.lease_until is null or c.lease_until <= now())
          and ((g.status = 'running' and s.status = 'waiting' and s.waiting_reason = 'reconcile')
               or g.status = any($2::text[]) or s.status = any($3::text[]))
        order by c.next_attempt_at, c.action_request_id
        limit $1`,
      [limit, [...ENDED_GOAL_RUN_STATUSES], [...ENDED_STEP_STATUSES]],
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      actionRequestId: row.action_request_id,
      stepRunId: row.step_run_id,
      goalRunId: row.goal_run_id,
      requesterId: row.on_behalf_of,
      closedBy: row.closed_by,
    }));
  } finally {
    client.release();
  }
}

export interface ReconcileCheckTickOptions extends ReconcileCheckOptions {
  /** One check's failure — the others in the batch still run. */
  readonly onError?: (error: unknown, check: DueReconcileCheck) => void;
}

/** Lists the due checks and runs each, one after another. Returns how many were looked at. */
export async function runReconcileCheckTick(
  deps: ReconcileCheckDeps,
  options: ReconcileCheckTickOptions = {},
): Promise<number> {
  const due = await listDueReconcileChecks(
    deps.pool,
    options.limit ?? deps.options?.limit ?? DEFAULT_RECONCILE_CHECK_BATCH,
  );
  for (const check of due) {
    try {
      await runReconcileCheck(deps, check);
    } catch (err) {
      options.onError?.(err, check);
    }
  }
  return due.length;
}

/** What the gate call needs, read in the requester's context — or why it is not made. */
type PreparedCall =
  | {
      readonly kind: 'call';
      readonly gate: GateTarget;
      readonly operationDigest: string;
      readonly credentialReview: Record<string, unknown>;
    }
  | { readonly kind: 'refused'; readonly code: string };

type GateAnswer =
  | { readonly kind: 'data'; readonly data: unknown }
  | { readonly kind: 'refused'; readonly code: string; readonly error: string | null }
  | { readonly kind: 'no_answer'; readonly code: string; readonly error: string | null };

/** The settle's verdict, decided after the locks (see the module comment). */
type Settlement =
  | {
      readonly kind: 'observed';
      readonly data: unknown;
      readonly operationDigest: string;
      readonly credentialReview: Record<string, unknown>;
    }
  | { readonly kind: 'unavailable'; readonly code: string; readonly error?: string | null }
  | { readonly kind: 'retry'; readonly code: string; readonly error: string | null };

/** One check — see the module comment. */
export async function runReconcileCheck(
  deps: ReconcileCheckDeps,
  due: DueReconcileCheck,
): Promise<ReconcileCheckOutcome> {
  const context = { workspaceId: due.workspaceId, principalId: due.requesterId };
  const maxAttempts = deps.options?.maxAttempts ?? DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS;
  const leaseMs = deps.options?.leaseMs ?? DEFAULT_RECONCILE_CHECK_LEASE_MS;

  const claimed = await withWorkspace(deps.pool, context, (client) =>
    claimReconcileCheck(client, due.workspaceId, due.actionRequestId, leaseMs),
  );
  if (!claimed) return 'skipped';

  if (due.closedBy !== null) {
    return settle(deps, due, claimed, { kind: 'unavailable', code: due.closedBy });
  }
  if (claimed.attempts > maxAttempts) {
    return settle(deps, due, claimed, { kind: 'unavailable', code: 'attempts_exhausted' });
  }

  const check = claimed.observationCheck;
  const prepared = await withWorkspace(deps.pool, context, (client) =>
    prepareCall(client, due, check),
  );
  if (prepared.kind === 'refused') {
    return settle(deps, due, claimed, { kind: 'unavailable', code: prepared.code });
  }

  const answer = await callGate(deps, due, check, prepared);
  if (answer.kind === 'data') {
    return settle(deps, due, claimed, {
      kind: 'observed',
      data: answer.data,
      operationDigest: prepared.operationDigest,
      credentialReview: prepared.credentialReview,
    });
  }
  if (answer.kind === 'refused' || claimed.attempts >= maxAttempts) {
    return settle(deps, due, claimed, {
      kind: 'unavailable',
      code: answer.code,
      error: answer.error,
    });
  }
  return settle(deps, due, claimed, { kind: 'retry', code: answer.code, error: answer.error });
}

async function prepareCall(
  client: PoolClient,
  due: DueReconcileCheck,
  check: ObservationCheck,
): Promise<PreparedCall> {
  const ws = due.workspaceId;
  const principal = await client.query<{ role: Role; disabled: boolean }>(
    `select role, disabled_at is not null as disabled from principals
      where workspace_id = $1 and id = $2`,
    [ws, due.requesterId],
  );
  const requester = principal.rows[0];
  if (
    !requester ||
    requester.disabled ||
    !roleMayUseCapability(requester.role, getCapability('observe_operation'))
  ) {
    return { kind: 'refused', code: 'requester_may_not_observe' };
  }
  const gatekeeper = await getGatekeeper(client, ws, check.gatekeeperId);
  const platformPolicy = await readGatekeeperPlatformPolicy(client, ws, check.gatekeeperId);
  const published = await getPublishedOperation(client, ws, check.gatekeeperId, check.operation);
  const refusal = observeRefusal(await readObserveExclusions(client, ws, due.requesterId), {
    gatekeeperId: check.gatekeeperId,
    gateEnabled: gatekeeper !== null,
    operationName: check.operation,
    publishedMode: published?.operation.mode,
    platformPolicy,
  });
  if (refusal || !gatekeeper || !published) {
    return { kind: 'refused', code: refusal?.reason ?? 'gate_not_enabled' };
  }
  let credentialReview: Record<string, unknown>;
  try {
    credentialReview = reviewObserveParams(gatekeeper.name, check.operation, check.params ?? {});
  } catch (err) {
    if (err instanceof ObserveParamsCarryCredentialsError) {
      return { kind: 'refused', code: err.code };
    }
    throw err;
  }
  return {
    kind: 'call',
    gate: await resolveGateTarget(client, ws, gatekeeper),
    operationDigest: operationRecordDigest(published),
    credentialReview,
  };
}

function errorText(err: unknown): string | null {
  return shownAuditReason(err instanceof Error ? err.message : String(err));
}

async function callGate(
  deps: ReconcileCheckDeps,
  due: DueReconcileCheck,
  check: ObservationCheck,
  prepared: Extract<PreparedCall, { kind: 'call' }>,
): Promise<GateAnswer> {
  try {
    const result = await deps.gatekeeperClient.observe(prepared.gate, {
      operation: check.operation,
      params: check.params ?? {},
      onBehalfOf: due.requesterId,
      operationDigest: prepared.operationDigest,
    });
    return { kind: 'data', data: result.data };
  } catch (err) {
    if (err instanceof GatekeeperClientError) {
      const refusal = gateRefusalOf(err);
      return refusal
        ? { kind: 'refused', code: refusal.code, error: errorText(err) }
        : { kind: 'no_answer', code: err.code, error: errorText(err) };
    }
    if (err instanceof GatekeeperTimeoutError) {
      return { kind: 'no_answer', code: 'gate_timeout', error: errorText(err) };
    }
    return { kind: 'no_answer', code: 'gate_error', error: errorText(err) };
  }
}

/** A redacted result as the evidence keeps it: whole, or cut at
 *  {@link RECONCILE_RESULT_MAX_CHARS} of its JSON. */
function keptResult(redacted: unknown): {
  readonly result: unknown;
  readonly truncated: boolean;
} {
  const serialized = JSON.stringify(redacted) ?? 'null';
  if (serialized.length <= RECONCILE_RESULT_MAX_CHARS)
    return { result: redacted, truncated: false };
  return {
    result: `${serialized.slice(0, RECONCILE_RESULT_MAX_CHARS)}… [${serialized.length - RECONCILE_RESULT_MAX_CHARS} more characters omitted]`,
    truncated: true,
  };
}

async function settle(
  deps: ReconcileCheckDeps,
  due: DueReconcileCheck,
  claimed: ReconcileCheckRow,
  settlement: Settlement,
): Promise<ReconcileCheckOutcome> {
  const ws = due.workspaceId;
  return withWorkspace(
    deps.pool,
    { workspaceId: ws, principalId: due.requesterId },
    async (client) => {
      // Lock order under a goal: the GoalRun, its StepRuns, the request, then its check.
      await lockGoalRun(client, ws, due.goalRunId);
      await lockStepRuns(client, ws, due.goalRunId);
      const request = await getActionRequestForUpdateOrThrow(client, ws, due.actionRequestId);
      const check = await lockReconcileCheck(client, ws, due.actionRequestId);
      if (!check || check.status !== 'pending' || check.attempts !== claimed.attempts) {
        return 'skipped';
      }
      const audit = (error?: string | null): ReconcileCheckAuditContext => ({
        actorPrincipalId: due.requesterId,
        stepRunId: request.stepRunId,
        goalRunId: due.goalRunId,
        ...(error ? { error } : {}),
      });

      let outcome: ReconcileCheckOutcome;
      if (request.reconciliation !== null) {
        await settleReconcileCheck(client, ws, check, { status: 'preempted' }, audit());
        outcome = 'preempted';
      } else if (settlement.kind === 'retry') {
        const delayMs = (deps.options?.backoffMs ?? defaultReconcileCheckBackoffMs)(check.attempts);
        await deferReconcileCheck(
          client,
          ws,
          check,
          { delayMs, lastError: settlement.code },
          audit(settlement.error),
        );
        return 'retry';
      } else if (settlement.kind === 'unavailable') {
        await settleReconcileCheck(
          client,
          ws,
          check,
          { status: 'unavailable', lastError: settlement.code },
          audit(settlement.error),
        );
        outcome = 'unavailable';
      } else {
        outcome = await recordObservation(client, due, check, settlement, audit());
      }
      await markGoalRunDue(client, ws, due.goalRunId);
      return outcome;
    },
  );
}

async function recordObservation(
  client: PoolClient,
  due: DueReconcileCheck,
  check: ReconcileCheckRow,
  settlement: Extract<Settlement, { kind: 'observed' }>,
  audit: ReconcileCheckAuditContext,
): Promise<'seen' | 'not_seen'> {
  const ws = due.workspaceId;
  const call = check.observationCheck;
  // Judged on the redacted result, the one the evidence keeps: a stored result that is not cut
  // gives the same outcome again.
  const redacted = redactSuspectedSecrets(settlement.data ?? null, { secretFields: true }).value;
  const evaluation = evaluatePredicate(call.expect, redacted);
  const { result, truncated } = keptResult(redacted);
  const activity = await startActivity(client, ws, {
    kind: RECONCILE_ACTIVITY_KIND,
    principalId: due.requesterId,
    metadata: {
      actionRequestId: due.actionRequestId,
      stepRunId: due.stepRunId,
      goalRunId: due.goalRunId,
      gatekeeperId: call.gatekeeperId,
      operation: call.operation,
      attempt: check.attempts,
    },
  });
  const sourceId = await getOrCreateGatekeeperSource(
    client,
    ws,
    call.gatekeeperId,
    await getOrCreateGatekeeperServicePrincipal(client, ws),
  );
  const observation = await recordSourceObservation(client, ws, {
    sourceId,
    activityId: activity.id,
    content: {
      purpose: 'reconcile_check',
      actionRequestId: due.actionRequestId,
      stepRunId: due.stepRunId,
      goalRunId: due.goalRunId,
      gatekeeperId: call.gatekeeperId,
      operation: call.operation,
      operationDigest: settlement.operationDigest,
      params: redactSuspectedSecrets(call.params ?? {}, { secretFields: true }).value,
      ...settlement.credentialReview,
      expect: call.expect,
      outcome: evaluation.outcome,
      undetermined: evaluation.undetermined,
      result,
      truncated,
    },
  });
  await endActivity(client, ws, activity.id, 'completed');

  if (evaluation.outcome === 'satisfied') {
    await recordObservedReconciliation(client, ws, {
      actionRequestId: due.actionRequestId,
      observationId: observation.id,
      sourceId,
      actorPrincipalId: due.requesterId,
      context: { goalRunId: due.goalRunId },
    });
    await settleReconcileCheck(
      client,
      ws,
      check,
      { status: 'seen', observationId: observation.id },
      audit,
    );
    return 'seen';
  }
  await settleReconcileCheck(
    client,
    ws,
    check,
    { status: 'not_seen', observationId: observation.id },
    audit,
  );
  return 'not_seen';
}
