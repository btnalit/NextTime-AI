import type { ChatMessage } from './ws-client.js';

/**
 * lib/chat-messages: keeps a Chat's persisted message list sorted ascending by `sequence`.
 * `WsClient.subscribeChat`'s `onMessage` already guarantees each `sequence` fires at most once
 * (see ws-client.ts's own doc comment), but delivery order across the initial history pages and
 * live pushes is not guaranteed to already be ascending (a live push can arrive interleaved with
 * a still-in-flight page) — this is the one place that gets sorted for rendering.
 */
export function insertChatMessage(
  messages: readonly ChatMessage[],
  message: ChatMessage,
): readonly ChatMessage[] {
  if (messages.some((existing) => existing.sequence === message.sequence)) return messages;
  const next = [...messages, message];
  next.sort((a, b) => a.sequence - b.sequence);
  return next;
}
