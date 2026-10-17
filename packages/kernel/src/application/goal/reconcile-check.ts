import { type ObservationCheck, type Role, getCapability } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import {
  type GateTarget,
  type GatekeeperClient,
  GatekeeperClientError,
  GatekeeperTimeoutError,
  gateFailureRetry,
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
  type PredicateOutcome,
  endActivity,
  evaluatePredicate,
  lintPredicate,
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
import { predicateCredentialProblems } from './plan.js';
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
 *   - **unsatisfied or undetermined** — an effect can show late (a restart that takes a minute, a
 *     replica that catches up), so the check tries again with backoff (review #493 on #649): the
 *     Observation is recorded and audited, kept as the check's latest, and the check is due again
 *     later. Once no further attempt fits — {@link ReconcileCheckOptions.maxAttempts} attempts made,
 *     or the next would start past {@link ReconcileCheckOptions.maxDurationMs} from the first
 *     ({@link reconcileRetryDelayMs}) — it settles `not_seen` on its latest Observation, and the
 *     next advance pauses the run `awaiting_reconcile` for a person. The platform never records
 *     `effect_absent`: an observation that does not show the effect may be early, or watch the
 *     wrong thing — only the direction that lets the step go on is the platform's.
 *   - **no answer** (the network, a timeout, a 5xx, a 429 — `adapters/gatekeeper-client`'s
 *     `gateFailureRetry`: `transient`) — tried again under the same caps; at the last, `not_seen`
 *     on the latest Observation if an earlier attempt made one, else `unavailable`.
 *   - **refused** — nothing a retry could change, so `unavailable` at once and a person
 *     reconciles: the predicate no longer passes the lint or the credential review (`plan.ts`,
 *     checked again here in case either learned more since the plan was confirmed), the requester
 *     may no longer observe through that gate (disabled, role, exclusions), the gate or Operation
 *     is gone, the params carry a credential, or the gate refused the call or answered what the
 *     kernel does not take (`gateFailureRetry`: `deterministic`).
 *
 * Retries hold nothing up and wake nothing: the run stays `running` with the step
 * `waiting(reconcile)` — no attempt starts beside an action that may have run (I-G4), the step's
 * attempt budget is untouched, and the advance's `next_tick_at` stays the wall-clock deadline, so
 * the goal's budget pauses it `budget_exhausted` on time whatever the check is doing (the check
 * then waits, pending, for the resume). Only a settled check sets the run due.
 *
 * **As the requester.** The observation is made for the request's requester, under the rule every
 * other observation is (`observe-access.ts`'s `observeRefusal`), with the requester's agent
 * exclusions applied — the check stands in for the requester's agent, so it reaches no gate their
 * agent could not — and their role still allowed to observe (R-35, `roleMayUseCapability`). No
 * Grant is needed, as for any observation. The gate call carries the published definition's digest
 * and the requester as `onBehalfOf`, like `observe_operation`'s.
 *
 * **When.** Only while the step waits on its reconcile in a `running` run: a paused run's checks
 * wait for the requester's resume (paused by a person, held by an owner, or out of budget). An
 * attempt already under way when the run was paused still settles: a finding runs nothing, so
 * `effect_seen` is recorded and the paused advance counts the action (`advance.ts` phase A) — but
 * nothing starts until the run is resumed. A check that can no longer matter settles
 * `unavailable` without a call — under a run that ended (completed, failed, cancelled:
 * `goal_ended`), or of a step that ended (revised away, skipped, cancelled — a cancel cancels the
 * waiting step: `step_ended`; the run pauses for a person over a revised-away step's unknown
 * action, `advance.ts`) — keeping its latest Observation, so no check reads "pending" forever and
 * the action is left to a person as GO3c leaves any unknown outcome under an ended goal.
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
/** Attempts a check makes at most — observations that did not show the effect and calls that got
 *  no answer alike. */
export const DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS = 5;
/** How long after its first attempt a check may still be tried again (pauses of the run
 *  included): an attempt whose retry would start later is its last. */
export const DEFAULT_RECONCILE_CHECK_MAX_DURATION_MS = 15 * 60 * 1000;
/** The longest wait between two attempts. */
export const RECONCILE_CHECK_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Checks looked at per tick. */
export const DEFAULT_RECONCILE_CHECK_BATCH = 10;
/** The most characters of an observation's result kept in its evidence. */
export const RECONCILE_RESULT_MAX_CHARS = 8000;

const RECONCILE_ACTIVITY_KIND = 'goal_reconcile_check';
const ENDED_GOAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const ENDED_STEP_STATUSES = ['succeeded', 'superseded', 'cancelled', 'skipped'] as const;

/** Delay before attempt `attempt + 1`: 30 s, doubling, at most
 *  {@link RECONCILE_CHECK_MAX_BACKOFF_MS} — with the defaults, five attempts within 7½ minutes. */
export function defaultReconcileCheckBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), RECONCILE_CHECK_MAX_BACKOFF_MS);
}

export interface ReconcileCheckOptions {
  readonly leaseMs?: number;
  /** Attempts at most (default {@link DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS}). */
  readonly maxAttempts?: number;
  /** No attempt is scheduled to start later than this after the first (default
   *  {@link DEFAULT_RECONCILE_CHECK_MAX_DURATION_MS}). */
  readonly maxDurationMs?: number;
  readonly limit?: number;
  readonly backoffMs?: (attempt: number) => number;
}

/** When the next attempt of a check that did not settle on attempt `attempts` starts, as a delay
 *  from `now` — or `null` when this attempt is its last: `attempts` reached `maxAttempts`, or the
 *  next would start past `maxDurationMs` from `firstAttemptAt`. */
