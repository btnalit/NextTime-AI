import { z } from 'zod';
import { ActionRequestStatusSchema, BlastRadiusSchema, TaskStatusSchema } from './enums.js';

/**
 * Chat message `kind`/`content` vocabulary for the three system-message kinds `application/
 * linkage` (kernel) writes into `chat_messages` (docs/development-tasks.md S2.11 deliverable 1:
 * "message kinds: system.task_update, system.action_pending, system.action_update; extend the
 * chat message schema/enum in the existing style").
 *
 * `chat_messages.role` (migrations/core/0008_chat_messages.sql) already reserves `'system'` for
 * exactly this future case (that migration's own comment says so) — this file is the "existing
 * style" extension point the S2.11 task brief asks for: a plain `role='system'` row's `content`
 * jsonb carries one of these three shapes, discriminated by a `kind` field the DB schema itself
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
] as const;
export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KIND_VALUES)[number];

const SystemTaskUpdateContent = z.object({
  kind: z.literal('system.task_update'),
  text: z.string(),
  taskId: z.string(),
  status: TaskStatusSchema,
  failureReason: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
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
});

export const SystemMessageContentSchema = z.discriminatedUnion('kind', [
  SystemTaskUpdateContent,
  SystemActionPendingContent,
  SystemActionUpdateContent,
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
