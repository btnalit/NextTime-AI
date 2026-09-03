import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalQueuePage } from './components/ApprovalQueuePage.js';
import { ChatListPage } from './components/ChatListPage.js';
import { ChatPage } from './components/ChatPage.js';
import { ConnectionsPage } from './components/ConnectionsPage.js';
import { LoginPage } from './components/LoginPage.js';
import { TasksPage } from './components/TasksPage.js';
import { AppShell } from './components/shell/AppShell.js';
import { ToastProvider } from './components/ui/Toast.js';
import { PermissionsProvider } from './hooks/usePermissions.js';
import { usePushToasts } from './hooks/usePushToasts.js';
import { HttpClient } from './lib/http-client.js';
import { type Route, hrefs, navigate, routeFromHash, sectionOf } from './lib/router.js';
import { clearApiKey, loadApiKey, saveApiKey } from './lib/session.js';
import { WsClient } from './lib/ws-client.js';
import { wsUrl } from './lib/ws-url.js';

interface Session {
  readonly ws: WsClient;
  readonly http: HttpClient;
  /** Increments per sign-in so per-session state (permissions, toasts) remounts on "Forget key". */
  readonly generation: number;
}

/**
 * App: session + routing (design doc §7.6; S1.8, S2.10). Owns the single `WsClient` (§7.6 "一个
 * WebSocket") and the single `HttpClient` — every page receives them as props, never constructs
 * its own. Hash routes (`lib/router.ts`) so a hard reload lands back on the same view; the API key
 * lives in `sessionStorage` only (`lib/session.ts`) and is re-used on reload to reconnect.
 */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<unknown | null>(null);
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const generation = useRef(0);

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
    const ws = new WsClient({ url: wsUrl() });
    try {
      await ws.connect();
      await ws.authenticate(apiKey);
      saveApiKey(apiKey);
      generation.current += 1;
      setSession({ ws, http: new HttpClient({ apiKey }), generation: generation.current });
    } catch (err) {
      ws.close();
      clearApiKey();
      setAuthError(err);
    } finally {
      setConnecting(false);
    }
  }, []);

  // Auto-connect once on mount if a key survived in this tab's sessionStorage. `attempted` guards
  // React 18 StrictMode's dev-only double effect invocation from opening a second socket.
  const autoConnectAttempted = useRef(false);
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;
    const stored = loadApiKey();
    if (stored) void connect(stored);
  }, [connect]);

  const handleForgetKey = useCallback((): void => {
    session?.ws.close();
    setSession(null);
    clearApiKey();
    setAuthError(null);
    window.location.hash = '';
  }, [session]);

  if (!session) {
    return (
      <LoginPage onLogin={(key) => void connect(key)} pending={connecting} error={authError} />
    );
  }

  return (
    <PermissionsProvider key={session.generation}>
      <ToastProvider>
        <Routed session={session} route={route} onForgetKey={handleForgetKey} />
      </ToastProvider>
    </PermissionsProvider>
  );
}

function Routed({
  session,
  route,
  onForgetKey,
}: {
  readonly session: Session;
  readonly route: Route;
  readonly onForgetKey: () => void;
}) {
  const active = sectionOf(route);
  usePushToasts(session.ws, active);
  const openApproval = (id: string) => navigate(hrefs.approval(id));
  const openTask = (id: string) => navigate(hrefs.task(id));

  let page: JSX.Element;
  switch (route.kind) {
    case 'chat':
      page = (
        <ChatPage
          key={route.chatId}
          client={session.ws}
          http={session.http}
          chatId={route.chatId}
          onBack={() => navigate(hrefs.chats())}
          onOpenApproval={openApproval}
          onOpenTask={openTask}
        />
      );
      break;
    case 'approvals':
      page = (
        <ApprovalQueuePage
          http={session.http}
          pushes={session.ws}
          selectedId={route.actionRequestId}
          onSelect={(id) => navigate(id ? hrefs.approval(id) : hrefs.approvals())}
        />
      );
      break;
    case 'tasks':
      page = (
        <TasksPage
          http={session.http}
          pushes={session.ws}
          selectedId={route.taskId}
          onSelect={(id) => navigate(id ? hrefs.task(id) : hrefs.tasks())}
          onOpenApproval={openApproval}
        />
      );
      break;
    case 'connections':
      page = <ConnectionsPage http={session.http} />;
      break;
    case 'chats':
      page = <ChatListPage client={session.ws} onSelectChat={(id) => navigate(hrefs.chat(id))} />;
      break;
  }

  return (
    <AppShell active={active} http={session.http} pushes={session.ws} onForgetKey={onForgetKey}>
      {page}
    </AppShell>
  );
}
