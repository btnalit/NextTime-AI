import { useCallback, useMemo, useState } from 'react';
import { useChatChangeListener } from '../../hooks/useChatUpdates.js';
import { useResource } from '../../hooks/useResource.js';
import { type ChatSummary, chatTitle, isArchived, spliceChat } from '../../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { Tabs } from '../kit/tabs.js';
import { ChatArchiveConfirm } from './ChatArchiveConfirm.js';
import { ChatLifecycleActions, useRestoreChat } from './ChatLifecycleActions.js';
import { ChatRenameForm } from './ChatRenameForm.js';

export type ChatListFilter = 'active' | 'archived';

export interface ChatListPaneProps {
  /** The WS client — `list_chats` / `new_chat` / `archive_chat` / `unarchive_chat` /
   *  `rename_chat` are `chat`-group capabilities (WS-eligible). */
  readonly client: CapabilityCaller;
  /** The currently open chat, if any — highlights its row and lets the pane know it is being
   *  rendered alongside an open conversation (console redesign P3-2, V3): the same pane is shared
   *  by `ChatListPage` (no chat open, `selectedChatId` omitted) and `ChatPage` (a chat open). */
  readonly selectedChatId?: string | null;
  readonly onSelectChat: (chatId: string) => void;
}

const SEARCH_ICON_PATH = 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35';

/**
 * components/chat/ChatListPane (console redesign P3-2, V3 "对话"): the ~300px list column the
 * artboard (`Chat.dc.html`) keeps on screen next to the conversation on both the chat-list route
 * and an open-chat route — the fix for V3's "没有对话列表栏（列表与会话是两个页面，来回跳）". Owns its
 * own `list_chats` load, the 进行中/已归档 split (`kit/tabs`), a client-side title search, and the
 * rename/archive/restore lifecycle a row offers — the same capability calls `ChatListPage` used to
 * own directly, now shared by whichever page renders this pane. A new file under `components/chat/`
 * — never imports `components/ui/*` (S8 risk ①): rows are hand-rolled (not `ui/DataList`/`DataRow`)
 * so the title cell can stay pure text (`.data-row-title`, kept for `ChatListPage.test.tsx`'s own
 * `rowTitles()` helper) while a relative time sits beside it and a status line sits below it —
 * `ui/DataRow`'s two-slot (title/meta) shape cannot express "time on the title's own line" without
 * polluting that text node.
 */
