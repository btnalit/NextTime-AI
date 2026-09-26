import {
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useRef,
  useState,
} from 'react';
import { type TurnState, initialTurnState, streamReducer } from '../../lib/streaming-reducer.js';
import type { WsClient } from '../../lib/ws-client.js';

export interface ComposerState {
  readonly composerText: string;
  readonly setComposerText: (text: string) => void;
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
 */
export function useComposer(
  client: WsClient,
  chatId: string,
  turnStatus: TurnState['status'],
  archived: boolean,
  setTurn: Dispatch<SetStateAction<TurnState>>,
  setSendError: Dispatch<SetStateAction<unknown | null>>,
  setFollow: (next: boolean) => void,
): ComposerState {
  const [composerText, setComposerText] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const composerDisabled = turnStatus === 'running' || busy || archived;

  return {
    composerText,
    setComposerText,
    busy,
    textareaRef,
    composerDisabled,
    handleSubmit,
    handleComposerKeyDown,
    handleStop,
  };
}
