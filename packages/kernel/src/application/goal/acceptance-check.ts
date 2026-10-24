import type { GateAbsence } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import type { PredicateOutcome } from '../../substrate/epistemic/index.js';
import {
  type AcceptanceCheckRow,
  FACT_NOT_OBSERVED,
  claimAcceptanceCheck,
  deferAcceptanceCheck,
  lockAcceptanceCheck,
  settleAcceptanceCheck,
  supersedePendingAcceptanceChecks,
  supersedePendingStepAcceptanceChecks,
} from './acceptance-checks.js';
import { markGoalRunDue } from './advancer.js';
import { judgeFact, prepareFactCheck, readFactEvidence } from './fact-check.js';
import {
  type PlatformObservationAnswer,
  callPlatformObservation,
  platformObservationRetryDelayMs,
  preparePlatformObservation,
  recordPlatformObservation,
} from './platform-observation.js';
import { lockStepRun } from './reads.js';
import { lockGoalRun } from './service.js';

/**
 * application/goal/acceptance-check (S11 GO4a; plan §4.6, I-G5, scenario S6): the platform's
 * acceptance observations. Every step of a GoalRun is done, the run is `verifying` and its round has
 * an `observe_predicate` row pending (`advance.ts` phase V, `acceptance-checks.ts`). This module
 * makes the observation — the steps every observation the platform makes for a requester takes,
 * `platform-observation.ts`, as the reconcile check does — and records what it showed:
 *
 *   - **satisfied** — the row settles `passed` on the Observation; the run is set due, and the
 *     advance completes it once every check of the round passed (or asks the requester, when the
 *     round has a confirmation).
 *   - **unsatisfied or undetermined** — what is checked may show late ("healthy within 2 minutes of
 *     the restart"), so the observation is tried again with backoff: the Observation is recorded
 *     and audited, kept as the row's latest, and the row is due again later. Once no further
 *     attempt fits — {@link AcceptanceCheckOptions.maxAttempts} attempts made, or the next would
 *     start past {@link AcceptanceCheckOptions.maxDurationMs} from the first
 *     (`platformObservationRetryDelayMs`) — it settles `failed` on its latest Observation, and the
 *     advance pauses the run `needs_decision` with the evidence on the row (S6: the goal is not
 *     declared achieved).
 *   - **no answer** (`gateFailureRetry`: `transient`) — tried again under the same caps; at the
 *     last, `failed` on the latest Observation if an earlier attempt made one, else `unavailable`.
 *   - **refused** — nothing a retry could change, so `unavailable` at once: the predicate no
 *     longer passes the lint or the credential review, the requester may no longer observe through
 *     that gate, the gate or Operation is gone, the params carry a credential, or the gate refused
 *     the call.
 *
 * **When.** Only while the run is `verifying` and the row is in its latest round: a move out of
 * `verifying` supersedes the round's pending rows in that transaction (`moves.ts`), so a paused,
 * held or cancelled run observes nothing, and a resume verifies in a new round. An attempt under
 * way when the run left `verifying` writes nothing (its row is no longer pending). Rows left
 * pending under a run that is not verifying — by a release that did not supersede them — are
 * superseded here without a call. No budget is checked: the caps bound an observation, and the
 * run's wall clock does not run while it verifies.
 *
 * **How.** {@link runAcceptanceCheckTick} lists due rows across workspaces (a read with no
 * workspace context, like the advancer's claim), then per row: claims it in its own transaction
 * (`claimAcceptanceCheck`: single-flight, the attempt number grows, a lease covers the attempt),
 * prepares the call in the requester's context in a second, calls the gate outside any
 * transaction, and settles in a third — the GoalRun, then the row locked, fenced on the run still
 * `verifying`, the row still `pending` at the claimed attempt and in the latest round; an attempt
 * that lost its claim writes nothing. The settle records the Observation (an Activity
 * `goal_acceptance_check` on the Gatekeeper's Source, `purpose: 'acceptance_check'` with the run,
 * the round and the check's key — the database lets a row pass only on such an Observation that
 * satisfied its predicate), settles or defers the row and, on a settlement, sets the run due.
 *
 * **A step's checks** (S11 GO4b, `step_acceptance_checks`) run the same way, while the step waits
 * on its acceptance (`waiting(acceptance)`) at the attempt the row verifies and the run is
 * `running`: the settle locks the GoalRun, the StepRun, then the row, and is fenced on all of that
 * and the row being in the step's latest round. Its Observation is an Activity
 * `goal_step_acceptance_check`, `purpose: 'step_acceptance_check'` with the run, the step, the
 * round and the check's key — the only Observation goal/0006 lets the row pass on. A step that
 * stops waiting, or a run that stops running, supersedes the round's pending rows in that
 * transaction (`moves.ts`); rows left pending otherwise are superseded here without a call. Unlike
 * the goal's, the run's wall clock keeps running while a step is verified: the other steps may
 * still be working.
 *
 * **A fact check** (S11 GO4c, `fact_predicate`, the goal's or a step's) is claimed, fenced and
 * settled the same way, but calls no gate: under the settle's locks it reads, as the requester,
 * the Fact the check may rest on (`fact-check.ts`: of the Link it names, observed since the round
 * opened and not by this goal's own doing — the database's `goal_fact_admissible`, which also holds
 * a passed row to it) and judges its properties. Satisfied → `passed` on that Fact. Seen but not
 * satisfied → tried again (the Fact may change), and at the last attempt `failed` on the latest
 * Fact seen. Nothing that may serve as evidence → tried again (an observation may still come), and
 * at the last attempt `unavailable` (`fact_not_observed`) — or `failed` when an earlier attempt saw
 * a Fact that did not satisfy it. Refused (the predicate or the Objects it names no longer pass the
 * review, the requester may no longer read Facts) → `unavailable` at once. "Could not see" and
 * "saw, and it was not so" never read alike: the row's status, its `last_error`, the step's
 * `waiting(acceptance_unavailable)` against `failed(verification_failed)`, and the audit say which.
 */

