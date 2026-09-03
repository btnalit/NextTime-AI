import {
  type ProcedureStep,
  TASK_TRANSITIONS,
  type TaskEvent,
  type TaskStatus,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withWorkspace } from '../../adapters/db/pool.js';
import { WORKER_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { getPublishedOperation } from '../../governance/gatekeepers/index.js';
import {
  findOperationCandidates,
  findProcedureCandidates,
  findWorkerDefinitionCandidates,
} from '../../substrate/graph/index.js';
import type { GraphObject } from '../../substrate/graph/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { getProcedure, getWorkerDefinition } from '../worker/index.js';
import {
  type ParentAuthority,
  computeChildHandleScope,
  defaultWorkerCapabilities,
} from './handle-mint.js';
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

/**
 * `list_tasks` (S2.10 addition — see packages/shared/src/capabilities.ts's own doc comment on
 * that registry entry for why one had to be added; §9.3 never defined a list capability for Task).
 * Unlike `getTaskWithWorkerRuns` above (workspace-scoped, any Task by id), this is narrowed to
 * `on_behalf_of = principalId` — "the caller's own Tasks" (the task brief's own words) — newest
 * first, each with its WorkerRuns. One query for the Task rows, one batched query for every
 * WorkerRun across all of them (`task_id = any($2)`), grouped back together in application code —
 * avoids an N+1 query per Task while staying a single, easily-read function (mirrors
 * `getTaskWithWorkerRuns`'s own per-Task WorkerRun query, just batched across the whole list).
 */
export async function listTasksForPrincipal(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<readonly TaskWithWorkerRuns[]> {
  const tasksResult = await client.query(
    `select ${TASK_ROW_COLUMNS} from tasks
     where workspace_id = $1 and on_behalf_of = $2
     order by created_at desc`,
    [workspaceId, principalId],
  );
  const tasks = tasksResult.rows.map(mapTaskRow);
  if (tasks.length === 0) return [];

  const workerRunsResult = await client.query(
    `select ${WORKER_RUN_ROW_COLUMNS} from worker_runs
     where workspace_id = $1 and task_id = any($2::uuid[])
     order by started_at asc`,
    [workspaceId, tasks.map((task) => task.id)],
  );
  const workerRunsByTaskId = new Map<string, WorkerRunRow[]>();
  for (const row of workerRunsResult.rows.map(mapWorkerRunRow)) {
    const bucket = workerRunsByTaskId.get(row.taskId);
    if (bucket) bucket.push(row);
    else workerRunsByTaskId.set(row.taskId, [row]);
  }

  return tasks.map((task) => ({ task, workerRuns: workerRunsByTaskId.get(task.id) ?? [] }));
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

/** S2.9: resolves the WorkerRun a `sessionId` belongs to — the identity mechanism `report_task_
 *  result`'s handler uses to find "which Task is this Worker allowed to report a result for"
 *  (`application/gateway/worker-result-handler.ts`), matching the calling Handle's own
 *  `claims.sid` rather than trusting a caller-supplied `taskId`/`workerRunId` (I13-style). `null`
 *  for a `sessionId` with no matching WorkerRun (an entry session, or any other stray Handle) —
 *  the handler maps that to a 403, never a distinguishable 404 (mirrors `application/task/
 *  invoke.ts`'s file-local `resolveCallerWorkerRun`, which this intentionally does not replace —
 *  see this function's own PR body note). */
export async function findWorkerRunBySessionId(
  client: PoolClient,
  workspaceId: string,
  sessionId: string,
): Promise<WorkerRunRow | null> {
  const result = await client.query(
    `select ${WORKER_RUN_ROW_COLUMNS} from worker_runs where workspace_id = $1 and session_id = $2`,
    [workspaceId, sessionId],
  );
  const row = result.rows[0];
  return row ? mapWorkerRunRow(row) : null;
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
      // Same default as invoke.ts's own minting path (handle-mint.ts's `defaultWorkerCapabilities`
      // — see its own doc comment for why the two must never independently guess at this) — a
      // definition declaring no `capabilities` needs the full observe/propose ceiling, not none.
      computeChildHandleScope({
        parentAuthority: caller.parentAuthority,
        declaredCapabilities:
          content.capabilities ?? defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES),
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

/**
 * `find_operations` — candidates from `substrate/graph/find-means.ts` (already published-only,
 * I16/I17), intersected with the caller's Grant (design doc §9.3 "find_* 与调用者 Grant 取交集";
 * docs/development-tasks.md S2.13's own runbook deliverable: "connect_gatekeeper 到一个成员 → 该
 * 成员的入口 agent 能 find_operations"). Wired now that S2.4/S2.13 have landed real `Operation`
 * Objects and a real `connect_gatekeeper` Grant to check against — this function's signature
 * already accepted `caller` in anticipation of exactly this (S2.7's own note, which this
 * supersedes).
 *
 * Mirrors `findWorkers` above: `'unconstrained'` (owner, human channel, no Handle to narrow from)
 * sees every published-candidate Operation; a real `CapabilityScope` keeps only candidates whose
 * `identityKey.gatekeeperId` is in `resources.gatekeeper` — exactly the same key
 * `computeChildHandleScope`/`ensureEntryHandle` already populate from an active
 * `connect_gatekeeper` Grant (`governance/policy`'s `GATEKEEPER_RESOURCE_SCOPE_KEY`).
 *
 * Known, deliberate asymmetry (see PR body "已知偏离"): `request-action-handler.ts`'s `observe`
 * path (the actual `<gate>.<op>` tool call, once an agent has *found* an Operation) does not
 * itself check `resources.gatekeeper` — a pre-existing S2.4 gap, not something this task's
 * ownership extends to fixing. This function narrows only what `find_operations` *surfaces* as a
 * candidate means; it is not the sole enforcement point.
 */
export async function findOperations(
  client: PoolClient,
  workspaceId: string,
  caller: FindMeansCaller,
  need: string,
  limit?: number,
): Promise<readonly GraphObject[]> {
  const candidates = await findOperationCandidates(client, workspaceId, { need, limit });
  if (caller.parentAuthority === 'unconstrained') return candidates;

  const allowedGatekeepers = new Set(caller.parentAuthority.resources.gatekeeper ?? []);
  return candidates.filter((candidate) => {
    const gatekeeperId = candidate.identityKey?.gatekeeperId;
    return typeof gatekeeperId === 'string' && allowedGatekeepers.has(gatekeeperId);
  });
}

export interface ProcedureMatch {
  readonly procedureId: string;
  readonly version: number;
  readonly name?: string;
  readonly description?: string;
}

function toProcedureMatch(object: GraphObject): ProcedureMatch | undefined {
  const identity = object.identityKey;
  const procedureId =
    identity && typeof identity.procedureId === 'string' ? identity.procedureId : undefined;
  const version = identity && typeof identity.version === 'number' ? identity.version : undefined;
  if (!procedureId || version === undefined) return undefined;
  const properties = object.properties;
  return {
    procedureId,
    version,
    name: typeof properties.name === 'string' ? properties.name : undefined,
    description: typeof properties.description === 'string' ? properties.description : undefined,
  };
}

/** One step's own Grant-intersection check (S2.14) — `false` means "this candidate is not usable
 *  by `caller` right now", never thrown; the caller (`findProcedures`) drops the whole Procedure
 *  candidate rather than surfacing a partially-usable one. */
async function stepUsableByCaller(
  client: PoolClient,
  workspaceId: string,
  caller: FindMeansCaller,
  step: ProcedureStep,
): Promise<boolean> {
  if (step.kind === 'worker') {
    const definition = await getWorkerDefinition(client, workspaceId, {
      definitionId: step.definitionId,
      version: step.version,
    });
    if (!definition || definition.status !== 'published') return false;
    const content = definition.definition as { capabilities?: string[]; gates?: string[] };
    try {
      // Same dry-run `findWorkers` already performs against a WorkerDefinition candidate's own
      // declared needs — see that function's own doc comment for the default-capabilities
      // rationale.
      computeChildHandleScope({
        parentAuthority: caller.parentAuthority,
        declaredCapabilities:
          content.capabilities ?? defaultWorkerCapabilities(WORKER_CEILING_CAPABILITIES),
        declaredGates: content.gates ?? [],
      });
    } catch (err) {
      if (err instanceof InvokeWorkerAttenuationError) return false;
      throw err;
    }
    return true;
  }

  if (step.kind === 'operation') {
    const operation = await getPublishedOperation(
      client,
      workspaceId,
      step.gatekeeperId,
      step.operationName,
    );
    if (!operation) return false; // I17: draft/deprecated/unknown is never usable.
    if (operation.operation.mode !== 'execute') return true; // §11: observe is ungated by design.
    try {
      // A synthetic single-gate "WorkerDefinition" dry run — `request_action` is the fixed
      // execute-class capability name every gate-execute call goes through
      // (`governance/capability/handles.ts`'s `EXECUTE_CLASS_CAPABILITY_NAMES`), so requiring it
      // here forces the same "does the caller's scope already cover this Gatekeeper" check
      // `computeChildHandleScope` performs for a real `invoke_worker` call.
      computeChildHandleScope({
        parentAuthority: caller.parentAuthority,
        declaredCapabilities: ['request_action'],
        declaredGates: [step.gatekeeperId],
      });
    } catch (err) {
      if (err instanceof InvokeWorkerAttenuationError) return false;
      throw err;
    }
    return true;
  }

  // 'approval' | 'verify' — no external reference to check (design doc §5.1.4 "含审批步与验证步" —
  // procedural markers, not something a Grant covers).
  return true;
}

/**
 * `find_procedures`: every published Procedure matching `need` (`substrate/graph/find-means.ts`),
 * filtered to only those every step of which `caller` could actually carry out right now — the
 * same "intersected with the caller's Grant/Handle scope" shape `findWorkers` established (design
 * doc §9.3), applied per-step (S2.14, `stepUsableByCaller` above). A step whose reference no
 * longer resolves to something *currently published* (e.g. the Operation/WorkerDefinition it named
 * at Procedure-publish-time has since been deprecated) excludes the whole candidate — soft
 * degradation, not an error; a Procedure is re-validated against the graph's current state on
 * every `find_procedures` call, not only once at its own publish time.
 */
export async function findProcedures(
  client: PoolClient,
  workspaceId: string,
  caller: FindMeansCaller,
  need: string,
  limit?: number,
): Promise<readonly ProcedureMatch[]> {
  const candidates = await findProcedureCandidates(client, workspaceId, { need, limit });
  const matches: ProcedureMatch[] = [];

  for (const candidate of candidates) {
    const match = toProcedureMatch(candidate);
    if (!match) continue;

    const procedure = await getProcedure(client, workspaceId, {
      procedureId: match.procedureId,
      version: match.version,
    });
    if (!procedure || procedure.status !== 'published') continue;

    let usable = true;
    for (const step of procedure.steps) {
      if (!(await stepUsableByCaller(client, workspaceId, caller, step))) {
        usable = false;
        break;
      }
    }
    if (usable) matches.push(match);
  }

  return matches;
}
