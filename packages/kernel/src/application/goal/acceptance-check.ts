import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import type { PredicateOutcome } from '../../substrate/epistemic/index.js';
import {
  type AcceptanceCheckRow,
  claimAcceptanceCheck,
  deferAcceptanceCheck,
  lockAcceptanceCheck,
  settleAcceptanceCheck,
  supersedePendingAcceptanceChecks,
} from './acceptance-checks.js';
import { markGoalRunDue } from './advancer.js';
import {
  type PlatformObservationAnswer,
  callPlatformObservation,
  platformObservationRetryDelayMs,
  preparePlatformObservation,
  recordPlatformObservation,
} from './platform-observation.js';
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
  readonly round: number;
  readonly checkKey: string;
  /** The run's requester — whom the observation is for. */
  readonly requesterId: string;
  /** `goal_left_verifying`: the row was left pending under a run that is not verifying — it is
   *  superseded without a call. `null`: an observation to make. */
  readonly closedBy: 'goal_left_verifying' | null;
}

export type AcceptanceCheckOutcome =
  | 'passed'
  | 'failed'
  | 'unavailable'
  | 'superseded'
  | 'retry'
  /** Not claimed (another kernel has it, or it is no longer due), or the claim was lost. */
  | 'skipped';

/** Pending observations of a verifying run's latest round that are due and not leased, and
 *  pending rows of runs that are not verifying (any kind) — oldest first. */
export async function listDueAcceptanceChecks(
  pool: PoolLike,
  limit = DEFAULT_ACCEPTANCE_CHECK_BATCH,
): Promise<readonly DueAcceptanceCheck[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      workspace_id: string;
      goal_run_id: string;
      round: number;
      check_key: string;
      on_behalf_of: string;
      closed: boolean;
    }>(
      `select c.workspace_id, c.goal_run_id, c.round, c.check_key, g.on_behalf_of,
              g.status <> 'verifying' as closed
         from goal_acceptance_checks c
         join goal_runs g on g.workspace_id = c.workspace_id and g.id = c.goal_run_id
        where c.status = 'pending'
          and (g.status <> 'verifying'
               or (c.kind = 'observe_predicate'
                   and c.next_attempt_at <= now()
                   and (c.lease_until is null or c.lease_until <= now())
                   and c.round = (select max(m.round) from goal_acceptance_checks m
                                   where m.workspace_id = c.workspace_id
                                     and m.goal_run_id = c.goal_run_id)))
        order by c.next_attempt_at, c.goal_run_id, c.round, c.check_key
        limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      goalRunId: row.goal_run_id,
      round: row.round,
      checkKey: row.check_key,
      requesterId: row.on_behalf_of,
      closedBy: row.closed ? 'goal_left_verifying' : null,
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
      readonly operationDigest: string;
      readonly credentialReview: Record<string, unknown>;
    }
  /** Nothing a retry could change. */
  | { readonly kind: 'unavailable'; readonly code: string; readonly error?: string | null }
  /** No answer: tried again while the caps allow. */
  | { readonly kind: 'no_answer'; readonly code: string; readonly error: string | null };

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
  if (!claimed?.observationCheck) return 'skipped';
  if (claimed.attempts > maxAttempts) {
    // Earlier attempts lost their lease without settling (a kernel died mid-call): no attempt is
    // left, so this one settles on what the row has — its latest Observation, or none.
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

/** A row left pending under a run that is not verifying: superseded, under the GoalRun lock. */
async function supersedeLeftover(
  deps: AcceptanceCheckDeps,
  due: DueAcceptanceCheck,
): Promise<AcceptanceCheckOutcome> {
  return withWorkspace(
    deps.pool,
    { workspaceId: due.workspaceId, principalId: due.requesterId },
    async (client) => {
      const goal = await lockGoalRun(client, due.workspaceId, due.goalRunId);
      if (!goal || goal.status === 'verifying') return 'skipped';
      const superseded = await supersedePendingAcceptanceChecks(client, due.workspaceId, {
        goalRunId: due.goalRunId,
        actorPrincipalId: due.requesterId,
        reason: 'goal_left_verifying',
      });
      return superseded > 0 ? 'superseded' : 'skipped';
    },
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
      // Lock order under a goal: the GoalRun, then its rows.
      const goal = await lockGoalRun(client, ws, due.goalRunId);
      const check = await lockAcceptanceCheck(client, ws, due);
      if (
        !goal ||
        goal.status !== 'verifying' ||
        !check ||
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
        // The last attempt: what an earlier one observed, if any, is what the check saw.
        const status = check.observationId !== null ? 'failed' : 'unavailable';
        await settleAcceptanceCheck(
          client,
          ws,
          check,
          { status, lastError: settlement.code },
          due.requesterId,
          settlement.error,
        );
        outcome = status;
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
    `select max(round) as round from goal_acceptance_checks
      where workspace_id = $1 and goal_run_id = $2`,
    [workspaceId, check.goalRunId],
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
  const { observationId, evaluation } = await recordPlatformObservation(client, ws, {
    requesterId: due.requesterId,
    check: observationCheck,
    activityKind: ACCEPTANCE_ACTIVITY_KIND,
    activityMetadata: {
      goalRunId: due.goalRunId,
      round: check.round,
      checkKey: check.checkKey,
      gatekeeperId: observationCheck.gatekeeperId,
      operation: observationCheck.operation,
      attempt: check.attempts,
    },
    about: {
      purpose: 'acceptance_check',
      goalRunId: due.goalRunId,
      round: check.round,
      checkKey: check.checkKey,
    },
    data: settlement.data,
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

/** The `last_error` of an attempt that observed without the predicate holding. */
function unmetCode(outcome: PredicateOutcome): string {
  return outcome === 'undetermined' ? 'predicate_undetermined' : 'predicate_unsatisfied';
}
