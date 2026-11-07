import { forgetDraft, loadDraftValue, saveDraftValue } from './drafts.js';
import type { ChatMessage } from './ws-client.js';

/**
 * lib/pending-send (legacy 673): the chat message box's send that has not been answered yet.
 *
 * A send can time out, or lose its socket, after the kernel already took it: the request arrives
 * late (TCP retransmits it once the network is back), runs, and the message turns up in the chat
 * while the page still says it failed. Sending the draft again used to start a second, identical
 * Turn — with its own tool calls and approvals. So every draft gets an `idempotencyKey`: trying
 * the same text again reuses it, and the kernel answers a second try with the first message
 * (`changed: false`) instead of writing another. Editing the text, or a send that went through,
 * gives the next one a new key.
 *
 * Kept next to the draft (`lib/drafts.ts`, same `sessionStorage` rules and scope) so a reload
 * keeps the key too — the restored draft sent again is still the same message.
 */
export interface PendingSend {
  /** The text as sent (trimmed). */
  readonly text: string;
  readonly idempotencyKey: string;
  /** The highest `sequence` the chat showed when this text was first sent: the message, if it
   *  landed, is after it. */
  readonly afterSequence: number;
}

/** 128 random bits as hex. `crypto.getRandomValues`, not `randomUUID`: the console is also served
 *  over plain HTTP on a LAN, where `randomUUID` does not exist. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function storageScope(draftScope: string): string {
  return `${draftScope}#send`;
}

export function loadPendingSend(draftScope: string): PendingSend | null {
  const value = loadDraftValue(storageScope(draftScope));
  if (!value || typeof value !== 'object') return null;
  const { text, idempotencyKey, afterSequence } = value as Record<string, unknown>;
  if (
    typeof text !== 'string' ||
    typeof idempotencyKey !== 'string' ||
    typeof afterSequence !== 'number'
  ) {
    return null;
  }
  return { text, idempotencyKey, afterSequence };
}

export function savePendingSend(draftScope: string, pending: PendingSend | null): void {
  if (pending === null) forgetDraft(storageScope(draftScope));
  else saveDraftValue(storageScope(draftScope), pending);
}

/** The send to make for `text`: the same key again when it is the text last tried, else a new
 *  one counted from the chat as it is now. */
export function pendingSendFor(
  text: string,
  previous: PendingSend | null,
  messages: readonly ChatMessage[],
): PendingSend {
  if (previous !== null && previous.text === text) return previous;
  return { text, idempotencyKey: newIdempotencyKey(), afterSequence: lastSequence(messages) };
}

/** Whether the chat now shows the message `pending` tried to send. */
export function pendingSendLanded(pending: PendingSend, messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'user' &&
      message.sequence > pending.afterSequence &&
      message.text.trim() === pending.text,
  );
}

function lastSequence(messages: readonly ChatMessage[]): number {
  let last = 0;
  for (const message of messages) last = Math.max(last, message.sequence);
  return last;
}