export function reconcileRetryDelayMs(
  check: { readonly attempts: number; readonly firstAttemptAt: Date | null },
  now: Date,
  options: ReconcileCheckOptions = {},
): number | null {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_RECONCILE_CHECK_MAX_DURATION_MS;
  if (check.attempts >= maxAttempts) return null;
  const delayMs = (options.backoffMs ?? defaultReconcileCheckBackoffMs)(check.attempts);
  const first = (check.firstAttemptAt ?? now).getTime();
  return now.getTime() + delayMs > first + maxDurationMs ? null : delayMs;
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

/** Pending checks that are not leased and either due, with their step waiting on its reconcile
 *  in a running run, or closed — their run or step ended: those are looked at at once, whatever
 *  their backoff said (a cancel stops the retries) — oldest first. */
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
        where c.status = 'pending'
          and (c.lease_until is null or c.lease_until <= now())
          and ((c.next_attempt_at <= now() and g.status = 'running' and s.status = 'waiting'
                and s.waiting_reason = 'reconcile')
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

/** What the attempt came to, before the locks; the settle decides the rest (see the module
 *  comment). */
type Settlement =
  | {
      readonly kind: 'observed';
      readonly data: unknown;
      readonly operationDigest: string;
      readonly credentialReview: Record<string, unknown>;
    }
  /** Nothing a retry could change. */
  | { readonly kind: 'unavailable'; readonly code: string; readonly error?: string | null }
  /** No answer: tried again while the caps allow. */
  | { readonly kind: 'no_answer'; readonly code: string; readonly error: string | null };

/** One check — see the module comment. */
export async function runReconcileCheck(
  deps: ReconcileCheckDeps,
  due: DueReconcileCheck,
): Promise<ReconcileCheckOutcome> {
  const context = { workspaceId: due.workspaceId, principalId: due.requesterId };
  const maxAttempts = deps.options?.maxAttempts ?? DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS;
  const leaseMs = deps.options?.leaseMs ?? DEFAULT_RECONCILE_CHECK_LEASE_MS;

  const claimed = await withWorkspace(deps.pool, context, (client) =>
    claimReconcileCheck(
      client,
      due.workspaceId,
      due.actionRequestId,
      leaseMs,
      due.closedBy !== null,
    ),
  );
  if (!claimed) return 'skipped';

  if (due.closedBy !== null) {
    return settle(deps, due, claimed, { kind: 'unavailable', code: due.closedBy });
  }
  if (claimed.attempts > maxAttempts) {
    // Earlier attempts lost their lease without settling (a kernel died mid-call): no attempt is
    // left, so this one settles on what the check has — its latest Observation, or none.
    return settle(deps, due, claimed, {
      kind: 'no_answer',
      code: 'attempts_exhausted',
      error: null,
    });
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
  return settle(deps, due, claimed, {
    kind: answer.kind === 'refused' ? 'unavailable' : 'no_answer',
    code: answer.code,
    error: answer.error,
  });
}

async function prepareCall(
  client: PoolClient,
  due: DueReconcileCheck,
  check: ObservationCheck,
): Promise<PreparedCall> {
  const ws = due.workspaceId;
  // The plan's own reviews, again: either may have learned more since the plan was confirmed.
  if (lintPredicate(check.expect).length > 0) return { kind: 'refused', code: 'predicate_refused' };
  if (predicateCredentialProblems(check.expect).length > 0) {
    return { kind: 'refused', code: 'credentials_in_predicate' };
  }
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
    const code =
      err instanceof GatekeeperClientError
        ? err.code
        : err instanceof GatekeeperTimeoutError
          ? 'gate_timeout'
          : 'gate_error';
    return {
      kind: gateFailureRetry(err) === 'deterministic' ? 'refused' : 'no_answer',
      code,
      error: errorText(err),
    };
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

      const now = (await client.query<{ now: Date }>('select now() as now')).rows[0]?.now;
      const retryDelayMs = reconcileRetryDelayMs(check, now ?? new Date(), deps.options);

      let outcome: ReconcileCheckOutcome;
      if (request.reconciliation !== null) {
        await settleReconcileCheck(client, ws, check, { status: 'preempted' }, audit());
        outcome = 'preempted';
      } else if (settlement.kind === 'unavailable') {
        await settleReconcileCheck(
          client,
          ws,
          check,
          { status: 'unavailable', lastError: settlement.code },
          audit(settlement.error),
        );
        outcome = 'unavailable';
      } else if (settlement.kind === 'no_answer') {
        if (retryDelayMs !== null) {
          await deferReconcileCheck(
            client,
            ws,
            check,
            { delayMs: retryDelayMs, lastError: settlement.code },
            audit(settlement.error),
          );
          return 'retry';
        }
        // The last attempt: what an earlier one observed, if any, is what the check saw.
        const status = check.observationId !== null ? 'not_seen' : 'unavailable';
        await settleReconcileCheck(
          client,
          ws,
          check,
          { status, lastError: settlement.code },
          audit(settlement.error),
        );
        outcome = status;
      } else {
        outcome = await recordObservation(client, due, check, settlement, audit(), retryDelayMs);
        if (outcome === 'retry') return outcome;
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
  retryDelayMs: number | null,
): Promise<'seen' | 'not_seen' | 'retry'> {
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
  if (retryDelayMs !== null) {
    await deferReconcileCheck(
      client,
      ws,
      check,
      {
        delayMs: retryDelayMs,
        lastError: notSeenCode(evaluation.outcome),
        observationId: observation.id,
      },
      audit,
    );
    return 'retry';
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

/** The `last_error` of an attempt that observed without seeing the effect. */
function notSeenCode(outcome: PredicateOutcome): string {
  return outcome === 'undetermined' ? 'predicate_undetermined' : 'predicate_unsatisfied';
}
