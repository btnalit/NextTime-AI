import type { StepFilesState } from '@nexttime/shared';
import type { PoolLike } from '../../adapters/db/pool.js';
import {
  TASK_DIRS_KEEP_BATCH,
  type TaskDirsKeepInput,
} from '../../adapters/supervisor-client/index.js';
import type { StepFilesPort } from './step-files.js';

/**
 * application/goal/files-keep (S11 GO14 I-F5, F3-A; s11-w2/go14-default-plan.md
 * §2.2): the retention lease on the files of goals that have not ended. While a GoalRun is
 * `running`, `paused` or `verifying`, the Task directories of the accepted attempt of each of its
 * live, succeeded StepRuns are renewed (`POST /task-dirs/keep`, the worker-supervisor touches a
 * `kept` one's directories) so its retention sweep (`TASK_WORKDIR_RETENTION_HOURS`, at least 2)
 * does not remove them while a later step — one the plan has now, or one a revision adds — may
 * still read them. Once the run ends nothing renews them, and they go after one retention period.
 *
 * Every succeeded step's directory, not only the ones a `filesFrom` names now (F3-A; F3-B, renewing
 * only those, is a STATUS legacy item): a step a revision adds can read a step that ended long ago.
 *
 * A raw cross-workspace read on a pooled connection with no workspace context — the posture of
 * the goal advancer's claim, the task reaper's scans and the invariant monitors — that writes
 * nothing. What the supervisor answers goes to the log and the tick's result, never to the
 * database: a directory found `missing` or `not_owned` here is the advancer's to act on if a step
 * comes to read it (`step-files.ts`), with the reader's own run.
 */

/** How often the composition root runs {@link runGoalFilesKeepTick}: well inside the shortest
 *  retention the supervisor accepts (two hours). */
export const DEFAULT_GOAL_FILES_KEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface GoalFilesKeepTickResult {
  /** Task directories asked about. */
  readonly tasks: number;
  readonly byState: Readonly<Partial<Record<StepFilesState, number>>>;
  /** The Tasks whose directories are not marked as their own goal run's — a kernel defect or a
   *  hand on the host's directories; logged as errors. */
  readonly notOwned: readonly string[];
}

/** The Tasks the lease renews — see the module comment. */
export async function listGoalFilesToKeep(pool: PoolLike): Promise<readonly TaskDirsKeepInput[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      task_id: string;
      workspace_id: string;
      goal_run_id: string;
    }>(
      `select t.id as task_id, g.workspace_id, g.id as goal_run_id
         from goal_runs g
         join step_runs s on s.workspace_id = g.workspace_id and s.goal_run_id = g.id
         join tasks t on t.workspace_id = s.workspace_id and t.step_run_id = s.id
                     and t.step_attempt = s.attempt_count
        where g.status in ('running', 'paused', 'verifying')
          and s.status = 'succeeded'
          and t.status = 'completed'
        order by g.workspace_id, g.id, t.id`,
    );
    return result.rows.map((row) => ({
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      goalRunId: row.goal_run_id,
    }));
  } finally {
    client.release();
  }
}

/** One renewal of every directory {@link listGoalFilesToKeep} names, in batches of
 *  {@link TASK_DIRS_KEEP_BATCH}. A batch the supervisor cannot take is reported to `onError` and
 *  the rest still go; the next tick asks again. */
export async function runGoalFilesKeepTick(
  deps: { readonly pool: PoolLike; readonly supervisorClient: StepFilesPort },
  options: { readonly onError?: (error: unknown) => void; readonly batch?: number } = {},
): Promise<GoalFilesKeepTickResult> {
  const client = deps.supervisorClient;
  if (!client.keepTaskDirs) return { tasks: 0, byState: {}, notOwned: [] };
  const tasks = await listGoalFilesToKeep(deps.pool);
  const byState: Partial<Record<StepFilesState, number>> = {};
  const notOwned: string[] = [];
  const size = Math.max(1, Math.min(options.batch ?? TASK_DIRS_KEEP_BATCH, TASK_DIRS_KEEP_BATCH));
  for (let at = 0; at < tasks.length; at += size) {
    try {
      const answers = await client.keepTaskDirs(tasks.slice(at, at + size));
      for (const answer of answers) {
        byState[answer.state] = (byState[answer.state] ?? 0) + 1;
        if (answer.state === 'not_owned') notOwned.push(answer.taskId);
      }
    } catch (err) {
      options.onError?.(err);
    }
  }
  return { tasks: tasks.length, byState, notOwned };
}
