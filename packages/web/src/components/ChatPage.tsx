import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useChatChangeListener } from '../hooks/useChatUpdates.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { actionCardFromPendingContent, isPendingCardMessage } from '../lib/action-card.js';
import { type ChatSummary, applyChatMetadata, isArchived } from '../lib/chat-lifecycle.js';
import { insertChatMessage, messageRoleLabel } from '../lib/chat-messages.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatTime, humanizeKind } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { initialTurnState, streamReducer } from '../lib/streaming-reducer.js';
import { systemStatusLineFromMessage } from '../lib/system-status.js';
import type { ChatMessage, ChatSubscriptionHandlers, WsClient } from '../lib/ws-client.js';
import { TurnAlreadyRunningError } from '../lib/ws-client.js';
import { ActionRequestCard } from './ActionRequestCard.js';
import { SystemStatusLineView } from './SystemStatusLineView.js';
import { ToolCallRowView } from './ToolCallRowView.js';
import { ChatHeader } from './chat/ChatHeader.js';
import { useRestoreChat } from './chat/ChatLifecycleActions.js';
import { MessageBody } from './chat/MessageBody.js';
import { MessageReferences } from './chat/MessageReferences.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { FollowPill } from './ui/FollowPill.js';
import { Kbd } from './ui/Kbd.js';
import { Notice } from './ui/Notice.js';
import { useToast } from './ui/Toast.js';

