import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { actionCardFromPendingContent, isPendingCardMessage } from '../lib/action-card.js';
import { insertChatMessage } from '../lib/chat-messages.js';
import { errorMessage } from '../lib/errors.js';
import type { HttpClient } from '../lib/http-client.js';
import { initialTurnState, streamReducer } from '../lib/streaming-reducer.js';
import { systemStatusLineFromMessage } from '../lib/system-status.js';
import type { ChatMessage, ChatSubscriptionHandlers, WsClient } from '../lib/ws-client.js';
import { TurnAlreadyRunningError } from '../lib/ws-client.js';
import { ActionRequestCard } from './ActionRequestCard.js';
import { SystemStatusLineView } from './SystemStatusLineView.js';
import { ToolCallRowView } from './ToolCallRowView.js';
import { TurnStatusBadge } from './TurnStatusBadge.js';

export interface ChatPageProps {
  readonly client: WsClient;
  readonly httpClient: HttpClient;
  readonly chatId: string;
  readonly onBack: () => void;
  readonly onForgetKey: () => void;
}

interface CardCallState {
  readonly busy: boolean;
  readonly error: string | null;
}

const IDLE_CARD_STATE: CardCallState = { busy: false, error: null };

/**
 * components/ChatPage: the conversation view (design doc §7.6; docs/development-tasks.md S1.8
 * deliverables 1 and 4 acceptance flow). Owns two independent pieces of state fed by one
 * `WsClient.subscribeChat` call:
 *   - `messages`: persisted history, kept sorted by `sequence` (lib/chat-messages.ts) — both the
 *     initial "subscribe first, then page" catch-up and every later live `chat.message` push land
 *     here through the exact same `onMessage` callback, already deduped by `WsClient` itself.
 *   - `turn`: the current Turn's ephemeral state (lib/streaming-reducer.ts), fed by `chat.stream`/
 *     `chat.metadata` pushes and by this component's own `send_chat_message` result (nothing on
 *     the wire announces "a Turn started" to the human channel — see streaming-reducer.ts's
 *     `turnStarted` action doc comment).
 *
 * `subscribeChat` is always called with `startAfter=0` here — a fresh mount (including a full
 * page reload) always walks complete history from the beginning (docs/development-tasks.md S1.8
 * acceptance: "刷新后历史完整"); `WsClient`'s own reconnect logic (a live socket drop mid-session)
 * separately resumes from the last sequence it already delivered, which is a different scenario
 * than opening this page.
 *
 * 假设与偏离 (see PR body): the human channel has no capability to read "is a Turn currently
 * running on this chat" on open (`get_entry_context` is Handle-channel only, S1 scope). This page
 * therefore always starts with the composer enabled and relies on `send_chat_message`'s `-32010`
 * response (`TurnAlreadyRunningError`) to discover a Turn already in progress — shown as an inline
 * notice rather than a pre-emptive disabled state. `stop_agent` does not require knowing the
 * Turn's id (the handler resolves the chat's own running Turn server-side), so the Stop button is
 * always available regardless of whether this page itself started the Turn.
 */
