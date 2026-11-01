import { z } from 'zod';
import {
  ActionRequestFailureKindSchema,
  ActionRequestStatusSchema,
  BlastRadiusSchema,
  GoalOutcomeBasisSchema,
  GoalRunPauseReasonSchema,
  GoalRunStatusSchema,
  LlmRefusalScopeSchema,
  ObjectiveOutcomeSchema,
  TaskStatusSchema,
} from './enums.js';
import { StepKeySchema } from './goal-plan.js';
import { GOAL_RUN_CHANGE_VALUES } from './transitions.js';

/**
 * Chat message `kind`/`content` vocabulary for the system-message kinds `application/linkage`
 * (kernel) writes into `chat_messages` (docs/development-tasks.md S2.11 deliverable 1: "message
 * kinds: system.task_update, system.action_pending, system.action_update; extend the chat message
 * schema/enum in the existing style"; S11 GO5e-2 adds `system.goal_update`; legacy 589 adds
 * `system.model_refused`, which `application/chat` writes when it ends a Turn).
 *
 * `chat_messages.role` (migrations/core/0008_chat_messages.sql) already reserves `'system'` for
 * exactly this future case (that migration's own comment says so) — this file is the "existing
 * style" extension point the S2.11 task brief asks for: a plain `role='system'` row's `content`
 * jsonb carries one of these shapes, discriminated by a `kind` field the DB schema itself
 * does not (and need not) constrain, since `chat_messages.content` is already an unconstrained
 * jsonb column. Every variant also carries `text` — a human-readable one-liner — so `chatMessageText`
 * (application/chat/service.ts) and any client that only reads `content.text` degrade gracefully
 * without knowing about `kind` at all.
 *
 * Kept as a *separate* file rather than folded into events.ts: this is chat-message *persisted
 * storage* content, not a wire event in `PlatformEventSchema`'s discriminated union (though the
 * `chat.message` WS push's `message.content` field, added alongside this file, carries the same
 * shape verbatim — see events.ts's own doc comment on that field).
 */

export const SYSTEM_MESSAGE_KIND_VALUES = [
  'system.task_update',
  'system.action_pending',
  'system.action_update',
  'system.goal_update',
  'system.model_refused',
] as const;
export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KIND_VALUES)[number];

const SystemTaskUpdateContent = z.object({
  kind: z.literal('system.task_update'),
  text: z.string(),
  taskId: z.string(),
  status: TaskStatusSchema,
  failureReason: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  // S11 GO5e-2: a Task run for a goal's step (its attempt, or a Task its Worker started) names the
  // GoalRun and the step, so it reads as that goal's progress and goes to that goal's chat.
  // Absent for any other Task, and on messages written before it.
  goalRunId: z.string().optional(),
  stepKey: StepKeySchema.optional(),
});

/** Written into a *holder's* Chat (§8.5 "卡片... 出现在持有范围者的对话") — `isHolder: true` — or, with
 *  the same `kind`, into the *requester's* Chat as a status-only variant (`isHolder: false`, §8.5
 *  "请求者的对话里只显示该动作的状态，没有批准按钮，除非请求者本人持有范围"); the client tells the two
 *  apart by `isHolder`, not by a different `kind`. */
const SystemActionPendingContent = z.object({
  kind: z.literal('system.action_pending'),
  text: z.string(),
  actionRequestId: z.string(),
  gatekeeperId: z.string(),
  actionKindTag: z.string(),
  resourceScope: z.string().nullable().optional(),
  blastRadius: BlastRadiusSchema.optional(),
  awaitDecision: z.boolean().optional(),
  isHolder: z.boolean(),
  // Decision 2026-10-09 "二次确认": the ActionRequest's suspected credential count (its wire row's
  // `suspectedSecretValues`), so the chat card can send the approver to the approvals page, where
  // the params are shown and the confirmation `approve` requires is asked. Absent when zero.
  suspectedSecretValues: z.number().int().positive().optional(),
});

const SystemActionUpdateContent = z.object({
  kind: z.literal('system.action_update'),
  text: z.string(),
  actionRequestId: z.string(),
  status: ActionRequestStatusSchema,
  actionKindTag: z.string(),
  isHolder: z.boolean(),
  // S11 GO1: on a `failed` / `compensated` update, why it failed (the row's `failure_kind`).
  // Optional: messages written before it carry none.
  failureKind: ActionRequestFailureKindSchema.optional(),
});

/**
 * S11 GO5e-2 (plan §4.14 "对话：发起目标的对话里，里程碑以系统消息出现"): one change of a GoalRun,
 * written into the chat the goal was proposed from (or, for a goal proposed with no conversation
 * behind it, the requester's most recent chat). `change` is what happened (`GoalRunChange`; absent
 * when the event that produced it predates it), `status` the run's status after it. The sub-state
 * fields are read from the run when the message is written and only while they still describe
 * that change — `pauseReason` (and `heldByOwner`) for a pause, `outcome` + `outcomeBasis` once
 * completed, `cleanupPending` once cancelled, `revision` for a revision. The goal's statement is
 * never copied in: a client reads it with `get_goal`, which shows it the way every read does.
 */
