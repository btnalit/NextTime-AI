import type { TaskStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

/**
 * application/task/goal-step (S11 GO1, migrations/task/0007_task_goal_step.sql): which GoalRun,
 * StepRun and plan revision a Task runs for. Written once when the Task is created — by the
 * advancer for a step's own attempt (GO2), by `invoke_worker` for a nested child Task, which
 * inherits its caller's (`invoke.ts`) — and never changed (a DB trigger).
 *
 * An attempt Task is carried by a WorkerRun like every other Task (`step-attempt.ts` inserts it
 * `queued` and starts it through `spawnWorkerRun`), so the reaper's `spawn_lost` / `run_lost`
 * sweeps apply to it unchanged (legacy 325).
 */
export interface TaskGoalStep {
  readonly goalRunId: string;
  readonly stepRunId: string;
  readonly planRevision: number;
}

/** The goal step `taskId` runs for, or `null` for a Task outside a goal (or no such Task). */
export async function readTaskGoalStep(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<TaskGoalStep | null> {
  const result = await client.query<{
    goal_run_id: string | null;
    step_run_id: string | null;
    plan_revision: number | null;
  }>(
    'select goal_run_id, step_run_id, plan_revision from tasks where workspace_id = $1 and id = $2',
    [workspaceId, taskId],
  );
  const row = result.rows[0];
  if (!row || row.goal_run_id === null || row.step_run_id === null || row.plan_revision === null) {
    return null;
  }
  return {
    goalRunId: row.goal_run_id,
    stepRunId: row.step_run_id,
    planRevision: row.plan_revision,
  };
}

/**
 * S11 GO2 (plan §4.4): what a step attempt ran with, recorded on its Task (`run_config_snapshot`,
 * immutable — task/0007) by the advancer (`step-attempt.ts`). The first attempt of a step resolves
 * it; every later attempt starts from the previous attempt's snapshot — the same WorkerDefinition
 * version and the same Skill versions, which must still be published, or the attempt does not
 * start. What is re-read for every attempt: the Handle (the requester's authority now, I-G7), the
 * platform's instance instructions (platform policy is always current; only their digest is kept)
 * and the attempt's budget (what is left of the goal's).
 *
 * Never credentials: ids, versions, a model id, an image reference, a digest, capability names and
 * gatekeeper ids.
 */
export const RunConfigSnapshotSchema = z
  .object({
    v: z.literal(1),
    definition: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
    skills: z.array(
      z.object({ skillId: z.string(), version: z.number().int().positive() }).strict(),
    ),
    model: z.string().nullable(),
    image: z.string().nullable(),
    systemPromptDigest: z.string().nullable(),
    handle: z
      .object({ capabilities: z.array(z.string()), gatekeepers: z.array(z.string()) })
      .strict(),
    budget: z
      .object({
        tokenBudget: z.number().int().positive().nullable(),
        durationLimitSec: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type RunConfigSnapshot = z.infer<typeof RunConfigSnapshotSchema>;

/** One attempt Task of a step, as the advancer judges the attempt by. */
export interface StepAttemptTask {
  readonly id: string;
  readonly status: TaskStatus;
  readonly failureReason: string | null;
  /** `null` when the stored snapshot does not parse — a later attempt then cannot start from it. */
  readonly runConfig: RunConfigSnapshot | null;
}

/** The Task of attempt `attempt` of `stepRunId`, or `null` (I-G1: at most one). */
export async function readStepAttemptTask(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
  attempt: number,
): Promise<StepAttemptTask | null> {
  const result = await client.query<{
    id: string;
    status: TaskStatus;
    failure_reason: string | null;
    run_config_snapshot: unknown;
  }>(
    `select id, status, failure_reason, run_config_snapshot from tasks
     where workspace_id = $1 and step_run_id = $2 and step_attempt = $3`,
    [workspaceId, stepRunId, attempt],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parsed = RunConfigSnapshotSchema.safeParse(row.run_config_snapshot);
  return {
    id: row.id,
    status: row.status,
    failureReason: row.failure_reason,
    runConfig: parsed.success ? parsed.data : null,
  };
}

/** The ids of `taskId`'s WorkerRuns and of every WorkerRun descended from them
 *  (`worker_runs.parent_worker_run_id`) — the runs that act for the Task, nested children included.
 *  The advancer judges an attempt by the ActionRequests these runs raised. */
export async function listTaskWorkerRunTree(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `with recursive tree as (
       select id from worker_runs where workspace_id = $1 and task_id = $2
       union
       select wr.id from worker_runs wr
         join tree on wr.parent_worker_run_id = tree.id
        where wr.workspace_id = $1
     )
     select id from tree`,
    [workspaceId, taskId],
  );
  return result.rows.map((row) => row.id);
}

/** A GoalRun's usage as I-G6 counts it: tokens are the sum of its Tasks' `tokens_used` (nested
 *  child Tasks included), steps the attempts the advancer started (Tasks with a `step_attempt`). */
export interface GoalRunUsage {
  readonly tokens: number;
  readonly steps: number;
}

export async function readGoalRunUsage(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<GoalRunUsage> {
  const result = await client.query<{ tokens: string; steps: string }>(
    `select coalesce(sum(tokens_used), 0)::bigint as tokens,
            count(*) filter (where step_attempt is not null)::bigint as steps
       from tasks
      where workspace_id = $1 and goal_run_id = $2`,
    [workspaceId, goalRunId],
  );
  const row = result.rows[0];
  return { tokens: Number(row?.tokens ?? 0), steps: Number(row?.steps ?? 0) };
}
