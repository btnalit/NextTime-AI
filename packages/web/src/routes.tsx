import { lazy, useCallback, useEffect, useState } from 'react';
import { AccountPage } from './components/AccountPage.js';
import { RouteBoundary } from './components/RouteBoundary.js';
import { AppShell } from './components/shell/AppShell.js';
import { EmptyState } from './components/ui/EmptyState.js';
import { usePushToasts } from './hooks/usePushToasts.js';
import type { MeResult, SessionResult, WireUser } from './lib/auth-api.js';
import { type Translate, useT } from './lib/i18n.js';
import { type Route, hrefs, navigate, routeFromHash, sectionOf } from './lib/router.js';
import type { Session } from './session/types.js';

/**
 * Every page below `AccountPage` is `React.lazy` (S8 W1-A5, leftover 49: the main JS chunk was
 * 806 kB raw / 228 kB gzip with all of them imported eagerly here — `MessageBody.tsx`'s own doc
 * comment on `react-markdown` set the precedent this follows). `AccountPage` is the one exception:
 * it is also reachable from `App.tsx`'s *unauthenticated* `noWorkspace` state (a cookie admin with
 * no workspace membership can still reach `#/me/account`), so it stays a static import — same as
 * `LoginPage`/`ChangePasswordPage`/`NoWorkspacePage`, kept eager there for fast first paint — and
 * both call sites share the same module/chunk rather than one static and one dynamic copy of it.
 *
 * `vite.config.ts`'s `manualChunks` groups every `components/platform/*` module (this file's nine
 * `platform*Page` imports) into one `platform` output chunk — the platform section is one admin
 * flow a reader moves through page to page, so bundling it as one fetch avoids a chunk-per-click
 * waterfall; the ten-way split still exists as separate `React.lazy` boundaries (so visiting only
 * `#/platform/overview` never pays for `PlatformAuditPage`'s *own* code needed once its chunk is
 * fetched, cases below just share the one physical file). `react`/`react-dom` go into their own
 * stable `vendor-react` chunk in the same config, so a page chunk's content hash does not change
 * (and its cache does not invalidate) on a release that only touched page code, or only bumped a
 * dependency version — `vendor-react` is already part of the eager initial load (needed to boot
 * at all) so this adds no extra request. The same config also carves out a `vendor-radix` chunk
 * for every `@radix-ui/*` module; nothing on this branch imports one yet (`components/kit/button`,
 * `dialog`, `sheet`, `tooltip` are primitives built ahead of their consumers, W1-A0) — the rule is
 * there so the next kit component that lands in a page (W1-A3 wires tooltip; more will follow)
 * gets its Radix code split from that page's own chunk instead of inflating it, per-page, forever.
 */
