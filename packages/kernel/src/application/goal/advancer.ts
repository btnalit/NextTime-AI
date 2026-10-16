import {
  ACTION_REQUEST_STATUS_VALUES,
  type ActionRequestStatus,
  type TaskStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import { getActionRequest } from '../../governance/approval/index.js';
import { SYSTEM_ACTOR_PLACEHOLDER } from '../../governance/gatekeepers/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import { readTaskGoalStep, terminateTaskWith } from '../task/index.js';
import { type GoalAdvanceDeps, type GoalAdvanceTarget, advanceGoalRun } from './advance.js';
import { readCancelLeftovers } from './cancelling.js';
import { actionDisposition } from './disposition.js';
import { lockGoalRun } from './service.js';
import { recordGoalRunTransition } from './transition-log.js';

/**
 * application/goal/advancer (S11 GO2; plan §4.2): what makes advances happen — all of it state in
 * the database (`goal_runs.next_tick_at`, goal/0002), none of it in the process, so a restart or a
 * second kernel loses nothing.
 *
 *   1. {@link runGoalAdvancerTick} — the composition root's short-interval tick: claims the due
 *      GoalRuns ({@link claimDueGoalRuns}: `next_tick_at <= now()`, `for no key update skip
 *      locked`, `next_tick_at` pushed one lease ahead in the claiming statement) and advances each
 *      (`advance.ts`). An advance that throws rolls back; its run is due again when the lease
 *      runs out.
 *   2. {@link registerGoalWakeConsumer} — the outbox consumer. A Task of a GoalRun finished, or an
 *      ActionRequest of one of its steps stopped being in flight: in its own short transaction it
 *      sets that GoalRun due, and returns. It never advances (§4.2: the dispatcher's delivery loop
 *      is serial and platform-wide) and never throws: a throw would redeliver the event to every
 *      consumer of it (chat system messages included), and the reconcile scan below covers a wake
 *      that failed.
 *   3. {@link markReconcileDue} — the periodic reconcile scan (S12): sets due every advanced
 *      GoalRun whose rows say an advance has work the run is not scheduled for — so a dead-lettered
 *      or failed wake delays a run by at most one scan period.
 *   4. {@link sweepGoalCancelCleanup} — on the same period (S11 GO3a): a run cancelled with
 *      `cleanup_pending` gets its remaining Tasks terminated again, and the flag cleared once
 *      neither Tasks nor executing requests are left.
 *
 * `running`, `paused` and `cancelling` runs are advanced ({@link ADVANCED_GOAL_RUN_STATUSES});
 * GO4 (`verifying`) extends the list with the advance step it adds.
 *
 * The claim and the scan are raw cross-workspace statements on a pooled connection with no
 * workspace context, the same posture as the task reaper's scans and the invariant monitors: they
 * read across workspaces and write only `next_tick_at`. Everything that moves a row runs in the
 * advance, inside the requester's workspace context.
 */

export const ADVANCED_GOAL_RUN_STATUSES = ['running', 'paused', 'cancelling'] as const;

/** How often the composition root runs {@link runGoalAdvancerTick}. */
export const DEFAULT_GOAL_ADVANCER_INTERVAL_MS = 1000;
/** How often the composition root runs {@link markReconcileDue}. */
export const DEFAULT_GOAL_RECONCILE_INTERVAL_MS = 60 * 1000;
/** How long a claim holds a run before another tick may claim it again. */
export const DEFAULT_GOAL_ADVANCE_LEASE_MS = 60 * 1000;
/** GoalRuns claimed per tick. */
export const DEFAULT_GOAL_ADVANCE_BATCH = 20;

/** ActionRequest statuses that can still run or still await a decision — the `in_flight`
 *  disposition (`disposition.ts`). A request leaving them wakes its GoalRun. */
const IN_FLIGHT_ACTION_STATUSES: readonly ActionRequestStatus[] =
  ACTION_REQUEST_STATUS_VALUES.filter(
    (status) =>
      status !== 'failed' && actionDisposition({ status, failureKind: null }) === 'in_flight',
  );
const IN_FLIGHT_ACTION_STATUS_SET: ReadonlySet<ActionRequestStatus> = new Set(
  IN_FLIGHT_ACTION_STATUSES,
);
const FINISHED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** Claims up to `limit` due GoalRuns — see the module doc comment. */
export async function claimDueGoalRuns(
  pool: PoolLike,
  options: { readonly limit?: number; readonly leaseMs?: number } = {},
): Promise<readonly GoalAdvanceTarget[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ workspace_id: string; id: string; on_behalf_of: string }>(
      `update goal_runs g
          set next_tick_at = now() + make_interval(secs => $2::double precision)
        where (g.workspace_id, g.id) in (
                select d.workspace_id, d.id from goal_runs d
                 where d.next_tick_at <= now()
                 order by d.next_tick_at, d.id
                 limit $1
                   for no key update skip locked)
        returning g.workspace_id, g.id, g.on_behalf_of`,
      [
        options.limit ?? DEFAULT_GOAL_ADVANCE_BATCH,
        (options.leaseMs ?? DEFAULT_GOAL_ADVANCE_LEASE_MS) / 1000,
      ],
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      goalRunId: row.id,
      requesterId: row.on_behalf_of,
    }));
  } finally {
    client.release();
  }
}

