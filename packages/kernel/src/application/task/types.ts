import type { TaskStatus, WorkerRunStatus } from '@nexttime/shared';

/**
 * application/task/types: `TaskRow`/`WorkerRunRow` — the shapes every other file in this module
 * reads and writes (migrations/task/0001_tasks.sql, 0003_task_worker_run_lineage.sql). Split out
 * per the design doc's own file-size guidance (§7.10 "单文件 ≤ 600 行...超过即拆，不等重构"), same
 * convention `governance/approval/types.ts` already established for this codebase.
 */

export interface TaskRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly status: TaskStatus;
  readonly onBehalfOf: string;
  readonly createdByActivityId: string | null;
  readonly workerDefinitionId: string;
  readonly workerDefinitionVersion: number;
  readonly input: unknown;
  readonly result: unknown;
  readonly tokenBudget: number | null;
  readonly durationLimitSec: number | null;
  readonly tokensUsed: number;
  readonly budgetWarnedAt: Date | null;
  readonly failureReason: string | null;
  readonly retryCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly failedAt: Date | null;
  readonly cancelledAt: Date | null;
}

interface TaskDbRow {
  workspace_id: string;
  id: string;
  status: TaskStatus;
  on_behalf_of: string;
  created_by_activity_id: string | null;
  worker_definition_id: string;
  worker_definition_version: number;
  input: unknown;
  result: unknown;
  token_budget: string | number | null;
  duration_limit_sec: number | null;
  tokens_used: string | number;
  budget_warned_at: Date | null;
  failure_reason: string | null;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
}

export function mapTaskRow(row: TaskDbRow): TaskRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    status: row.status,
    onBehalfOf: row.on_behalf_of,
    createdByActivityId: row.created_by_activity_id,
    workerDefinitionId: row.worker_definition_id,
    workerDefinitionVersion: row.worker_definition_version,
    input: row.input,
    result: row.result,
    tokenBudget: row.token_budget === null ? null : Number(row.token_budget),
    durationLimitSec: row.duration_limit_sec,
    tokensUsed: Number(row.tokens_used),
    budgetWarnedAt: row.budget_warned_at,
    failureReason: row.failure_reason,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    cancelledAt: row.cancelled_at,
  };
}

export const TASK_ROW_COLUMNS = `workspace_id, id, status, on_behalf_of, created_by_activity_id,
  worker_definition_id, worker_definition_version, input, result, token_budget,
  duration_limit_sec, tokens_used, budget_warned_at, failure_reason, retry_count, created_at,
  updated_at, completed_at, failed_at, cancelled_at`;

export interface WorkerRunRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly status: WorkerRunStatus;
  readonly taskId: string;
  readonly parentWorkerRunId: string | null;
  readonly sessionId: string | null;
  readonly containerId: string | null;
  readonly depth: number;
  readonly activityId: string | null;
  readonly attempt: number;
  /** The (workspace, WorkerDefinition) agent principal `ensureWorkerAgentPrincipal`
   *  (`application/task/agent-principal.ts`) resolved when this row was spawned
   *  (migrations/task/0004_worker_run_agent_principal.sql) — `application/task/result.ts`'s
   *  `postWorkerResult` reads it straight off this row rather than re-deriving it. Nullable only
   *  because it is set in the same statement that creates the row; see that migration's own doc
   *  comment. */
  readonly agentPrincipalId: string | null;
  readonly startedAt: Date;
  readonly terminatedAt: Date | null;
}

interface WorkerRunDbRow {
  workspace_id: string;
  id: string;
  status: WorkerRunStatus;
  task_id: string;
  parent_worker_run_id: string | null;
  session_id: string | null;
  container_id: string | null;
  depth: number;
  activity_id: string | null;
  attempt: number;
  agent_principal_id: string | null;
  started_at: Date;
  terminated_at: Date | null;
}

export function mapWorkerRunRow(row: WorkerRunDbRow): WorkerRunRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    status: row.status,
    taskId: row.task_id,
    parentWorkerRunId: row.parent_worker_run_id,
    sessionId: row.session_id,
    containerId: row.container_id,
    depth: row.depth,
    activityId: row.activity_id,
    attempt: row.attempt,
    agentPrincipalId: row.agent_principal_id,
    startedAt: row.started_at,
    terminatedAt: row.terminated_at,
  };
}

