import { useState } from 'react';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import { type ChatSummary, chatTitle, isArchived } from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
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
  /** The HTTP client — the agent-profile group behind `ModelSwitcher`, and `get_workspace` for the
   *  status line's workspace name (`useWorkspaceIdentity`, already cached by `AppShell`'s own read
   *  of the same key). */
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
  /** The current/last Turn's tool-call count (`turn.toolCalls.length`) — omitted (or 0) hides the
   *  "本轮 N 次工具调用" segment; console redesign P3-2 V3, "if available" (a fresh page load has
   *  none until a Turn actually streams one, `lib/streaming-reducer.ts`'s own scope note). */
  readonly toolCallCount?: number;
}

/**
 * components/chat/ChatHeader (console redesign P3-2, V3 "对话" — replaces the S8 W1-A3 two-row
 * layout): one row, split left/right like the artboard (`Chat.dc.html`) — left is the back
 * affordance + title + a single status line ("● 入口 agent · 常驻 · 工作区 <name>" plus the tool-call
 * count when this session has one and the Turn badge); right is `ModelSwitcher`'s compact model
 * pill, the overflow menu (改名/归档/恢复, `kit/dropdown-menu`) and Stop. The back button
 * (`onBack` → `#/work/chats`) stays visible at every width — unlike the artboard, which omits it
 * because its own list pane is always on screen — because `e2e/chat.spec.ts` (opt-in, exercised by
 * `.github/workflows/e2e.yml`) asserts it directly: `getByRole('button', {name:'返回对话列表'})
 * .toBeVisible()`. On ≤960px, where `chat/ChatListPane` is hidden (`styles/pages.css`'s
 * `.chat-workspace[data-active-pane]` rule), this same button is the single-pane "back" affordance
 * the redesign spec calls for.
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
  toolCallCount,
}: ChatHeaderProps) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ChatSummary | null>(null);
  const { restore, restoringId } = useRestoreChat(client, onChatChanged);
  const { workspaceName } = useWorkspaceIdentity(http);
  const archived = chat !== null && isArchived(chat);
  const title = chat ? chatTitle(chat, t) : lookupFailed ? t('对话', 'Chat') : ' ';

  return (
    <TooltipProvider>
      <header className="chat-header">
        <Button
          variant="ghost"
          size="s"
          icon="arrow-left"
          iconOnly
          aria-label={t('返回对话列表', 'Back to chats')}
          onClick={onBack}
          className="chat-header-back"
        />
        <div className="chat-header-main">
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
                  className={`chat-header-title${chat && chat.title === null ? ' text-3' : ''}`}
                  data-testid="chat-title"
                >
                  {title}
                </h1>
              </TooltipTrigger>
              <TooltipContent>{title}</TooltipContent>
            </Tooltip>
          )}
          <div className="chat-header-status" data-testid="chat-header-status">
            {archived ? (
              <span className="chip chip-s chip-neutral" data-testid="chat-archived-chip">
                {t('已归档', 'Archived')}
              </span>
            ) : (
              <span className="chat-header-status-dot" aria-hidden />
            )}
            <span>{t('入口 agent', 'Entry agent')}</span>
            <span aria-hidden>·</span>
            <span>{t('常驻', 'Resident')}</span>
            <span aria-hidden>·</span>
            <span>
              {t('工作区', 'Workspace')} {workspaceName}
            </span>
            {toolCallCount !== undefined && toolCallCount > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  {t(`本轮 ${toolCallCount} 次工具调用`, `${toolCallCount} tool call(s) this turn`)}
                </span>
              </>
            ) : null}
            <TurnStatusBadge status={turnStatus} />
          </div>
        </div>
        <div className="chat-header-side">
          <ModelSwitcher http={http} turnRunning={turnStatus === 'running'} />
          {chat ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="s"
                  icon="more"
                  iconOnly
                  aria-label={t('更多操作', 'More actions')}
                  data-testid="chat-header-menu"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!archived ? (
                  <DropdownMenuItem
                    data-testid="chat-header-rename"
                    onSelect={() => setRenaming(true)}
                  >
                    {t('改名', 'Rename')}
                  </DropdownMenuItem>
                ) : null}
                {archived ? (
                  <DropdownMenuItem
                    data-testid="chat-header-restore"
                    disabled={restoringId === chat.id}
                    onSelect={() => void restore(chat)}
                  >
                    {t('恢复', 'Restore')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    data-testid="chat-header-archive"
                    onSelect={() => setArchiveTarget(chat)}
                  >
                    {t('归档', 'Archive')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button
            variant={turnStatus === 'running' ? 'danger' : 'ghost'}
            size="s"
            icon="stop"
            iconOnly
            aria-label={t('停止当前轮', 'Stop the running turn')}
            onClick={onStop}
            disabled={stopBusy}
          />
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
