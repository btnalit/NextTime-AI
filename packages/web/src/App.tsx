import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalQueuePage } from './components/ApprovalQueuePage.js';
import { ChatListPage } from './components/ChatListPage.js';
import { ChatPage } from './components/ChatPage.js';
import { ConnectionsPage } from './components/ConnectionsPage.js';
import { LoginPage } from './components/LoginPage.js';
import { TasksPage } from './components/TasksPage.js';
import { errorMessage } from './lib/errors.js';
import { HttpClient } from './lib/http-client.js';
import { clearApiKey, loadApiKey, saveApiKey } from './lib/session.js';
import { WsClient } from './lib/ws-client.js';
import { wsUrl } from './lib/ws-url.js';

/**
 * Hash-based routing (no router library, per S1.8's own convention) — `#/chats/<id>` ↔ one open
 * chat, `#/chats` ↔ the chat list, `#/approvals`/`#/tasks`/`#/connections` ↔ the three S2.10
 * additions, anything else (including empty) falls back to the chat list. Hash-based so a hard
 * page reload (docs/development-tasks.md S1.8 acceptance: "刷新后历史完整") lands back on the same
 * view without any server-side routing.
 */
type Route =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'chats' }
  | { readonly kind: 'approvals' }
  | { readonly kind: 'tasks' }
  | { readonly kind: 'connections' };

function routeFromHash(hash: string): Route {
  const chatMatch = /^#\/chats\/(.+)$/.exec(hash);
  if (chatMatch?.[1]) return { kind: 'chat', chatId: decodeURIComponent(chatMatch[1]) };
  if (hash === '#/approvals') return { kind: 'approvals' };
  if (hash === '#/tasks') return { kind: 'tasks' };
  if (hash === '#/connections') return { kind: 'connections' };
  return { kind: 'chats' };
}

function navigateToChat(chatId: string): void {
  window.location.hash = `#/chats/${encodeURIComponent(chatId)}`;
}

function navigateToChatList(): void {
  window.location.hash = '#/chats';
}

/**
 * App: the top-level screen switch (design doc §7.6; docs/development-tasks.md S1.8, S2.10). Owns
 * the single `WsClient` (§7.6 "一个 WebSocket") and the single `HttpClient` (S2.10 addition — every
 * capability outside the `chat` group goes over `POST /api/cap/<name>` instead, lib/http-client.ts)
 * for the whole app; every page only ever receives them as props, never constructs its own.
 */
export function App() {
  const [client, setClient] = useState<WsClient | null>(null);
  const [httpClient, setHttpClient] = useState<HttpClient | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    function onHashChange(): void {
      setRoute(routeFromHash(window.location.hash));
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
      setHttpClient(new HttpClient({ apiKey }));
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
    setHttpClient(null);
    clearApiKey();
    setAuthError(null);
    window.location.hash = '';
  }, [client]);

  if (!client || !httpClient) {
    return (
      <LoginPage onLogin={(key) => void connect(key)} pending={connecting} error={authError} />
    );
  }

  switch (route.kind) {
    case 'chat':
      return (
        <ChatPage
          key={route.chatId}
          client={client}
          httpClient={httpClient}
          chatId={route.chatId}
          onBack={navigateToChatList}
          onForgetKey={handleForgetKey}
        />
      );
    case 'approvals':
      return (
        <ApprovalQueuePage
          httpClient={httpClient}
          wsClient={client}
          onForgetKey={handleForgetKey}
        />
      );
    case 'tasks':
      return <TasksPage httpClient={httpClient} wsClient={client} onForgetKey={handleForgetKey} />;
    case 'connections':
      return <ConnectionsPage httpClient={httpClient} onForgetKey={handleForgetKey} />;
    case 'chats':
      return (
        <ChatListPage client={client} onSelectChat={navigateToChat} onForgetKey={handleForgetKey} />
      );
  }
}
