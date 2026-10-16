import type { PoolClient } from 'pg';

/**
 * application/task/goal-step (S11 GO1, migrations/task/0007_task_goal_step.sql): which GoalRun,
 * StepRun and plan revision a Task runs for. Written once when the Task is created — by the
 * advancer for a step's own attempt (GO2), by `invoke_worker` for a nested child Task, which
 * inherits its caller's (`invoke.ts`) — and never changed (a DB trigger).
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
