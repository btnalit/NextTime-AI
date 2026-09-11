import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessPage } from './components/AccessPage.js';
import { AccountPage } from './components/AccountPage.js';
import { AgentProfilePage } from './components/AgentProfilePage.js';
import { ApprovalQueuePage } from './components/ApprovalQueuePage.js';
import { AuditPage } from './components/AuditPage.js';
import { CatalogPage } from './components/CatalogPage.js';
import { ChangePasswordPage } from './components/ChangePasswordPage.js';
import { ChatListPage } from './components/ChatListPage.js';
import { ChatPage } from './components/ChatPage.js';
import { ConnectionsPage } from './components/ConnectionsPage.js';
import { LoginPage } from './components/LoginPage.js';
import { MembersPage } from './components/MembersPage.js';
import { ModelsPage } from './components/ModelsPage.js';
import { NoWorkspacePage } from './components/NoWorkspacePage.js';
import { SetupPage } from './components/SetupPage.js';
import { TasksPage } from './components/TasksPage.js';
import { AppShell } from './components/shell/AppShell.js';
import { ToastProvider } from './components/ui/Toast.js';
import { PermissionsProvider } from './hooks/usePermissions.js';
import { usePushToasts } from './hooks/usePushToasts.js';
import {
  type WireMembership,
  type WireUser,
  logout as apiLogout,
  getMe,
  getSetupState,
  setWorkspaceCookie,
} from './lib/auth-api.js';
import { HttpClient } from './lib/http-client.js';
import { type Route, hrefs, navigate, routeFromHash, sectionOf } from './lib/router.js';
import {
  clearApiKey,
  loadApiKey,
  loadSelectedWorkspaceId,
  saveApiKey,
  saveSelectedWorkspaceId,
} from './lib/session.js';
import { WsClient } from './lib/ws-client.js';
import { wsUrl } from './lib/ws-url.js';

interface Session {
  readonly ws: WsClient;
  readonly http: HttpClient;
  /** Increments per sign-in/workspace-switch so per-session state (permissions, toasts) remounts. */
  readonly generation: number;
  readonly authMode: 'apiKey' | 'cookie';
  // Cookie mode only (S4.1) — undefined for an apiKey session, which has no platform user.
  readonly user?: WireUser;
  readonly memberships?: readonly WireMembership[];
  readonly selectedWorkspaceId?: string;
}

/**
 * The pre-session state machine (S4.1; design doc §7.11) — everything `App` shows *before* a
 * `Session` (a workspace-scoped WS + HTTP pair) exists. `boot` is the brief window while
 * `GET /api/auth/me` is in flight (rendered as nothing — see `App`'s own render switch: a login
 * form flashing into existence and then vanishing again is worse than a blank frame, and
 * `e2e/approvals.spec.ts`'s login helper explicitly treats "no login input in the DOM yet" as
 * "still booting", not "ready to sign in"). `changePassword`/`noWorkspace` both carry the
 * already-known `user`/`memberships` so `AccountPage`/`ChangePasswordPage` never have to re-fetch
 * them.
 */
type PreSessionState =
  | { readonly kind: 'boot' }
  | { readonly kind: 'setup'; readonly tokenAvailable: boolean }
  | { readonly kind: 'login' }
  | {
      readonly kind: 'changePassword';
      readonly user: WireUser;
      readonly memberships: readonly WireMembership[];
    }
  | {
      readonly kind: 'noWorkspace';
      readonly user: WireUser;
      readonly memberships: readonly WireMembership[];
    };

