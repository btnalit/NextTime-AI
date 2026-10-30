import type { PoolClient } from 'pg';
import type { ObserveExclusions, TaskObserveScope } from '../gates/index.js';
import { readObserveExclusions } from '../gates/index.js';

/**
 * application/task/observe-scope: S11 GO11 "任务级观察范围" (docs/goal-orchestration-and-admin-agent-
 * plan-2026-10-16.md §4.11; S10 I-E1). A Task may fix the only Gatekeepers its Workers observe
 * through (`tasks.observe_scope`, migrations/task/0010): every other gate's observe-class
 * Operations are refused `excluded_by_policy` to them and left out of their tool list. It is one
 * more source of the exclusions `observeRefusal` already applies (application/gates/
 * observe-access.ts), so it only ever narrows what the member's agent may observe.
 *
 *   - **Where it comes from**: set once, when the Task is created (`invokeWorkerCreate`'s
 *     `observeScope` option — never a wire param), and never changed (a trigger refuses it). A
 *     Worker of a scoped Task that invokes another Worker gives that Task its own scope, narrowed
 *     further when asked (`narrowObserveScope`); task 0010's `worker_runs` trigger refuses a run
 *     whose Task is not within its parent run's Task's scope, so nesting never escapes it. The
 *     first producer is S10 E3's evaluation Task (`purpose=evaluation`: only the fixture gates its
 *     EvalSuite declares); GO8's WorkerSpec declares one later.
 *   - **Where it applies**: read per call from the calling Handle's session — `sid` → its WorkerRun
 *     → that run's Task — by `readHandleObserveExclusions`, which every Handle-caller consumer of
 *     `observeRefusal` reads its exclusions with (`observe_operation`, `request_action`'s observe
 *     branch, `list_allowed_operations`, `find_procedures`). Never from the Handle itself: a Handle
 *     carries execute authority only.
 */

/** Sorted, without repeats — how a scope is stored and compared. */
export function normalizeObserveScope(gatekeeperIds: readonly string[]): string[] {
  return [...new Set(gatekeeperIds)].sort();
}

/** The scope a new Task gets: its caller's Task's scope (`null` when the caller is not a Worker of
 *  a scoped Task) narrowed by the one asked for (`null` = none asked). Never wider than either. */
export function narrowObserveScope(
  callerScope: readonly string[] | null,
  requested: readonly string[] | null,
): string[] | null {
  if (callerScope === null) return requested === null ? null : normalizeObserveScope(requested);
  if (requested === null) return normalizeObserveScope(callerScope);
  const allowed = new Set(callerScope);
  return normalizeObserveScope(requested.filter((id) => allowed.has(id)));
}

/** A Task's own scope, by id (`null` = it sets none, or there is no such Task). */
export async function readTaskObserveScope(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<string[] | null> {
  const result = await client.query<{ observe_scope: string[] | null }>(
    'select observe_scope from tasks where workspace_id = $1 and id = $2',
    [workspaceId, taskId],
  );
  return result.rows[0]?.observe_scope ?? null;
}

/** The scope of the Task the WorkerRun of `sessionId` runs — the identity `report_task_result` and
 *  `request_action` already trust (`claims.sid`). `null` when there is no session, it is not a
 *  WorkerRun's (an entry, interactive or service session), or its Task sets no scope. */
export async function readSessionTaskObserveScope(
  client: PoolClient,
  workspaceId: string,
  sessionId: string | undefined,
): Promise<TaskObserveScope | null> {
  if (sessionId === undefined) return null;
  const result = await client.query<{ task_id: string; observe_scope: string[] | null }>(
    `select t.id as task_id, t.observe_scope
       from worker_runs w
       join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
      where w.workspace_id = $1 and w.session_id = $2`,
    [workspaceId, sessionId],
  );
  const row = result.rows[0];
  if (!row || row.observe_scope === null) return null;
  return { taskId: row.task_id, gatekeeperIds: row.observe_scope };
}

/** A Handle caller's `observeRefusal` inputs: the AgentPolicy cap and the AgentProfile of the
 *  member it acts for (`obo`), and its session's Task scope. Every Handle-caller consumer reads
 *  them here, so none can leave the Task scope out. */
export async function readHandleObserveExclusions(
  client: PoolClient,
  workspaceId: string,
  caller: { readonly principalId: string; readonly sessionId: string | undefined },
): Promise<ObserveExclusions> {
  const taskScope = await readSessionTaskObserveScope(client, workspaceId, caller.sessionId);
  return readObserveExclusions(client, workspaceId, caller.principalId, taskScope);
}
