import type { TaskStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { GoalStepClosedError } from './types.js';

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

/** The StepRun statuses that take new work for the step (I-G9): its attempt is running, or it
 *  waits on its actions. */
const STEP_STATUSES_TAKING_WORK: ReadonlySet<string> = new Set(['running', 'waiting']);

/**
 * S11 GO3a (plan I-G9, §4.8): the entry check for new work under a goal step — `request_action`
 * and a nested `invoke_worker` from a Worker whose Task runs for `stepRunId`. Locks the StepRun
 * `for share` and refuses ({@link GoalStepClosedError}) unless it is `running` or `waiting`.
 *
 * Cancelling a GoalRun (or, GO3b, superseding a step) cancels the step and withdraws its pending
 * and approved actions in one transaction, under a `for no key update` lock on the StepRun. The
 * share lock here conflicts with that one, so the two serialize: new work either commits first —
 * and its ActionRequest or Task is there for the cancel to withdraw or terminate — or finds the
 * step closed. A step that ended for another reason (succeeded, failed awaiting a retry) takes no
 * new work either: its attempt's Task is over.
 */
export async function lockGoalStepForNewWork(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
  work: 'request_action' | 'invoke_worker',
): Promise<void> {
  const result = await client.query<{ status: string }>(
    'select status from step_runs where workspace_id = $1 and id = $2 for share',
    [workspaceId, stepRunId],
  );
  const status = result.rows[0]?.status ?? 'missing';
  if (!STEP_STATUSES_TAKING_WORK.has(status)) {
    throw new GoalStepClosedError(stepRunId, status, work);
  }
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

/**
 * S11 GO3a (I-G6, #619 deviation 6): how many tokens of its budget a GoalRun can still hand to a
 * new Task. Every Task of the run holds what it may spend: a finished Task what it used, a live one
 * the larger of its budget and what it used (a live Task with no budget, only what it used). The
 * headroom is the budget less all of that, never below zero.
 *
 * New Tasks of the run take their budget out of it — the attempts one advance starts split it, and
 * a nested child Task of a step is capped by it — so the live Tasks' budgets together never exceed
 * what is left of the goal's. A live Task's unspent budget comes back when it ends.
 */
export async function readGoalRunTokenHeadroom(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<number> {
  const result = await client.query<{ headroom: string }>(
    `select greatest(0, g.budget_max_tokens - coalesce((
              select sum(case when t.status in ('completed', 'failed', 'cancelled') then t.tokens_used
                              else greatest(t.tokens_used, coalesce(t.token_budget, 0)) end)
                from tasks t
               where t.workspace_id = g.workspace_id and t.goal_run_id = g.id), 0))::bigint as headroom
       from goal_runs g
      where g.workspace_id = $1 and g.id = $2`,
    [workspaceId, goalRunId],
  );
  return Number(result.rows[0]?.headroom ?? 0);
}

/** The Tasks of a GoalRun that have not ended — step attempts and nested child Tasks alike — oldest
 *  first. What a cancelling GoalRun terminates and waits for (S11 GO3a, plan §4.8). */
export async function listGoalRunLiveTasks(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `select id from tasks
     where workspace_id = $1 and goal_run_id = $2
       and status not in ('completed', 'failed', 'cancelled')
     order by created_at, id`,
    [workspaceId, goalRunId],
  );
  return result.rows.map((row) => row.id);
}
