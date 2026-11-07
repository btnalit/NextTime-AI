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
import { type TurnState, initialTurnState, streamReducer } from '../../lib/streaming-reducer.js';
import type { WsClient } from '../../lib/ws-client.js';

export interface ComposerState {
  readonly composerText: string;
  readonly setComposerText: (text: string) => void;
  /** The draft holds U+0000, which the kernel refuses to store (`unstorable_text`). */
  readonly hasUnstorableChar: boolean;
  /** Legacy 335: takes every U+0000 out of the draft, clears the refusal and returns focus to the
   *  box; it does not send — the person checks the message first. Returns how many it removed. */
  readonly removeUnstorableChars: () => number;
  readonly busy: boolean;
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
): ComposerState {
  const [composerText, setComposerText] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // One effect, so the first run for a scope restores before anything is kept: keeping the empty
  // box first would throw away the very draft there is to restore. Text typed before the caller
  // was known wins over a stored draft — it is newer — and is kept from then on.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (draftScope === null) return;
    if (restoredFor.current !== draftScope) {
      restoredFor.current = draftScope;
      const stored = composerText === '' ? loadDraft(draftScope) : null;
      if (stored !== null) {
        setComposerText(stored);
        return;
      }
    }
    saveDraft(draftScope, composerText);
  }, [draftScope, composerText]);

  async function send(): Promise<void> {
    const text = composerText.trim();
    if (!text || turnStatus === 'running' || busy || archived) return;
    setSendError(null);
    setBusy(true);
    try {
      const result = await client.sendChatMessage(chatId, text);
      setTurn(streamReducer(initialTurnState, { kind: 'turnStarted', turnId: result.turnId }));
      setComposerText('');
      setFollow(true);
      textareaRef.current?.focus();
    } catch (err) {
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
    textareaRef,
    composerDisabled,
    handleSubmit,
    handleComposerKeyDown,
    handleStop,
  };
}
