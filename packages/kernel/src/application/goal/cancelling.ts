import type { GoalRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type ExecutingStepAction,
  listExecutingStepActions,
  withdrawStepActions,
} from '../../governance/approval/index.js';
import { listGoalRunLiveTasks } from '../task/index.js';
import { moveGoalRun } from './moves.js';
import { listStepRuns } from './reads.js';
import type { GoalRunRow } from './types.js';

/**
 * application/goal/cancelling (S11 GO3a; plan §3.4, §4.8, I-G9): the advance of a `cancelling`
 * GoalRun. The cancel itself (`control.ts`) already cancelled every live step and withdrew their
 * requests that had not run, in one transaction; what is left is waiting for what cannot be taken
 * back:
 *
 *   - the run's live Tasks — step attempts and nested child Tasks alike. Each advance hands them
 *     to the advancer to terminate after its commit (`terminateTaskWith`: the Task `cancelled`,
 *     its WorkerRuns terminated, their Handles revoked); terminating an ended Task is a no-op.
 *   - its requests still `executing` — started before the cancel, so never withdrawn (the
 *     transition table and governance/0021 refuse it). They end the R-48 way: the gate answers,
 *     or the stale-executing reaper replays them under the same id; their result is audited like
 *     any other.
 *
 * When neither is left the run is `cancelled`. Past {@link CancellingOptions.cancelDeadlineMs}
 * from entering `cancelling` (`updated_at`: only transitions write it) it is `cancelled` with
 * `cleanup_pending` and the leftovers listed in the audit payload; the advancer's cleanup sweep
 * (`advancer.ts`) keeps terminating its Tasks and clears the flag once nothing is left.
 *
 * Each advance also withdraws again whatever of the run's steps is still withdrawable. The cancel
 * left nothing, and I-G9's entry check keeps a closed step from raising anything new, so this
 * finds nothing — a backstop that costs one indexed read.
 *
 * A step of a cancelling run never starts or resumes (goal/0003's step guard): an action still
 * executing finishes on its own row, and resuming the step would be new work under a goal that is
 * being cancelled.
 */

/** How long a cancelling GoalRun waits for its Tasks and executing actions to end before it is
 *  `cancelled(cleanup_pending)` with them listed (§3.4). Longer than the R-48 reaper takes to give
 *  up on an action whose outcome is unknown, so a gate that answers late still ends it cleanly. */
export const DEFAULT_CANCEL_DEADLINE_MS = 30 * 60 * 1000;

/** How often a cancelling GoalRun looks again when no event has woken it. */
export const DEFAULT_CANCEL_RECHECK_MS = 60 * 1000;

/** Why a cancelled run's requests were withdrawn — in each withdrawal's audit payload. */
export const GOAL_CANCELLED_WITHDRAW_REASON = 'its goal run was cancelled';

export interface CancellingOptions {
  readonly cancelDeadlineMs?: number;
  readonly cancelRecheckMs?: number;
}

export interface CancellingAdvance {
  readonly status: GoalRunStatus;
  /** Live Tasks for the advancer to terminate after the commit. */
  readonly terminatedTaskIds: readonly string[];
  readonly nextTickAt: Date | null;
}

/** What a cancelled run still has running. */
export interface CancelLeftovers {
  readonly liveTaskIds: readonly string[];
  readonly executingActions: readonly ExecutingStepAction[];
}

/** The live Tasks and executing requests of a GoalRun — what its cancel waits for. */
export async function readCancelLeftovers(
  client: PoolClient,
  goal: Pick<GoalRunRow, 'workspaceId' | 'id'>,
): Promise<CancelLeftovers & { readonly stepRunIds: readonly string[] }> {
  const stepRunIds = (await listStepRuns(client, goal.workspaceId, goal.id)).map((s) => s.id);
  return {
    stepRunIds,
    liveTaskIds: await listGoalRunLiveTasks(client, goal.workspaceId, goal.id),
    executingActions: await listExecutingStepActions(client, goal.workspaceId, stepRunIds),
  };
}

/** One advance of a `cancelling` GoalRun, under its lock — see the module doc comment. */
export async function advanceCancellingGoalRun(
  client: PoolClient,
  goal: GoalRunRow,
  now: Date,
  options: CancellingOptions,
): Promise<CancellingAdvance> {
  const actor = { principalId: goal.onBehalfOf, by: 'advancer' } as const;
  const leftovers = await readCancelLeftovers(client, goal);
  await withdrawStepActions(client, goal.workspaceId, leftovers.stepRunIds, {
    actorPrincipalId: goal.onBehalfOf,
    reason: GOAL_CANCELLED_WITHDRAW_REASON,
  });
  const { liveTaskIds, executingActions } = leftovers;
  if (liveTaskIds.length === 0 && executingActions.length === 0) {
    const status = await moveGoalRun(client, actor, goal, 'cancelling', 'finish_cancel');
    return { status, terminatedTaskIds: [], nextTickAt: null };
  }
  const deadline =
    goal.updatedAt.getTime() + (options.cancelDeadlineMs ?? DEFAULT_CANCEL_DEADLINE_MS);
  if (now.getTime() >= deadline) {
    const status = await moveGoalRun(client, actor, goal, 'cancelling', 'finish_cancel', {
      cleanupPending: true,
      audit: { liveTaskIds, executingActions },
    });
    return { status, terminatedTaskIds: liveTaskIds, nextTickAt: null };
  }
  const recheck = now.getTime() + (options.cancelRecheckMs ?? DEFAULT_CANCEL_RECHECK_MS);
  return {
    status: 'cancelling',
    terminatedTaskIds: liveTaskIds,
    nextTickAt: new Date(Math.min(deadline, recheck)),
  };
}
