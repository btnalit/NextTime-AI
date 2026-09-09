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