const AccessPage = lazy(() =>
  import('./components/AccessPage.js').then((m) => ({ default: m.AccessPage })),
);
const AgentProfilePage = lazy(() =>
  import('./components/AgentProfilePage.js').then((m) => ({ default: m.AgentProfilePage })),
);
const ApprovalQueuePage = lazy(() =>
  import('./components/ApprovalQueuePage.js').then((m) => ({ default: m.ApprovalQueuePage })),
);
const AuditPage = lazy(() =>
  import('./components/AuditPage.js').then((m) => ({ default: m.AuditPage })),
);
const CatalogPage = lazy(() =>
  import('./components/CatalogPage.js').then((m) => ({ default: m.CatalogPage })),
);
const ChatListPage = lazy(() =>
  import('./components/ChatListPage.js').then((m) => ({ default: m.ChatListPage })),
);
const ChatPage = lazy(() =>
  import('./components/ChatPage.js').then((m) => ({ default: m.ChatPage })),
);
const ConnectionsPage = lazy(() =>
  import('./components/ConnectionsPage.js').then((m) => ({ default: m.ConnectionsPage })),
);
const MembersPage = lazy(() =>
  import('./components/MembersPage.js').then((m) => ({ default: m.MembersPage })),
);
const ModelsPage = lazy(() =>
  import('./components/ModelsPage.js').then((m) => ({ default: m.ModelsPage })),
);
const TasksPage = lazy(() =>
  import('./components/TasksPage.js').then((m) => ({ default: m.TasksPage })),
);
const GraphPage = lazy(() =>
  import('./components/graph/GraphPage.js').then((m) => ({ default: m.GraphPage })),
);
const PlatformAuditPage = lazy(() =>
  import('./components/platform/PlatformAuditPage.js').then((m) => ({
    default: m.PlatformAuditPage,
  })),
);
const PlatformIntegrationsPage = lazy(() =>
  import('./components/platform/PlatformIntegrationsPage.js').then((m) => ({
    default: m.PlatformIntegrationsPage,
  })),
);
const PlatformModelsPage = lazy(() =>
  import('./components/platform/PlatformModelsPage.js').then((m) => ({
    default: m.PlatformModelsPage,
  })),
);
const PlatformModulesPage = lazy(() =>
  import('./components/platform/PlatformModulesPage.js').then((m) => ({
    default: m.PlatformModulesPage,
  })),
);
const PlatformOverviewPage = lazy(() =>
  import('./components/platform/PlatformOverviewPage.js').then((m) => ({
    default: m.PlatformOverviewPage,
  })),
);
const PlatformResiduePage = lazy(() =>
  import('./components/platform/PlatformResiduePage.js').then((m) => ({
    default: m.PlatformResiduePage,
  })),
);
const PlatformRuntimePage = lazy(() =>
  import('./components/platform/PlatformRuntimePage.js').then((m) => ({
    default: m.PlatformRuntimePage,
  })),
);
const PlatformSettingsPage = lazy(() =>
  import('./components/platform/PlatformSettingsPage.js').then((m) => ({
    default: m.PlatformSettingsPage,
  })),
);
const PlatformStatusPage = lazy(() =>
  import('./components/platform/PlatformStatusPage.js').then((m) => ({
    default: m.PlatformStatusPage,
  })),
);
const PlatformUsersPage = lazy(() =>
  import('./components/platform/PlatformUsersPage.js').then((m) => ({
    default: m.PlatformUsersPage,
  })),
);
const PlatformWorkspacesPage = lazy(() =>
  import('./components/platform/PlatformWorkspacesPage.js').then((m) => ({
    default: m.PlatformWorkspacesPage,
  })),
);

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
  const t = useT();
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
      page = (
        <ChatListPage
          client={session.ws}
          http={session.http}
          onSelectChat={(id) => navigate(hrefs.chat(id))}
        />
      );
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
          // D3: only when a real workspace is in scope — the same condition `platformOnly` above
          // reads, so a platform-only admin (`selectedWorkspaceId` undefined) never gets a `http`
          // whose `issue_handle` call would target no workspace at all.
          http={session.selectedWorkspaceId !== undefined ? session.http : undefined}
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
          platformAdmin={session.user?.platformRole === 'admin'}
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
    // S6-D: no `key` on purpose — the focus trail and the frozen `sessionAt` are component state a
    // hash-keyed element would reset on every 展开 (GraphPage's own doc comment).
    case 'graph':
      page = <GraphPage http={session.http} />;
      break;
    case 'platformOverview':
      page = requireAdmin(
        session,
        <PlatformOverviewPage http={session.http} onKeyBound={onKeyBound} />,
        t,
      );
      break;
    case 'platformUsers':
      page = requireAdmin(session, <PlatformUsersPage http={session.http} />, t);
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
        t,
      );
      break;
    case 'platformIntegrations':
      page = requireAdmin(
        session,
        <PlatformIntegrationsPage
          http={session.http}
          selectedGateId={route.gateId}
          onSelectGate={(id) =>
            navigate(id ? hrefs.platformGateInstance(id) : hrefs.platformIntegrations())
          }
        />,
        t,
      );
      break;
    case 'platformModules':
      page = requireAdmin(session, <PlatformModulesPage http={session.http} />, t);
      break;
    case 'platformModels':
      page = requireAdmin(session, <PlatformModelsPage http={session.http} />, t);
      break;
    case 'platformSettings':
      page = requireAdmin(session, <PlatformSettingsPage http={session.http} />, t);
      break;
    case 'platformRuntime':
      page = requireAdmin(session, <PlatformRuntimePage http={session.http} />, t);
      break;
    case 'platformStatus':
      page = requireAdmin(session, <PlatformStatusPage http={session.http} />, t);
      break;
    case 'platformAudit':
      page = requireAdmin(session, <PlatformAuditPage http={session.http} />, t);
      break;
    case 'platformResidue':
      page = requireAdmin(session, <PlatformResiduePage http={session.http} />, t);
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
      user={session.user}
    >
      <RouteBoundary key={route.kind}>{page}</RouteBoundary>
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
    kind === 'platformModules' ||
    kind === 'platformModels' ||
    kind === 'platformSettings' ||
    kind === 'platformRuntime' ||
    kind === 'platformStatus' ||
    kind === 'platformAudit' ||
    kind === 'platformResidue'
  );
}

/** Gates a `#/platform/*` page on `platformRole === 'admin'` (design doc §7 "scope:'platform'" —
 *  cookie session + admin only; an apiKey session has no `user` at all here, same denial). A
 *  non-admin who navigates here directly (a stale link, a manually-typed hash) sees a short
 *  explanation rather than a capability call that can only 403. */
function requireAdmin(session: Session, page: JSX.Element, t: Translate): JSX.Element {
  if (session.user?.platformRole === 'admin') return page;
  return (
    <div className="page">
      <EmptyState
        icon="shield"
        title={t('需要管理员', 'Administrator only')}
        testId="platform-admin-required"
      />
    </div>
  );
}
