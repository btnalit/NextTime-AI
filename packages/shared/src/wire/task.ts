import { z } from 'zod';
import { TaskStatusSchema, WorkerRunStatusSchema } from '../enums.js';
import {
  ObjectiveOutcomeWireSchema,
  SkillLoadWireSchema,
  TurnAttributionWireSchema,
} from './attribution.js';

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
    /** S10 E1: the Skill versions this run loaded (`worker_run_skills`). `null` = not recorded (a
     *  run from before E1); `[]` = recorded, no Skill loaded. */
    skills: z.array(SkillLoadWireSchema).nullable(),
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
    /** S10 E1: `Turn --generated--> Task` (`tasks.created_by_activity_id`). A nested Worker's Task
     *  carries its root Task's Turn. `null` = no Turn (human channel, a call outside any Turn, or
     *  a nested Task from before E1). */
    turnId: z.string().nullable(),
    /** That Turn's attribution — the Procedure its entry agent claimed to follow and the
     *  requester's objective outcome. `null` when `turnId` is null or the Turn's Chat is not
     *  visible to the caller (a private Chat of someone else). */
    turn: TurnAttributionWireSchema.nullable(),
    /** S10 E1: the Task's own objective outcome, reported from a Procedure's `verify` step by the
     *  entry agent (`report_task_outcome`). `null` = unknown. */
    objectiveOutcome: ObjectiveOutcomeWireSchema.nullable(),
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
