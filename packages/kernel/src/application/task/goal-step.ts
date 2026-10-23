import type { TaskStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { writeAudit } from '../../substrate/audit/index.js';
import { type RejectedOutput, parseRejectedOutput } from './output-contract.js';
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
const ENDED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

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
  /** S11 GO5d-1: the last report its output contract refused (`output-contract.ts`). */
  readonly rejectedOutput: RejectedOutput | null;
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
    rejected_output: unknown;
  }>(
    `select id, status, failure_reason, run_config_snapshot, rejected_output from tasks
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
    rejectedOutput: parseRejectedOutput(row.rejected_output),
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
  return (
    (await readGoalRunsUsage(client, workspaceId, [goalRunId])).get(goalRunId) ?? {
      tokens: 0,
      steps: 0,
    }
  );
}

/** {@link readGoalRunUsage} of several GoalRuns in one query (S11 GO5a: a page of `list_goals`). A
 *  run with no Task yet is absent from the map. */
export async function readGoalRunsUsage(
  client: PoolClient,
  workspaceId: string,
  goalRunIds: readonly string[],
): Promise<ReadonlyMap<string, GoalRunUsage>> {
  if (goalRunIds.length === 0) return new Map();
  const result = await client.query<{ goal_run_id: string; tokens: string; steps: string }>(
    `select goal_run_id,
            coalesce(sum(tokens_used), 0)::bigint as tokens,
            count(*) filter (where step_attempt is not null)::bigint as steps
       from tasks
      where workspace_id = $1 and goal_run_id = any($2::uuid[])
      group by goal_run_id`,
    [workspaceId, [...goalRunIds]],
  );
  return new Map(
    result.rows.map((row) => [
      row.goal_run_id,
      { tokens: Number(row.tokens), steps: Number(row.steps) },
    ]),
  );
}

/** One attempt of a step of a GoalRun: the Task the advancer started for it (S11 GO5a, `get_goal`). */
export interface GoalStepAttempt {
  readonly stepRunId: string;
  readonly attempt: number;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly createdAt: Date;
  /** S11 GO5d-1: why the attempt's Task failed, whether it redoes an earlier attempt, the last
   *  report its output contract refused, and the output its accepted result carried (`null`
   *  without one). */
  readonly failureReason: string | null;
  readonly rework: boolean;
  readonly rejectedOutput: RejectedOutput | null;
  readonly output: Record<string, unknown> | null;
}

/** Every step attempt of `goalRunId` — the Tasks with a `step_attempt`, not their nested child
 *  Tasks — by step, then attempt. */
export async function listGoalRunStepAttempts(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly GoalStepAttempt[]> {
  const result = await client.query<{
    step_run_id: string;
    step_attempt: number;
    id: string;
    status: TaskStatus;
    created_at: Date;
    failure_reason: string | null;
    rework: boolean;
    rejected_output: unknown;
    output: unknown;
  }>(
    `select step_run_id, step_attempt, id, status, created_at, failure_reason,
            rework_of is not null as rework, rejected_output,
            case when status = 'completed' then result -> 'output' end as output
       from tasks
      where workspace_id = $1 and goal_run_id = $2 and step_attempt is not null
      order by step_run_id, step_attempt`,
    [workspaceId, goalRunId],
  );
  return result.rows.map((row) => ({
    stepRunId: row.step_run_id,
    attempt: row.step_attempt,
    taskId: row.id,
    status: row.status,
    createdAt: row.created_at,
    failureReason: row.failure_reason,
    rework: row.rework,
    rejectedOutput: parseRejectedOutput(row.rejected_output),
    output:
      row.output !== null && typeof row.output === 'object' && !Array.isArray(row.output)
        ? (row.output as Record<string, unknown>)
        : null,
  }));
}

/**
 * S11 GO3a (I-G6, #619 deviation 6): how many tokens of its budget a GoalRun can still hand to a
 * new Task. Every Task of the run holds what it may spend: a finished Task what it used, a live one
 * the larger of its budget and what it used (a live Task with no budget, only what it used). The
 * headroom is the budget less all of that, never below zero.
 *
 * New Tasks of the run take their budget out of it — the attempts one advance starts split it, and
 * a nested child Task of a step draws on it before its caller's unspent budget
 * ({@link allotChildTokenBudget}) — so the live Tasks' budgets together never exceed what is left
 * of the goal's. A live Task's unspent budget comes back when it ends.
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

/** What a nested child Task of a goal step may spend, and what its caller's Task gives up for it
 *  ({@link allotChildTokenBudget}). */
export interface ChildTokenBudget {
  readonly tokenBudget: number;
  /** The part of `tokenBudget` the goal's free headroom could not cover: taken out of the caller
   *  Task's own unspent budget by {@link takeChildBudgetFromCaller}. */
  readonly fromCaller: number;
}

/**
 * S11 GO3a (I-G6; review #493 P2-1 on #626): the token budget of a nested child Task that a goal
 * step's Worker invokes, or `null` when the goal has nothing left to give it. A step's attempt
 * holds its share of the goal (with one ready step, all of it), so the child draws first on the
 * goal's free headroom ({@link readGoalRunTokenHeadroom}) and then on what its caller's Task has
 * not spent — at most half of that: the caller still has to read the child's result and finish,
 * and an even split is the rule the advance uses between the attempts it starts. The caller is
 * the invoking Worker's Task (a step attempt, or a child one level down — the same rule at every
 * depth). The workspace's per-Task default still caps the result.
 *
 * Takes the caller Task's row lock (`for no key update`) before reading the headroom, so what it
 * has spent cannot change underneath (the usage hook updates the same row). Lock order: the
 * StepRun's share lock, then the quota lock, then this — `invoke.ts`'s order; the advance takes
 * no existing Task's lock. An ended caller holds only what it used: it gives nothing.
 */
export async function allotChildTokenBudget(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly goalRunId: string;
    readonly callerTaskId: string;
    readonly defaultTokenBudget: number | null;
  },
): Promise<ChildTokenBudget | null> {
  const caller = await client.query<{
    status: TaskStatus;
    token_budget: string | null;
    tokens_used: string;
  }>(
    `select status, token_budget, tokens_used from tasks
      where workspace_id = $1 and id = $2
      for no key update`,
    [workspaceId, input.callerTaskId],
  );
  const row = caller.rows[0];
  const unspent =
    row && row.token_budget !== null && !ENDED_TASK_STATUSES.has(row.status)
      ? Math.max(0, Number(row.token_budget) - Number(row.tokens_used))
      : 0;
  const free = await readGoalRunTokenHeadroom(client, workspaceId, input.goalRunId);
  const cap = free + Math.floor(unspent / 2);
  if (cap < 1) return null;
  const tokenBudget =
    input.defaultTokenBudget === null ? cap : Math.min(input.defaultTokenBudget, cap);
  return { tokenBudget, fromCaller: Math.max(0, tokenBudget - free) };
}

/**
 * Lowers the caller Task's budget by what {@link allotChildTokenBudget} took from it for
 * `childTaskId`, in the transaction that inserted the child (still holding the caller's row lock),
 * and audits it on the caller (`task.budget_handed_down`). The usage hook reads the row's budget on
 * every record, so the lower budget applies to the caller's next model call.
 */
export async function takeChildBudgetFromCaller(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly callerTaskId: string;
    readonly childTaskId: string;
    readonly tokens: number;
    readonly actorPrincipalId: string;
  },
): Promise<void> {
  if (input.tokens < 1) return;
  const result = await client.query<{ token_budget: string }>(
    `update tasks set token_budget = token_budget - $3
      where workspace_id = $1 and id = $2 and token_budget >= $3
      returning token_budget`,
    [workspaceId, input.callerTaskId, input.tokens],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`task ${input.callerTaskId} cannot give ${input.tokens} tokens`);
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actorPrincipalId,
    action: 'task.budget_handed_down',
    resourceType: 'task',
    resourceId: input.callerTaskId,
    payload: {
      childTaskId: input.childTaskId,
      tokens: input.tokens,
      tokenBudget: Number(row.token_budget),
    },
  });
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

/** The Tasks of one step that have not ended — its attempt and the nested child Tasks started under
 *  it (they carry the step's `step_run_id`, `invoke.ts`), oldest first. S11 GO3b: a step is judged,
 *  retried or let go only once nothing of it still runs (plan §4.5, §4.8). Reads by the GoalRun's
 *  index (`tasks_goal_run_idx`): a nested child Task has no `step_attempt`. */
export async function listStepLiveTasks(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  stepRunId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `select id from tasks
     where workspace_id = $1 and goal_run_id = $2 and step_run_id = $3
       and status not in ('completed', 'failed', 'cancelled')
     order by created_at, id`,
    [workspaceId, goalRunId, stepRunId],
  );
  return result.rows.map((row) => row.id);
}

/** A live Task of a GoalRun and the step it runs for. */
export interface LiveGoalTask {
  readonly taskId: string;
  readonly stepRunId: string;
}

/** {@link listGoalRunLiveTasks} with each Task's step — one read for an advance that asks, step by
 *  step, whether anything of a step still runs (S11 GO3b). */
export async function listGoalRunLiveTaskSteps(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly LiveGoalTask[]> {
  const result = await client.query<{ id: string; step_run_id: string }>(
    `select id, step_run_id from tasks
     where workspace_id = $1 and goal_run_id = $2
       and status not in ('completed', 'failed', 'cancelled')
     order by created_at, id`,
    [workspaceId, goalRunId],
  );
  return result.rows.map((row) => ({ taskId: row.id, stepRunId: row.step_run_id }));
}
