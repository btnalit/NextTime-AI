import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { actionCardFromPendingContent, isPendingCardMessage } from '../lib/action-card.js';
import { insertChatMessage } from '../lib/chat-messages.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime } from '../lib/format.js';
import { initialTurnState, streamReducer } from '../lib/streaming-reducer.js';
import { systemStatusLineFromMessage } from '../lib/system-status.js';
import type { ChatMessage, ChatSubscriptionHandlers, WsClient } from '../lib/ws-client.js';
import { TurnAlreadyRunningError } from '../lib/ws-client.js';
import { ActionRequestCard } from './ActionRequestCard.js';
import type { ChatSummary } from './ChatListPage.js';
import { SystemStatusLineView } from './SystemStatusLineView.js';
import { ToolCallRowView } from './ToolCallRowView.js';
import { TurnStatusBadge } from './TurnStatusBadge.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Kbd } from './ui/Kbd.js';
import { useToast } from './ui/Toast.js';

export interface ChatPageProps {
  readonly client: WsClient;
  readonly http: CapabilityCaller;
  readonly chatId: string;
  readonly onBack: () => void;
  readonly onOpenApproval: (actionRequestId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}

interface CardCallState {
  readonly busy: boolean;
  readonly error: unknown | null;
}

const IDLE_CARD_STATE: CardCallState = { busy: false, error: null };
const AT_BOTTOM_THRESHOLD_PX = 48;

/**
 * components/ChatPage: the conversation (design doc §7.6; S1.8 deliverables 1 and 4). Two pieces
 * of state fed by one `WsClient.subscribeChat` call: `messages` (persisted history, kept sorted by
 * `sequence`, lib/chat-messages.ts) and `turn` (the running Turn's ephemeral stream,
 * lib/streaming-reducer.ts). `subscribeChat` is always called with `startAfter=0` — a fresh mount
 * walks complete history ("刷新后历史完整"); the client's own reconnect logic resumes separately.
 *
 * Inline approval cards (`system.action_pending`) reuse `ActionRequestDetail`; their status is
 * kept current by two converging signals — a live `action.updated` push (`actionStatusOverrides`)
 * and any later `system.action_update` message already in this chat (`latestActionStatus`).
 * `system.action_update`/`system.task_update` render as compact notices that open the matching
 * Approvals/Tasks drawer.
 *
 * The human channel has no "is a Turn running" read (S1.8 假设与偏离); the composer starts enabled
 * and learns of a foreign Turn from `send_chat_message`'s -32010 (`TurnAlreadyRunningError`).
 */
export function ChatPage({ client, http, chatId, onBack, onOpenApproval, onOpenTask }: ChatPageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [turn, setTurn] = useState(initialTurnState);
  const [caughtUp, setCaughtUp] = useState(false);
  const [subscribeError, setSubscribeError] = useState<unknown | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sendError, setSendError] = useState<unknown | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [actionStatusOverrides, setActionStatusOverrides] = useState<Readonly<Record<string, string>>>({});
  const [cardState, setCardState] = useState<Readonly<Record<string, CardCallState>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client
      .call<readonly ChatSummary[]>('list_chats')
      .then((chats) => {
        if (cancelled) return;
        const match = chats.find((chat) => chat.id === chatId);
        setTitle(match?.title ?? 'Untitled chat');
      })
      .catch(() => {
        if (!cancelled) setTitle('Chat');
      });
    return () => {
      cancelled = true;
    };
  }, [client, chatId]);

  useEffect(
    () =>
      client.onActionUpdated((event) => {
        setActionStatusOverrides((prev) => ({ ...prev, [event.actionRequestId]: event.status }));
      }),
    [client],
  );

  const latestActionStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      const line = systemStatusLineFromMessage(message);
      if (line?.variant === 'action_update') map.set(line.actionRequestId, line.status);
    }
    return map;
  }, [messages]);

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
        // Any chat.metadata means the chat's one running Turn ended (one running Turn per chat).
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
        if (!cancelled) setSubscribeError(err);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, chatId]);

  // Auto-scroll: follow new content only while the reader is already at the bottom; otherwise
  // count what arrived and offer "Jump to latest".
  const contentVersion = `${messages.length}:${turn.streamingText.length}:${turn.toolCalls.length}`;
  const lastCount = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
      setUnseen(0);
    } else if (messages.length > lastCount.current) {
      setUnseen((count) => count + (messages.length - lastCount.current));
    }
    lastCount.current = messages.length;
  }, [contentVersion, atBottom, messages.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowAtBottom = distance < AT_BOTTOM_THRESHOLD_PX;
    setAtBottom(nowAtBottom);
    if (nowAtBottom) setUnseen(0);
  }, []);

  function jumpToLatest(): void {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setUnseen(0);
  }

  function setCardBusy(id: string, value: boolean): void {
    setCardState((prev) => ({ ...prev, [id]: { busy: value, error: value ? null : (prev[id]?.error ?? null) } }));
  }

  async function handleApprove(id: string, options: { alwaysAllow: boolean }): Promise<void> {
    setCardBusy(id, true);
    try {
      const result = await http.call<{ status: string }>('approve', { actionRequestId: id });
      setActionStatusOverrides((prev) => ({ ...prev, [id]: result.status }));
      setCardState((prev) => ({ ...prev, [id]: IDLE_CARD_STATE }));
      if (options.alwaysAllow) {
        const card = messages.map((m) => (m.content ? actionCardFromPendingContent(m.content) : undefined)).find((c) => c?.actionRequestId === id);
        try {
          await http.call('set_auto_approved_action_kind', { actionKind: card?.actionKindTag });
          toast.push({ tone: 'info', title: `${card?.actionKindTag ?? 'This kind'} will be auto-approved from now on` });
        } catch (err) {
          if (isForbiddenError(err)) permissions.markDenied('set_auto_approved_action_kind');
          toast.push({ tone: 'warn', title: 'Approved, but the auto-approval rule was not written' });
        }
      }
    } catch (err) {
      setCardState((prev) => ({ ...prev, [id]: { busy: false, error: err } }));
    }
  }

  async function handleReject(id: string, reason: string | undefined): Promise<void> {
    setCardBusy(id, true);
    try {
      const result = await http.call<{ status: string }>('reject', {
        actionRequestId: id,
        ...(reason !== undefined ? { reason } : {}),
      });
      setActionStatusOverrides((prev) => ({ ...prev, [id]: result.status }));
      setCardState((prev) => ({ ...prev, [id]: IDLE_CARD_STATE }));
    } catch (err) {
      setCardState((prev) => ({ ...prev, [id]: { busy: false, error: err } }));
    }
  }

  async function send(): Promise<void> {
    const text = composerText.trim();
    if (!text || turn.status === 'running' || busy) return;
    setSendError(null);
    setBusy(true);
    try {
      const result = await client.sendChatMessage(chatId, text);
      setTurn(streamReducer(initialTurnState, { kind: 'turnStarted', turnId: result.turnId }));
      setComposerText('');
      setAtBottom(true);
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

  const composerDisabled = turn.status === 'running' || busy;
  const canAlwaysAllow = !permissions.isDenied('set_auto_approved_action_kind');

  function renderMessage(message: ChatMessage) {
    if (isPendingCardMessage(message) && message.content) {
      const card = actionCardFromPendingContent(message.content);
      if (card) {
        const effectiveStatus =
          actionStatusOverrides[card.actionRequestId] ?? latestActionStatus.get(card.actionRequestId) ?? card.status;
        const state = cardState[card.actionRequestId] ?? IDLE_CARD_STATE;
        return (
          <ActionRequestCard
            key={message.sequence}
            card={{ ...card, status: effectiveStatus }}
            busy={state.busy}
            error={state.error}
            onApprove={(id, options) => void handleApprove(id, options)}
            onReject={(id, reason) => void handleReject(id, reason)}
            canAlwaysAllow={canAlwaysAllow}
          />
        );
      }
    }
    const statusLine = systemStatusLineFromMessage(message);
    if (statusLine) {
      return (
        <SystemStatusLineView
          key={message.sequence}
          line={statusLine}
          onOpen={() =>
            statusLine.variant === 'action_update'
              ? onOpenApproval(statusLine.actionRequestId)
              : onOpenTask(statusLine.taskId)
          }
        />
      );
    }
    return (
      <div key={message.sequence} className={`message message-${message.role}`} data-role={message.role}>
        <div className="message-bubble message-text">{message.text}</div>
        <div className="message-meta">
          <span>{message.role}</span>
          <time title={formatDateTime(message.createdAt)}>
            {new Date(message.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </time>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-page" data-testid="chat-page">
      <header className="chat-header">
        <Button variant="ghost" size="s" icon="arrow-left" iconOnly aria-label="Back to chats" onClick={onBack} />
        <h1 className="chat-header-title">{title ?? ' '}</h1>
        <TurnStatusBadge status={turn.status} />
        <div className="grow" />
        <Button
          variant={turn.status === 'running' ? 'danger' : 'ghost'}
          size="s"
          icon="stop"
          onClick={() => void handleStop()}
          disabled={busy}
          title="Stop the running turn"
        >
          Stop
        </Button>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-thread" data-testid="chat-thread">
          {subscribeError !== null ? <ErrorBanner error={subscribeError} title="Could not open this chat" /> : null}
          {!caughtUp && subscribeError === null ? <p className="chat-empty">Loading history…</p> : null}
          {caughtUp && messages.length === 0 && turn.status !== 'running' ? (
            <p className="chat-empty">No messages yet. Ask the entry agent something — it can observe systems, propose actions and delegate to Workers.</p>
          ) : null}
          {messages.map(renderMessage)}

          {turn.status === 'running' ? (
            <div className="message message-assistant message-streaming" data-role="assistant">
              <div className="message-bubble message-text">
                <span>{turn.streamingText}</span>
                <span className="streaming-caret" aria-hidden />
              </div>
              {turn.toolCalls.length > 0 ? (
                <div className="tool-calls">
                  {turn.toolCalls.map((row) => (
                    <ToolCallRowView key={row.toolCallId} row={row} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {!atBottom ? (
          <div className="chat-thread" style={{ paddingTop: 0, paddingBottom: 0 }}>
            <Button variant="secondary" size="s" icon="arrow-down" className="jump-latest" onClick={jumpToLatest}>
              Jump to latest{unseen > 0 ? ` (${unseen})` : ''}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={handleSubmit}>
          {sendError !== null ? <ErrorBanner error={sendError} /> : null}
          <div className="composer-box">
            <textarea
              ref={textareaRef}
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={composerDisabled ? 'Waiting for the current turn to finish…' : 'Message…'}
              disabled={composerDisabled}
              rows={Math.min(6, Math.max(1, composerText.split('\n').length))}
              aria-label="Message"
            />
            <Button
              type="submit"
              variant="primary"
              size="s"
              icon="send"
              iconOnly
              aria-label="Send"
              disabled={composerDisabled || composerText.trim().length === 0}
              loading={busy && turn.status !== 'running'}
            />
          </div>
          <div className="composer-hint">
            <span>
              <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line
            </span>
            <span className="mono" title={chatId}>
              {chatId.slice(0, 8)}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
