import type { PoolClient } from 'pg';
import { type RefusedOnlyUsage, sessionRefusedOnly } from '../../governance/llm-usage/index.js';
import { failTaskRow, readTaskRow, terminateWorkerRunRow } from './lifecycle.js';
import type { TaskRow } from './types.js';

/**
 * Legacy 589: a Task whose Worker's model never answered fails `model_refused` instead of
 * completing.
 *
 * When llm-proxy refuses every model call of a Worker because the workspace's daily budget is
 * spent (402 `budget_exhausted`), the model never produces a word, so it never calls
 * `report_result`; worker mode's `agent_settled` fallback still posts a contract it synthesized
 * from nothing. Completing the Task with that contract made an evaluation trial score an empty
 * answer as `failed` and a goal step judge it. The report path asks the usage the Worker's session
 * metered first (`sessionRefusedOnly`, migrations/llm-usage/0003): refused calls and no answered
 * one means the result is not the Worker's — the Task fails `model_refused` (a platform failure,
 * `skill-stats.ts`) and nothing of the report is stored.
 */
export async function workerModelRefusal(
  client: PoolClient,
  workspaceId: string,
  sessionId: string,
): Promise<RefusedOnlyUsage | null> {
  return sessionRefusedOnly(client, workspaceId, sessionId);
}

/**
 * Fails `taskId` `model_refused` and ends the WorkerRun that reported for it (its Handle revoked),
 * in the caller's transaction — the report's own, so the 200 the Worker gets means it is recorded.
 * Guarded like every Task failure (`failTaskRow`): a Task a concurrent writer already ended keeps
 * its status. The container is exiting on its own (the report is its last call), as after a
 * completed report (`completeTaskWithResult` does not ask worker-supervisor either). Returns the
 * Task as it now stands.
 */
export async function failTaskForModelRefusal(
  client: PoolClient,
  workspaceId: string,
  actorPrincipalId: string,
  taskId: string,
  workerRunId: string,
): Promise<TaskRow> {
  await failTaskRow(client, workspaceId, actorPrincipalId, taskId, 'model_refused');
  await terminateWorkerRunRow(client, workspaceId, actorPrincipalId, workerRunId, 'model_refused');
  const task = await readTaskRow(client, workspaceId, taskId);
  if (!task)
    throw new Error(`failTaskForModelRefusal: no Task ${taskId} in workspace ${workspaceId}`);
  return task;
}
