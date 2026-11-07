import { UNSTORABLE_CHAR } from '@nexttime/shared';
import {
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import { loadDraft, saveDraft } from '../../lib/drafts.js';
import { describeError } from '../../lib/errors.js';
import {
  type PendingSend,
  loadPendingSend,
  pendingSendFor,
  pendingSendLanded,
  savePendingSend,
} from '../../lib/pending-send.js';
import { type TurnState, streamReducer } from '../../lib/streaming-reducer.js';
import { type ChatMessage, RpcTimeoutError, type WsClient } from '../../lib/ws-client.js';

export interface ComposerState {
  readonly composerText: string;
  readonly setComposerText: (text: string) => void;
  /** The draft holds U+0000, which the kernel refuses to store (`unstorable_text`). */
  readonly hasUnstorableChar: boolean;
  /** Legacy 335: takes every U+0000 out of the draft, clears the refusal and returns focus to the
   *  box; it does not send — the person checks the message first. Returns how many it removed. */
  readonly removeUnstorableChars: () => number;
  readonly busy: boolean;
  /** Legacy 673: the last send got no answer — it timed out, or its connection closed under it —
   *  so it may have gone through. Cleared once the message shows up in the chat, the send is
   *  tried again, or the text is edited. */
  readonly sendUncertain: boolean;
  /** Legacy 673: the box still holds the text of the send that got no answer, so sending it again
   *  reuses that send's key — it cannot come out twice. */
  readonly resendable: boolean;
  /** Legacy 673: sends the draft again (under the same key while `resendable`). */
  readonly resend: () => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly composerDisabled: boolean;
  readonly handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly handleComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly handleStop: () => Promise<void>;
}

/**
 * components/chat/useComposer: `ChatPage`'s message box. The human channel has no "is a Turn
 * running" read (S1.8 假设与偏离); the composer starts enabled and learns of a foreign Turn from
 * `send_chat_message`'s -32010 (`TurnAlreadyRunningError`, surfaced via `setSendError` from the
 * caller). An archived chat is read-only *here* — the kernel does not refuse `send_chat_message` on
 * an archived chat, so this is a client-side rule.
 *
 * Legacy 658: the unsent text is kept under `draftScope` (`lib/drafts.ts`, who is typing in which
 * chat) as it changes, and put back into an empty box when the box opens again for the same scope —
 * after a session expired under it and the person signed in again, or after they left the chat.
 * `null` while the caller is not known yet: nothing is read or kept until it is.
 *
 * Legacy 673: each draft is sent under an idempotency key (`lib/pending-send.ts`), kept until the
 * send is answered. A send that got no answer may still have run, so the key stays: sending the
 * same text again — 「再发一次」 or the send button — reuses it, and the kernel answers with the
 * first message instead of starting a second Turn. When the message turns up in `messages` (the
 * late request ran), the draft and the note go by themselves.
 */
export function useComposer(
  client: WsClient,
  chatId: string,
  turnStatus: TurnState['status'],
  archived: boolean,
  setTurn: Dispatch<SetStateAction<TurnState>>,
  setSendError: Dispatch<SetStateAction<unknown | null>>,
  setFollow: (next: boolean) => void,
  draftScope: string | null,
  messages: readonly ChatMessage[],
): ComposerState {
  const [composerText, setComposerText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendUncertain, setSendUncertain] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<PendingSend | null>(null);

  function keepPending(next: PendingSend | null): void {
    pending.current = next;
    if (draftScope !== null) savePendingSend(draftScope, next);
  }

  // One effect, so the first run for a scope restores before anything is kept: keeping the empty
  // box first would throw away the very draft there is to restore. Text typed before the caller
  // was known wins over a stored draft — it is newer — and is kept from then on.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (draftScope === null) return;
    if (restoredFor.current !== draftScope) {
      restoredFor.current = draftScope;
      pending.current = loadPendingSend(draftScope);
      const stored = composerText === '' ? loadDraft(draftScope) : null;
      if (stored !== null) {
        setComposerText(stored);
        return;
      }
    }
    saveDraft(draftScope, composerText);
  }, [draftScope, composerText]);

  // Legacy 673: the send that got no answer ran after all — its message is in the chat now.
  // Not while a send is in flight: its own answer clears the box.
  useEffect(() => {
    const tried = pending.current;
    if (busy || tried === null || !pendingSendLanded(tried, messages)) return;
    keepPending(null);
    setComposerText((current) => (current.trim() === tried.text ? '' : current));
    if (sendUncertain) {
      setSendUncertain(false);
      setSendError(null);
    }
  });

  async function send(): Promise<void> {
    const text = composerText.trim();
    if (!text || turnStatus === 'running' || busy || archived) return;
    const attempt = pendingSendFor(text, pending.current, messages);
    // The same message again after a send that got no answer: until this try is answered, what
    // the page knows is still that the first may have gone out.
    const resending = sendUncertain && attempt.idempotencyKey === pending.current?.idempotencyKey;
    keepPending(attempt);
    if (!resending) {
      setSendError(null);
      setSendUncertain(false);
    }
    setBusy(true);
    try {
      const result = await client.sendChatMessage(chatId, text, attempt.idempotencyKey);
      keepPending(null);
      setSendError(null);
      setSendUncertain(false);
      // A second try the kernel answered with the first message: its Turn may be over already,
      // and a finished Turn sends no end push — marking it running would hold the box shut.
      if (result.changed !== false || result.turnStatus === 'running') {
        // Its first pushes may have come before this answer: the reducer keeps them.
        setTurn((prev) => streamReducer(prev, { kind: 'turnStarted', turnId: result.turnId }));
      }
      setComposerText('');
      setFollow(true);
      textareaRef.current?.focus();
    } catch (err) {
      // Refused before it left (no connection): it says nothing about the first try, so the note
      // that it may have gone out stays, and so does 「再发一次」 for when the connection is back.
      if (resending && neverLeft(err)) return;
      if (describeError(err).code === 'idempotency_key_reused') keepPending(null);
      setSendUncertain(answerLost(err));
      setSendError(err);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void send();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function handleStop(): Promise<void> {
    setBusy(true);
    try {
      await client.stopAgent(chatId);
    } catch (err) {
      setSendError(err);
    } finally {
      setBusy(false);
    }
  }

  function removeUnstorableChars(): number {
    const removed = composerText.split(UNSTORABLE_CHAR).length - 1;
    setComposerText(composerText.replaceAll(UNSTORABLE_CHAR, ''));
    setSendError(null);
    textareaRef.current?.focus();
    return removed;
  }

  const composerDisabled = turnStatus === 'running' || busy || archived;

  return {
    composerText,
    setComposerText,
    hasUnstorableChar: composerText.includes(UNSTORABLE_CHAR),
    removeUnstorableChars,
    busy,
    sendUncertain,
    resendable: sendUncertain && composerText.trim() === pending.current?.text,
    resend: () => void send(),
    textareaRef,
    composerDisabled,
    handleSubmit,
    handleComposerKeyDown,
    handleStop,
  };
}

/** The send was refused before it left the page: it did not run. */
function neverLeft(err: unknown): boolean {
  return err instanceof Error && err.message === 'WsClient: not connected';
}

/** A send whose answer never came: the deadline passed, or the socket closed while it was out
 *  (`WsClient` rejects what is in flight with "connection closed"). A send refused before it left
 *  ("not connected") or answered with an error did not run. */
function answerLost(err: unknown): boolean {
  return (
    err instanceof RpcTimeoutError ||
    (err instanceof Error && err.message === 'WsClient: connection closed')
  );
}
