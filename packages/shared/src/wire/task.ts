import { z } from 'zod';
import { TaskStatusSchema, WorkerRunStatusSchema } from '../enums.js';
import { OutputProblemSchema } from '../output-schema.js';
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

/** S11 GO5d-1: a report a goal step's attempt made that its output contract refused
 *  (`report_task_result` 400) — the output as sent (`null` when the report carried none), where it
 *  did not match (at most `MAX_OUTPUT_PROBLEMS`, `problemCount` exact) and when. The last one is
 *  kept on the Task; an attempt that never reports an accepted result ends `no_result`. */
export const RejectedOutputWireSchema = z
  .object({
    output: z.record(z.string(), z.unknown()).nullable(),
    problems: z.array(OutputProblemSchema),
    problemCount: z.number().int().nonnegative(),
    at: z.string(),
  })
  .strict();
export type RejectedOutputWire = z.infer<typeof RejectedOutputWireSchema>;

/** S11 GO5d-1: the attempt of the same goal step this one redoes — one that ended without an
 *  accepted result (`no_result`): its Task, its number and the last report its output contract
 *  refused (`null` when it reported none). Recorded when the attempt starts, so the Worker reads
 *  what to fix. */
export const ReworkOfWireSchema = z
  .object({
    taskId: z.string(),
    attempt: z.number().int().positive(),
    rejectedOutput: RejectedOutputWireSchema.nullable(),
  })
  .strict();
export type ReworkOfWire = z.infer<typeof ReworkOfWireSchema>;

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
    /** S11 GO5d-1: the output schema of the goal step this Task is an attempt of — what its
     *  result's `output` is held to (`output-schema.ts`). `null` = none asked (not a step's attempt,
     *  or a step that declares none). */
    outputSchema: z.record(z.string(), z.unknown()).nullable(),
    /** S11 GO5d-1: the last report of this Task its output contract refused, if any. */
    rejectedOutput: RejectedOutputWireSchema.nullable(),
    /** S11 GO5d-1: the earlier attempt of the step this one redoes, if it is a rework. */
    reworkOf: ReworkOfWireSchema.nullable(),
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
