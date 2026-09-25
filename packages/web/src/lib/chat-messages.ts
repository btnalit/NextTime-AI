import type { Translate } from './i18n.js';
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

/** S8 W4 (audit C4 "角色标签原样显示 user / assistant"): the reader-facing name for a
 *  `ChatMessage.role` — never the raw wire enum value (audit's own long-standing rule against raw
 *  enums in visible text, `lib/labels.ts`'s module doc). `tool`/`system` are covered too, even
 *  though `ChatPage` only ever renders a `user`/`assistant` row through this today (`tool`/
 *  `system` rows resolve to an inline card or status line first) — a future bare row of either
 *  kind reads as a name, not a wire value, without this helper needing a second call site. */
export function messageRoleLabel(role: string, t: Translate): string {
  switch (role) {
    case 'user':
      return t('你', 'You');
    case 'assistant':
      return t('入口 agent', 'Entry agent');
    case 'tool':
      return t('工具', 'Tool');
    case 'system':
      return t('系统', 'System');
    default:
      return role;
  }
}
