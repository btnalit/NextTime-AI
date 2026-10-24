import type { GateAbsence } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import {
  type ReconcileCheckAuditContext,
  type ReconcileCheckRow,
  claimReconcileCheck,
  deferReconcileCheck,
  getActionRequestForUpdateOrThrow,
  lockReconcileCheck,
  recordObservedReconciliation,
  settleReconcileCheck,
} from '../../governance/approval/index.js';
import type { PredicateOutcome } from '../../substrate/epistemic/index.js';
import { markGoalRunDue } from './advancer.js';
import {
  PLATFORM_OBSERVATION_MAX_BACKOFF_MS,
  PLATFORM_OBSERVATION_RESULT_MAX_CHARS,
  type PlatformObservationAnswer,
  callPlatformObservation,
  defaultPlatformObservationBackoffMs,
  platformObservationRetryDelayMs,
  preparePlatformObservation,
  recordPlatformObservation,
} from './platform-observation.js';
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
/** The longest wait between two attempts (`platform-observation.ts`). */
export const RECONCILE_CHECK_MAX_BACKOFF_MS = PLATFORM_OBSERVATION_MAX_BACKOFF_MS;
/** Checks looked at per tick. */
export const DEFAULT_RECONCILE_CHECK_BATCH = 10;
/** The most characters of an observation's result kept in its evidence
 *  (`platform-observation.ts`). */
export const RECONCILE_RESULT_MAX_CHARS = PLATFORM_OBSERVATION_RESULT_MAX_CHARS;

const RECONCILE_ACTIVITY_KIND = 'goal_reconcile_check';
const ENDED_GOAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const ENDED_STEP_STATUSES = ['succeeded', 'superseded', 'cancelled', 'skipped'] as const;

/** Delay before attempt `attempt + 1`: 30 s, doubling, at most
 *  {@link RECONCILE_CHECK_MAX_BACKOFF_MS} — with the defaults, five attempts within 7½ minutes. */
export function defaultReconcileCheckBackoffMs(attempt: number): number {
  return defaultPlatformObservationBackoffMs(attempt);
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
  return platformObservationRetryDelayMs(check, now, {
    maxAttempts: options.maxAttempts ?? DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS,
    maxDurationMs: options.maxDurationMs ?? DEFAULT_RECONCILE_CHECK_MAX_DURATION_MS,
    ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
  });
}

export interface ReconcileCheckDeps {
  readonly pool: PoolLike;
  readonly gatekeeperClient: Parameters<typeof callPlatformObservation>[0];
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

/** What the attempt came to, before the locks; the settle decides the rest (see the module
 *  comment). */
type Settlement =
  | {
      readonly kind: 'observed';
      readonly data: unknown;
      /** The gate answered that the target has no such thing (`PlatformObservationAnswer`). */
      readonly absent?: GateAbsence;
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
    preparePlatformObservation(client, due.workspaceId, due.requesterId, check),
  );
  if (prepared.kind === 'refused') {
    return settle(deps, due, claimed, { kind: 'unavailable', code: prepared.code });
  }

  const answer: PlatformObservationAnswer = await callPlatformObservation(
    deps.gatekeeperClient,
    due.requesterId,
    check,
    prepared,
  );
  if (answer.kind === 'data') {
    return settle(deps, due, claimed, {
      kind: 'observed',
      data: answer.data,
      ...(answer.absent ? { absent: answer.absent } : {}),
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
  const { observationId, sourceId, evaluation } = await recordPlatformObservation(client, ws, {
    requesterId: due.requesterId,
    check: check.observationCheck,
    activityKind: RECONCILE_ACTIVITY_KIND,
    activityMetadata: {
      actionRequestId: due.actionRequestId,
      stepRunId: due.stepRunId,
      goalRunId: due.goalRunId,
      gatekeeperId: check.observationCheck.gatekeeperId,
      operation: check.observationCheck.operation,
      attempt: check.attempts,
    },
    about: {
      purpose: 'reconcile_check',
      actionRequestId: due.actionRequestId,
      stepRunId: due.stepRunId,
      goalRunId: due.goalRunId,
    },
    data: settlement.data,
    ...(settlement.absent ? { absent: settlement.absent } : {}),
    operationDigest: settlement.operationDigest,
    credentialReview: settlement.credentialReview,
  });

  if (evaluation.outcome === 'satisfied') {
    await recordObservedReconciliation(client, ws, {
      actionRequestId: due.actionRequestId,
      observationId,
      sourceId,
      actorPrincipalId: due.requesterId,
      context: { goalRunId: due.goalRunId },
    });
    await settleReconcileCheck(client, ws, check, { status: 'seen', observationId }, audit);
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
        observationId,
      },
      audit,
    );
    return 'retry';
  }
  await settleReconcileCheck(client, ws, check, { status: 'not_seen', observationId }, audit);
  return 'not_seen';
}

/** The `last_error` of an attempt that observed without seeing the effect. */
function notSeenCode(outcome: PredicateOutcome): string {
  return outcome === 'undetermined' ? 'predicate_undetermined' : 'predicate_unsatisfied';
}
