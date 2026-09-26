import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from 'react';
import { useChatChangeListener } from '../../hooks/useChatUpdates.js';
import { type ChatSummary, isArchived } from '../../lib/chat-lifecycle.js';
import type { WsClient } from '../../lib/ws-client.js';
import { useRestoreChat } from './ChatLifecycleActions.js';

export interface ChatSummaryState {
  readonly chat: ChatSummary | null;
  readonly setChat: Dispatch<SetStateAction<ChatSummary | null>>;
  readonly chatLookupFailed: boolean;
  readonly archived: boolean;
  readonly onChatChanged: (updated: ChatSummary) => void;
  readonly restore: (chat: ChatSummary) => Promise<void>;
  readonly restoringId: string | null;
}

/**
 * components/chat/useChatSummary: `ChatPage`'s own row (title, `archivedAt`) — looked up once per
 * `chatId` from `list_chats{includeArchived: true}` and kept current by `chat.metadata` pushes
 * (applied by the caller through `setChat`, see `useChatMessages`), by rename/archive/restore
 * results (`onChatChanged`), and by the cross-page archive broadcast (`useChatChangeListener`).
 * 遗留 57: the broadcast listener only applies an update that is still about *this* open chat —
 * `hooks/useChatUpdates.tsx`'s broadcast reaches whichever page is mounted when it fires, not only
 * the one that triggered it.
 */
export function useChatSummary(client: WsClient, chatId: string): ChatSummaryState {
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [chatLookupFailed, setChatLookupFailed] = useState(false);

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
  const onBroadcastChatChanged = useCallback(
    (updated: ChatSummary): void => {
      if (updated.id === chatId) setChat(updated);
    },
    [chatId],
  );
  useChatChangeListener(onBroadcastChatChanged);
  const { restore, restoringId } = useRestoreChat(client, onChatChanged);
  const archived = chat !== null && isArchived(chat);

  return { chat, setChat, chatLookupFailed, archived, onChatChanged, restore, restoringId };
}
