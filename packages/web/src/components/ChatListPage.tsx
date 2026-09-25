import { useCallback, useMemo, useState } from 'react';
import { useChatChangeListener } from '../hooks/useChatUpdates.js';
import { useResource } from '../hooks/useResource.js';
import { type ChatSummary, chatTitle, isArchived, spliceChat } from '../lib/chat-lifecycle.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { ChatArchiveConfirm } from './chat/ChatArchiveConfirm.js';
import { ChatLifecycleActions, useRestoreChat } from './chat/ChatLifecycleActions.js';
import { ChatRenameForm } from './chat/ChatRenameForm.js';
import { PageHeader } from './kit/page-header.js';
import { ExecutionReadinessCard } from './readiness/ExecutionReadinessCard.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Icon } from './ui/Icon.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { Tabs } from './ui/Tabs.js';

export type { ChatSummary } from '../lib/chat-lifecycle.js';

export interface ChatListPageProps {
  /** The WS client — `list_chats` / `new_chat` / `archive_chat` / `unarchive_chat` /
   *  `rename_chat` are `chat`-group capabilities (WS-eligible). */
  readonly client: CapabilityCaller;
  /** S8 W2 U3a (ui-audit-2026-09-23 J1): `execution_readiness` is `group:'governance'`, not
   *  `chat` — the `ws` client above only carries `chat`-group capabilities
   *  (`lib/clients.ts`'s own doc comment) — so `ExecutionReadinessCard` needs the workspace `http`
   *  caller separately. See that component's own doc comment for why this page, rather than
   *  `PlatformOverviewPage`, is where J1's "执行就绪" check lives. */
  readonly http: CapabilityCaller;
  readonly onSelectChat: (chatId: string) => void;
}

type Filter = 'active' | 'archived';

/**
 * components/ChatListPage: `list_chats` / `new_chat` (design doc §7.6; S1.8 deliverable 1) plus
 * the S6-A lifecycle (console-completion-plan §5.1 "归档与改名", W1): one load with
 * `includeArchived: true`, split client-side by `archivedAt` into the 活跃 / 已归档 tabs, so an
 * archive, restore or rename only splices the kernel's returned row into the cache
 * (`spliceChat`) and the row moves between tabs without a refetch. `chat.metadata` pushes never
 * reach this page (per-chat subscription only) — the splice is the one source of freshness here
 * besides a reload. A chat with no title yet reads as "新对话 New chat": the kernel writes the
 * auto-title when the first user message lands.
 */
export function ChatListPage({ client, http, onSelectChat }: ChatListPageProps) {
  const t = useT();
  const load = useCallback(
    () =>
      client
        .call<{ items: readonly ChatSummary[] }>('list_chats', { includeArchived: true })
        .then((page) => page.items),
    [client],
  );
  const chats = useResource(load);
  const [filter, setFilter] = useState<Filter>('active');
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
  const visible = filter === 'active' ? split.active : split.archived;

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
  // 遗留 57: an archive Undo toast fired from a different, now-unmounted page (or from this page
  // after it remounted for an unrelated reason) reaches every currently-mounted listener via
  // `hooks/useChatUpdates.tsx`'s broadcast, not only the `ChatArchiveConfirm` instance below —
  // `onChanged` already knows how to splice a changed row into this page's own cache.
  useChatChangeListener(onChanged);
  const { restore, restoringId } = useRestoreChat(client, onChanged);

  const newChatButton = (
    <Button variant="primary" icon="plus" onClick={() => void handleNewChat()} loading={creating}>
      {t('新对话', 'New chat')}
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('chats')}
        title={t('对话', 'Chats')}
        description={t(
          '与工作区入口 agent 的对话。',
          'Your conversations with the workspace entry agent.',
        )}
        primaryAction={newChatButton}
      />

      <ExecutionReadinessCard http={http} />

      <div className="page-toolbar">
        <Tabs<Filter>
          ariaLabel="Filter chats"
          value={filter}
          onChange={setFilter}
          options={[
            {
              value: 'active',
              label: t('活跃', 'Active'),
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
      </div>

      {createError !== null ? (
        <ErrorBanner error={createError} title={t('无法创建对话', 'Could not create a chat')} />
      ) : null}

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
            icon="chat"
            title={t('还没有对话', 'No chats yet')}
            body={t(
              '开始一段对话——入口 agent 可以观察系统、提出动作并代表你派发 Worker。',
              'Start a conversation — the entry agent can observe systems, propose actions and spawn Workers on your behalf.',
            )}
            action={newChatButton}
            testId="chats-empty"
          />
        ) : (
          <EmptyState
            icon="inbox"
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
          <DataList ariaLabel="Chats" testId="chats-list">
            {visible.map((chat) => (
              <DataRow
                key={chat.id}
                className="chat-list-item"
                leading={<Icon name="chat" className="text-3" />}
                title={
                  renamingId === chat.id ? (
                    <ChatRenameForm
                      client={client}
                      chat={chat}
                      onSaved={onChanged}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <span className={chat.title === null ? 'text-3' : undefined}>
                      {chatTitle(chat, t)}
                    </span>
                  )
                }
                meta={
                  isArchived(chat) ? (
                    <span className="row-wrap">
                      <span className="chip chip-s chip-neutral" data-testid="chat-archived-chip">
                        {t('已归档', 'Archived')}
                      </span>
                      <time title={formatDateTime(chat.archivedAt)} data-testid="chat-archived-at">
                        {formatRelative(chat.archivedAt)}
                      </time>
                      <span className="text-3">
                        {t('· 创建于', 'created')}{' '}
                        <time title={formatDateTime(chat.createdAt)}>
                          {formatRelative(chat.createdAt)}
                        </time>
                      </span>
                    </span>
                  ) : (
                    <time title={formatDateTime(chat.createdAt)}>
                      {formatRelative(chat.createdAt)}
                    </time>
                  )
                }
                trailing={
                  <span className="row">
                    <ChatLifecycleActions
                      chat={chat}
                      onRename={() => setRenamingId(chat.id)}
                      onArchive={() => setArchiveTarget(chat)}
                      onRestore={() => void restore(chat)}
                      restoring={restoringId === chat.id}
                      testIdPrefix="chat-row"
                    />
                    <Icon name="chevron-right" />
                  </span>
                }
                onSelect={() => onSelectChat(chat.id)}
                testId="chat-row"
              />
            ))}
          </DataList>
        </>
      )}

      <ChatArchiveConfirm
        client={client}
        chat={archiveTarget}
        onChanged={onChanged}
        onClose={() => setArchiveTarget(null)}
      />
    </div>
  );
}
