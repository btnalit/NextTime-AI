import { useCallback, useEffect, useState } from 'react';
import { AccessPage } from './components/AccessPage.js';
import { AccountPage } from './components/AccountPage.js';
import { AgentProfilePage } from './components/AgentProfilePage.js';
import { ApprovalQueuePage } from './components/ApprovalQueuePage.js';
import { AuditPage } from './components/AuditPage.js';
import { CatalogPage } from './components/CatalogPage.js';
import { ChatListPage } from './components/ChatListPage.js';
import { ChatPage } from './components/ChatPage.js';
import { ConnectionsPage } from './components/ConnectionsPage.js';
import { MembersPage } from './components/MembersPage.js';
import { ModelsPage } from './components/ModelsPage.js';
import { TasksPage } from './components/TasksPage.js';
import { PlatformAuditPage } from './components/platform/PlatformAuditPage.js';
import { PlatformIntegrationsPage } from './components/platform/PlatformIntegrationsPage.js';
import { PlatformOverviewPage } from './components/platform/PlatformOverviewPage.js';
import { PlatformSettingsPage } from './components/platform/PlatformSettingsPage.js';
import { PlatformUsersPage } from './components/platform/PlatformUsersPage.js';
import { PlatformWorkspacesPage } from './components/platform/PlatformWorkspacesPage.js';
import { AppShell } from './components/shell/AppShell.js';
import { EmptyState } from './components/ui/EmptyState.js';
import { usePushToasts } from './hooks/usePushToasts.js';
import type { MeResult, SessionResult, WireUser } from './lib/auth-api.js';
import { type Route, hrefs, navigate, routeFromHash, sectionOf } from './lib/router.js';
import type { Session } from './session/types.js';

/**
 * routes: the route table — which page a `Route` (lib/router.ts) renders inside the shell for a
 * published `Session` (C23 split of App.tsx, console-completion-plan §5.8). Hash routing is
 * unchanged: `lib/router.ts` parses the hash into a `Route`, `useHashRoute` below keeps that in
 * React state, and `Routed`'s `switch` maps it to a page.
 *
 * **Add new pages here**: (1) add the `Route` variant, its `NavSection` and its `hrefs` entry in
 * `lib/router.ts`; (2) add a `case` to `Routed`'s `switch` below (wrap it in `requireAdmin` for a
 * `#/platform/*` page and list its kind in `isPlatformRoute`); (3) add the nav item in
 * `components/shell/Sidebar.tsx`. Session-level concerns (sign-in, workspace switch, logout)
 * stay in `session/useSessionMachine.ts` — a page only ever receives `session.http` /
 * `session.ws` and navigation callbacks.
 */

/** The current hash route in React state, plus `syncRoute` — a synchronous re-read for the one
 *  caller that cannot wait for the asynchronous `hashchange` event (`useSessionMachine`'s
 *  `proceedAfterCookieAuth`, which publishes a session right after navigating). */
export function useHashRoute(): { readonly route: Route; readonly syncRoute: () => void } {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const syncRoute = useCallback((): void => {
    setRoute(routeFromHash(window.location.hash));
  }, []);
  useEffect(() => {
    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, [syncRoute]);
  return { route, syncRoute };
}

export interface RoutedProps {
  readonly session: Session;
  readonly route: Route;
  readonly onLogout: () => void;
  readonly onSwitchWorkspace: (workspaceId: string, destination?: string) => void;
  readonly switchingWorkspace: boolean;
  readonly onUserChanged: (user: WireUser) => void;
  readonly onKeyBound: (result: MeResult) => void;
  readonly onClaimed: (result: SessionResult) => void;
}

/** The signed-in shell: `AppShell` around the page `route` selects. */
export function Routed({
  session,
  route,
  onLogout,
  onSwitchWorkspace,
  switchingWorkspace,
  onUserChanged,
  onKeyBound,
  onClaimed,
}: RoutedProps) {
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

  // A platform-only session (`useSessionMachine`'s `openPlatformOnlySession` — a cookie admin with
  // zero workspace memberships, `selectedWorkspaceId` undefined) has no workspace to render any
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
      // C1: an API-key session needs its key for the claim form; a cookie session needs the bind
      // handler for the "bind another API key" card — neither was wired before, so both flows
      // the login page advertises were unreachable (console-completion-plan §2b C1).
      page = (
        <AccountPage
          user={session.user ?? null}
          memberships={session.memberships ?? []}
          onUserChanged={onUserChanged}
          apiKey={session.apiKey}
          onClaimed={onClaimed}
          onBound={onKeyBound}
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
export function isDefaultLanding(hash: string): boolean {
  if (hash === '' || hash === '#' || hash === '#/' || hash === hrefs.login()) return true;
  return routeFromHash(hash).kind === 'chats' && hash !== hrefs.chats();
}

/** True for every `#/platform/*` route kind — used by `Routed`'s platform-only redirect. */
export function isPlatformRoute(kind: Route['kind']): boolean {
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
