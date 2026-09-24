import type { ChatWire } from '@nexttime/shared';
import type { CapabilityCaller } from './clients.js';
import type { Translate } from './i18n.js';

/**
 * lib/chat-lifecycle: the S6-A chat lifecycle on the client (docs/console-completion-plan.md §4
 * "Chat 生命周期", §5.1 "归档与改名"; the kernel half is `application/chat/service.ts`
 * `renameChat` / `setChatArchived` / `autoTitleChat`). Pure helpers over the `ChatWire` shape
 * plus the three thin capability wrappers — `ChatListPage` and the open chat's header both go
 * through here, so the list splice, the metadata push and the title rules are written once.
 *
 * Wire facts this module relies on (packages/shared/src/wire/chat.ts, capabilities.ts):
 *   - `archivedAt: string | null` — `null` is active; the timestamp *is* the status.
 *   - `list_chats{includeArchived?}` hides archived rows by default.
 *   - `archive_chat` / `unarchive_chat` / `rename_chat` each return the updated `ChatWire` —
 *     the page splices that row into its cache (`spliceChat`) rather than refetching.
 *   - `chat.metadata {title}` / `{archivedAt}` arrives on the per-chat subscription only
 *     (`applyChatMetadata`); the list page never sees it, hence the splice.
 *   - Auto-title: the first user message's first 40 code points; a rename is never overwritten.
 */

/** The list row / open chat's identity — the full wire shape, no local subset (S6-A). */
export type ChatSummary = ChatWire;

/** `rename_chat`'s ceiling (`packages/shared/src/capabilities.ts` `rename_chat.paramsSchema`). */
export const CHAT_TITLE_MAX_CHARS = 200;

/** What a chat with no title yet reads as: the kernel writes the auto-title when the first user
 *  message lands, so `title: null` means "nothing said yet", not "untitled forever". S8 W1-A9: a
 *  plain lib helper (not a component/hook), so it takes `t` from its caller (every caller is a
 *  component that already has one) rather than calling `useT()` itself. */
export function chatTitle(chat: Pick<ChatWire, 'title'> | null | undefined, t: Translate): string {
  const title = chat?.title;
  return title === null || title === undefined || title === '' ? t('新对话', 'New chat') : title;
}

/** `archivedAt` is the status. Read as "is a timestamp" rather than `!== null` so a row from a
 *  kernel predating migration 0031 (no `archivedAt` key at all) still counts as active. */
export function isArchived(chat: Pick<ChatWire, 'archivedAt'>): boolean {
  return typeof chat.archivedAt === 'string';
}

/** Client-side mirror of the kernel's `normalizeChatTitle` (application/chat/service.ts): one
 *  line, trimmed, inner whitespace collapsed, cut to `CHAT_TITLE_MAX_CHARS` *code points*;
 *  `null` when nothing printable is left — the rename form then refuses to submit rather than
 *  sending what the kernel's `regex(/\S/)` would 400. */
export function normalizeChatTitle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  const chars = Array.from(collapsed);
  return chars.length <= CHAT_TITLE_MAX_CHARS
    ? collapsed
    : chars.slice(0, CHAT_TITLE_MAX_CHARS).join('').trimEnd();
}

/** Replaces the entry with `chat.id` in place (list order is the kernel's, newest first — a
 *  splice never reorders). A chat the list does not hold is left out, not appended: the list
 *  page decides what its current filter shows. */
export function spliceChat(list: readonly ChatWire[], chat: ChatWire): readonly ChatWire[] {
  if (!list.some((entry) => entry.id === chat.id)) return list;
  return list.map((entry) => (entry.id === chat.id ? chat : entry));
}

/** Applies one `chat.metadata` push to the open chat. Only the two lifecycle keys are read
 *  (`title` from auto-title / rename, `archivedAt` from archive / unarchive); a Turn-end push
 *  (`{turnId, turnStatus}`) or anything else returns the same object, so callers can key state
 *  updates on identity. */
export function applyChatMetadata(
  chat: ChatWire,
  metadata: Readonly<Record<string, unknown>>,
): ChatWire {
  let next = chat;
  if (typeof metadata.title === 'string' && metadata.title !== chat.title) {
    next = { ...next, title: metadata.title };
  }
  if ('archivedAt' in metadata) {
    const archivedAt = metadata.archivedAt;
    if ((archivedAt === null || typeof archivedAt === 'string') && archivedAt !== chat.archivedAt) {
      next = { ...next, archivedAt };
    }
  }
  return next;
}

/** `archive_chat` — own chat, or any visible chat for the workspace owner (403 otherwise). */
export function archiveChat(client: CapabilityCaller, chatId: string): Promise<ChatWire> {
  return client.call<ChatWire>('archive_chat', { chatId });
}

/** `unarchive_chat` — the undo of `archiveChat`; same ownership rule. */
export function unarchiveChat(client: CapabilityCaller, chatId: string): Promise<ChatWire> {
  return client.call<ChatWire>('unarchive_chat', { chatId });
}

/** `rename_chat` — own chat only (the workspace owner may archive others' chats but never
 *  rename them). `title` must already be normalized (`normalizeChatTitle`). */
export function renameChat(
  client: CapabilityCaller,
  chatId: string,
  title: string,
): Promise<ChatWire> {
  return client.call<ChatWire>('rename_chat', { chatId, title });
}
