import { useCallback, useState } from 'react';
import { useResource } from '../hooks/useResource.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Icon } from './ui/Icon.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';

/** The subset of `ChatRow` (packages/kernel/src/application/chat/service.ts) this page renders —
 *  extra wire fields (workspaceId, ownerPrincipalId, visibility) are ignored. */
export interface ChatSummary {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
}

export interface ChatListPageProps {
  /** The WS client — `list_chats`/`new_chat` are `chat`-group capabilities (WS-eligible). */
  readonly client: CapabilityCaller;
  readonly onSelectChat: (chatId: string) => void;
}

/** components/ChatListPage: `list_chats` / `new_chat` (design doc §7.6; S1.8 deliverable 1). */
export function ChatListPage({ client, onSelectChat }: ChatListPageProps) {
  const load = useCallback(() => client.call<readonly ChatSummary[]>('list_chats'), [client]);
  const chats = useResource(load);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown | null>(null);

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

  const newChatButton = (
    <Button variant="primary" icon="plus" onClick={() => void handleNewChat()} loading={creating}>
      New chat
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        title="Chats"
        description="Your conversations with the workspace entry agent."
        actions={newChatButton}
      />

      {createError !== null ? (
        <ErrorBanner error={createError} title="Could not create a chat" />
      ) : null}

      {chats.state.status === 'loading' ? (
        <SkeletonRows count={5} label="Loading chats" testId="chats-loading" />
      ) : chats.state.status === 'error' ? (
        <ErrorBanner
          error={chats.state.error}
          title="Could not load chats"
          onRetry={() => void chats.reload()}
          testId="chats-error"
        />
      ) : chats.state.data.length === 0 ? (
        <EmptyState
          icon="chat"
          title="No chats yet"
          body="Start a conversation — the entry agent can observe systems, propose actions and spawn Workers on your behalf."
          action={newChatButton}
          testId="chats-empty"
        />
      ) : (
        <>
          {chats.state.refreshError ? (
            <ErrorBanner error={chats.state.refreshError} onRetry={() => void chats.reload()} />
          ) : null}
          <DataList ariaLabel="Chats" testId="chats-list">
            {chats.state.data.map((chat) => (
              <DataRow
                key={chat.id}
                className="chat-list-item"
                leading={<Icon name="chat" className="text-3" />}
                title={chat.title ?? 'Untitled chat'}
                meta={<time title={formatDateTime(chat.createdAt)}>{formatRelative(chat.createdAt)}</time>}
                trailing={<Icon name="chevron-right" />}
                onSelect={() => onSelectChat(chat.id)}
                testId="chat-row"
              />
            ))}
          </DataList>
        </>
      )}
    </div>
  );
}
