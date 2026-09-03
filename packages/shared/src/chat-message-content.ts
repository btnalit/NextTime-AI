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
  actionKind: z.string(),
  resourceScope: z.string().nullable().optional(),
  blastRadius: BlastRadiusSchema.optional(),
  awaitDecision: z.boolean().optional(),
  isHolder: z.boolean(),
});

const SystemActionUpdateContent = z.object({
  kind: z.literal('system.action_update'),
  text: z.string(),
  actionRequestId: z.string(),
  status: ActionRequestStatusSchema,
  actionKind: z.string(),
  isHolder: z.boolean(),
});

export const SystemMessageContentSchema = z.discriminatedUnion('kind', [
  SystemTaskUpdateContent,
  SystemActionPendingContent,
  SystemActionUpdateContent,
]);
export type SystemMessageContent = z.infer<typeof SystemMessageContentSchema>;