/** How often the composition root runs {@link runAcceptanceCheckTick}. */
export const DEFAULT_ACCEPTANCE_CHECK_INTERVAL_MS = 5000;
/** How long a claim holds a row: past the gate client's observe timeout with room to settle. */
export const DEFAULT_ACCEPTANCE_CHECK_LEASE_MS = 120 * 1000;
/** Attempts an observation makes at most. */
export const DEFAULT_ACCEPTANCE_CHECK_MAX_ATTEMPTS = 5;
/** How long after its first attempt an observation may still be tried again. */
export const DEFAULT_ACCEPTANCE_CHECK_MAX_DURATION_MS = 15 * 60 * 1000;
/** Rows looked at per tick. */
export const DEFAULT_ACCEPTANCE_CHECK_BATCH = 10;

const ACCEPTANCE_ACTIVITY_KIND = 'goal_acceptance_check';
const STEP_ACCEPTANCE_ACTIVITY_KIND = 'goal_step_acceptance_check';

export interface AcceptanceCheckOptions {
  readonly leaseMs?: number;
  /** Attempts at most (default {@link DEFAULT_ACCEPTANCE_CHECK_MAX_ATTEMPTS}). */
  readonly maxAttempts?: number;
  /** No attempt is scheduled to start later than this after the first (default
   *  {@link DEFAULT_ACCEPTANCE_CHECK_MAX_DURATION_MS}). */
  readonly maxDurationMs?: number;
  readonly limit?: number;
  readonly backoffMs?: (attempt: number) => number;
}

/** When the next attempt of an observation that did not settle on attempt `attempts` starts, as a
 *  delay from `now` — or `null` when this attempt is its last. */
export function acceptanceRetryDelayMs(
  check: { readonly attempts: number; readonly firstAttemptAt: Date | null },
  now: Date,
  options: AcceptanceCheckOptions = {},
): number | null {
  return platformObservationRetryDelayMs(check, now, {
    maxAttempts: options.maxAttempts ?? DEFAULT_ACCEPTANCE_CHECK_MAX_ATTEMPTS,
    maxDurationMs: options.maxDurationMs ?? DEFAULT_ACCEPTANCE_CHECK_MAX_DURATION_MS,
    ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
  });
}

