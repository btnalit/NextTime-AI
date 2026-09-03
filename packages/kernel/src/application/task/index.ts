/**
 * application/task: Task/WorkerRun; `invoke_worker`; calls worker-supervisor; crash requeue;
 * timeout; I18 quotas (design doc §7.1, §7.10; docs/development-tasks.md S2.7).
 *
 * This module owns its own tables/migrations (migrations/task/0001_tasks.sql, 0002_quotas.sql,
 * 0003_task_worker_run_lineage.sql) and exposes only this service interface — it must not be
 * reached into from another module's internal files, and other modules must not query its tables
 * directly; cross-module coordination happens through domain events (see packages/shared,
 * `TaskUpdated`/`WorkerRunUpdated`/`ActionRequestPending`/`ActionRequestUpdated`).
 *
 * `chat` and `host-bridge` must never import this module (`.dependency-cruiser.cjs`
 * `chat-and-host-bridge-must-not-import-approval-or-task`) — they consume `TaskUpdated`/
 * `WorkerRunUpdated` events instead (S2.11's job, not this one's).
 */

export {
  type InvokeWorkerCallerCtx,
  type InvokeWorkerInput,
  type InvokeWorkerResult,
  invokeWorker,
  readTask,
} from './invoke.js';

export {
  completeTaskWithResult,
  reactToSupervisorStatus,
  readTaskRow,
  readWorkerRunRow,
  terminateWorkerRunRow,
} from './lifecycle.js';

export {
  type FindMeansCaller,
  type TaskWithWorkerRuns,
  type WorkerDefinitionMatch,
  type WorkerRunUsageTokens,
  findOperations,
  findProcedures,
  findWorkers,
  findWorkerRunBySessionId,
  getTaskWithWorkerRuns,
  recordWorkerRunUsage,
  taskForWorkerRun,
  terminateTask,
} from './service.js';

export {
  type PostWorkerResultInput,
  type PostWorkerResultOutcome,
  postWorkerResult,
} from './result.js';

export {
  type ComputeChildHandleScopeInput,
  type ParentAuthority,
  type ParentHandleLineage,
  EMPTY_CAPABILITY_SCOPE,
  computeChildHandleScope,
  resolveParentAuthority,
} from './handle-mint.js';

export {
  DEFAULT_QUOTA_VALUES,
  HARD_MAX_DEPTH,
  QUOTA_KEY_VALUES,
  type QuotaKey,
  type QuotaRow,
  type ResolvedQuotas,
  type SetQuotaInput,
  InvalidQuotaValueError,
  UnknownQuotaKeyError,
  isQuotaKey,
  resolveQuotas,
  setQuotaValue,
} from './quotas.js';

export {
  type ActionRequestEventSource,
  type RunTaskReaperResult,
  registerActionRequestRoutingConsumer,
  runTaskReaper,
} from './reaper.js';

export {
  type TaskRuntimeDeps,
  TaskRuntimeNotConfiguredError,
  configureTaskRuntime,
  getConfiguredTaskRuntime,
  resetTaskRuntimeForTests,
} from './runtime.js';

export {
  InvokeWorkerAttenuationError,
  InvokeWorkerValidationError,
  QuotaExceededError,
  type QuotaViolationCode,
  TaskNotFoundError,
  type TaskRow,
  WorkerRunNotFoundError,
  type WorkerRunRow,
} from './types.js';
