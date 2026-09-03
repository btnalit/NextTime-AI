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
    startedAt: row.started_at,
    terminatedAt: row.terminated_at,
  };
}

export const WORKER_RUN_ROW_COLUMNS = `workspace_id, id, status, task_id, parent_worker_run_id,
  session_id, container_id, depth, activity_id, attempt, started_at, terminated_at`;

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
