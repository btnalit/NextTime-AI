import { z } from 'zod';
import { TaskStatusSchema, WorkerRunStatusSchema } from '../enums.js';

/**
 * wire/task: Task / WorkerRun wire shapes (docs/wire-contract-conventions.md §5, S3.7) — mirrors
 * `application/gateway/handlers.ts`'s `toWireTask`/`toWireWorkerRun`/`toWireInvokeWorkerResult`
 * (already ISO-string clean, no wire fix needed). Reused by `get_task`/`list_tasks`/`invoke_worker`
 * result schemas and by the `task.updated` WS push event (`packages/shared/src/events.ts`), a
 * same-shape subset per §3.
 */

export const WorkerRunWireSchema = z
  .object({
    id: z.string(),
    status: WorkerRunStatusSchema,
    containerId: z.string().nullable(),
    depth: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    startedAt: z.string(),
    terminatedAt: z.string().nullable(),
  })
  .strict();
export type WorkerRunWire = z.infer<typeof WorkerRunWireSchema>;

export const TaskWireSchema = z
  .object({
    id: z.string(),
    status: TaskStatusSchema,
    onBehalfOf: z.string(),
    workerDefinitionId: z.string(),
    workerDefinitionVersion: z.number().int().positive(),
    input: z.unknown(),
    result: z.unknown(),
    tokenBudget: z.number().nullable(),
    tokensUsed: z.number(),
    durationLimitSec: z.number().nullable(),
    failureReason: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    workerRuns: z.array(WorkerRunWireSchema),
  })
  .strict();
export type TaskWire = z.infer<typeof TaskWireSchema>;

/** `invoke_worker`'s result (`toWireInvokeWorkerResult`) — a created-resource projection of
 *  `InvokeWorkerResult` (application/task/invoke.ts), not a full `TaskWireSchema`: `id` (not a
 *  full Task row — the Task/WorkerRun have just been created and `wait:false` returns immediately,
 *  §2 "创建/提议类 capability 的结果 = 被创建的资源对象"), `workerRunId` a `<resource>Id` reference
 *  to the sibling WorkerRun, plus (once `wait:true` resolves) the terminal `result`/
 *  `failureReason`. */
export const InvokeWorkerResultWireSchema = z
  .object({
    id: z.string(),
    workerRunId: z.string(),
    status: TaskStatusSchema,
    result: z.unknown().optional(),
    // `toWireInvokeWorkerResult` (handlers.ts) only omits this key when the internal
    // `InvokeWorkerResult.failureReason` is `undefined` — an explicit `null` (its type is
    // `string | null | undefined`) still spreads through as a literal `null` value.
    failureReason: z.string().nullable().optional(),
  })
  .strict();
export type InvokeWorkerResultWire = z.infer<typeof InvokeWorkerResultWireSchema>;

/** `cancel_task`'s result — `{id, status}` only (handlers.ts's `cancelTaskHandler`). */
export const CancelTaskResultWireSchema = TaskWireSchema.pick({ id: true, status: true });

/** `report_task_result`'s result (worker-result-handler.ts's `reportTaskResultHandler`). */
export const ReportTaskResultWireSchema = z
  .object({
    id: z.string(),
    status: TaskStatusSchema,
    activityId: z.string(),
    factIds: z.array(z.string()),
  })
  .strict();