export function ChatListPane({ client, selectedChatId, onSelectChat }: ChatListPaneProps) {
  const t = useT();
  const load = useCallback(
    () =>
      client
        .call<{ items: readonly ChatSummary[] }>('list_chats', { includeArchived: true })
        .then((page) => page.items),
    [client],
  );
  const chats = useResource(load);
  const [filter, setFilter] = useState<ChatListFilter>('active');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ChatSummary | null>(null);

  const all = chats.state.status === 'ready' ? chats.state.data : undefined;
  const split = useMemo(() => {
    const active: ChatSummary[] = [];
    const archived: ChatSummary[] = [];
    for (const chat of all ?? []) (isArchived(chat) ? archived : active).push(chat);
    return { active, archived };
  }, [all]);
  const byFilter = filter === 'active' ? split.active : split.archived;
  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      query === ''
        ? byFilter
        : byFilter.filter((chat) => chatTitle(chat, t).toLowerCase().includes(query)),
    [byFilter, query, t],
  );

  async function handleNewChat(): Promise<void> {
    setCreating(true);
    setCreateError(null);
    try {
      const chat = await client.call<ChatSummary>('new_chat', {});
      onSelectChat(chat.id);
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  const onChanged = useCallback(
    (chat: ChatSummary): void => {
      chats.mutate((list) => spliceChat(list, chat));
      setRenamingId((current) => (current === chat.id ? null : current));
    },
    [chats.mutate],
  );
  // 遗留 57: an archive Undo toast fired from elsewhere reaches every currently-mounted listener —
  // see `hooks/useChatUpdates.tsx`'s own doc comment.
  useChatChangeListener(onChanged);
  const { restore, restoringId } = useRestoreChat(client, onChanged);

  return (
    <aside className="chat-list-pane" data-testid="chat-list-pane">
      <header className="chat-list-pane-header">
        <div className="chat-list-pane-title-row">
          <h1 className="chat-list-pane-title">{t('对话', 'Chats')}</h1>
          <Button
            variant="primary"
            size="s"
            onClick={() => void handleNewChat()}
            disabled={creating}
          >
            {t('新对话', 'New chat')}
          </Button>
        </div>
        <label className="chat-list-search">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="chat-list-search-icon"
          >
            <path d={SEARCH_ICON_PATH} />
          </svg>
          <span className="visually-hidden">{t('搜索对话', 'Search chats')}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('搜索对话…', 'Search chats…')}
            className="chat-list-search-input"
          />
        </label>
        <Tabs<ChatListFilter>
          ariaLabel="Filter chats"
          value={filter}
          onChange={setFilter}
          options={[
            {
              value: 'active',
              label: t('进行中', 'In progress'),
              count: all === undefined ? undefined : split.active.length,
              testId: 'chats-tab-active',
            },
            {
              value: 'archived',
              label: t('已归档', 'Archived'),
              count: all === undefined ? undefined : split.archived.length,
              testId: 'chats-tab-archived',
            },
          ]}
        />
      </header>

      {createError !== null ? (
        <ErrorBanner error={createError} title={t('无法创建对话', 'Could not create a chat')} />
      ) : null}

      <div className="chat-list-pane-body">
        {chats.state.status === 'loading' ? (
          <SkeletonRows count={5} label="Loading chats" testId="chats-loading" />
        ) : chats.state.status === 'error' ? (
          <ErrorBanner
            error={chats.state.error}
            title={t('无法加载对话', 'Could not load chats')}
            onRetry={() => void chats.reload()}
            testId="chats-error"
          />
        ) : visible.length === 0 ? (
          filter === 'active' ? (
            <EmptyState
              title={t('还没有对话', 'No chats yet')}
              body={t(
                '开始一段对话——入口 agent 可以观察系统、提出动作并代表你派发 Worker。',
                'Start a conversation — the entry agent can observe systems, propose actions and spawn Workers on your behalf.',
              )}
              testId="chats-empty"
            />
          ) : (
            <EmptyState
              title={t('没有已归档的对话', 'No archived chats')}
              body={t(
                '归档只影响列表可见性；对话的 Turn、决定与溯源链保持可查。',
                'Archiving only hides a chat from the list; its Turns, decisions and provenance stay resolvable.',
              )}
              testId="chats-archived-empty"
            />
          )
        ) : (
          <>
            {chats.state.refreshError ? (
              <ErrorBanner error={chats.state.refreshError} onRetry={() => void chats.reload()} />
            ) : null}
            <ul className="chat-rows" aria-label="Chats" data-testid="chats-list">
              {visible.map((chat) => {
                const archived = isArchived(chat);
                const selected = chat.id === selectedChatId;
                const timeValue = archived ? chat.archivedAt : chat.lastActivityAt;
                return (
                  <li
                    key={chat.id}
                    className={`chat-row-item${selected ? ' chat-row-item-selected' : ''}`}
                    data-testid="chat-row"
                    aria-current={selected ? 'true' : undefined}
                    // Same interactive-<li> pattern `components/ui/DataList.tsx`'s `DataRow` uses
                    // (there via a ternary that happens to dodge biome's static check; every row
                    // here is unconditionally selectable, so there is no ternary to write).
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: a selectable list row
                    tabIndex={0}
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest('button, a, input, select, textarea')
                      ) {
                        return;
                      }
                      onSelectChat(chat.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectChat(chat.id);
                      }
                    }}
                  >
                    {renamingId === chat.id ? (
                      <ChatRenameForm
                        client={client}
                        chat={chat}
                        onSaved={onChanged}
                        onCancel={() => setRenamingId(null)}
                      />
                    ) : (
                      <>
                        <div className="chat-row-line1">
                          <span
                            className={`data-row-title chat-row-title-text${chat.title === null ? ' text-3' : ''}`}
                          >
                            {chatTitle(chat, t)}
                          </span>
                          <time
                            className="chat-row-time text-3"
                            title={formatDateTime(timeValue)}
                            data-testid={archived ? 'chat-archived-at' : 'chat-last-activity-at'}
                          >
                            {formatRelative(timeValue)}
                          </time>
                        </div>
                        <div className="chat-row-line2 text-3">
                          {archived ? (
                            <span className="row-wrap">
                              <span
                                className="chip chip-s chip-neutral"
                                data-testid="chat-archived-chip"
                              >
                                {t('已归档', 'Archived')}
                              </span>
                              <span>
                                {t('· 创建于', 'created')}{' '}
                                <time title={formatDateTime(chat.createdAt)}>
                                  {formatRelative(chat.createdAt)}
                                </time>
                              </span>
                            </span>
                          ) : chat.hasRunningTurn ? (
                            <span
                              className="chip chip-s chip-info chip-live"
                              data-testid="chat-running-chip"
                            >
                              {t('运行中', 'Running')}
                            </span>
                          ) : null}
                        </div>
                        <div className="chat-row-actions">
                          <ChatLifecycleActions
                            chat={chat}
                            onRename={() => setRenamingId(chat.id)}
                            onArchive={() => setArchiveTarget(chat)}
                            onRestore={() => void restore(chat)}
                            restoring={restoringId === chat.id}
                            testIdPrefix="chat-row"
                          />
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <ChatArchiveConfirm
        client={client}
        chat={archiveTarget}
        onChanged={onChanged}
        onClose={() => setArchiveTarget(null)}
      />
    </aside>
  );
}
