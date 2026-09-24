import { useState } from 'react';
import { type ChatSummary, chatTitle, isArchived } from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { TurnStatus } from '../../lib/streaming-reducer.js';
import { TurnStatusBadge } from '../TurnStatusBadge.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../kit/dropdown-menu.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../kit/tooltip.js';
import { Button } from '../ui/Button.js';
import { ChatArchiveConfirm } from './ChatArchiveConfirm.js';
import { useRestoreChat } from './ChatLifecycleActions.js';
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
 * components/chat/ChatHeader (S6-A, console-completion-plan §5.1, §5.9 "页面对照原型 — 对话";
 * S8 W1-A3 audit C3 "对话顶栏 折到第二行 / 重叠"): two fixed rows instead of one wrapping one —
 * row 1 is back, title (or the inline rename editor; truncated with a tooltip for the full text
 * — `kit/tooltip`), the 已归档 chip, the Turn status, an overflow menu (`kit/dropdown-menu`)
 * holding 改名 / 归档 / 恢复, and Stop; row 2 is `ModelSwitcher`'s own 模式 · 模型 · 来源 line,
 * alone on its own row so it never has to fight row 1 for width and never wraps mid-sentence with
 * an orphan "·" (the audit's 1280px finding). Archive stays the page-level `ChatArchiveConfirm`
 * (tier low + undo) — only *opening* it moved into the overflow menu.
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
  const title = chat ? chatTitle(chat) : lookupFailed ? '对话 Chat' : ' ';

  return (
    <TooltipProvider>
      <header className="chat-header">
        <div className="chat-header-row1">
          <Button
            variant="ghost"
            size="s"
            icon="arrow-left"
            iconOnly
            aria-label="Back to chats"
            onClick={onBack}
          />
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
            <Tooltip>
              <TooltipTrigger asChild>
                <h1
                  className={`chat-header-title grow${chat && chat.title === null ? ' text-3' : ''}`}
                  data-testid="chat-title"
                >
                  {title}
                </h1>
              </TooltipTrigger>
              <TooltipContent>{title}</TooltipContent>
            </Tooltip>
          )}
          {archived ? (
            <span className="chip chip-s chip-neutral" data-testid="chat-archived-chip">
              已归档 Archived
            </span>
          ) : null}
          <TurnStatusBadge status={turnStatus} />
          {chat ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="s"
                  icon="more"
                  iconOnly
                  aria-label="更多操作 More actions"
                  data-testid="chat-header-menu"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!archived ? (
                  <DropdownMenuItem
                    data-testid="chat-header-rename"
                    onSelect={() => setRenaming(true)}
                  >
                    改名 Rename
                  </DropdownMenuItem>
                ) : null}
                {archived ? (
                  <DropdownMenuItem
                    data-testid="chat-header-restore"
                    disabled={restoringId === chat.id}
                    onSelect={() => void restore(chat)}
                  >
                    恢复 Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    data-testid="chat-header-archive"
                    onSelect={() => setArchiveTarget(chat)}
                  >
                    归档 Archive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
        </div>
        <div className="chat-header-row2">
          <ModelSwitcher http={http} turnRunning={turnStatus === 'running'} />
        </div>
        <ChatArchiveConfirm
          client={client}
          chat={archiveTarget}
          onChanged={onChatChanged}
          onClose={() => setArchiveTarget(null)}
        />
      </header>
    </TooltipProvider>
  );
}
