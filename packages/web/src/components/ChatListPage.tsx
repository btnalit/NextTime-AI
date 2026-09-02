import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../lib/errors.js';
import type { WsClient } from '../lib/ws-client.js';

/** The subset of `ChatRow` (packages/kernel/src/application/chat/service.ts) this page renders —
 *  extra wire fields (workspaceId, ownerPrincipalId, visibility) are simply ignored. */
export interface ChatSummary {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
}

export interface ChatListPageProps {
  readonly client: WsClient;
  readonly onSelectChat: (chatId: string) => void;
  readonly onForgetKey: () => void;
}

/**
 * components/ChatListPage: `list_chats` / `new_chat` (design doc §7.6; docs/development-tasks.md
 * S1.8 deliverable 1).
 */
export function ChatListPage({ client, onSelectChat, onForgetKey }: ChatListPageProps) {
  const [chats, setChats] = useState<readonly ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await client.call<readonly ChatSummary[]>('list_chats');
      setChats(result);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleNewChat(): Promise<void> {
    setCreating(true);
    setError(null);
    try {
      const chat = await client.call<ChatSummary>('new_chat', {});
      onSelectChat(chat.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Chats</h1>
        <div className="header-actions">
          <button type="button" onClick={() => void handleNewChat()} disabled={creating}>
            {creating ? 'Creating…' : 'New chat'}
          </button>
          <button type="button" className="secondary" onClick={onForgetKey}>
            Forget key
          </button>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {chats === null ? (
        <p className="hint">Loading…</p>
      ) : chats.length === 0 ? (
        <p className="hint">No chats yet — start one.</p>
      ) : (
        <ul className="chat-list">
          {chats.map((chat) => (
            <li key={chat.id}>
              <button
                type="button"
                className="chat-list-item"
                onClick={() => onSelectChat(chat.id)}
              >
                <span className="chat-title">{chat.title ?? 'Untitled chat'}</span>
                <span className="chat-created">{new Date(chat.createdAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
