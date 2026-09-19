import { useState } from 'react';
import { type ChatSummary, chatTitle, isArchived } from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { TurnStatus } from '../../lib/streaming-reducer.js';
import { TurnStatusBadge } from '../TurnStatusBadge.js';
import { Button } from '../ui/Button.js';
import { ChatArchiveConfirm } from './ChatArchiveConfirm.js';
import { ChatLifecycleActions, useRestoreChat } from './ChatLifecycleActions.js';
import { ChatRenameForm } from './ChatRenameForm.js';
import { ModelSwitcher } from './ModelSwitcher.js';

export interface ChatHeaderProps {
  /** The WS client — the `chat` group (rename / archive / unarchive). */
  readonly client: CapabilityCaller;
  /** The HTTP client — the agent-profile group behind `ModelSwitcher`. */
  readonly http: CapabilityCaller;
  /** `null` while the chat row is still being looked up, or when it could not be (a chat the
   *  caller does not own is not in `list_chats`) — then no lifecycle actions are offered. */
  readonly chat: ChatSummary | null;
  /** `true` once the lookup failed — the title falls back to "对话 Chat" instead of blank. */
  readonly lookupFailed: boolean;
  readonly turnStatus: TurnStatus;
  readonly stopBusy: boolean;
  readonly onBack: () => void;
  readonly onStop: () => void;
  /** The kernel's updated row after rename / archive / restore / undo — the page keeps it. */
  readonly onChatChanged: (chat: ChatSummary) => void;
}

/**
 * components/chat/ChatHeader (S6-A, console-completion-plan §5.1, §5.9 "页面对照原型 — 对话"): the
 * open chat's header — back, title (or the inline rename editor), the 已归档 chip, the Turn
 * status, the 模式 · 模型 · 来源 line (`ModelSwitcher`), the same 改名 / 归档 / 恢复 actions the
 * list rows have, and Stop. Archive is the page-level `ChatArchiveConfirm` (tier low + undo).
 */
export function ChatHeader({
  client,
  http,
  chat,
  lookupFailed,
  turnStatus,
  stopBusy,
  onBack,
  onStop,
  onChatChanged,
}: ChatHeaderProps) {
  const [renaming, setRenaming] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ChatSummary | null>(null);
  const { restore, restoringId } = useRestoreChat(client, onChatChanged);
  const archived = chat !== null && isArchived(chat);

  return (
    <header className="chat-header">
      <Button
        variant="ghost"
        size="s"
        icon="arrow-left"
        iconOnly
        aria-label="Back to chats"
        onClick={onBack}
      />
      <div className="grow stack-s">
        <div className="row">
          {renaming && chat ? (
            <ChatRenameForm
              client={client}
              chat={chat}
              onSaved={(updated) => {
                setRenaming(false);
                onChatChanged(updated);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <h1
              className={`chat-header-title${chat && chat.title === null ? ' text-3' : ''}`}
              data-testid="chat-title"
            >
              {chat ? chatTitle(chat) : lookupFailed ? '对话 Chat' : ' '}
            </h1>
          )}
          {archived ? (
            <span className="chip chip-s chip-neutral" data-testid="chat-archived-chip">
              已归档 Archived
            </span>
          ) : null}
          <TurnStatusBadge status={turnStatus} />
        </div>
        <ModelSwitcher http={http} turnRunning={turnStatus === 'running'} />
      </div>
      {chat ? (
        <ChatLifecycleActions
          chat={chat}
          onRename={() => setRenaming(true)}
          onArchive={() => setArchiveTarget(chat)}
          onRestore={() => void restore(chat)}
          restoring={restoringId === chat.id}
          testIdPrefix="chat-header"
        />
      ) : null}
      <Button
        variant={turnStatus === 'running' ? 'danger' : 'ghost'}
        size="s"
        icon="stop"
        onClick={onStop}
        disabled={stopBusy}
        title="停止当前轮 Stop the running turn"
      >
        停止 Stop
      </Button>
      <ChatArchiveConfirm
        client={client}
        chat={archiveTarget}
        onChanged={onChatChanged}
        onClose={() => setArchiveTarget(null)}
      />
    </header>
  );
}
