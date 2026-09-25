import type { ChatWire } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_TITLE_MAX_CHARS,
  applyChatMetadata,
  archiveChat,
  chatTitle,
  isArchived,
  normalizeChatTitle,
  renameChat,
  spliceChat,
  unarchiveChat,
} from './chat-lifecycle.js';

/** `chatTitle` takes `t` from its (component) caller (S8 W1-A9) — a plain zh-CN picker stands in
 *  for it here, same as every test's default-language expectation elsewhere in this lane. */
const t = <T>(zh: T, _en: T): T => zh;

function chat(overrides: Partial<ChatWire> = {}): ChatWire {
  return {
    id: 'chat-1',
    ownerPrincipalId: 'p-1',
    title: 'Ops chat',
    visibility: 'private',
    createdAt: '2026-09-01T00:00:00.000Z',
    archivedAt: null,
    lastActivityAt: '2026-09-01T00:00:00.000Z',
    hasRunningTurn: false,
    ...overrides,
  };
}

describe('chatTitle / isArchived', () => {
  it('reads a null or empty title as the new-chat placeholder', () => {
    expect(chatTitle(chat({ title: null }), t)).toBe('新对话');
    expect(chatTitle(chat({ title: '' }), t)).toBe('新对话');
    expect(chatTitle(null, t)).toBe('新对话');
    expect(chatTitle(chat(), t)).toBe('Ops chat');
  });

  it('archivedAt is the status; a row without the key (older kernel) is active', () => {
    expect(isArchived(chat())).toBe(false);
    expect(isArchived(chat({ archivedAt: '2026-09-02T00:00:00.000Z' }))).toBe(true);
    expect(isArchived({ archivedAt: undefined as unknown as null })).toBe(false);
  });
});

describe('normalizeChatTitle (mirror of the kernel rule)', () => {
  it('trims, collapses inner whitespace and refuses a blank title', () => {
    expect(normalizeChatTitle('  restart   web-1 \n please ')).toBe('restart web-1 please');
    expect(normalizeChatTitle('   \n\t ')).toBeNull();
    expect(normalizeChatTitle('')).toBeNull();
  });

  it('cuts to 200 code points without splitting a surrogate pair', () => {
    const long = `${'龙'.repeat(199)}😀x`;
    const normalized = normalizeChatTitle(long);
    expect(normalized).not.toBeNull();
    expect(Array.from(normalized as string)).toHaveLength(CHAT_TITLE_MAX_CHARS);
    expect((normalized as string).endsWith('😀')).toBe(true);
  });
});

describe('spliceChat', () => {
  it('replaces the matching entry in place and keeps the order', () => {
    const list = [chat({ id: 'a' }), chat({ id: 'b' }), chat({ id: 'c' })];
    const next = spliceChat(list, chat({ id: 'b', title: 'renamed' }));
    expect(next.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(next[1]?.title).toBe('renamed');
    expect(next[0]).toBe(list[0]);
  });

  it('returns the same list when the chat is not held', () => {
    const list = [chat({ id: 'a' })];
    expect(spliceChat(list, chat({ id: 'z' }))).toBe(list);
  });
});

describe('applyChatMetadata', () => {
  it('applies a title push and an archivedAt push, and ignores a Turn-end push', () => {
    const base = chat({ title: null });
    const titled = applyChatMetadata(base, { title: 'restart web-1' });
    expect(titled.title).toBe('restart web-1');
    const archived = applyChatMetadata(titled, { archivedAt: '2026-09-02T00:00:00.000Z' });
    expect(archived.archivedAt).toBe('2026-09-02T00:00:00.000Z');
    const restored = applyChatMetadata(archived, { archivedAt: null });
    expect(restored.archivedAt).toBeNull();
    expect(applyChatMetadata(restored, { turnId: 't-1', turnStatus: 'completed' })).toBe(restored);
  });

  it('returns the same object when nothing changes, so state updates can key on identity', () => {
    const base = chat();
    expect(applyChatMetadata(base, { title: 'Ops chat' })).toBe(base);
    expect(applyChatMetadata(base, { archivedAt: null })).toBe(base);
    expect(applyChatMetadata(base, { archivedAt: 42 })).toBe(base);
  });
});

describe('capability wrappers', () => {
  it('call archive_chat / unarchive_chat / rename_chat with the documented params', async () => {
    const call = vi.fn(async (name: string) => chat({ title: name }));
    const client = { call } as unknown as Parameters<typeof archiveChat>[0];
    await archiveChat(client, 'chat-1');
    await unarchiveChat(client, 'chat-1');
    await renameChat(client, 'chat-1', 'New name');
    expect(call.mock.calls).toEqual([
      ['archive_chat', { chatId: 'chat-1' }],
      ['unarchive_chat', { chatId: 'chat-1' }],
      ['rename_chat', { chatId: 'chat-1', title: 'New name' }],
    ]);
  });
});