export const WORKER_RUN_ROW_COLUMNS = `workspace_id, id, status, task_id, parent_worker_run_id,
  session_id, container_id, depth, activity_id, attempt, agent_principal_id, started_at,
  terminated_at`;

export class TaskNotFoundError extends Error {
  constructor(workspaceId: string, taskId: string) {
    super(`Task not found: workspace ${workspaceId}, id ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class WorkerRunNotFoundError extends Error {
  constructor(workspaceId: string, workerRunId: string) {
    super(`WorkerRun not found: workspace ${workspaceId}, id ${workerRunId}`);
    this.name = 'WorkerRunNotFoundError';
  }
}

/** A quota (I18) was violated — thrown by `invoke.ts` *before* any Task/WorkerRun row is created
 *  (docs/development-tasks.md S2.7: "quota checks (I18) before anything is created"). `code` is a
 *  stable, machine-readable identifier the entry agent's tool-call result can relay verbatim
 *  (task brief: "a violated quota returns an error the entry agent can relay verbatim (stable code
 *  + readable message)"); `message` is the human-readable half. */
export type QuotaViolationCode = 'depth_exceeded' | 'concurrency_exceeded' | 'daily_cost_exceeded';

export class QuotaExceededError extends Error {
  readonly code: QuotaViolationCode;

  constructor(code: QuotaViolationCode, message: string) {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = code;
  }
}

/** Thrown when `invoke_worker`'s child-Handle minting cannot cover what the WorkerDefinition
 *  declares it needs (`application/task/handle-mint.ts`'s `computeChildHandleScope`) — a thin,
 *  task-module-specific wrapper around `governance/capability/handles.ts`'s `AttenuationError` so
 *  callers of *this* module never need to import `governance/capability` themselves just to catch
 *  it (mirrors `governance/approval/types.ts`'s own `ApprovalScopeError`, a module-local error for
 *  a cross-cutting concern). */
export class InvokeWorkerAttenuationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvokeWorkerAttenuationError';
  }
}

/** Thrown when `invoke_worker`'s `gates` param names a gate the invoked WorkerDefinition does not
 *  itself declare (`capabilities.ts`'s own doc comment: "never lets a caller ask for a gate the
 *  definition itself does not declare"). */
export class InvokeWorkerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvokeWorkerValidationError';
  }
}

/**
 * S3.13 runtime consumer (docs/development-tasks.md S3.13's own "已知缺口" — `enabledWorkerDefinitions`
 * was resolved but never enforced): `invoke_worker`'s target WorkerDefinition is outside the
 * calling principal's `AgentProfile.effective.enabledWorkerDefinitions`. The calling principal is
 * always the chain's originating human (`on_behalf_of`/`claims.obo` — a Worker→Worker
 * `invoke_worker` call inherits it unchanged from its own parent Handle, never substitutes its own
 * immediate agent identity, `invoke.ts`'s own module doc comment on `caller.principalId`), and a
 * Profile only ever *narrows* what that human is willing to see — including for the human's own
 * `owner` role: AgentProfile is a preference the principal set for themselves, not a privilege
 * boundary an owner is exempt from (unlike I14's owner-override, which governs a *different*
 * question — approval scope, not the owner's own agent's visibility).
 *
 * A thin, task-module-specific wrapper (same convention `InvokeWorkerAttenuationError`'s own doc
 * comment already establishes) rather than importing `application/gateway`'s `ForbiddenError`:
 * `application/task` is a peer of `application/gateway`, not a layer beneath it, and importing
 * "downward" from a sibling would be a step toward a cycle dependency-cruiser's own `no-circular`
 * rule flags — every consumer maps this by `instanceof`, exactly like every other error this module
 * already defines. */
export class InvokeWorkerDefinitionNotEnabledError extends Error {
  readonly definitionId: string;

  constructor(definitionId: string) {
    super(
      `invoke_worker: WorkerDefinition "${definitionId}" is outside the calling principal's AgentProfile.enabledWorkerDefinitions`,
    );
    this.name = 'InvokeWorkerDefinitionNotEnabledError';
    this.definitionId = definitionId;
  }
}
