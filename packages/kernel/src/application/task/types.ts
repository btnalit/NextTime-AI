import {
  IllegalTransition,
  type OutputSchema,
  type TaskPurpose,
  type TaskStatus,
  type WorkerRunStatus,
} from '@nexttime/shared';
import {
  type RejectedOutput,
  type ReworkOf,
  parseRejectedOutput,
  parseReworkOf,
} from './output-contract.js';

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
  /** S11 GO2: the goal advancer's attempt number when this Task is a step's attempt
   *  (migrations/task/0007 `step_attempt`), else `null` — a Task outside a goal, or a nested child
   *  Task of a step. An attempt Task never retries inside itself: a new attempt is the step's. */
  readonly stepAttempt: number | null;
  /** S11 GO5d-1 (migrations/task/0008, `output-contract.ts`): the step's output schema an attempt
   *  Task's result is held to, its last refused report, and the attempt it redoes. */
  readonly outputSchema: OutputSchema | null;
  readonly rejectedOutput: RejectedOutput | null;
  readonly reworkOf: ReworkOf | null;
  /** S11 GO11 (migrations/task/0010, `observe-scope.ts`): the only Gatekeepers this Task's Workers
   *  may observe through, sorted; `null` = the Task sets no scope. Written once, at creation. */
  readonly observeScope: readonly string[] | null;
  /** S10 E3-2a (migrations/task/0011): `evaluation` — a run of an evaluation case, acting for the
   *  workspace's evaluation service principal; `null` — ordinary work. Fixed at creation. */
  readonly purpose: TaskPurpose | null;
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
  step_attempt: number | null;
  output_schema: unknown;
  rejected_output: unknown;
  rework_of: unknown;
  observe_scope: string[] | null;
  purpose: TaskPurpose | null;
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
    stepAttempt: row.step_attempt,
    outputSchema:
      row.output_schema !== null && typeof row.output_schema === 'object'
        ? (row.output_schema as OutputSchema)
        : null,
    rejectedOutput: parseRejectedOutput(row.rejected_output),
    reworkOf: parseReworkOf(row.rework_of),
    observeScope: row.observe_scope,
    purpose: row.purpose,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    cancelledAt: row.cancelled_at,
  };
}

export const TASK_ROW_COLUMNS = `workspace_id, id, status, on_behalf_of, created_by_activity_id,
  worker_definition_id, worker_definition_version, input, result, token_budget,
  duration_limit_sec, tokens_used, budget_warned_at, failure_reason, retry_count, step_attempt,
  output_schema, rejected_output, rework_of, observe_scope, purpose, created_at, updated_at,
  completed_at, failed_at, cancelled_at`;

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
export type QuotaViolationCode =
  | 'depth_exceeded'
  | 'concurrency_exceeded'
  | 'daily_cost_exceeded'
  /** S11 GO3a: a nested child Task of a goal step, when the goal's live Tasks hold all of what is
   *  left of its token budget (`readGoalRunTokenHeadroom`). */
  | 'goal_budget_exhausted';

export class QuotaExceededError extends Error {
  readonly code: QuotaViolationCode;

  constructor(code: QuotaViolationCode, message: string) {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = code;
  }
}

/**
 * S11 GO3a (plan I-G9): a Worker acting for a goal step asked for new work — an ActionRequest
 * (`request_action`) or a nested child Task (`invoke_worker`) — but the step no longer takes any:
 * it was cancelled with its GoalRun, superseded by a revision, or has already ended. Only a step
 * that is `running` or `waiting` takes new work. Nothing was created.
 *
 * An `IllegalTransition` (409 `illegal_transition` on both the HTTP and WS routes): a well-formed
 * request the step's current state forbids — the same family as an ActionRequest that moved on
 * under the caller.
 */
export class GoalStepClosedError extends IllegalTransition {
  readonly stepRunId: string;
  readonly stepStatus: string;

  constructor(stepRunId: string, stepStatus: string, work: 'request_action' | 'invoke_worker') {
    super('StepRun', stepStatus, work);
    this.name = 'GoalStepClosedError';
    this.stepRunId = stepRunId;
    this.stepStatus = stepStatus;
    // I-G9: only a running or waiting step takes new work.
    this.message = `${work}: goal step ${stepRunId} is ${stepStatus} and takes no new work (I-G9)`;
  }
}

/** Thrown when `invoke_worker`'s child-Handle minting cannot cover what the WorkerDefinition
 *  declares it needs (`application/task/handle-mint.ts`'s `computeChildHandleScope`) — a thin,
 *  task-module-specific wrapper around `governance/capability/handles.ts`'s `AttenuationError` so
 *  callers of *this* module never need to import `governance/capability` themselves just to catch
 *  it (mirrors `governance/approval/types.ts`'s own `ApprovalScopeError`, a module-local error for
 *  a cross-cutting concern). */
export class InvokeWorkerAttenuationError extends Error {
  /** S11 GO5c: the execute-class capabilities the WorkerDefinition declares and the calling Handle
   *  does not hold — empty when the refusal is about gates. */
  readonly capabilities: readonly string[];
  constructor(message: string, options?: { cause?: unknown; capabilities?: readonly string[] }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InvokeWorkerAttenuationError';
    this.capabilities = [...(options?.capabilities ?? [])];
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
      `invoke_worker: WorkerDefinition "${definitionId}" is excluded by the calling principal's AgentProfile (excludedWorkerDefinitions)`,
    );
    this.name = 'InvokeWorkerDefinitionNotEnabledError';
    this.definitionId = definitionId;
  }
}