/**
 * App: session + routing (design doc §7.6, §7.11; S1.8, S2.10, S4.1). Owns the single `WsClient`
 * (§7.6 "一个 WebSocket") and the single `HttpClient` — every page receives them as props, never
 * constructs its own. Hash routes (`lib/router.ts`) so a hard reload lands back on the same view.
 *
 * Two independent credential channels reach the same shell: the pre-existing API key
 * (`lib/session.ts` sessionStorage, re-used on reload to reconnect) and, S4.1, the console session
 * cookie (HttpOnly — this file never reads it, only `GET /api/auth/me`'s response). Boot sequence:
 *   1. `GET /api/auth/me`. 200 → cookie session (`proceedAfterCookieAuth` below decides
 *      changePassword / noWorkspace / open-a-workspace from there). 401 (or any other failure —
 *      fails open rather than showing nothing forever) → `GET /api/platform/setup-state`:
 *      `initialized:false` → `SetupPage`; otherwise → `LoginPage`. Either way, also try the stored
 *      API key auto-connect — the two channels are independent, so a held API key must keep
 *      working whether or not anyone has ever completed platform setup (see `SetupPage`'s own
 *      module doc comment for why it *also* offers a way back to `LoginPage`/the API-key form).
 *   2. Workspace selection (`proceedAfterCookieAuth`): auto-select when there is exactly one
 *      active membership; else the last-selected workspace from this tab's sessionStorage if it is
 *      still a membership; else (deviation from a literal "none" — there is no separate workspace-
 *      chooser screen in this task's scope) the first membership, with the Sidebar's switcher
 *      (`>1` membership) covering the rest.
 */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [preSession, setPreSession] = useState<PreSessionState>({ kind: 'boot' });
  const [apiKeyConnecting, setApiKeyConnecting] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<unknown | null>(null);
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const generation = useRef(0);
  // Fence for every in-flight connect/authenticate continuation (review finding, S4.1): each
  // attempt takes the next number, and only a continuation whose number is still current may
  // publish a session. A logout, a "Forget key", or a newer attempt bumps the counter, so the
  // loser of a race closes its own socket instead of leaking it or resurrecting a signed-out
  // shell. `preSessionRef` mirrors `preSession` for callbacks that fire after an await.
  const attempt = useRef(0);
  const preSessionRef = useRef<PreSessionState>({ kind: 'boot' });
  preSessionRef.current = preSession;

  useEffect(() => {
    function onHashChange(): void {
      setRoute(routeFromHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const connectApiKey = useCallback(async (apiKey: string): Promise<void> => {
    setApiKeyConnecting(true);
    setApiKeyError(null);
    const myAttempt = ++attempt.current;
    const ws = new WsClient({ url: wsUrl() });
    try {
      await ws.connect();
      await ws.authenticate({ token: apiKey });
      if (attempt.current !== myAttempt) {
        ws.close();
        return;
      }
      saveApiKey(apiKey);
      generation.current += 1;
      setSession({
        ws,
        http: new HttpClient({ auth: { kind: 'apiKey', apiKey } }),
        generation: generation.current,
        authMode: 'apiKey',
      });
    } catch (err) {
      ws.close();
      if (attempt.current !== myAttempt) return;
      clearApiKey();
      setApiKeyError(err);
    } finally {
      setApiKeyConnecting(false);
    }
  }, []);

  /** Opens a workspace-scoped WS + HTTP session for an already-authenticated cookie user. Sets
   *  the `nexttime_workspace` selector cookie (Explorer, `lib/auth-api.ts`) *before* `setSession`
   *  so any capability call a just-rendered page fires (or a same-tab Explorer navigation) always
   *  sees it. `replacing` is the previous session's socket on a workspace switch: it stays open
   *  (pages still hold it) until the new one is authenticated, then is closed — on success or
   *  failure — by whichever continuation is still current. */
  const openCookieSession = useCallback(
    async (
      user: WireUser,
      memberships: readonly WireMembership[],
      workspaceId: string,
      replacing?: WsClient,
    ): Promise<void> => {
      const myAttempt = ++attempt.current;
      const ws = new WsClient({ url: wsUrl() });
      try {
        await ws.connect();
        await ws.authenticate({ workspaceId });
        if (attempt.current !== myAttempt) {
          ws.close();
          return;
        }
        replacing?.close();
        setWorkspaceCookie(workspaceId);
        saveSelectedWorkspaceId(workspaceId);
        generation.current += 1;
        setSession({
          ws,
          http: new HttpClient({ auth: { kind: 'cookie', workspaceId } }),
          generation: generation.current,
          authMode: 'cookie',
          user,
          memberships,
          selectedWorkspaceId: workspaceId,
        });
      } catch (err) {
        ws.close();
        if (attempt.current !== myAttempt) return;
        replacing?.close();
        // The named membership disappeared, or some other race lost the cookie session between
        // GET /api/auth/me and this WS authenticate — fall back to an always-renderable state
        // rather than a blank screen.
        console.warn('openCookieSession: authenticate failed', err);
        setSession(null);
        setPreSession(
          memberships.length === 0 ? { kind: 'noWorkspace', user, memberships } : { kind: 'login' },
        );
      }
    },
    [],
  );

  const proceedAfterCookieAuth = useCallback(
    async (user: WireUser, memberships: readonly WireMembership[]): Promise<void> => {
      if (user.mustChangePassword) {
        setPreSession({ kind: 'changePassword', user, memberships });
        return;
      }
      if (memberships.length === 0) {
        setPreSession({ kind: 'noWorkspace', user, memberships });
        return;
      }
      const stored = loadSelectedWorkspaceId();
      const firstMembership = memberships[0];
      if (!firstMembership) {
        setPreSession({ kind: 'noWorkspace', user, memberships });
        return;
      }
      const chosen =
        memberships.length === 1
          ? firstMembership.workspaceId
          : stored && memberships.some((m) => m.workspaceId === stored)
            ? stored
            : firstMembership.workspaceId;
      await openCookieSession(user, memberships, chosen);
    },
    [openCookieSession],
  );

  const bootUnauthenticated = useCallback(async (): Promise<void> => {
    try {
      const state = await getSetupState();
      setPreSession(
        state.initialized
          ? { kind: 'login' }
          : { kind: 'setup', tokenAvailable: state.tokenAvailable },
      );
    } catch {
      setPreSession({ kind: 'login' });
    }
    const stored = loadApiKey();
    if (stored) void connectApiKey(stored);
  }, [connectApiKey]);

  // `bootAttempted` guards React 18 StrictMode's dev-only double effect invocation from firing
  // GET /api/auth/me (and, transitively, opening a second WS) twice — same pattern S1.8's own
  // API-key auto-connect always used.
  const bootAttempted = useRef(false);
  useEffect(() => {
    if (bootAttempted.current) return;
    bootAttempted.current = true;
    void (async () => {
      try {
        const me = await getMe();
        await proceedAfterCookieAuth(me.user, me.memberships);
      } catch {
        await bootUnauthenticated();
      }
    })();
  }, [proceedAfterCookieAuth, bootUnauthenticated]);

  const handleForgetKey = useCallback((): void => {
    attempt.current += 1;
    session?.ws.close();
    setSession(null);
    clearApiKey();
    setApiKeyError(null);
    window.location.hash = '';
  }, [session]);

  const handleCookieLogout = useCallback(async (): Promise<void> => {
    attempt.current += 1;
    session?.ws.close();
    setSession(null);
    setWorkspaceCookie(null);
    setPreSession({ kind: 'login' });
    try {
      await apiLogout();
    } catch {
      // Best-effort — server-side revoke (§7.11) is not required for the client to consider
      // itself signed out; the cookie is cleared client-side above either way.
    }
  }, [session]);

  const handleSwitchWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (!session || session.authMode !== 'cookie' || !session.user || !session.memberships)
        return;
      if (workspaceId === session.selectedWorkspaceId || switchingWorkspace) return;
      setSwitchingWorkspace(true);
      try {
        // The old socket is handed over, not closed here: pages keep a working `ws` until the
        // new workspace is authenticated (or the switch fails), and a switch that loses to a
        // later attempt never publishes.
        await openCookieSession(session.user, session.memberships, workspaceId, session.ws);
        navigate(hrefs.chats());
      } finally {
        setSwitchingWorkspace(false);
      }
    },
    [session, switchingWorkspace, openCookieSession],
  );

  const handleUserChanged = useCallback((user: WireUser): void => {
    setSession((s) => (s && s.authMode === 'cookie' ? { ...s, user } : s));
    setPreSession((p) =>
      p.kind === 'noWorkspace' || p.kind === 'changePassword' ? { ...p, user } : p,
    );
  }, []);

  const handlePasswordChanged = useCallback(
    (user: WireUser): void => {
      // Read the *current* state, not the render this callback was created in: a "Sign out"
      // clicked while the change-password request was in flight has already moved us to `login`,
      // and the late success must not reopen a session on a cookie that is being revoked.
      const current = preSessionRef.current;
      if (current.kind !== 'changePassword') return;
      void proceedAfterCookieAuth(user, current.memberships);
    },
    [proceedAfterCookieAuth],
  );

  if (session) {
    return (
      <PermissionsProvider key={session.generation}>
        <ToastProvider>
          <Routed
            session={session}
            route={route}
            onLogout={
              session.authMode === 'cookie' ? () => void handleCookieLogout() : handleForgetKey
            }
            onSwitchWorkspace={(workspaceId) => void handleSwitchWorkspace(workspaceId)}
            switchingWorkspace={switchingWorkspace}
            onUserChanged={handleUserChanged}
          />
        </ToastProvider>
      </PermissionsProvider>
    );
  }

  switch (preSession.kind) {
    case 'boot':
      return null;
    case 'setup':
      return (
        <SetupPage
          tokenAvailable={preSession.tokenAvailable}
          onSetupComplete={(result) => void proceedAfterCookieAuth(result.user, result.memberships)}
          onLoginInstead={() => setPreSession({ kind: 'login' })}
          onApiKeyLogin={(key) => void connectApiKey(key)}
          apiKeyPending={apiKeyConnecting}
          apiKeyError={apiKeyError}
        />
      );
    case 'login':
      return (
        <LoginPage
          onApiKeyLogin={(key) => void connectApiKey(key)}
          apiKeyPending={apiKeyConnecting}
          apiKeyError={apiKeyError}
          onLoggedIn={(result) => void proceedAfterCookieAuth(result.user, result.memberships)}
        />
      );
    case 'changePassword':
      return (
        <ChangePasswordPage
          user={preSession.user}
          onChanged={handlePasswordChanged}
          onLogout={() => void handleCookieLogout()}
        />
      );
    case 'noWorkspace':
      if (route.kind === 'account') {
        return (
          <AccountPage
            user={preSession.user}
            memberships={preSession.memberships}
            onUserChanged={handleUserChanged}
          />
        );
      }
      return (
        <NoWorkspacePage
          user={preSession.user}
          onOpenAccount={() => navigate(hrefs.account())}
          onLogout={() => void handleCookieLogout()}
        />
      );
  }
}

function Routed({
  session,
  route,
  onLogout,
  onSwitchWorkspace,
  switchingWorkspace,
  onUserChanged,
}: {
  readonly session: Session;
  readonly route: Route;
  readonly onLogout: () => void;
  readonly onSwitchWorkspace: (workspaceId: string) => void;
  readonly switchingWorkspace: boolean;
  readonly onUserChanged: (user: WireUser) => void;
}) {
  const active = sectionOf(route);
  usePushToasts(session.ws, active);
  const openApproval = (id: string) => navigate(hrefs.approval(id));
  const openTask = (id: string) => navigate(hrefs.task(id));

  // A stray `#/login` while already signed in (a leftover tab, a manually-typed hash) has nowhere
  // sensible to render — redirect to the default work view, same as an unmatched hash
  // (`lib/router.ts`'s own fallback).
  useEffect(() => {
    if (route.kind === 'login') navigate(hrefs.chats());
  }, [route.kind]);
  if (route.kind === 'login') return null;

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
    case 'chats':
      page = <ChatListPage client={session.ws} onSelectChat={(id) => navigate(hrefs.chat(id))} />;
      break;
    case 'agent':
      page = <AgentProfilePage http={session.http} />;
      break;
    case 'account':
      page = (
        <AccountPage
          user={session.user ?? null}
          memberships={session.memberships ?? []}
          onUserChanged={onUserChanged}
        />
      );
      break;
    case 'members':
      page = <MembersPage http={session.http} />;
      break;
    case 'access':
      page = <AccessPage http={session.http} />;
      break;
    case 'systems':
      page = (
        <ConnectionsPage
          http={session.http}
          selectedGatekeeperId={route.gatekeeperId}
          onSelectGatekeeper={(id) => navigate(id ? hrefs.gatekeeper(id) : hrefs.systems())}
        />
      );
      break;
    case 'catalog':
      page = (
        <CatalogPage
          http={session.http}
          tab={route.tab}
          onTabChange={(tab) => navigate(hrefs.catalog(tab))}
        />
      );
      break;
    case 'models':
      page = <ModelsPage http={session.http} />;
      break;
    case 'audit':
      page = <AuditPage http={session.http} />;
      break;
  }

  return (
    <AppShell
      active={active}
      http={session.http}
      pushes={session.ws}
      authMode={session.authMode}
      onLogout={onLogout}
      memberships={session.memberships}
      selectedWorkspaceId={session.selectedWorkspaceId}
      onSwitchWorkspace={onSwitchWorkspace}
      switchingWorkspace={switchingWorkspace}
    >
      {page}
    </AppShell>
  );
}