export interface ChatPageProps {
  readonly client: WsClient;
  readonly http: CapabilityCaller;
  readonly chatId: string;
  readonly onBack: () => void;
  readonly onOpenApproval: (actionRequestId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}

/** How close to the live end (px) still counts as "at the bottom" — the reader may be a line or
 *  two up and still expects the thread to follow. Shared by the `IntersectionObserver` root
 *  margin and the `scroll`-event fallback below so both mechanisms agree. */
const AT_BOTTOM_THRESHOLD_PX = 48;

/**
 * components/ChatPage: the conversation (design doc §7.6; S1.8 deliverables 1 and 4). Two pieces
 * of state fed by one `WsClient.subscribeChat` call: `messages` (persisted history, kept sorted by
 * `sequence`, lib/chat-messages.ts) and `turn` (the running Turn's ephemeral stream,
 * lib/streaming-reducer.ts). `subscribeChat` is always called with `startAfter=0` — a fresh mount
 * walks complete history ("刷新后历史完整"); the client's own reconnect logic resumes separately.
 *
 * Inline approval cards (`system.action_pending`) are `ActionRequestCard` on the shared
 * `ui/ApprovalCard` (S6-A); their status is kept current by two converging signals — a live `action.updated` push (`actionStatusOverrides`)
 * and any later `system.action_update` message already in this chat (`latestActionStatus`).
 * `system.action_update`/`system.task_update` render as compact notices that open the matching
 * Approvals/Tasks drawer.
 *
 * The human channel has no "is a Turn running" read (S1.8 假设与偏离); the composer starts enabled
 * and learns of a foreign Turn from `send_chat_message`'s -32010 (`TurnAlreadyRunningError`).
 *
 * S6-A (console-completion-plan §5.1): the chat's own row (`chat` — title, `archivedAt`) comes
 * from `list_chats{includeArchived: true}` and is kept current by `chat.metadata {title}` /
 * `{archivedAt}` pushes (`applyChatMetadata`) and by the header's own rename / archive / restore
 * results. An archived chat is read-only *here*: the composer is disabled with a 恢复 Restore
 * note. The kernel does not refuse `send_chat_message` on an archived chat (`sendChatMessage`
 * only checks access), so this is a client-side rule — restoring is one click away.
 */
export function ChatPage({
  client,
  http,
  chatId,
  onBack,
  onOpenApproval,
  onOpenTask,
}: ChatPageProps) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [turn, setTurn] = useState(initialTurnState);
  const [caughtUp, setCaughtUp] = useState(false);
  const [subscribeError, setSubscribeError] = useState<unknown | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sendError, setSendError] = useState<unknown | null>(null);
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [chatLookupFailed, setChatLookupFailed] = useState(false);
  const [actionStatusOverrides, setActionStatusOverrides] = useState<
    Readonly<Record<string, string>>
  >({});
  /** The last failed decision call per ActionRequest — `ActionRequestCard` renders it; the card
   *  owns its own busy state (S6-A `ui/ApprovalCard`), so the handlers below only need to settle. */
  const [cardErrors, setCardErrors] = useState<Readonly<Record<string, unknown>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // W3 auto-follow (console-completion-plan §2 row W3, §5.1, §9). `followingRef` is the intent
  // ("keep the live end in view") read synchronously by the layout effect and the observers;
  // `following` mirrors it for rendering the `FollowPill`. `lastWrittenTop` is the scrollTop this
  // component itself last wrote — the way the `scroll`-event fallback tells its own programmatic
  // scroll (which must never stop following) from the reader's.
  const followingRef = useRef(true);
  const lastWrittenTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const seenCount = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setChat(null);
    setChatLookupFailed(false);
    client
      .call<{ items: readonly ChatSummary[] }>('list_chats', { includeArchived: true })
      .then((page) => {
        if (cancelled) return;
        const match = page.items.find((row) => row.id === chatId);
        if (match) setChat(match);
        else setChatLookupFailed(true);
      })
      .catch(() => {
        if (!cancelled) setChatLookupFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, chatId]);

  const onChatChanged = useCallback((updated: ChatSummary): void => {
    setChat(updated);
  }, []);
  // 遗留 57: the archive Undo toast can fire after this page (or a different one) unmounted and
  // remounted for a different `chatId` — `hooks/useChatUpdates.tsx`'s broadcast reaches whichever
  // page is mounted when it fires, not only the one that triggered it. Only apply it when it is
  // still about *this* open chat.
  const onBroadcastChatChanged = useCallback(
    (updated: ChatSummary): void => {
      if (updated.id === chatId) setChat(updated);
    },
    [chatId],
  );
  useChatChangeListener(onBroadcastChatChanged);
  const { restore, restoringId } = useRestoreChat(client, onChatChanged);
  const archived = chat !== null && isArchived(chat);

  useEffect(
    () =>
      client.onActionUpdated((event) => {
        setActionStatusOverrides((prev) => ({ ...prev, [event.id]: event.status }));
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
  }, [client, chatId]);

  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Read back rather than remember `scrollHeight`: the element clamps the write to its real
    // maximum, and that clamped value is what a later `scroll` event will report.
    lastWrittenTop.current = el.scrollTop;
  }, []);

  const setFollow = useCallback((next: boolean): void => {
    followingRef.current = next;
    setFollowing(next);
    if (next) setUnseen(0);
  }, []);

  // The follow write. A *layout* effect, keyed on the `messages` / `turn` object identities:
  //   - identity, not `${messages.length}:${streamingText.length}:${toolCalls.length}`, so a
  //     tool-call result landing in an already-rendered row (W3 mechanism b — `toolCalls.length`
  //     unchanged, the row grows in place) is a fresh `turn` object and still scrolls;
  //   - layout (before paint), so the observers below never get to see the un-scrolled frame —
  //     the sentinel is back in view before the browser measures intersections.
  // While the reader has scrolled away, count the persisted messages that arrived for the pill.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `turn` is the trigger (streamed text / tool rows grow it), not read in the body
  useLayoutEffect(() => {
    if (followingRef.current) {
      scrollToBottom();
      seenCount.current = messages.length;
      return;
    }
    if (messages.length > seenCount.current) {
      const delta = messages.length - seenCount.current;
      setUnseen((count) => count + delta);
    }
    seenCount.current = messages.length;
  }, [messages, turn, scrollToBottom]);

  // Bottom sentinel + `IntersectionObserver` (W3 fix, plan §5.1 "改用 IntersectionObserver 判底"):
  // the sentinel is the last child of the thread, so "is it within AT_BOTTOM_THRESHOLD_PX of the
  // viewport" *is* "is the reader at the bottom". Because every content change scrolls before
  // paint (layout effect above) and every size change re-pins (`ResizeObserver` below — resize
  // steps run before intersection steps in the same frame), the sentinel can only leave the
  // viewport when the reader scrolls away — and it re-entering is the reader coming back.
  // Guarded: jsdom has neither observer, so the `scroll` fallback carries the tests.
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting !== followingRef.current) setFollow(entry.isIntersecting);
      },
      { root, rootMargin: `0px 0px ${AT_BOTTOM_THRESHOLD_PX}px 0px`, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [setFollow]);

  // In-place growth that no React state announces (an image or a `<details>` opening, fonts
  // arriving, the viewport shrinking): re-pin to the bottom while following.
  useEffect(() => {
    const root = scrollRef.current;
    const thread = threadRef.current;
    if (!root || !thread || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToBottom();
    });
    observer.observe(thread);
    observer.observe(root);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // `scroll`-event fallback (no `IntersectionObserver`). The event a programmatic `scrollTop`
  // write produces is asynchronous: if the next chunk has already been committed by the time it
  // is dispatched, the naive "distance from bottom" reads that chunk's height and stops following
  // (W3 mechanism a). Our own write leaves `scrollTop` at `lastWrittenTop` (or beyond, if the
  // element grew and the browser kept the position) — a reader scrolling *up* is the only way
  // for it to read lower, so that is the one case measured.
  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el || typeof IntersectionObserver !== 'undefined') return;
    if (followingRef.current && el.scrollTop >= lastWrittenTop.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowAtBottom = distance < AT_BOTTOM_THRESHOLD_PX;
    if (nowAtBottom !== followingRef.current) setFollow(nowAtBottom);
  }, [setFollow]);

  function jumpToLatest(): void {
    setFollow(true);
    scrollToBottom();
  }

  function setCardError(id: string, error: unknown): void {
    setCardErrors((prev) => {
      if (error === null) {
        if (!(id in prev)) return prev;
        const { [id]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: error };
    });
  }

  async function handleApprove(
    id: string,
    options: { readonly reason: string | undefined; readonly alwaysAllow: boolean },
  ): Promise<void> {
    setCardError(id, null);
    try {
      // C25: `reason` travels with approve (required by the kernel for a high blast radius —
      // `ui/ApprovalCard` validates that in front of the call; a kernel 400 still lands below).
      const result = await http.call<{ status: string }>('approve', {
        actionRequestId: id,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      });
      setActionStatusOverrides((prev) => ({ ...prev, [id]: result.status }));
    } catch (err) {
      setCardError(id, err);
      return;
    }
    if (!options.alwaysAllow) return;
    const card = messages
      .map((m) => (m.content ? actionCardFromPendingContent(m.content) : undefined))
      .find((c) => c?.actionRequestId === id);
    // C8 (console-completion-plan §2b): the persisted `system.action_pending` message is the
    // only source of the kind tag here. Without it — a push that outran persistence, a card
    // this closure no longer sees — there is nothing to write a rule for; say so instead of
    // calling `set_auto_approved_action_kind` with `actionKindTag: undefined`.
    if (!card) {
      toast.push({
        tone: 'warn',
        title: t(
          '已批准，但未写入自动批准规则',
          'Approved, but the auto-approval rule was not written',
        ),
        description: t(
          '这个请求的动作种类尚未到达此对话。',
          'The action kind of this request is not known to this chat yet.',
        ),
      });
      return;
    }
    try {
      await http.call('set_auto_approved_action_kind', { actionKindTag: card.actionKindTag });
      // S8 W4 i18n baseline: was a raw un-t()'d template literal splicing the enum value
      // (`actionKindTag`) straight into glued zh/en text — `humanizeKind` (same helper
      // `ApprovalQueuePage`'s own toast already uses for this) instead of the raw tag.
      toast.push({
        tone: 'info',
        title: t(
          `今后将自动批准 ${humanizeKind(card.actionKindTag)}`,
          `Will be auto-approved from now on: ${humanizeKind(card.actionKindTag)}`,
        ),
      });
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('set_auto_approved_action_kind');
      toast.push({
        tone: 'warn',
        title: t(
          '已批准，但未写入自动批准规则',
          'Approved, but the auto-approval rule was not written',
        ),
      });
    }
  }

  async function handleReject(id: string, reason: string | undefined): Promise<void> {
    setCardError(id, null);
    try {
      const result = await http.call<{ status: string }>('reject', {
        actionRequestId: id,
        ...(reason !== undefined ? { reason } : {}),
      });
      setActionStatusOverrides((prev) => ({ ...prev, [id]: result.status }));
    } catch (err) {
      setCardError(id, err);
    }
  }

  async function send(): Promise<void> {
    const text = composerText.trim();
    if (!text || turn.status === 'running' || busy || archived) return;
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

  const composerDisabled = turn.status === 'running' || busy || archived;
  const canAlwaysAllow = !permissions.isDenied('set_auto_approved_action_kind');

  function renderMessage(message: ChatMessage) {
    if (isPendingCardMessage(message) && message.content) {
      const card = actionCardFromPendingContent(message.content);
      if (card) {
        const effectiveStatus =
          actionStatusOverrides[card.actionRequestId] ??
          latestActionStatus.get(card.actionRequestId) ??
          card.status;
        return (
          <ActionRequestCard
            key={message.sequence}
            card={{ ...card, status: effectiveStatus }}
            error={cardErrors[card.actionRequestId] ?? null}
            onApprove={handleApprove}
            onReject={handleReject}
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
      <div
        key={message.sequence}
        className={`message message-${message.role}`}
        data-role={message.role}
      >
        <MessageBody messageRole={message.role} text={message.text} />
        {message.role === 'assistant' ? (
          <MessageReferences http={http} text={message.text} />
        ) : null}
        <div className="message-meta">
          <span>{messageRoleLabel(message.role, t)}</span>
          <time title={formatDateTime(message.createdAt)}>{formatTime(message.createdAt)}</time>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-page" data-testid="chat-page">
      <ChatHeader
        client={client}
        http={http}
        chat={chat}
        lookupFailed={chatLookupFailed}
        turnStatus={turn.status}
        stopBusy={busy}
        onBack={onBack}
        onStop={() => void handleStop()}
        onChatChanged={onChatChanged}
      />

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-thread" data-testid="chat-thread" ref={threadRef}>
          {subscribeError !== null ? (
            <ErrorBanner
              error={subscribeError}
              title={t('无法打开对话', 'Could not open this chat')}
            />
          ) : null}
          {!caughtUp && subscribeError === null ? (
            <p className="chat-empty">{t('正在加载历史…', 'Loading history…')}</p>
          ) : null}
          {caughtUp && messages.length === 0 && turn.status !== 'running' ? (
            <p className="chat-empty">
              {t(
                '还没有消息。问入口 agent 点什么——它可以观察系统、提出动作并委派给 Worker。',
                'No messages yet. Ask the entry agent something — it can observe systems, propose actions and delegate to Workers.',
              )}
            </p>
          ) : null}
          {messages.map(renderMessage)}

          {turn.status === 'running' ? (
            <div className="message message-assistant message-streaming" data-role="assistant">
              <MessageBody
                messageRole="assistant"
                text={turn.streamingText}
                trailing={<span className="streaming-caret" aria-hidden />}
              />
              {turn.toolCalls.length > 0 ? (
                <div className="tool-calls">
                  {turn.toolCalls.map((row) => (
                    <ToolCallRowView key={row.toolCallId} row={row} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div ref={sentinelRef} aria-hidden data-testid="chat-bottom-sentinel" />
        </div>
        {!following ? (
          <div className="chat-thread chat-thread-pill">
            {/* Same anchoring as the former `.jump-latest` button (pages.css `.follow-pill-anchor`). */}
            <div className="follow-pill-anchor">
              <FollowPill count={unseen} onClick={jumpToLatest} testId="follow-pill" />
            </div>
          </div>
        ) : null}
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={handleSubmit}>
          {archived && chat ? (
            <Notice tone="info" testId="chat-archived-notice">
              <span className="row-wrap">
                <span>{t('已归档：这个对话是只读的。', 'Archived — this chat is read-only.')}</span>
                <Button
                  variant="secondary"
                  size="s"
                  onClick={() => void restore(chat)}
                  loading={restoringId === chat.id}
                  data-testid="chat-composer-restore"
                >
                  {t('恢复', 'Restore')}
                </Button>
              </span>
            </Notice>
          ) : null}
          {sendError !== null ? <ErrorBanner error={sendError} /> : null}
          <div className="composer-box">
            <textarea
              ref={textareaRef}
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                archived
                  ? t('已归档', 'Archived')
                  : composerDisabled
                    ? t('等待本轮结束…', 'Waiting for the current turn to finish…')
                    : t('输入消息…', 'Message…')
              }
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
              aria-label={t('发送', 'Send')}
              disabled={composerDisabled || composerText.trim().length === 0}
              loading={busy && turn.status !== 'running'}
            />
          </div>
          <div className="composer-hint">
            <span>
              <Kbd>Enter</Kbd> 发送 send · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd>{' '}
              {t('换行', 'new line')}
            </span>
            <span className="mono" title={chatId} data-volatile="">
              {chatId.slice(0, 8)}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
