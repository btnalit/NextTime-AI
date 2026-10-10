import { Fragment, useMemo, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { useRoleCan } from '../hooks/useRoleCan.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { useT } from '../lib/i18n.js';
import { liveOutputPaused } from '../lib/live-stream.js';
import { persistedToolCallIds, threadItems } from '../lib/tool-call-record.js';
import type { WsClient } from '../lib/ws-client.js';
import { ToolCallGroupView, ToolCallRowView } from './ToolCallRowView.js';
import { ChatHeader } from './chat/ChatHeader.js';
import { ChatListPane } from './chat/ChatListPane.js';
import { ChatMessageRow } from './chat/ChatMessageRow.js';
import { MessageBody } from './chat/MessageBody.js';
import { ChatModelHealthNotice, type RunningModelHealth } from './chat/ModelSwitcher.js';
import { TurnOutcomeControl } from './chat/TurnOutcomeControl.js';
import { useActionCards } from './chat/useActionCards.js';
import { useAutoFollow } from './chat/useAutoFollow.js';
import { useChatMessages } from './chat/useChatMessages.js';
import { useChatSummary } from './chat/useChatSummary.js';
import { useComposer } from './chat/useComposer.js';
import { useTurnAttributions } from './chat/useTurnAttributions.js';
import { Textarea } from './kit/textarea.js';
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
  /** Opens a different chat from the shared list pane (`chat/ChatListPane`) — console redesign
   *  P3-2, V3: the list stays on screen next to an open conversation, so picking another row here
   *  must navigate without first going back to the bare chats route. */
  readonly onSelectChat: (chatId: string) => void;
  readonly onOpenApproval: (actionRequestId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}

/**
 * components/ChatPage: the conversation (design doc §7.6; S1.8 deliverables 1 and 4). The bulk of
 * this page's own state and effects moved out to `components/chat/*` hooks (console redesign P1) —
 * `useChatSummary` (the chat row, restore), `useChatMessages` (the `WsClient.subscribeChat` feed),
 * `useAutoFollow` (W3 scroll-follow), `useActionCards` (inline approval-card decisions), and
 * `useComposer` (the message box) — each documents its own slice; this file wires them together and
 * owns the JSX. Still imports `components/ui/*` for `ErrorBanner`/`Notice`/`Button`/`FollowPill`/
 * `Kbd`/`Toast` (no kit equivalent exists yet for `FollowPill`, and `useToast` is the app-root
 * toast provider, out of scope to migrate here) — `scripts/guards/legacy-ui-importers.json` keeps
 * this file listed for that reason; the composer's own textarea now goes through `kit/textarea`
 * and the header's model select through `kit/select` (console redesign P3-2).
 *
 * Console redesign P3-2 (V3 "对话"): renders `chat/ChatListPane` beside the conversation — the
 * three-pane layout `docs/console-visual-p3-spec-2026-09-26.md` calls for — instead of the list
 * living only on `ChatListPage`'s own route; `onSelectChat` lets a row picked from that pane while
 * a chat is already open navigate directly to the new one.
 *
 * S6-A (console-completion-plan §5.1): the chat's own row (`chat` — title, `archivedAt`) comes
 * from `list_chats{includeArchived: true}` and is kept current by `chat.metadata` /
 * pushes and by the header's own rename / archive / restore results (`useChatSummary`). An
 * archived chat is read-only *here*: the composer is disabled with a 恢复 Restore note. The kernel
 * does not refuse `send_chat_message` on an archived chat (`sendChatMessage` only checks access),
 * so this is a client-side rule — restoring is one click away.
 */
export function ChatPage({
  client,
  http,
  chatId,
  onBack,
  onSelectChat,
  onOpenApproval,
  onOpenTask,
}: ChatPageProps) {
  const t = useT();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const toast = useToast();
  const [sendError, setSendError] = useState<unknown | null>(null);

  const chatSummary = useChatSummary(client, chatId);
  const { messages, turn, setTurn, caughtUp, subscribeError } = useChatMessages(
    client,
    chatId,
    chatSummary.setChat,
    setSendError,
  );
  const follow = useAutoFollow(messages, turn);
  const actionCards = useActionCards(client, http, messages, toast, t, permissions);
  const composer = useComposer(
    client,
    chatId,
    turn.status,
    chatSummary.archived,
    setTurn,
    setSendError,
    follow.setFollow,
  );

  // S10 E1: the per-Turn outcome line goes under each Turn's last assistant reply.
  const { principalId: viewerId } = useWorkspaceIdentity(http);
  const turnAttributions = useTurnAttributions(http, chatId, turn.status);
  const lastReplyOfTurn = useMemo(() => {
    const last = new Map<string, number>();
    for (const message of messages) {
      if (message.role === 'assistant' && message.turnId) {
        last.set(message.turnId, message.sequence);
      }
    }
    return new Set(last.values());
  }, [messages]);

  // A Turn's tool calls are persisted as each one ends (`lib/tool-call-record`): fold them into one
  // group per Turn, and drop a live row once its persisted record has arrived.
  const items = useMemo(() => threadItems(messages), [messages]);
  const persistedIds = useMemo(() => persistedToolCallIds(messages), [messages]);
  const liveToolCalls = turn.toolCalls.filter((row) => !persistedIds.has(row.toolCallId));

  const canAlwaysAllow = can('set_auto_approved_action_kind') !== false;
  const canDecide = can('approve') !== false && can('reject') !== false;
  // #530 必修 3: the model the next Turn runs, when its provider is not known to work.
  const [runningModel, setRunningModel] = useState<RunningModelHealth | null>(null);
  const { chat, archived } = chatSummary;

  return (
    <div className="chat-page" data-testid="chat-page">
      <div className="chat-workspace" data-active-pane="conversation">
        <ChatListPane client={client} selectedChatId={chatId} onSelectChat={onSelectChat} />
        <div className="chat-conversation-pane">
          <ChatHeader
            client={client}
            http={http}
            chat={chat}
            lookupFailed={chatSummary.chatLookupFailed}
            turnStatus={turn.status}
            stopBusy={composer.busy}
            onBack={onBack}
            onStop={() => void composer.handleStop()}
            onChatChanged={chatSummary.onChatChanged}
            toolCallCount={turn.toolCalls.length}
            onRunningModel={setRunningModel}
          />

          <div className="chat-scroll" ref={follow.scrollRef} onScroll={follow.onScroll}>
            <div className="chat-thread" data-testid="chat-thread" ref={follow.threadRef}>
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
              {items.map((item) => {
                if (item.kind === 'tools') {
                  return <ToolCallGroupView key={`tools-${item.key}`} records={item.records} />;
                }
                const { message } = item;
                const turnAttribution =
                  message.turnId && lastReplyOfTurn.has(message.sequence)
                    ? turnAttributions.byTurn.get(message.turnId)
                    : undefined;
                return (
                  <Fragment key={message.sequence}>
                    <ChatMessageRow
                      message={message}
                      http={http}
                      actionStatusOverrides={actionCards.actionStatusOverrides}
                      latestActionStatus={actionCards.latestActionStatus}
                      cardErrors={actionCards.cardErrors}
                      canAlwaysAllow={canAlwaysAllow}
                      canDecide={canDecide}
                      onApprove={actionCards.handleApprove}
                      onReject={actionCards.handleReject}
                      onOpenApproval={onOpenApproval}
                      onOpenTask={onOpenTask}
                    />
                    {turnAttribution ? (
                      <TurnOutcomeControl
                        http={http}
                        turn={turnAttribution}
                        viewerId={viewerId}
                        onChanged={turnAttributions.apply}
                        onError={(title, description) =>
                          toast.push({ tone: 'danger', title, description })
                        }
                      />
                    ) : null}
                  </Fragment>
                );
              })}

              {turn.status === 'running' ? (
                <div className="message message-assistant message-streaming" data-role="assistant">
                  <div className="message-meta message-meta-lead">
                    <span className="message-avatar" aria-hidden="true">
                      A
                    </span>
                    <span>{t('入口 agent', 'Entry agent')}</span>
                    <span aria-hidden>·</span>
                    <span>{t('正在输出', 'Streaming')}</span>
                  </div>
                  <MessageBody
                    messageRole="assistant"
                    text={turn.streamingText}
                    trailing={<span className="streaming-caret" aria-hidden />}
                  />
                  {liveOutputPaused(turn.streamingText) ? (
                    <p className="text-3 text-small" data-testid="chat-stream-paused">
                      {t(
                        '实时输出已暂停：这段内容可能含凭据，回复完成后会显示完整内容（凭据已替换）。',
                        'Live output paused: this part may contain a credential. The full reply, with credentials replaced, shows when it finishes.',
                      )}
                    </p>
                  ) : null}
                  {liveToolCalls.length > 0 ? (
                    <div className="tool-calls">
                      {liveToolCalls.map((row) => (
                        <ToolCallRowView key={row.toolCallId} row={row} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div ref={follow.sentinelRef} aria-hidden data-testid="chat-bottom-sentinel" />
            </div>
            {!follow.following ? (
              <div className="chat-thread chat-thread-pill">
                {/* Same anchoring as the former `.jump-latest` button (pages.css `.follow-pill-anchor`). */}
                <div className="follow-pill-anchor">
                  <FollowPill
                    count={follow.unseen}
                    onClick={follow.jumpToLatest}
                    testId="follow-pill"
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="composer-wrap">
            <ChatModelHealthNotice running={runningModel} />
            <form className="composer" onSubmit={composer.handleSubmit}>
              {archived && chat ? (
                <Notice tone="info" testId="chat-archived-notice">
                  <span className="row-wrap">
                    <span>
                      {t('已归档：这个对话是只读的。', 'Archived — this chat is read-only.')}
                    </span>
                    <Button
                      variant="secondary"
                      size="s"
                      onClick={() => void chatSummary.restore(chat)}
                      loading={chatSummary.restoringId === chat.id}
                      data-testid="chat-composer-restore"
                    >
                      {t('恢复', 'Restore')}
                    </Button>
                  </span>
                </Notice>
              ) : null}
              {sendError !== null ? <ErrorBanner error={sendError} /> : null}
              <div className="composer-box">
                <Textarea
                  ref={composer.textareaRef}
                  value={composer.composerText}
                  onChange={(event) => composer.setComposerText(event.target.value)}
                  onKeyDown={composer.handleComposerKeyDown}
                  placeholder={
                    archived
                      ? t('已归档', 'Archived')
                      : composer.composerDisabled
                        ? t('等待本轮结束…', 'Waiting for the current turn to finish…')
                        : t('输入消息…', 'Message…')
                  }
                  disabled={composer.composerDisabled}
                  aria-label="Message"
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="s"
                  icon="send"
                  iconOnly
                  aria-label={t('发送', 'Send')}
                  disabled={composer.composerDisabled || composer.composerText.trim().length === 0}
                  loading={composer.busy && turn.status !== 'running'}
                />
              </div>
              <div className="composer-hint">
                <span>
                  <Kbd>Enter</Kbd> {t('发送', 'Send')} · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd>{' '}
                  {t('换行', 'New line')}
                </span>
                <span>
                  {t(
                    '执行类动作都会先经你审批',
                    'Actions that execute something always wait for your approval',
                  )}
                </span>
                <span className="mono" title={chatId} data-volatile="">
                  {chatId.slice(0, 8)}
                </span>
                {turn.status === 'running' ? (
                  <Button
                    variant="secondary"
                    size="s"
                    className="composer-stop"
                    onClick={() => void composer.handleStop()}
                    disabled={composer.busy}
                  >
                    {t('停止本轮', 'Stop this turn')}
                  </Button>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