export function ChatPage({ client, httpClient, chatId, onBack, onForgetKey }: ChatPageProps) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [turn, setTurn] = useState(initialTurnState);
  const [caughtUp, setCaughtUp] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [sendError, setSendError] = useState<string | TurnAlreadyRunningError | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  // S2.10: live `action.updated` overrides for a pending card's status, keyed by actionRequestId —
  // see lib/action-card.ts's module doc comment for why `system.action_pending` alone never carries
  // an up-to-date status. Complements (does not replace) deriving the latest status from a later
  // `system.action_update` message already in `messages` (the `latestActionStatus` memo below) —
  // the two agree once that message has arrived; this map is what makes a card react *before* it
  // does (or when the update landed in a different chat than this one — `action.updated` is
  // principal-scoped, not chat-scoped, so it still reaches this page either way).
  const [actionStatusOverrides, setActionStatusOverrides] = useState<
    Readonly<Record<string, string>>
  >({});
  const [cardState, setCardState] = useState<Readonly<Record<string, CardCallState>>>({});

  useEffect(() => {
    return client.onActionUpdated((event) => {
      setActionStatusOverrides((prev) => ({ ...prev, [event.actionRequestId]: event.status }));
    });
  }, [client]);

  // Latest `system.action_update` status per actionRequestId already visible in this chat's
  // history (`messages` is kept ascending by `sequence`, lib/chat-messages.ts, so a later entry
  // always overwrites an earlier one here).
  const latestActionStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      const line = systemStatusLineFromMessage(message);
      if (line?.variant === 'action_update') map.set(line.actionRequestId, line.status);
    }
    return map;
  }, [messages]);

  function setCardBusy(actionRequestId: string, busyValue: boolean): void {
    setCardState((prev) => ({
      ...prev,
      [actionRequestId]: { busy: busyValue, error: prev[actionRequestId]?.error ?? null },
    }));
  }

  function setCardError(actionRequestId: string, error: string | null): void {
    setCardState((prev) => ({ ...prev, [actionRequestId]: { busy: false, error } }));
  }

  async function handleApprove(actionRequestId: string): Promise<void> {
    setCardBusy(actionRequestId, true);
    try {
      const result = await httpClient.call<{ status: string }>('approve', { actionRequestId });
      setActionStatusOverrides((prev) => ({ ...prev, [actionRequestId]: result.status }));
      setCardState((prev) => ({ ...prev, [actionRequestId]: IDLE_CARD_STATE }));
    } catch (err) {
      setCardError(actionRequestId, errorMessage(err));
    }
  }

  async function handleReject(actionRequestId: string, reason: string | undefined): Promise<void> {
    setCardBusy(actionRequestId, true);
    try {
      const result = await httpClient.call<{ status: string }>('reject', {
        actionRequestId,
        ...(reason !== undefined ? { reason } : {}),
      });
      setActionStatusOverrides((prev) => ({ ...prev, [actionRequestId]: result.status }));
      setCardState((prev) => ({ ...prev, [actionRequestId]: IDLE_CARD_STATE }));
    } catch (err) {
      setCardError(actionRequestId, errorMessage(err));
    }
  }

  async function handleAlwaysApprove(actionRequestId: string, actionKind: string): Promise<void> {
    setCardBusy(actionRequestId, true);
    try {
      await httpClient.call('set_auto_approved_action_kind', { actionKind });
      setCardState((prev) => ({ ...prev, [actionRequestId]: IDLE_CARD_STATE }));
    } catch (err) {
      setCardError(actionRequestId, errorMessage(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    setMessages([]);
    setTurn(initialTurnState);
    setCaughtUp(false);

    const handlers: ChatSubscriptionHandlers = {
      onMessage: (message) => {
        if (cancelled) return;
        setMessages((prev) => insertChatMessage(prev, message));
      },
      onStream: (turnId, payload) => {
        if (cancelled) return;
        setTurn((prev) => streamReducer(prev, { kind: 'stream', turnId, payload }));
      },
      onMetadata: (metadata) => {
        if (cancelled) return;
        setTurn((prev) => streamReducer(prev, { kind: 'metadata', metadata }));
        // See this file's module doc comment: any chat.metadata is treated as "the chat's one
        // running Turn just ended" for the purpose of clearing a foreign -32010 notice, since
        // activities_one_running_turn_per_chat_uidx (migrations/core/0008_chat_messages.sql)
        // guarantees at most one running Turn per chat regardless of who started it.
        setSendError((prev) => (prev instanceof TurnAlreadyRunningError ? null : prev));
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
        if (!cancelled) setSendError(errorMessage(err));
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, chatId]);

  // Re-runs the scroll-to-bottom effect whenever new content is added (a persisted message, a
  // streamed delta, or a tool-call row) — none of these are read in the body, only used to
  // trigger the effect, hence the lint suppression below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, turn.streamingText, turn.toolCalls.length]);

  async function handleSend(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = composerText.trim();
    if (!text || turn.status === 'running') return;
    setSendError(null);
    setBusy(true);
    try {
      const result = await client.sendChatMessage(chatId, text);
      setTurn(streamReducer(initialTurnState, { kind: 'turnStarted', turnId: result.turnId }));
      setComposerText('');
    } catch (err) {
      if (err instanceof TurnAlreadyRunningError) {
        setSendError(err);
      } else {
        setSendError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(): Promise<void> {
    setBusy(true);
    try {
      await client.stopAgent(chatId);
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const composerDisabled = turn.status === 'running' || busy;

  function renderMessage(message: ChatMessage) {
    if (isPendingCardMessage(message) && message.content) {
      const card = actionCardFromPendingContent(message.content);
      if (card) {
        const effectiveStatus =
          actionStatusOverrides[card.actionRequestId] ??
          latestActionStatus.get(card.actionRequestId) ??
          card.status;
        const state = cardState[card.actionRequestId] ?? IDLE_CARD_STATE;
        return (
          <ActionRequestCard
            key={message.sequence}
            card={{ ...card, status: effectiveStatus }}
            busy={state.busy}
            error={state.error}
            onApprove={(id) => void handleApprove(id)}
            onReject={(id, reason) => void handleReject(id, reason)}
            onAlwaysApprove={(actionKind) =>
              void handleAlwaysApprove(card.actionRequestId, actionKind)
            }
          />
        );
      }
    }

    const statusLine = systemStatusLineFromMessage(message);
    if (statusLine) {
      return <SystemStatusLineView key={message.sequence} line={statusLine} />;
    }

    return (
      <div key={message.sequence} className={`message message-${message.role}`}>
        <span className="message-role">{message.role}</span>
        <p className="message-text">{message.text}</p>
      </div>
    );
  }

  return (
    <div className="page chat-page">
      <header className="page-header">
        <button type="button" className="secondary" onClick={onBack}>
          ← Chats
        </button>
        <TurnStatusBadge status={turn.status} />
        <div className="header-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void handleStop()}
            disabled={busy}
          >
            Stop
          </button>
          <button type="button" className="secondary" onClick={onForgetKey}>
            Forget key
          </button>
        </div>
      </header>

      <div className="message-list">
        {!caughtUp && <p className="hint">Loading history…</p>}
        {messages.map(renderMessage)}

        {turn.status === 'running' && (
          <div className="message message-assistant message-streaming">
            <span className="message-role">assistant</span>
            <p className="message-text">{turn.streamingText}</p>
            {turn.toolCalls.map((row) => (
              <ToolCallRowView key={row.toolCallId} row={row} />
            ))}
          </div>
        )}

        <div ref={scrollAnchorRef} />
      </div>

      {sendError && (
        <p className="error" role="alert">
          {typeof sendError === 'string' ? sendError : sendError.message}
        </p>
      )}

      <form className="composer" onSubmit={(event) => void handleSend(event)}>
        <textarea
          value={composerText}
          onChange={(event) => setComposerText(event.target.value)}
          placeholder={composerDisabled ? 'Waiting for the current turn to finish…' : 'Message…'}
          disabled={composerDisabled}
          rows={2}
        />
        <button type="submit" disabled={composerDisabled || composerText.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}
