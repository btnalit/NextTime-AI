import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { type ChatSummary, applyChatMetadata } from '../../lib/chat-lifecycle.js';
import { insertChatMessage } from '../../lib/chat-messages.js';
import { type TurnState, initialTurnState, streamReducer } from '../../lib/streaming-reducer.js';
import {
  type ChatMessage,
  type ChatSubscriptionHandlers,
  TurnAlreadyRunningError,
  type WsClient,
} from '../../lib/ws-client.js';

export interface ChatMessagesState {
  readonly messages: readonly ChatMessage[];
  readonly turn: TurnState;
  readonly setTurn: Dispatch<SetStateAction<TurnState>>;
  readonly caughtUp: boolean;
  readonly subscribeError: unknown | null;
}

/**
 * components/chat/useChatMessages: the one `WsClient.subscribeChat` call `ChatPage` feeds off —
 * `messages` (persisted history, kept sorted by `sequence`, `lib/chat-messages.ts`) and `turn` (the
 * running Turn's ephemeral stream, `lib/streaming-reducer.ts`). Always called with `startAfter=0` —
 * a fresh mount walks complete history ("刷新后历史完整"); the client's own reconnect logic resumes
 * separately.
 *
 * Every `chat.metadata` push also updates the chat row (`setChat` — a rename / auto-title / archive
 * / restore) and clears a stale "foreign Turn" composer error (`setSendError`) once a Turn-end push
 * says the chat's one running Turn ended. `setChat`/`setSendError` are plain `useState` setters
 * (referentially stable across renders), so taking them as parameters here — rather than owning
 * that state itself — never causes an extra resubscribe, even though they are listed in this
 * effect's own dependency array.
 */
export function useChatMessages(
  client: WsClient,
  chatId: string,
  setChat: Dispatch<SetStateAction<ChatSummary | null>>,
  setSendError: Dispatch<SetStateAction<unknown | null>>,
): ChatMessagesState {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [turn, setTurn] = useState(initialTurnState);
  const [caughtUp, setCaughtUp] = useState(false);
  const [subscribeError, setSubscribeError] = useState<unknown | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setMessages([]);
    setTurn(initialTurnState);
    setCaughtUp(false);
    setSubscribeError(null);

    const handlers: ChatSubscriptionHandlers = {
      onMessage: (message) => {
        if (!cancelled) setMessages((prev) => insertChatMessage(prev, message));
      },
      onStream: (turnId, payload) => {
        if (!cancelled) setTurn((prev) => streamReducer(prev, { kind: 'stream', turnId, payload }));
      },
      onMetadata: (metadata) => {
        if (cancelled) return;
        setTurn((prev) => streamReducer(prev, { kind: 'metadata', metadata }));
        // Lifecycle pushes (`{title}` from the auto-title / a rename, `{archivedAt}` from
        // archive / restore) update the header and the read-only state in place.
        setChat((prev) => (prev ? applyChatMetadata(prev, metadata) : prev));
        // A Turn-end push (`{turnId, turnStatus}`) means the chat's one running Turn ended (one
        // running Turn per chat) — a lifecycle push says nothing about that, so it is gated.
        if (typeof metadata.turnStatus === 'string') {
          setSendError((prev: unknown) => (prev instanceof TurnAlreadyRunningError ? null : prev));
        }
      },
      onCaughtUp: () => {
        if (!cancelled) setCaughtUp(true);
      },
    };

    client
      .subscribeChat(chatId, 0, handlers)
      .then((unsub) => {
        if (cancelled) unsub();
        else unsubscribe = unsub;
      })
      .catch((err: unknown) => {
        if (!cancelled) setSubscribeError(err);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, chatId, setChat, setSendError]);

  return { messages, turn, setTurn, caughtUp, subscribeError };
}
