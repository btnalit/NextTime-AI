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
import { TasksPage } from './components/TasksPage.js';
import { PlatformAuditPage } from './components/platform/PlatformAuditPage.js';
import { PlatformIntegrationsPage } from './components/platform/PlatformIntegrationsPage.js';
import { PlatformOverviewPage } from './components/platform/PlatformOverviewPage.js';
import { PlatformSettingsPage } from './components/platform/PlatformSettingsPage.js';
import { PlatformUsersPage } from './components/platform/PlatformUsersPage.js';
import { PlatformWorkspacesPage } from './components/platform/PlatformWorkspacesPage.js';
import { AppShell } from './components/shell/AppShell.js';
import { EmptyState } from './components/ui/EmptyState.js';
import { ToastProvider } from './components/ui/Toast.js';
import { PermissionsProvider } from './hooks/usePermissions.js';
import { usePushToasts } from './hooks/usePushToasts.js';
import {
  type MeResult,
  type WireMembership,
  type WireUser,
  logout as apiLogout,
  getMe,
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
 * them. `noWorkspace` is reached only by a `platformRole === 'user'` cookie user with zero
 * memberships (design doc §4/§6.7) — a platform admin with zero memberships instead gets a
 * `Session` with `selectedWorkspaceId` undefined (`openPlatformOnlySession` below), since an
 * administrator always has the platform plane even with no workspace data access (§2 "平台管理员
 * 在业务工作区没有任何数据权限").
 */
type PreSessionState =
  | { readonly kind: 'boot' }
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
 * cookie (HttpOnly — this file never reads it, only `GET /api/auth/me`'s response). Boot sequence
 * (P-A1 revised — no setup token/page any more; the kernel pre-creates `admin`, design doc §4):
 *   1. `GET /api/auth/me`. 200 → cookie session (`proceedAfterCookieAuth` below decides
 *      changePassword / noWorkspace / platform-only / open-a-workspace from there). 401 (or any
 *      other failure — fails open rather than showing nothing forever) → `LoginPage`. Either way,
 *      also try the stored API key auto-connect — the two channels are independent.
 *   2. Workspace selection (`proceedAfterCookieAuth`): auto-select when there is exactly one
 *      active membership; else the last-selected workspace from this tab's sessionStorage if it is
 *      still a membership; else (deviation from a literal "none" — there is no separate workspace-
 *      chooser screen in this task's scope) the first membership, with the Sidebar's switcher
 *      (`>1` membership) covering the rest. Zero memberships: `platformRole === 'admin'` opens a
 *      platform-only session (`openPlatformOnlySession`) landing on `#/platform/overview`;
 *      `platformRole === 'user'` sees `NoWorkspacePage`.
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

  /** Opens a session for a cookie-authenticated platform admin with zero workspace memberships —
   *  the normal state before anyone else exists / has been added anywhere (design doc §4 "平台管
   *  理员在业务工作区没有任何数据权限"). There is no workspace to open a WS session against — the
   *  kernel's `authenticate {workspaceId}` always requires one and throws `WorkspaceRequiredError`
   *  otherwise (`resolve-caller.ts`) — so unlike `openCookieSession` this never calls `connect()`/
   *  `authenticate()` at all: the `WsClient` stays `closed` (the Sidebar honestly shows
   *  "Disconnected"), and every page this session can reach (`platform_overview`,
   *  `platform_audit_query`, ...) calls over `http` only, never `session.ws.call()`. `http` uses
   *  `workspaceId: null` — `scope:'platform'` capabilities ignore the workspace header entirely
   *  (`resolvePlatformCaller`), so this degrades cleanly. `replacing` mirrors `openCookieSession`'s
   *  own — the previous socket, closed once this session publishes. */
  const openPlatformOnlySession = useCallback(
    (user: WireUser, memberships: readonly WireMembership[], replacing?: WsClient): void => {
      attempt.current += 1;
      replacing?.close();
      setWorkspaceCookie(null);
      generation.current += 1;
      setSession({
        ws: new WsClient({ url: wsUrl() }),
        http: new HttpClient({ auth: { kind: 'cookie', workspaceId: null } }),
        generation: generation.current,
        authMode: 'cookie',
        user,
        memberships,
        selectedWorkspaceId: undefined,
      });
    },
    [],
  );

  const proceedAfterCookieAuth = useCallback(
    async (
      user: WireUser,
      memberships: readonly WireMembership[],
      replacing?: WsClient,
    ): Promise<void> => {
      if (user.mustChangePassword) {
        setPreSession({ kind: 'changePassword', user, memberships });
        return;
      }
      // Administrators land on the platform plane, everyone else on chats (design doc §6.7:
      // "概览是管理员的落地页；普通用户落在对话页"). Only when the hash carries no deliberate
      // destination — a reload on `#/work/chats`, a bookmarked `#/govern/audit`, and the
      // `#/platform/overview` this very function is re-entered with after a bind (below) are all
      // left exactly where they are. `setRoute` is called alongside `navigate` because the
      // `hashchange` event is asynchronous and `openPlatformOnlySession` right below is not: a
      // session published against the *old* route would otherwise be redirected by `Routed`'s own
      // stale-`#/login` effect before the hash change ever arrives.
      if (user.platformRole === 'admin' && isDefaultLanding(window.location.hash)) {
        navigate(hrefs.platformOverview());
        setRoute(routeFromHash(window.location.hash));
      }
      if (memberships.length === 0) {
        if (user.platformRole === 'admin') {
          openPlatformOnlySession(user, memberships, replacing);
          return;
        }
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
      await openCookieSession(user, memberships, chosen, replacing);
    },
    [openCookieSession, openPlatformOnlySession],
  );

  const bootUnauthenticated = useCallback(async (): Promise<void> => {
    setPreSession({ kind: 'login' });
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

  /** `destination` is where to land *after* the new workspace is authenticated — the Sidebar's own
   *  switcher takes the default (`#/work/chats`), P-A2's "打开工作区配置" passes `#/govern/members`.
   *  It has to be navigated here rather than by the caller: the caller's `navigate` would run
   *  while the old session is still published and this function would then overwrite it. */
  const handleSwitchWorkspace = useCallback(
    async (workspaceId: string, destination: string = hrefs.chats()): Promise<void> => {
      if (!session || session.authMode !== 'cookie' || !session.user || !session.memberships)
        return;
      if (workspaceId === session.selectedWorkspaceId || switchingWorkspace) return;
      setSwitchingWorkspace(true);
      try {
        // The old socket is handed over, not closed here: pages keep a working `ws` until the
        // new workspace is authenticated (or the switch fails), and a switch that loses to a
        // later attempt never publishes.
        await openCookieSession(session.user, session.memberships, workspaceId, session.ws);
        navigate(destination);
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

  /** `BindApiKeyForm` on the platform overview just folded an existing API key's membership into
   *  this account (`POST /api/auth/bind-api-key` answers with the caller's refreshed
   *  `{user, memberships}`). Route it through the same `proceedAfterCookieAuth` the change-password
   *  path uses, handing over the current socket: a platform-only admin (no memberships, no WS at
   *  all) is thereby upgraded to a real workspace session and can open the workspace it just
   *  bound without reloading the page. */
  const handleKeyBound = useCallback(
    (result: MeResult): void => {
      void proceedAfterCookieAuth(result.user, result.memberships, session?.ws);
    },
    [proceedAfterCookieAuth, session],
  );

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
            onSwitchWorkspace={(workspaceId, destination) =>
              void handleSwitchWorkspace(workspaceId, destination)
            }
            switchingWorkspace={switchingWorkspace}
            onUserChanged={handleUserChanged}
            onKeyBound={handleKeyBound}
          />
        </ToastProvider>
      </PermissionsProvider>
    );
  }

  switch (preSession.kind) {
    case 'boot':
      return null;
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
  onKeyBound,
}: {
  readonly session: Session;
  readonly route: Route;
  readonly onLogout: () => void;
  readonly onSwitchWorkspace: (workspaceId: string, destination?: string) => void;
  readonly switchingWorkspace: boolean;
  readonly onUserChanged: (user: WireUser) => void;
  readonly onKeyBound: (result: MeResult) => void;
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

  // A platform-only session (`App`'s `openPlatformOnlySession` — a cookie admin with zero
  // workspace memberships, `selectedWorkspaceId` undefined) has no workspace to render any
  // workspace-scoped route against. `#/me/account` is let through (`AccountPage` takes only
  // `user`/`memberships`, no capability call — same as the old `noWorkspace` preSession state
  // allowed) — every other non-platform route redirects to `#/platform/overview`, covering both a
  // fresh landing and a reload on a stale workspace hash. Computed before either early `return`
  // below so both `useEffect` calls above always run in the same order (Rules of Hooks).
  const platformOnly = session.authMode === 'cookie' && session.selectedWorkspaceId === undefined;
  const platformOnlyBlocked =
    platformOnly && !isPlatformRoute(route.kind) && route.kind !== 'account';
  useEffect(() => {
    if (platformOnlyBlocked) navigate(hrefs.platformOverview());
  }, [platformOnlyBlocked]);

  if (route.kind === 'login') return null;
  if (platformOnlyBlocked) return null;

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
    case 'platformOverview':
      page = requireAdmin(
        session,
        <PlatformOverviewPage http={session.http} onKeyBound={onKeyBound} />,
      );
      break;
    case 'platformUsers':
      page = requireAdmin(session, <PlatformUsersPage http={session.http} />);
      break;
    case 'platformWorkspaces':
      page = requireAdmin(
        session,
        <PlatformWorkspacesPage
          http={session.http}
          memberships={session.memberships ?? []}
          onOpenWorkspaceConfig={(workspaceId) => {
            // Already in it (the switcher would no-op) — just go to the owner pages.
            if (workspaceId === session.selectedWorkspaceId) navigate(hrefs.members());
            else onSwitchWorkspace(workspaceId, hrefs.members());
          }}
        />,
      );
      break;
    case 'platformIntegrations':
      page = requireAdmin(session, <PlatformIntegrationsPage http={session.http} />);
      break;
    case 'platformSettings':
      page = requireAdmin(session, <PlatformSettingsPage http={session.http} />);
      break;
    case 'platformAudit':
      page = requireAdmin(session, <PlatformAuditPage http={session.http} />);
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
      platformRole={session.user?.platformRole}
    >
      {page}
    </AppShell>
  );
}

/**
 * True when the current hash names no deliberate destination: empty (a fresh load), a bare `#`/
 * `#/`, a stale `#/login`, or anything unknown that `routeFromHash` had to fall back to the
 * default `chats` route for. An explicit `#/work/chats` — or any other real route — *is* a
 * destination and is left alone, so a reload never moves the reader off the page they were on.
 */
function isDefaultLanding(hash: string): boolean {
  if (hash === '' || hash === '#' || hash === '#/' || hash === hrefs.login()) return true;
  return routeFromHash(hash).kind === 'chats' && hash !== hrefs.chats();
}

/** True for every `#/platform/*` route kind — used by `Routed`'s platform-only redirect. */
function isPlatformRoute(kind: Route['kind']): boolean {
  return (
    kind === 'platformOverview' ||
    kind === 'platformUsers' ||
    kind === 'platformWorkspaces' ||
    kind === 'platformIntegrations' ||
    kind === 'platformSettings' ||
    kind === 'platformAudit'
  );
}

/** Gates a `#/platform/*` page on `platformRole === 'admin'` (design doc §7 "scope:'platform'" —
 *  cookie session + admin only; an apiKey session has no `user` at all here, same denial). A
 *  non-admin who navigates here directly (a stale link, a manually-typed hash) sees a short
 *  explanation rather than a capability call that can only 403. */
function requireAdmin(session: Session, page: JSX.Element): JSX.Element {
  if (session.user?.platformRole === 'admin') return page;
  return (
    <div className="page">
      <EmptyState
        icon="shield"
        title="需要管理员 Administrator only"
        testId="platform-admin-required"
      />
    </div>
  );
}
