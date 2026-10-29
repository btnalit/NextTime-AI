import type { GateAbsence } from '@nexttime/shared';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import type { OperationAbsentAnswersReview } from '../../governance/gatekeepers/index.js';
import {
  type AbsenceBaselineRow,
  claimAbsenceBaseline,
  deferAbsenceBaseline,
  lockAbsenceBaseline,
  settleAbsenceBaseline,
  supersedePendingAbsenceBaselines,
} from './absence-baselines.js';
import {
  type AcceptanceCheckDeps,
  DEFAULT_ACCEPTANCE_CHECK_BATCH,
  DEFAULT_ACCEPTANCE_CHECK_LEASE_MS,
  DEFAULT_ACCEPTANCE_CHECK_MAX_ATTEMPTS,
  acceptanceRetryDelayMs,
} from './acceptance-check.js';
import { markGoalRunDue } from './advancer.js';
import {
  callPlatformObservation,
  preparePlatformObservation,
  recordPlatformObservation,
} from './platform-observation.js';
import { lockGoalRun } from './service.js';

/**
 * application/goal/absence-baseline (S11 「门确认不存在」 B-c, goal/0012, I-AB1): the platform's
 * look, before the goal's work, at what an absence check (`observe_absent`) will later want gone —
 * its baseline (`absence-baselines.ts` opens the takes). The look is made as an acceptance
 * observation is (`platform-observation.ts`: prepare in the requester's context, the gate call
 * outside any transaction, the record in the settling one), under the same caps
 * (`GOAL_ACCEPTANCE_CHECK_MAX_ATTEMPTS` / `_MAX_DURATION_MS`), and settles at once on what the gate
 * answers:
 *
 *   - **data** — the thing is there: `seen_present`, on the Observation. Only such a baseline lets
 *     the check pass later (I-AB1).
 *   - **absent**, in an answer the published Operation declares means so — it is not there before
 *     the goal did anything: `never_seen_present`, on the Observation. The check could never show
 *     this goal removed it; the advance pauses the run for the requester.
 *   - **refused** (the prepare's refusals — among them an Operation that no longer declares, or
 *     whose version nobody confirmed, which answers mean "not there" — or the gate's): `unavailable`
 *     at once.
 *   - **no answer** — tried again with backoff; at the last, `unavailable`.
 *
 * A settlement sets the run due. **When:** only while the run is `running` — a move out of it
 * supersedes the pending takes in that transaction (`moves.ts`), so nothing is looked at for a
 * paused, held or cancelled run; takes left pending under a run that is not running (by a release
 * that did not supersede them) are superseded here without a call. The settle locks the GoalRun,
 * then the take, and is fenced on the run still `running` and the take still `pending` at the
 * claimed attempt; an attempt that lost its claim writes nothing.
 *
 * The Observation is an Activity `goal_absence_baseline` on the Gatekeeper's Source, `purpose:
 * 'absence_baseline'` with the run, the check (`stepKey` for a step's) and the take — the only
 * Observation goal/0012 settles a take on. It records the call, the gate's answer (`absent`, or the
 * result kept as an acceptance observation keeps it) and the `outcome` of the absence the check
 * waits for (`unsatisfied` when the thing was there) — the same record an absence check's own
 * attempt leaves.
 */

const BASELINE_ACTIVITY_KIND = 'goal_absence_baseline';

/** A due take, as the tick found it. */
export interface DueAbsenceBaseline {
  readonly workspaceId: string;
  readonly goalRunId: string;
  readonly baselineId: string;
  /** The run's requester — whom the look is for. */
  readonly requesterId: string;
  /** The run is not running: the take is superseded without a call. */
  readonly closed: boolean;
}

export type AbsenceBaselineOutcome =
  | 'seen_present'
  | 'never_seen_present'
  | 'unavailable'
  | 'superseded'
  | 'retry'
  /** Not claimed (another kernel has it, or it is no longer due), or the claim was lost. */
  | 'skipped';

/** Pending takes of running runs that are due and not leased, and pending takes of runs that are
 *  not running — oldest first. A read with no workspace context, like the advancer's claim. */
