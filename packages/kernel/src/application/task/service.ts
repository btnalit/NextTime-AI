import { TASK_TRANSITIONS, type TaskEvent, type TaskStatus, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import {
  findOperationCandidates,
  findProcedureCandidates,
  findWorkerDefinitionCandidates,
} from '../../substrate/graph/index.js';
import type { GraphObject } from '../../substrate/graph/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { getWorkerDefinition } from '../worker/index.js';
import { type ParentAuthority, computeChildHandleScope } from './handle-mint.js';
import { failTaskRow, readTaskRow, readWorkerRunRow, terminateWorkerRunRow } from './lifecycle.js';
import { getConfiguredTaskRuntime } from './runtime.js';
import { recordTaskTransition } from './transition-log.js';
import {
  InvokeWorkerAttenuationError,
  TASK_ROW_COLUMNS,
  TaskNotFoundError,
  type TaskRow,
  WORKER_RUN_ROW_COLUMNS,
  type WorkerRunRow,
  mapTaskRow,
  mapWorkerRunRow,
} from './types.js';

/**
 * application/task/service: `get_task`/`cancel_task`/`terminate` (terminateTask), per-Task token
 * accounting (I18 budget), and the `find_*` handlers' full behavior — the substrate half
 * (`substrate/graph/find-means.ts`) plus the "intersected with what the caller may use" half this
 * module adds (design doc §9.3 "find_* 与调用者 Grant 取交集"; docs/development-tasks.md S2.7).
 */

// -------------------------------------------------------------------------------------------
// get_task / taskForWorkerRun
// -------------------------------------------------------------------------------------------

export interface TaskWithWorkerRuns {
  readonly task: TaskRow;
  readonly workerRuns: readonly WorkerRunRow[];
}

/** Workspace-scoped, on_behalf_of-visible (docs/development-tasks.md S2.7 "get_task
 *  (workspace-scoped, on_behalf_of-visible)"): `tasks`'/`worker_runs`' own RLS policies are
 *  workspace-only (migrations/task/0001_tasks.sql's own header comment — no owner-narrowing rule
 *  is implied by §5.6 for Task the way it is for Chat/private-Source), so any workspace member may
 *  read any Task; "on_behalf_of-visible" describes *who a Task is for*, not an access restriction
 *  this function enforces on top of that. */
export async function getTaskWithWorkerRuns(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<TaskWithWorkerRuns> {
  const task = await readTaskRow(client, workspaceId, taskId);
  if (!task) throw new TaskNotFoundError(workspaceId, taskId);

  const workerRunsResult = await client.query(
    `select ${WORKER_RUN_ROW_COLUMNS} from worker_runs
     where workspace_id = $1 and task_id = $2
     order by started_at asc`,
    [workspaceId, taskId],
  );
  return { task, workerRuns: workerRunsResult.rows.map(mapWorkerRunRow) };
}

/** `taskForWorkerRun` (docs/development-tasks.md S2.7 deliverable: "expose taskForWorkerRun
 *  (workerRunId)" — the seam `reaper.ts`'s ActionRequest-routing consumer uses to find which Task
 *  to move to `waiting_approval`). */
export async function taskForWorkerRun(
  client: PoolClient,
  workspaceId: string,
  workerRunId: string,
): Promise<TaskRow | null> {
  const workerRun = await readWorkerRunRow(client, workspaceId, workerRunId);
  if (!workerRun) return null;
  return readTaskRow(client, workspaceId, workerRun.taskId);
}

// -------------------------------------------------------------------------------------------
// terminateTask / cancelTask
// -------------------------------------------------------------------------------------------

/** The real, if momentary, hop sequence from `status` to `running`, mirrored from
 *  `lifecycle.ts`'s own `pathToRunning` (kept file-local — a two-line duplicate is cheaper than a
 *  cross-file import for something this small and this module's own `cancel` event needs the same
 *  shape `fail` did there). */
function pathToRunning(status: TaskStatus): readonly TaskEvent[] {
  switch (status) {
    case 'created':
      return ['queue', 'start'];
    case 'queued':
      return ['start'];
    case 'waiting_approval':
      return ['resume'];
    default:
      return [];
  }
}

/** `cancel_task`'s service half: terminates every non-terminated WorkerRun under the Task
 *  (revoking their Handles) and transitions the Task itself to `cancelled`. Idempotent — a Task
 *  already in a terminal status is a no-op, not an error (matches `terminateWorkerRunRow`'s own
 *  idempotency contract). */
export async function terminateTask(
  workspaceId: string,
  actorPrincipalId: string,
  taskId: string,
): Promise<TaskRow> {
  const deps = getConfiguredTaskRuntime();

  const task = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: actorPrincipalId },
    (client) => readTaskRow(client, workspaceId, taskId),
  );
  if (!task) throw new TaskNotFoundError(workspaceId, taskId);
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
    return task;
  }

  const workerRuns = await withWorkspace(
    deps.pool,
    { workspaceId, principalId: actorPrincipalId },
    async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from worker_runs
         where workspace_id = $1 and task_id = $2 and status <> 'terminated'`,
        [workspaceId, taskId],
      );
      return result.rows.map((row) => row.id);
    },
  );

  for (const workerRunId of workerRuns) {
    // Best-effort: a supervisor that is unreachable must not prevent the platform side (Handle
    // revocation, row transitions) from proceeding — the reaper's own status polling will notice
    // and finish tidying up the container side once the supervisor is reachable again.
    await deps.supervisorClient.terminate(workerRunId).catch(() => {});
    await withWorkspace(deps.pool, { workspaceId, principalId: actorPrincipalId }, (client) =>
      terminateWorkerRunRow(client, workspaceId, actorPrincipalId, workerRunId, 'requested'),
    );
  }

  return withWorkspace(
    deps.pool,
    { workspaceId, principalId: actorPrincipalId },
    async (client) => {
      const current = await readTaskRow(client, workspaceId, taskId);
      if (!current) throw new TaskNotFoundError(workspaceId, taskId);
      if (
        current.status === 'completed' ||
        current.status === 'failed' ||
        current.status === 'cancelled'
      ) {
        return current;
      }
      let cursor: TaskStatus = current.status;
      for (const event of pathToRunning(current.status)) {
        cursor = transition(TASK_TRANSITIONS, cursor, event);
      }
      transition(TASK_TRANSITIONS, cursor, 'cancel');

      const result = await client.query(
        `update tasks set status = 'cancelled', cancelled_at = now()
       where workspace_id = $1 and id = $2
       returning ${TASK_ROW_COLUMNS}`,
        [workspaceId, taskId],
      );
      const row = result.rows[0];
      if (!row) throw new TaskNotFoundError(workspaceId, taskId);
      const mapped = mapTaskRow(row);
      await recordTaskTransition(client, workspaceId, {
        actorPrincipalId,
        action: 'task.cancel',
        taskId,
        resultingStatus: 'cancelled',
      });
      return mapped;
    },
  );
}

// -------------------------------------------------------------------------------------------
// I18 budget accounting — the llm-usage per-record hook
// (interfaces/http/internal/llm-usage.ts -> here; see that route's own doc comment).
// -------------------------------------------------------------------------------------------

export interface WorkerRunUsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Accumulates one llm-usage record's token count onto its Task (only when `sessionId` belongs to
 *  a `worker_run` session — an entry/other session's usage has no per-Task budget to accumulate
 *  onto, and is silently a no-op here); at ≥80% of `token_budget` emits one `BudgetWarning` (edge-
 *  triggered via `budget_warned_at`, mirroring `governance/llm-usage/service.ts`'s own workspace-
 *  level crossing check); at ≥100% marks the Task `failed: budget_exhausted` and best-effort
 *  terminates every still-running WorkerRun under it (design doc I18: "到 100% 时 ... Task 进入
 *  failed: budget_exhausted"). Must be called on the same `client`/transaction the llm-usage
 *  INSERT itself ran on (`interfaces/http/internal/llm-usage.ts`'s own doc comment) — this
 *  function opens no transaction of its own.
 */
export async function recordWorkerRunUsage(
  client: PoolClient,
  workspaceId: string,
  sessionId: string,
  tokens: WorkerRunUsageTokens,
): Promise<void> {
  const workerRunResult = await client.query<{ task_id: string }>(
    'select task_id from worker_runs where workspace_id = $1 and session_id = $2',
    [workspaceId, sessionId],
  );
  const workerRunRow = workerRunResult.rows[0];
  if (!workerRunRow) return;

  const delta =
    tokens.inputTokens +
    tokens.outputTokens +
    (tokens.cacheReadTokens ?? 0) +
    (tokens.cacheWriteTokens ?? 0);

  const taskResult = await client.query(
    `update tasks set tokens_used = tokens_used + $3
     where workspace_id = $1 and id = $2
     returning ${TASK_ROW_COLUMNS}`,
    [workspaceId, workerRunRow.task_id, delta],
  );
  const taskRow = taskResult.rows[0];
  if (!taskRow) return;
  const task = mapTaskRow(taskRow);

  if (task.tokenBudget === null || task.status !== 'running') return;
  const percent = task.tokenBudget > 0 ? (task.tokensUsed / task.tokenBudget) * 100 : 100;

  if (percent >= 100) {
    await failTaskRow(client, workspaceId, task.onBehalfOf, task.id, 'budget_exhausted');
    const runningRuns = await client.query<{ id: string }>(
      `select id from worker_runs
       where workspace_id = $1 and task_id = $2 and status in ('provisioning', 'running', 'suspended')`,
      [workspaceId, task.id],
    );
    for (const run of runningRuns.rows) {
      await terminateWorkerRunRow(client, workspaceId, task.onBehalfOf, run.id, 'budget_exhausted');
      try {
        const deps = getConfiguredTaskRuntime();
        await deps.supervisorClient.terminate(run.id);
      } catch {
        // Best-effort container-side cleanup — the Handle is already revoked either way, so the
        // Worker's own subsequent API calls fail closed regardless of whether this succeeds.
      }
    }
    return;
  }

  if (percent >= 80 && task.budgetWarnedAt === null) {
    await client.query(
      'update tasks set budget_warned_at = now() where workspace_id = $1 and id = $2',
      [workspaceId, task.id],
    );
    await enqueue(client, {
      type: 'BudgetWarning',
      workspaceId,
      scope: 'task',
      taskId: task.id,
      percent,
    });
  }
}

// -------------------------------------------------------------------------------------------
// find_operations / find_workers / find_procedures — the "intersected with what the caller may
// use" half (substrate/graph/find-means.ts is the pure candidate-list half).
// -------------------------------------------------------------------------------------------

export interface FindMeansCaller {
  readonly parentAuthority: ParentAuthority;
}

export interface WorkerDefinitionMatch {
  readonly definitionId: string;
  readonly version: number;
  readonly kind: string;
  readonly name?: string;
  readonly description?: string;
}

function toWorkerDefinitionMatch(object: GraphObject): WorkerDefinitionMatch | undefined {
  const identity = object.identityKey;
  const definitionId =
    identity && typeof identity.definitionId === 'string' ? identity.definitionId : undefined;
  const version = identity && typeof identity.version === 'number' ? identity.version : undefined;
  if (!definitionId || version === undefined) return undefined;
  const properties = object.properties;
  return {
    definitionId,
    version,
    kind: typeof properties.kind === 'string' ? properties.kind : 'worker',
    name: typeof properties.name === 'string' ? properties.name : undefined,
    description: typeof properties.description === 'string' ? properties.description : undefined,
  };
}

/**
 * `find_workers`: every published `WorkerDefinition@version` matching `need`
 * (`substrate/graph/find-means.ts`), filtered to only those `caller` could actually successfully
 * `invoke_worker` right now — a dry run of `handle-mint.ts`'s `computeChildHandleScope` against
 * each candidate's own declared `capabilities`/`gates`, discarding any that would raise
 * `InvokeWorkerAttenuationError`. This is the concrete, testable shape "intersected with the
 * caller's Grant/Handle scope" takes for `find_workers` today (design doc §9.3) — a candidate an
 * entry Handle could never actually invoke (e.g. one declaring execute-class needs) is filtered
 * out here rather than surfaced only to fail later at `invoke_worker` time. `kind='entry'`
 * WorkerDefinitions never appear (`find_workers` finds things *to invoke*, and only `kind='worker'`
 * is invocable — `invoke.ts`'s own check).
 */
export async function findWorkers(
  client: PoolClient,
  workspaceId: string,
  caller: FindMeansCaller,
  need: string,
  limit?: number,
): Promise<readonly WorkerDefinitionMatch[]> {
  const candidates = await findWorkerDefinitionCandidates(client, workspaceId, { need, limit });
  const matches: WorkerDefinitionMatch[] = [];

  for (const candidate of candidates) {
    const match = toWorkerDefinitionMatch(candidate);
    if (!match || match.kind !== 'worker') continue;

    const definition = await getWorkerDefinition(client, workspaceId, {
      definitionId: match.definitionId,
      version: match.version,
    });
    if (!definition || definition.status !== 'published') continue;

    const content = definition.definition as { capabilities?: string[]; gates?: string[] };
    try {
      computeChildHandleScope({
        parentAuthority: caller.parentAuthority,
        declaredCapabilities: content.capabilities ?? [],
        declaredGates: content.gates ?? [],
      });
    } catch (err) {
      if (err instanceof InvokeWorkerAttenuationError) continue;
      throw err;
    }
    matches.push(match);
  }

  return matches;
}

/** `find_operations` — candidates from `substrate/graph/find-means.ts`; the Grant-intersection
 *  half is a documented no-op until S2.4 projects real `Operation` Objects with a resolvable
 *  `Gatekeeper` relationship to check a Grant against (this function's own signature already
 *  accepts `caller` so wiring that check in later touches only this file). */
export async function findOperations(
  client: PoolClient,
  workspaceId: string,
  _caller: FindMeansCaller,
  need: string,
  limit?: number,
): Promise<readonly GraphObject[]> {
  return findOperationCandidates(client, workspaceId, { need, limit });
}

/** `find_procedures` — same no-op-until-S2.14 note as `findOperations` above. */
export async function findProcedures(
  client: PoolClient,
  workspaceId: string,
  _caller: FindMeansCaller,
  need: string,
  limit?: number,
): Promise<readonly GraphObject[]> {
  return findProcedureCandidates(client, workspaceId, { need, limit });
}