const SystemGoalUpdateContent = z.object({
  kind: z.literal('system.goal_update'),
  text: z.string(),
  goalRunId: z.string(),
  change: z.enum(GOAL_RUN_CHANGE_VALUES).optional(),
  status: GoalRunStatusSchema,
  pauseReason: GoalRunPauseReasonSchema.optional(),
  heldByOwner: z.boolean().optional(),
  outcome: ObjectiveOutcomeSchema.optional(),
  outcomeBasis: GoalOutcomeBasisSchema.optional(),
  cleanupPending: z.boolean().optional(),
  revision: z.number().int().positive().optional(),
});

/**
 * Legacy 589: the platform refused every model call of an entry Turn — llm-proxy answered 402
 * `budget_exhausted` because a workspace budget ran out, and no call of the Turn succeeded — so
 * the Turn ended `failed` with no reply. Written into that Turn's chat (`turnId`) by the kernel when
 * it ends the Turn, from llm-proxy's own `refused` usage records, never from what the agent said.
 * `scope` is which budget (`LlmRefusalScope`), `resetsAt` when it resets (the next UTC midnight
 * after the refusal, ISO 8601).
 */
const SystemModelRefusedContent = z.object({
  kind: z.literal('system.model_refused'),
  text: z.string(),
  turnId: z.string(),
  scope: LlmRefusalScopeSchema,
  resetsAt: z.string(),
});

export const SystemMessageContentSchema = z.discriminatedUnion('kind', [
  SystemTaskUpdateContent,
  SystemActionPendingContent,
  SystemActionUpdateContent,
  SystemGoalUpdateContent,
  SystemModelRefusedContent,
]);
export type SystemMessageContent = z.infer<typeof SystemMessageContentSchema>;

/**
 * A Turn's tool call as a persisted `role='tool'` chat message (`kind: 'tool_call'`). The live
 * `chat.stream` `toolCallStarted`/`toolCallEnded` deltas are still never stored (§9.4); this is the
 * record the kernel's chat event sink writes once a call ends — or, for a call still open when its
 * Turn ends, as `not_finished` — so an operator who reloads the page can still see which tools a
 * Turn called and what came back ("why did it say there is no data").
 *
 * It is the agent runtime's own report of its tool use, at the same trust level as the Turn's
 * assistant text: not a verified record. A kernel capability call also has its audit record
 * (`audit_records`, name and redacted params, no result), which stays the authoritative one.
 *
 * `args`/`result` are previews, not the payloads: read only up to a bound, secret-looking values
 * replaced (`redactedValues` counts them), then cut at a fixed length (`truncated`, `totalChars`). `result.text` is the tool
 * result's own text when it has any (pi's `content` text parts — a capability tool's is its JSON),
 * otherwise the result as JSON. `startedAt`/`endedAt` are when the kernel received the events.
 */
export const TOOL_CALL_MESSAGE_KIND = 'tool_call' as const;

export const TOOL_CALL_OUTCOME_VALUES = ['done', 'failed', 'not_finished'] as const;
export type ToolCallOutcome = (typeof TOOL_CALL_OUTCOME_VALUES)[number];

export const ToolCallPayloadPreviewSchema = z
  .object({
    text: z.string(),
    /** How long the payload's text was before it was cut — a result's text as the tool returned
     *  it; for a structured payload too large to read whole, a lower bound (`truncated` is then
     *  true). Larger than `text.length` when it was cut. */
    totalChars: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type ToolCallPayloadPreview = z.infer<typeof ToolCallPayloadPreviewSchema>;

export const ToolCallMessageContentSchema = z
  .object({
    kind: z.literal(TOOL_CALL_MESSAGE_KIND),
    /** One line for a client that reads only `content.text`: the tool's name. */
    text: z.string(),
    toolCallId: z.string(),
    /** `null` only when the kernel saw neither the call's start nor a name on its end. */
    name: z.string().nullable(),
    /** `failed`: the runtime flagged the result as an error. `not_finished`: the Turn ended while
     *  the call was still open (stopped, failed, or the runtime lost it). */
    outcome: z.enum(TOOL_CALL_OUTCOME_VALUES),
    /** Absent when the call's start (which carries the arguments) was not seen. */
    args: ToolCallPayloadPreviewSchema.optional(),
    /** Absent for a `not_finished` call, or when the runtime reported no result. */
    result: ToolCallPayloadPreviewSchema.optional(),
    redactedValues: z.number().int().nonnegative(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  })
  .strict();
export type ToolCallMessageContent = z.infer<typeof ToolCallMessageContentSchema>;