export async function listDueAbsenceBaselines(
  pool: PoolLike,
  limit = DEFAULT_ACCEPTANCE_CHECK_BATCH,
): Promise<readonly DueAbsenceBaseline[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      workspace_id: string;
      goal_run_id: string;
      id: string;
      on_behalf_of: string;
      closed: boolean;
    }>(
      `select b.workspace_id, b.goal_run_id, b.id, g.on_behalf_of,
              g.status <> 'running' as closed
         from goal_absence_baselines b
         join goal_runs g on g.workspace_id = b.workspace_id and g.id = b.goal_run_id
        where b.status = 'pending'
          and (g.status <> 'running'
               or (b.next_attempt_at <= now()
                   and (b.lease_until is null or b.lease_until <= now())))
        order by b.next_attempt_at, b.goal_run_id, b.id
        limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      goalRunId: row.goal_run_id,
      baselineId: row.id,
      requesterId: row.on_behalf_of,
      closed: row.closed,
    }));
  } finally {
    client.release();
  }
}

/** Lists the due takes and runs each, one after another (`onError`: one take's failure — the others
 *  still run). Returns how many were looked at. The composition root (`index.ts`) runs it on the
 *  acceptance checks' timer, just before `runAcceptanceCheckTick`, under their options. */
export async function runAbsenceBaselineTick(
  deps: AcceptanceCheckDeps,
  options: {
    readonly limit?: number;
    readonly onError?: (error: unknown, due: DueAbsenceBaseline) => void;
  } = {},
): Promise<number> {
  const due = await listDueAbsenceBaselines(
    deps.pool,
    options.limit ?? deps.options?.limit ?? DEFAULT_ACCEPTANCE_CHECK_BATCH,
  );
  for (const baseline of due) {
    try {
      await runAbsenceBaseline(deps, baseline);
    } catch (err) {
      options.onError?.(err, baseline);
    }
  }
  return due.length;
}

/** What the attempt came to, before the locks; the settle decides the rest. */
type Settlement =
  | {
      readonly kind: 'observed';
      readonly data: unknown;
      readonly absent?: GateAbsence;
      readonly operationDigest: string;
      readonly credentialReview: Record<string, unknown>;
      readonly absentAnswersReview?: OperationAbsentAnswersReview;
    }
  | { readonly kind: 'unavailable'; readonly code: string; readonly error?: string | null }
  | { readonly kind: 'no_answer'; readonly code: string; readonly error: string | null };

/** One take — see the module comment. */
export async function runAbsenceBaseline(
  deps: AcceptanceCheckDeps,
  due: DueAbsenceBaseline,
): Promise<AbsenceBaselineOutcome> {
  const context = { workspaceId: due.workspaceId, principalId: due.requesterId };
  if (due.closed) {
    return withWorkspace(deps.pool, context, async (client) => {
      const goal = await lockGoalRun(client, due.workspaceId, due.goalRunId);
      if (!goal || goal.status === 'running') return 'skipped';
      const superseded = await supersedePendingAbsenceBaselines(client, due.workspaceId, {
        goalRunId: due.goalRunId,
        actorPrincipalId: due.requesterId,
        reason: 'goal_not_running',
      });
      return superseded > 0 ? 'superseded' : 'skipped';
    });
  }

  const maxAttempts = deps.options?.maxAttempts ?? DEFAULT_ACCEPTANCE_CHECK_MAX_ATTEMPTS;
  const leaseMs = deps.options?.leaseMs ?? DEFAULT_ACCEPTANCE_CHECK_LEASE_MS;
  const claimed = await withWorkspace(deps.pool, context, (client) =>
    claimAbsenceBaseline(client, due.workspaceId, due.baselineId, leaseMs),
  );
  if (!claimed) return 'skipped';
  if (claimed.attempts > maxAttempts) {
    // Earlier attempts lost their lease without settling (a kernel died mid-call): none is left.
    return settle(deps, due, claimed, {
      kind: 'no_answer',
      code: 'attempts_exhausted',
      error: null,
    });
  }

  const prepared = await withWorkspace(deps.pool, context, (client) =>
    preparePlatformObservation(client, due.workspaceId, due.requesterId, claimed.call),
  );
  if (prepared.kind === 'refused') {
    return settle(deps, due, claimed, { kind: 'unavailable', code: prepared.code });
  }
  const answer = await callPlatformObservation(
    deps.gatekeeperClient,
    due.requesterId,
    claimed.call,
    prepared,
  );
  if (answer.kind === 'data') {
    return settle(deps, due, claimed, {
      kind: 'observed',
      data: answer.data,
      ...(answer.absent ? { absent: answer.absent } : {}),
      operationDigest: prepared.operationDigest,
      credentialReview: prepared.credentialReview,
      ...(prepared.absentAnswersReview
        ? { absentAnswersReview: prepared.absentAnswersReview }
        : {}),
    });
  }
  return settle(deps, due, claimed, {
    kind: answer.kind === 'refused' ? 'unavailable' : 'no_answer',
    code: answer.code,
    error: answer.error,
  });
}

async function settle(
  deps: AcceptanceCheckDeps,
  due: DueAbsenceBaseline,
  claimed: AbsenceBaselineRow,
  settlement: Settlement,
): Promise<AbsenceBaselineOutcome> {
  const ws = due.workspaceId;
  return withWorkspace(
    deps.pool,
    { workspaceId: ws, principalId: due.requesterId },
    async (client) => {
      // Lock order under a goal: the GoalRun, then the rows under it.
      const goal = await lockGoalRun(client, ws, due.goalRunId);
      const row = await lockAbsenceBaseline(client, ws, due.baselineId);
      if (
        !goal ||
        !row ||
        goal.status !== 'running' ||
        row.status !== 'pending' ||
        row.attempts !== claimed.attempts
      ) {
        return 'skipped';
      }
      let outcome: AbsenceBaselineOutcome;
      if (settlement.kind === 'unavailable') {
        await settleAbsenceBaseline(
          client,
          ws,
          row,
          { status: 'unavailable', lastError: settlement.code },
          due.requesterId,
          settlement.error,
        );
        outcome = 'unavailable';
      } else if (settlement.kind === 'no_answer') {
        const now = (await client.query<{ now: Date }>('select now() as now')).rows[0]?.now;
        const retryDelayMs = acceptanceRetryDelayMs(row, now ?? new Date(), deps.options);
        if (retryDelayMs !== null) {
          await deferAbsenceBaseline(
            client,
            ws,
            row,
            { delayMs: retryDelayMs, lastError: settlement.code },
            due.requesterId,
            settlement.error,
          );
          return 'retry';
        }
        await settleAbsenceBaseline(
          client,
          ws,
          row,
          { status: 'unavailable', lastError: settlement.code },
          due.requesterId,
          settlement.error,
        );
        outcome = 'unavailable';
      } else {
        const step = row.stepKey !== null ? { stepKey: row.stepKey } : {};
        const { observationId } = await recordPlatformObservation(client, ws, {
          requesterId: due.requesterId,
          check: row.call,
          activityKind: BASELINE_ACTIVITY_KIND,
          activityMetadata: {
            goalRunId: due.goalRunId,
            ...step,
            checkKey: row.checkKey,
            take: row.take,
            gatekeeperId: row.call.gatekeeperId,
            operation: row.call.operation,
            attempt: row.attempts,
          },
          about: {
            purpose: 'absence_baseline',
            goalRunId: due.goalRunId,
            ...step,
            checkKey: row.checkKey,
            take: row.take,
          },
          data: settlement.data,
          ...(settlement.absent ? { absent: settlement.absent } : {}),
          operationDigest: settlement.operationDigest,
          credentialReview: settlement.credentialReview,
          ...(settlement.absentAnswersReview
            ? { absentAnswersReview: settlement.absentAnswersReview }
            : {}),
        });
        outcome = settlement.absent ? 'never_seen_present' : 'seen_present';
        await settleAbsenceBaseline(
          client,
          ws,
          row,
          { status: outcome, observationId },
          due.requesterId,
        );
      }
      await markGoalRunDue(client, ws, due.goalRunId);
      return outcome;
    },
  );
}
