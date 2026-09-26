import { useState } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { useT } from '../lib/i18n.js';
import type { WsClient } from '../lib/ws-client.js';
import { ToolCallRowView } from './ToolCallRowView.js';
import { ChatHeader } from './chat/ChatHeader.js';
import { ChatMessageRow } from './chat/ChatMessageRow.js';
import { MessageBody } from './chat/MessageBody.js';
import { useActionCards } from './chat/useActionCards.js';
import { useAutoFollow } from './chat/useAutoFollow.js';
import { useChatMessages } from './chat/useChatMessages.js';
import { useChatSummary } from './chat/useChatSummary.js';
import { useComposer } from './chat/useComposer.js';
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

/**
 * components/ChatPage: the conversation (design doc §7.6; S1.8 deliverables 1 and 4). The bulk of
 * this page's own state and effects moved out to `components/chat/*` hooks (console redesign P1) —
 * `useChatSummary` (the chat row, restore), `useChatMessages` (the `WsClient.subscribeChat` feed),
 * `useAutoFollow` (W3 scroll-follow), `useActionCards` (inline approval-card decisions), and
 * `useComposer` (the message box) — each documents its own slice; this file wires them together and
 * owns the JSX, which still needs `components/ui/*` throughout (no kit equivalents exist yet for
 * `ErrorBanner`/`Notice`/`Button`/`FollowPill`/`Kbd`, `scripts/guards/legacy-ui-importers.json`).
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
  onOpenApproval,
  onOpenTask,
}: ChatPageProps) {
  const t = useT();
  const permissions = usePermissions();
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

  const canAlwaysAllow = !permissions.isDenied('set_auto_approved_action_kind');
  const { chat, archived } = chatSummary;

  return (
    <div className="chat-page" data-testid="chat-page">
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
          {messages.map((message) => (
            <ChatMessageRow
              key={message.sequence}
              message={message}
              http={http}
              actionStatusOverrides={actionCards.actionStatusOverrides}
              latestActionStatus={actionCards.latestActionStatus}
              cardErrors={actionCards.cardErrors}
              canAlwaysAllow={canAlwaysAllow}
              onApprove={actionCards.handleApprove}
              onReject={actionCards.handleReject}
              onOpenApproval={onOpenApproval}
              onOpenTask={onOpenTask}
            />
          ))}

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
        <form className="composer" onSubmit={composer.handleSubmit}>
          {archived && chat ? (
            <Notice tone="info" testId="chat-archived-notice">
              <span className="row-wrap">
                <span>{t('已归档：这个对话是只读的。', 'Archived — this chat is read-only.')}</span>
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
            <textarea
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
              rows={Math.min(6, Math.max(1, composer.composerText.split('\n').length))}
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
