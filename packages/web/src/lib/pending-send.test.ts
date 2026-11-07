// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPendingSend,
  newIdempotencyKey,
  pendingSendFor,
  pendingSendLanded,
  savePendingSend,
} from './pending-send.js';
import type { ChatMessage } from './ws-client.js';

afterEach(() => sessionStorage.clear());

function message(sequence: number, role: ChatMessage['role'], text: string): ChatMessage {
  return { id: `m-${sequence}`, role, text, createdAt: '2026-11-07T00:00:00.000Z', sequence };
}

describe('lib/pending-send (legacy 673)', () => {
  it('makes 128-bit hex keys, a new one each time', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it('reuses the key for the same text and counts a new text from the chat as it is now', () => {
    const chat = [message(4, 'user', 'hello'), message(5, 'assistant', 'hi')];
    const first = pendingSendFor('restart web-1', null, chat);
    expect(first.afterSequence).toBe(5);
    expect(pendingSendFor('restart web-1', first, [...chat, message(6, 'system', 'x')])).toBe(
      first,
    );
    const edited = pendingSendFor('restart web-2', first, chat);
    expect(edited.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('sees the message only when the person’s own text lands after the send', () => {
    const pending = { text: 'hello', idempotencyKey: 'k', afterSequence: 5 };
    expect(pendingSendLanded(pending, [message(4, 'user', 'hello')])).toBe(false);
    expect(pendingSendLanded(pending, [message(6, 'assistant', 'hello')])).toBe(false);
    expect(pendingSendLanded(pending, [message(6, 'user', 'hello\n')])).toBe(true);
  });

  it('keeps the send next to the draft, and forgets it', () => {
    const pending = { text: 'hello', idempotencyKey: 'k', afterSequence: 5 };
    savePendingSend('p-1/chat-1', pending);
    expect(loadPendingSend('p-1/chat-1')).toEqual(pending);
    expect(loadPendingSend('p-2/chat-1')).toBeNull();
    savePendingSend('p-1/chat-1', null);
    expect(loadPendingSend('p-1/chat-1')).toBeNull();
  });
});
