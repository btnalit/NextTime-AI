import type { PoolClient } from 'pg';
import { listStepActionOutcomes } from '../../governance/approval/index.js';
import { type StepActionEffect, stepActionEffect } from './disposition.js';
import {
  GOAL_RUN_ROW_COLUMNS,
  type GoalRunDbRow,
  type GoalRunRow,
  PLAN_REVISION_ROW_COLUMNS,
  type PlanRevisionDbRow,
  type PlanRevisionRow,
  STEP_RUN_ROW_COLUMNS,
  type StepRunDbRow,
  type StepRunRow,
  mapGoalRunRow,
  mapPlanRevisionRow,
  mapStepRunRow,
} from './types.js';

/** application/goal/reads (S11 GO1): reads of this module's own tables, workspace-scoped. */

export async function getGoalRun(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<GoalRunRow | null> {
  const result = await client.query<GoalRunDbRow>(
    `select ${GOAL_RUN_ROW_COLUMNS} from goal_runs where workspace_id = $1 and id = $2`,
    [workspaceId, goalRunId],
  );
  const row = result.rows[0];
  return row ? mapGoalRunRow(row) : null;
}

export async function getPlanRevision(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  revision: number,
): Promise<PlanRevisionRow | null> {
  const result = await client.query<PlanRevisionDbRow>(
    `select ${PLAN_REVISION_ROW_COLUMNS} from plan_revisions
     where workspace_id = $1 and goal_run_id = $2 and revision = $3`,
    [workspaceId, goalRunId, revision],
  );
  const row = result.rows[0];
  return row ? mapPlanRevisionRow(row) : null;
}

/** Every StepRun of a GoalRun, superseded ones included, in creation order. */
export async function listStepRuns(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly StepRunRow[]> {
  const result = await client.query<StepRunDbRow>(
    `select ${STEP_RUN_ROW_COLUMNS} from step_runs
     where workspace_id = $1 and goal_run_id = $2
     order by created_at, id`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapStepRunRow);
}

/** One StepRun, unlocked (a read for display: `application/linkage` naming a step); `null` when
 *  there is none. */
export async function getStepRun(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
): Promise<StepRunRow | null> {
  const result = await client.query<StepRunDbRow>(
    `select ${STEP_RUN_ROW_COLUMNS} from step_runs where workspace_id = $1 and id = $2`,
    [workspaceId, stepRunId],
  );
  const row = result.rows[0];
  return row ? mapStepRunRow(row) : null;
}

/** {@link listStepRuns}, each row locked `for no key update` — after the GoalRun's row (lock order:
 *  GoalRun, then its StepRuns, the order the guards take too). */
export async function lockStepRuns(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly StepRunRow[]> {
  const result = await client.query<StepRunDbRow>(
    `select ${STEP_RUN_ROW_COLUMNS} from step_runs
     where workspace_id = $1 and goal_run_id = $2
     order by created_at, id
     for no key update`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapStepRunRow);
}

/** One StepRun, locked `for no key update` — after its GoalRun's row; `null` when there is none. */
export async function lockStepRun(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
): Promise<StepRunRow | null> {
  const result = await client.query<StepRunDbRow>(
    `select ${STEP_RUN_ROW_COLUMNS} from step_runs
     where workspace_id = $1 and id = $2
     for no key update`,
    [workspaceId, stepRunId],
  );
  const row = result.rows[0];
  return row ? mapStepRunRow(row) : null;
}

/** What a step's ActionRequests call for (`disposition.ts`), read from their `status` and
 *  `failure_kind` columns through `governance/approval` — the advancer's one way to split a step on
 *  its actions (plan §4.7). */
export async function readStepActionEffect(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
): Promise<StepActionEffect> {
  return stepActionEffect(await listStepActionOutcomes(client, workspaceId, stepRunId));
}

/** Every revision of a GoalRun's plan, oldest first. */
export async function listPlanRevisions(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly PlanRevisionRow[]> {
  const result = await client.query<PlanRevisionDbRow>(
    `select ${PLAN_REVISION_ROW_COLUMNS} from plan_revisions
     where workspace_id = $1 and goal_run_id = $2
     order by revision`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapPlanRevisionRow);
}