export interface GoalAdvancerTickOptions {
  readonly limit?: number;
  readonly leaseMs?: number;
  /** One run's failed advance — the others in the batch still advance. */
  readonly onError?: (error: unknown, target: GoalAdvanceTarget) => void;
}

/** Claims the due GoalRuns and advances each, one after another. Returns how many were claimed. */
export async function runGoalAdvancerTick(
  deps: GoalAdvanceDeps,
  options: GoalAdvancerTickOptions = {},
): Promise<number> {
  const claimed = await claimDueGoalRuns(deps.pool, options);
  for (const target of claimed) {
    try {
      await advanceGoalRun(deps, target);
    } catch (err) {
      options.onError?.(err, target);
    }
  }
  return claimed.length;
}

/**
 * The reconcile scan (§4.2 item 3, S12): sets due — `next_tick_at = now()` — every advanced
 * GoalRun ({@link ADVANCED_GOAL_RUN_STATUSES}) not already due, and not held by an advance
 * (`skip locked`: an advance in progress re-reads everything anyway), that has
 *   (a) a `running` step whose current attempt's Task has finished;
 *   (b) a step `waiting(approval)` with no request of the step still in flight;
 *   (c) while running or cancelling: no `next_tick_at` at all (an advance of such a run always
 *       leaves one — the wall-clock or cancel deadline at the latest);
 *   (d) while running: Tokens used by its Tasks at or past its token budget (usage has no event of
 *       its own; each Task's budget is capped by the goal's headroom, but the model call that
 *       crosses a Task's budget lands before the usage hook fails the Task).
 * Returns how many runs it set due. A `waiting(reconcile)` step is not counted: its GoalRun is
 * paused for a person (GO3b runs the reconcile observation).
 */
export async function markReconcileDue(pool: PoolLike): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `update goal_runs g
          set next_tick_at = now()
        where (g.workspace_id, g.id) in (
                select c.workspace_id, c.id from goal_runs c
                 where c.status = any($1::text[])
                   and (c.next_tick_at is null or c.next_tick_at > now())
                   and (
                     exists (
                       select 1 from step_runs s
                         join tasks t
                           on t.workspace_id = s.workspace_id and t.step_run_id = s.id
                          and t.step_attempt = s.attempt_count
                        where s.workspace_id = c.workspace_id and s.goal_run_id = c.id
                          and s.status = 'running'
                          and t.status in ('completed', 'failed', 'cancelled'))
                     or exists (
                       select 1 from step_runs s
                        where s.workspace_id = c.workspace_id and s.goal_run_id = c.id
                          and s.status = 'waiting' and s.waiting_reason = 'approval'
                          and not exists (
                            select 1 from action_requests ar
                             where ar.workspace_id = s.workspace_id and ar.step_run_id = s.id
                               and ar.status = any($2::text[])))
                     or (c.status in ('running', 'cancelling') and c.next_tick_at is null)
                     or (c.status = 'running'
                         and (select coalesce(sum(t.tokens_used), 0) from tasks t
                               where t.workspace_id = c.workspace_id and t.goal_run_id = c.id)
                             >= c.budget_max_tokens)
                   )
                   for no key update skip locked)`,
      [[...ADVANCED_GOAL_RUN_STATUSES], [...IN_FLIGHT_ACTION_STATUSES]],
    );
    return result.rowCount ?? 0;
  } finally {
    client.release();
  }
}

/** Cancelled runs with `cleanup_pending` looked at per sweep. */
export const DEFAULT_GOAL_CLEANUP_BATCH = 20;

/**
 * The cleanup sweep (§3.4 `cleanup_pending`, S11 GO3a): a run whose cancel deadline passed with
 * Tasks or executing requests left was `cancelled` with `cleanup_pending` (`cancelling.ts`). For
 * each such run, in the requester's workspace context and under the GoalRun lock: when nothing is
 * left, the flag is cleared (`goal_run.cleanup_finished`, with a `GoalRunUpdated` so a page showing
 * the leftovers refreshes); otherwise its live Tasks are terminated again after the commit.
 * Executing requests need nothing from here: the R-48 reaper ends them. Returns how many runs had
 * their flag cleared.
 */