export interface AcceptanceCheckDeps {
  readonly pool: PoolLike;
  readonly gatekeeperClient: Parameters<typeof callPlatformObservation>[0];
  readonly options?: AcceptanceCheckOptions;
}

/** A due row, as the tick found it. */
export interface DueAcceptanceCheck {
  readonly workspaceId: string;
  readonly goalRunId: string;
  /** A step's check (S11 GO4b): its StepRun; `null` for the goal's own. */
  readonly stepRunId: string | null;
  readonly round: number;
  readonly checkKey: string;
  /** The run's requester — whom the observation is for. */
  readonly requesterId: string;
  /** The row was left pending after its round ended — it is superseded without a call:
   *  `goal_left_verifying` (the goal's own, under a run that is not verifying),
   *  `step_left_acceptance` (a step's, under a step no longer waiting on it at that attempt, or a
   *  run that is not running). `null`: an observation to make. */
  readonly closedBy: 'goal_left_verifying' | 'step_left_acceptance' | null;
}

export type AcceptanceCheckOutcome =
  | 'passed'
  | 'failed'
  | 'unavailable'
  | 'superseded'
  | 'retry'
  /** Not claimed (another kernel has it, or it is no longer due), or the claim was lost. */
  | 'skipped';

/** Pending checks the platform makes (observations, fact checks) of a verifying run's latest round,
 *  and of the latest round of a step waiting on its acceptance in a running run, that are due and
 *  not leased; and pending rows whose round ended (any kind) — oldest first. */
