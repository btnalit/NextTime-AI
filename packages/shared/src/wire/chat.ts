import { z } from 'zod';

/**
 * wire/chat: Chat / ChatMessage wire shapes (docs/wire-contract-conventions.md §5, S3.7) — one
 * definition per resource, reused by `list_chats`/`new_chat`/`get_chat_history` result schemas
 * (`packages/shared/src/capabilities.ts`) and by the `chat.message` WS push event
 * (`packages/shared/src/events.ts`), which the conventions doc's §3 already requires to carry the
 * "same shape" as the resource it announces.
 */

export const ChatWireSchema = z
  .object({
    id: z.string(),
    ownerPrincipalId: z.string(),
    title: z.string().nullable(),
    visibility: z.string(),
    createdAt: z.string(),
    /** S6-A chat lifecycle (docs/console-completion-plan.md §4): `null` = active; an ISO timestamp
     *  = archived at that moment (`archive_chat`; `unarchive_chat` sets it back to `null`).
     *  `list_chats` hides archived rows unless `includeArchived: true`. Chosen over a
     *  `status: 'active' | 'archived'` enum because the timestamp *is* the status and the console
     *  wants to show "archived <relative time>" — one field, no second source of truth. */
    archivedAt: z.string().nullable(),
    /** S8 W4 (audit C1 "对话行副标题显示 chats.created_at"): the newer of `createdAt` and the
     *  Chat's own newest `chat_messages.created_at` — a read-only projection (`toWireChat`,
     *  application/gateway/resource-wire.ts), never a stored column. Equals `createdAt` for a
     *  Chat with no messages yet. */
    lastActivityAt: z.string(),
    /** S8 W4 (audit C1 "状态副标题"): whether the Chat currently has a Turn in `status='running'`
     *  — read back from the same partial unique index `sendChatMessage` relies on
     *  (`activities_one_running_turn_per_chat_uidx`), not a second source of truth. */
    hasRunningTurn: z.boolean(),
  })
  .strict();
export type ChatWire = z.infer<typeof ChatWireSchema>;

/** `get_chat_history`/`subscribe_chat` replay item (application/gateway/handlers.ts
 *  `toWireChatMessage`) — deliberately looser than `chat.message`'s own push payload (`content`
 *  here is always present, `kind` always at least `undefined`), matching what that projection
 *  function actually returns today. */
export const ChatMessageWireSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    text: z.string(),
    content: z.record(z.string(), z.unknown()),
    kind: z.string().optional(),
    createdAt: z.string(),
    sequence: z.number(),
  })
  .strict();
export type ChatMessageWire = z.infer<typeof ChatMessageWireSchema>;
