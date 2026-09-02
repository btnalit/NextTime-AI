import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatListPage } from './components/ChatListPage.js';
import { ChatPage } from './components/ChatPage.js';
import { LoginPage } from './components/LoginPage.js';
import { errorMessage } from './lib/errors.js';
import { clearApiKey, loadApiKey, saveApiKey } from './lib/session.js';
import { WsClient } from './lib/ws-client.js';
import { wsUrl } from './lib/ws-url.js';

/** `#/chats/<id>` ↔ the open chat; `#/chats` (or anything else) ↔ the chat list. Hash-based so a
 *  hard page reload (docs/development-tasks.md S1.8 acceptance: "刷新后历史完整") lands back on
 *  the same chat without any server-side routing. */
function chatIdFromHash(hash: string): string | null {
  const match = /^#\/chats\/(.+)$/.exec(hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function navigateToChat(chatId: string): void {
  window.location.hash = `#/chats/${encodeURIComponent(chatId)}`;
}

function navigateToChatList(): void {
  window.location.hash = '#/chats';
}

/**
 * App: the top-level screen switch (design doc §7.6; docs/development-tasks.md S1.8). Owns the
 * single `WsClient` for the whole app (§7.6 "一个 WebSocket") — `ChatListPage`/`ChatPage` only
 * ever receive it as a prop, never construct their own.
 */
export function App() {
  const [client, setClient] = useState<WsClient | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(() => chatIdFromHash(window.location.hash));

  useEffect(() => {
    function onHashChange(): void {
      setChatId(chatIdFromHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const connect = useCallback(async (apiKey: string): Promise<void> => {
    setConnecting(true);
    setAuthError(null);
    const next = new WsClient({ url: wsUrl() });
    try {
      await next.connect();
      await next.authenticate(apiKey);
      saveApiKey(apiKey);
      setClient(next);
    } catch (err) {
      next.close();
      clearApiKey();
      setAuthError(errorMessage(err));
    } finally {
      setConnecting(false);
    }
  }, []);

  // Auto-connect once on mount if a key survived from an earlier load in this tab (sessionStorage
  // — src/lib/session.ts). A hard reload re-runs this, which is exactly what "刷新后历史完整"
  // depends on: reload -> reconnect -> re-authenticate -> ChatPage re-subscribes from scratch.
  // `attempted` guards against React 18 StrictMode's dev-only double-invoke of effects opening a
  // second, redundant socket.
  const autoConnectAttempted = useRef(false);
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;
    const stored = loadApiKey();
    if (stored) void connect(stored);
  }, [connect]);

  const handleForgetKey = useCallback((): void => {
    client?.close();
    setClient(null);
    clearApiKey();
    setAuthError(null);
    window.location.hash = '';
  }, [client]);

  if (!client) {
    return (
      <LoginPage onLogin={(key) => void connect(key)} pending={connecting} error={authError} />
    );
  }

  if (chatId) {
    return (
      <ChatPage
        key={chatId}
        client={client}
        chatId={chatId}
        onBack={navigateToChatList}
        onForgetKey={handleForgetKey}
      />
    );
  }

  return (
    <ChatListPage client={client} onSelectChat={navigateToChat} onForgetKey={handleForgetKey} />
  );
}