export async function listDueAcceptanceChecks(
  pool: PoolLike,
  limit = DEFAULT_ACCEPTANCE_CHECK_BATCH,
): Promise<readonly DueAcceptanceCheck[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      workspace_id: string;
      goal_run_id: string;
      step_run_id: string | null;
      round: number;
      check_key: string;
      on_behalf_of: string;
      closed: boolean;
    }>(
      `select * from (
         select c.workspace_id, c.goal_run_id, null::uuid as step_run_id, c.round, c.check_key,
                g.on_behalf_of, g.status <> 'verifying' as closed, c.next_attempt_at
           from goal_acceptance_checks c
           join goal_runs g on g.workspace_id = c.workspace_id and g.id = c.goal_run_id
          where c.status = 'pending'
            and (g.status <> 'verifying'
                 or (c.kind in ('observe_predicate', 'fact_predicate')
                     and c.next_attempt_at <= now()
                     and (c.lease_until is null or c.lease_until <= now())
                     and c.round = (select max(m.round) from goal_acceptance_checks m
                                     where m.workspace_id = c.workspace_id
                                       and m.goal_run_id = c.goal_run_id)))
         union all
         select c.workspace_id, c.goal_run_id, c.step_run_id, c.round, c.check_key,
                g.on_behalf_of, not open.open as closed, c.next_attempt_at
           from step_acceptance_checks c
           join goal_runs g on g.workspace_id = c.workspace_id and g.id = c.goal_run_id
           join step_runs s on s.workspace_id = c.workspace_id and s.id = c.step_run_id
           cross join lateral (
             select g.status = 'running' and s.status = 'waiting'
                    and s.waiting_reason = 'acceptance'
                    and s.attempt_count = c.step_attempt as open) open
          where c.status = 'pending'
            and (not open.open
                 or (c.next_attempt_at <= now()
                     and (c.lease_until is null or c.lease_until <= now())
                     and c.round = (select max(m.round) from step_acceptance_checks m
                                     where m.workspace_id = c.workspace_id
                                       and m.step_run_id = c.step_run_id)))
       ) due
        order by next_attempt_at, goal_run_id, round, check_key
        limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      goalRunId: row.goal_run_id,
      stepRunId: row.step_run_id,
      round: row.round,
      checkKey: row.check_key,
      requesterId: row.on_behalf_of,
      closedBy: !row.closed
        ? null
        : row.step_run_id
          ? 'step_left_acceptance'
          : 'goal_left_verifying',
    }));
  } finally {
    client.release();
  }
}

export interface AcceptanceCheckTickOptions extends AcceptanceCheckOptions {
  /** One row's failure — the others in the batch still run. */
  readonly onError?: (error: unknown, check: DueAcceptanceCheck) => void;
}

/** Lists the due rows and runs each, one after another. Returns how many were looked at. */
export async function runAcceptanceCheckTick(
  deps: AcceptanceCheckDeps,
  options: AcceptanceCheckTickOptions = {},
): Promise<number> {
  const due = await listDueAcceptanceChecks(
    deps.pool,
    options.limit ?? deps.options?.limit ?? DEFAULT_ACCEPTANCE_CHECK_BATCH,
  );
  for (const check of due) {
    try {
      await runAcceptanceCheck(deps, check);
    } catch (err) {
      options.onError?.(err, check);
    }
  }
  return due.length;
}

/** What the attempt came to, before the locks; the settle decides the rest. */
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
  | { readonly kind: 'no_answer'; readonly code: string; readonly error: string | null }
  /** A fact check: the Fact is read and judged under the settle's locks. */
  | { readonly kind: 'fact' };

/** One row — see the module comment. */
export async function runAcceptanceCheck(
  deps: AcceptanceCheckDeps,
  due: DueAcceptanceCheck,
): Promise<AcceptanceCheckOutcome> {
  const context = { workspaceId: due.workspaceId, principalId: due.requesterId };
  if (due.closedBy !== null) return supersedeLeftover(deps, due);

  const maxAttempts = deps.options?.maxAttempts ?? DEFAULT_ACCEPTANCE_CHECK_MAX_ATTEMPTS;
  const leaseMs = deps.options?.leaseMs ?? DEFAULT_ACCEPTANCE_CHECK_LEASE_MS;
  const claimed = await withWorkspace(deps.pool, context, (client) =>
    claimAcceptanceCheck(client, due.workspaceId, due, leaseMs),
  );
  if (!claimed || (!claimed.observationCheck && !claimed.factCheck)) return 'skipped';
  if (claimed.attempts > maxAttempts) {
    // Earlier attempts lost their lease without settling (a kernel died mid-call): no attempt is
    // left, so this one settles on what the row has — its latest Observation, or none.
    return settle(deps, due, claimed, {
      kind: 'no_answer',
      code: 'attempts_exhausted',
      error: null,
    });
  }

  if (!claimed.observationCheck) return settle(deps, due, claimed, { kind: 'fact' });
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

/** A row left pending after its round ended: superseded, under the GoalRun lock (and the
 *  StepRun's, for a step's). */
async function supersedeLeftover(
  deps: AcceptanceCheckDeps,
  due: DueAcceptanceCheck,
): Promise<AcceptanceCheckOutcome> {
  return withWorkspace(
    deps.pool,
    { workspaceId: due.workspaceId, principalId: due.requesterId },
    async (client) => {
      const goal = await lockGoalRun(client, due.workspaceId, due.goalRunId);
      if (!goal) return 'skipped';
      if (due.stepRunId) {
        const step = await lockStepRun(client, due.workspaceId, due.stepRunId);
        const check = await lockAcceptanceCheck(client, due.workspaceId, due);
        if (!step || !check || stepVerifies(goal.status, step, check)) return 'skipped';
        const superseded = await supersedePendingStepAcceptanceChecks(client, due.workspaceId, {
          goalRunId: due.goalRunId,
          stepRunId: due.stepRunId,
          actorPrincipalId: due.requesterId,
          reason: 'step_left_acceptance',
        });
        return superseded > 0 ? 'superseded' : 'skipped';
      }
      if (goal.status === 'verifying') return 'skipped';
      const superseded = await supersedePendingAcceptanceChecks(client, due.workspaceId, {
        goalRunId: due.goalRunId,
        actorPrincipalId: due.requesterId,
        reason: 'goal_left_verifying',
      });
      return superseded > 0 ? 'superseded' : 'skipped';
    },
  );
}

/** Whether a step's row may still settle: the run is running and the step waits on its acceptance
 *  at the attempt the row verifies (goal/0006's guard says the same). */
function stepVerifies(
  goalStatus: string,
  step: {
    readonly status: string;
    readonly waitingReason: string | null;
    readonly attemptCount: number;
  },
  check: AcceptanceCheckRow,
): boolean {
  return (
    goalStatus === 'running' &&
    step.status === 'waiting' &&
    step.waitingReason === 'acceptance' &&
    step.attemptCount === check.stepAttempt
  );
}

async function settle(
  deps: AcceptanceCheckDeps,
  due: DueAcceptanceCheck,
  claimed: AcceptanceCheckRow,
  settlement: Settlement,
): Promise<AcceptanceCheckOutcome> {
  const ws = due.workspaceId;
  return withWorkspace(
    deps.pool,
    { workspaceId: ws, principalId: due.requesterId },
    async (client) => {
      // Lock order under a goal: the GoalRun, then its StepRuns, then the rows.
      const goal = await lockGoalRun(client, ws, due.goalRunId);
      const step = due.stepRunId ? await lockStepRun(client, ws, due.stepRunId) : null;
      const check = await lockAcceptanceCheck(client, ws, due);
      if (
        !goal ||
        !check ||
        (due.stepRunId
          ? !step || !stepVerifies(goal.status, step, check)
          : goal.status !== 'verifying') ||
        check.status !== 'pending' ||
        check.attempts !== claimed.attempts ||
        !(await isLatestRound(client, ws, check))
      ) {
        return 'skipped';
      }
      const now = (await client.query<{ now: Date }>('select now() as now')).rows[0]?.now;
      const retryDelayMs = acceptanceRetryDelayMs(check, now ?? new Date(), deps.options);

      let outcome: AcceptanceCheckOutcome;
      if (settlement.kind === 'unavailable') {
        await settleAcceptanceCheck(
          client,
          ws,
          check,
          { status: 'unavailable', lastError: settlement.code },
          due.requesterId,
          settlement.error,
        );
        outcome = 'unavailable';
      } else if (settlement.kind === 'no_answer') {
        if (retryDelayMs !== null) {
          await deferAcceptanceCheck(
            client,
            ws,
            check,
            { delayMs: retryDelayMs, lastError: settlement.code },
            due.requesterId,
            settlement.error,
          );
          return 'retry';
        }
        // The last attempt: what an earlier one saw, if any, is what the check saw.
        const status =
          check.observationId !== null || check.factId !== null ? 'failed' : 'unavailable';
        await settleAcceptanceCheck(
          client,
          ws,
          check,
          { status, lastError: settlement.code },
          due.requesterId,
          settlement.error,
        );
        outcome = status;
      } else if (settlement.kind === 'fact') {
        outcome = await judgeFactCheck(client, due, check, retryDelayMs);
        if (outcome === 'retry') return outcome;
      } else {
        outcome = await recordObservation(client, due, check, settlement, retryDelayMs);
        if (outcome === 'retry') return outcome;
      }
      await markGoalRunDue(client, ws, due.goalRunId);
      return outcome;
    },
  );
}

async function isLatestRound(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheckRow,
): Promise<boolean> {
  const result = await client.query<{ round: number | null }>(
    check.stepRunId
      ? `select max(round) as round from step_acceptance_checks
          where workspace_id = $1 and step_run_id = $2`
      : `select max(round) as round from goal_acceptance_checks
          where workspace_id = $1 and goal_run_id = $2`,
    [workspaceId, check.stepRunId ?? check.goalRunId],
  );
  return result.rows[0]?.round === check.round;
}

async function recordObservation(
  client: PoolClient,
  due: DueAcceptanceCheck,
  check: AcceptanceCheckRow,
  settlement: Extract<Settlement, { kind: 'observed' }>,
  retryDelayMs: number | null,
): Promise<'passed' | 'failed' | 'retry'> {
  const ws = due.workspaceId;
  const observationCheck = check.observationCheck;
  if (!observationCheck) throw new Error('recordObservation: a confirmation is not observed');
  // A step's check names its step and the attempt it verifies (S11 GO4b).
  const step = check.stepRunId
    ? { stepRunId: check.stepRunId, stepAttempt: check.stepAttempt }
    : {};
  const { observationId, evaluation } = await recordPlatformObservation(client, ws, {
    requesterId: due.requesterId,
    check: observationCheck,
    activityKind: check.stepRunId ? STEP_ACCEPTANCE_ACTIVITY_KIND : ACCEPTANCE_ACTIVITY_KIND,
    activityMetadata: {
      goalRunId: due.goalRunId,
      ...step,
      round: check.round,
      checkKey: check.checkKey,
      gatekeeperId: observationCheck.gatekeeperId,
      operation: observationCheck.operation,
      attempt: check.attempts,
    },
    about: {
      purpose: check.stepRunId ? 'step_acceptance_check' : 'acceptance_check',
      goalRunId: due.goalRunId,
      ...step,
      round: check.round,
      checkKey: check.checkKey,
    },
    data: settlement.data,
    ...(settlement.absent ? { absent: settlement.absent } : {}),
    operationDigest: settlement.operationDigest,
    credentialReview: settlement.credentialReview,
  });

  if (evaluation.outcome === 'satisfied') {
    await settleAcceptanceCheck(
      client,
      ws,
      check,
      { status: 'passed', observationId },
      due.requesterId,
    );
    return 'passed';
  }
  if (retryDelayMs !== null) {
    await deferAcceptanceCheck(
      client,
      ws,
      check,
      { delayMs: retryDelayMs, lastError: unmetCode(evaluation.outcome), observationId },
      due.requesterId,
    );
    return 'retry';
  }
  await settleAcceptanceCheck(
    client,
    ws,
    check,
    { status: 'failed', observationId, lastError: unmetCode(evaluation.outcome) },
    due.requesterId,
  );
  return 'failed';
}

/** A fact check's attempt, under the settle's locks — see the module comment. */
async function judgeFactCheck(
  client: PoolClient,
  due: DueAcceptanceCheck,
  check: AcceptanceCheckRow,
  retryDelayMs: number | null,
): Promise<'passed' | 'failed' | 'unavailable' | 'retry'> {
  const ws = due.workspaceId;
  const fact = check.factCheck;
  if (!fact) throw new Error('judgeFactCheck: an observation is not judged on a Fact');
  const refusal = await prepareFactCheck(client, ws, due.requesterId, fact);
  if (refusal) {
    await settleAcceptanceCheck(
      client,
      ws,
      check,
      { status: 'unavailable', lastError: refusal },
      due.requesterId,
    );
    return 'unavailable';
  }
  const evidence = await readFactEvidence(client, ws, {
    goalRunId: due.goalRunId,
    fact,
    since: check.createdAt,
  });
  if (!evidence) {
    if (retryDelayMs !== null) {
      await deferAcceptanceCheck(
        client,
        ws,
        check,
        { delayMs: retryDelayMs, lastError: FACT_NOT_OBSERVED },
        due.requesterId,
      );
      return 'retry';
    }
    // The last attempt: a Fact an earlier one saw, if any, is what the check saw.
    const status = check.factId !== null ? 'failed' : 'unavailable';
    await settleAcceptanceCheck(
      client,
      ws,
      check,
      { status, lastError: FACT_NOT_OBSERVED },
      due.requesterId,
    );
    return status;
  }

  const evaluation = judgeFact(fact, evidence);
  const detail = {
    evaluation: {
      outcome: evaluation.outcome,
      ...(evaluation.undetermined.length > 0 ? { undetermined: evaluation.undetermined } : {}),
    },
  };
  if (evaluation.outcome === 'satisfied') {
    await settleAcceptanceCheck(
      client,
      ws,
      check,
      { status: 'passed', factId: evidence.factId, detail },
      due.requesterId,
    );
    return 'passed';
  }
  if (retryDelayMs !== null) {
    await deferAcceptanceCheck(
      client,
      ws,
      check,
      {
        delayMs: retryDelayMs,
        lastError: unmetCode(evaluation.outcome),
        factId: evidence.factId,
        detail,
      },
      due.requesterId,
    );
    return 'retry';
  }
  await settleAcceptanceCheck(
    client,
    ws,
    check,
    { status: 'failed', factId: evidence.factId, lastError: unmetCode(evaluation.outcome), detail },
    due.requesterId,
  );
  return 'failed';
}

/** The `last_error` of an attempt that observed without the predicate holding. */
function unmetCode(outcome: PredicateOutcome): string {
  return outcome === 'undetermined' ? 'predicate_undetermined' : 'predicate_unsatisfied';
}