export async function sweepGoalCancelCleanup(
  deps: GoalAdvanceDeps,
  options: { readonly limit?: number } = {},
): Promise<number> {
  const client = await deps.pool.connect();
  let targets: readonly GoalAdvanceTarget[];
  try {
    const result = await client.query<{ workspace_id: string; id: string; on_behalf_of: string }>(
      `select workspace_id, id, on_behalf_of from goal_runs
        where status = 'cancelled' and cleanup_pending
        order by updated_at, id
        limit $1`,
      [options.limit ?? DEFAULT_GOAL_CLEANUP_BATCH],
    );
    targets = result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      goalRunId: row.id,
      requesterId: row.on_behalf_of,
    }));
  } finally {
    client.release();
  }
  let cleared = 0;
  for (const target of targets) {
    try {
      const swept = await withWorkspace(
        deps.pool,
        { workspaceId: target.workspaceId, principalId: target.requesterId },
        async (tx) => {
          const goal = await lockGoalRun(tx, target.workspaceId, target.goalRunId);
          if (!goal || goal.status !== 'cancelled' || !goal.cleanupPending) {
            return { liveTaskIds: [], cleared: false };
          }
          const leftovers = await readCancelLeftovers(tx, goal);
          if (leftovers.liveTaskIds.length > 0 || leftovers.executingActions.length > 0) {
            return { liveTaskIds: leftovers.liveTaskIds, cleared: false };
          }
          await tx.query(
            `update goal_runs set cleanup_pending = false
              where workspace_id = $1 and id = $2 and status = 'cancelled' and cleanup_pending`,
            [goal.workspaceId, goal.id],
          );
          // Not a transition (the status stays `cancelled`); recorded the same way so the audit
          // log and the event stream say the leftovers are gone.
          await recordGoalRunTransition(tx, goal.workspaceId, {
            actorPrincipalId: goal.onBehalfOf,
            action: 'goal_run.cleanup_finished',
            goalRunId: goal.id,
            resultingStatus: 'cancelled',
            extraAuditPayload: { by: 'advancer' },
          });
          return { liveTaskIds: [], cleared: true };
        },
      );
      if (swept.cleared) cleared += 1;
      for (const taskId of swept.liveTaskIds) {
        await terminateTaskWith(deps.taskRuntime, target.workspaceId, target.requesterId, taskId);
      }
    } catch (err) {
      deps.onStartError?.(err);
    }
  }
  return cleared;
}

type GoalWakeEventType = 'TaskUpdated' | 'ActionRequestUpdated';

/** The slice of the outbox dispatcher the wake consumer needs (generic, like
 *  `application/task/reaper.ts`'s `ActionRequestEventSource`, so a real `OutboxDispatcher` is
 *  assignable to it). */
export interface GoalWakeEventSource {
  subscribe<T extends GoalWakeEventType>(
    eventType: T,
    consumer: (event: Extract<DomainEvent, { type: T }>) => Promise<void> | void,
  ): () => void;
}

/** Sets a GoalRun due unless it already is, or is not advanced. */
async function markGoalRunDue(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<void> {
  await client.query(
    `update goal_runs set next_tick_at = now()
      where workspace_id = $1 and id = $2 and status = any($3::text[])
        and (next_tick_at is null or next_tick_at > now())`,
    [workspaceId, goalRunId, [...ADVANCED_GOAL_RUN_STATUSES]],
  );
}

async function goalRunOfStep(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
): Promise<string | null> {
  const result = await client.query<{ goal_run_id: string }>(
    'select goal_run_id from step_runs where workspace_id = $1 and id = $2',
    [workspaceId, stepRunId],
  );
  return result.rows[0]?.goal_run_id ?? null;
}

/** Registers the wake consumer — see the module doc comment. Returns the unsubscribe. */
export function registerGoalWakeConsumer(
  source: GoalWakeEventSource,
  pool: PoolLike,
  onError: (error: unknown) => void = () => {},
): () => void {
  const wake = async (
    workspaceId: string,
    findGoalRun: (client: PoolClient) => Promise<string | null>,
  ): Promise<void> => {
    try {
      await withWorkspace(
        pool,
        { workspaceId, principalId: SYSTEM_ACTOR_PLACEHOLDER },
        async (client) => {
          // An advance holds the row while it runs; wait for it (the wake then lands after it),
          // but not without bound — the reconcile scan covers a wake that gave up.
          await client.query("set local lock_timeout = '5s'");
          const goalRunId = await findGoalRun(client);
          if (goalRunId) await markGoalRunDue(client, workspaceId, goalRunId);
        },
        { skipRoleSwitch: true },
      );
    } catch (err) {
      onError(err);
    }
  };

  const offTask = source.subscribe('TaskUpdated', async (event) => {
    if (!FINISHED_TASK_STATUSES.has(event.status)) return;
    await wake(
      event.workspaceId,
      async (client) =>
        (await readTaskGoalStep(client, event.workspaceId, event.taskId))?.goalRunId ?? null,
    );
  });
  const offAction = source.subscribe('ActionRequestUpdated', async (event) => {
    if (IN_FLIGHT_ACTION_STATUS_SET.has(event.status)) return;
    await wake(event.workspaceId, async (client) => {
      const actionRequest = await getActionRequest(
        client,
        event.workspaceId,
        event.actionRequestId,
      );
      if (!actionRequest?.stepRunId) return null;
      return goalRunOfStep(client, event.workspaceId, actionRequest.stepRunId);
    });
  });
  return () => {
    offTask();
    offAction();
  };
}
