import type { ReactNode } from 'react';
import type { WireMembership } from '../../lib/auth-api.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { roleLabel } from '../../lib/labels.js';
import type { ExternalNavItem, NavItem } from '../../lib/nav.js';
import { EXPLORER_NAV, GOVERN_NAV, PLATFORM_NAV, WORK_NAV } from '../../lib/nav.js';
import type { InferredRole, WorkspaceRole } from '../../lib/role.js';
import { ROLE_BADGE_LABEL, isProvenMember } from '../../lib/role.js';
import type { NavSection } from '../../lib/router.js';
import type { WsConnectionStatus } from '../../lib/ws-client.js';
import { LangSwitch } from '../LangSwitch.js';
import { Sheet, SheetContent, SheetTitle } from '../kit/sheet.js';
import { Button } from '../ui/Button.js';
import { Select } from '../ui/Field.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { StatusChip } from '../ui/StatusChip.js';

const STATUS_LABEL: Readonly<Record<WsConnectionStatus, string>> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  closed: 'Disconnected',
};

const ROLE_BADGE_CLASS: Readonly<Record<InferredRole, string>> = {
  owner: 'role-badge-owner',
  'operator+': 'role-badge-operator',
  member: 'role-badge-member',
  unknown: 'role-badge-member',
};

export interface SidebarProps {
  readonly active: NavSection;
  readonly pendingCount: number | null;
  readonly wsStatus: WsConnectionStatus;
  readonly workspaceName: string;
  readonly role: WorkspaceRole;
  /** S4.1: which credential this session is signed in with — governs the footer's sign-out
   *  button label (e2e depends on the exact text: "Forget key" for `apiKey`, "登出 Sign out" for
   *  `cookie`) and whether the workspace switcher below can ever render. */
  readonly authMode: 'apiKey' | 'cookie';
  readonly onLogout: () => void;
  /** Cookie-mode only: every active membership the signed-in user holds. The switcher (a `<select>`
   *  next to the workspace name) only renders when there is more than one — a single membership
   *  has nothing to switch to, same as `showGovern`'s "nothing to show, don't show it"
   *  rule. */
  readonly memberships?: readonly WireMembership[];
  readonly selectedWorkspaceId?: string | null;
  readonly onSwitchWorkspace?: (workspaceId: string) => void;
  readonly switchingWorkspace?: boolean;
  /** P-A1: the signed-in user's platform role (`WireUser.platformRole`) — `undefined` for an
   *  apiKey session (no platform user) or before a cookie session's user is known. Gates the
   *  whole 平台 group. */
  readonly platformRole?: 'admin' | 'user';
  /** S6-C: `false` = the Explorer bundle is not built (placeholder served) → hide its link;
   *  `null` / `undefined` = still probing → shown (`lib/explorer-probe.ts`). */
  readonly explorerAvailable?: boolean | null;
  /** S6-A0 footer: the kernel version (`useKernelVersion`; admin sessions only) — omitted when
   *  unknown. */
  readonly kernelVersion?: string | null;
  /** S6-A0 footer: who is signed in — the cookie user's display name, or for an apiKey session
   *  the caller Principal's (`get_workspace.caller.displayName`). Omitted when unknown. */
  readonly currentUser?: { readonly displayName: string; readonly login?: string } | null;
  /** S8 W1-A3 follow-up (audit S2, journey ③ narrow-screen fix): `false` omits the
   *  `data-testid="ws-status"` attribute from this render's own connection-status line (the dot
   *  and label still render — only the testid is dropped). `NavDrawer` passes `false`: at ≤960px
   *  `MobileTopBar` — always mounted, unlike the drawer's `SidebarContent`, which only exists in
   *  the DOM while open — already carries the one canonical `ws-status` element every spec's
   *  `loginWithApiKey`/journey waits on; a second one inside the (occasionally also open) drawer
   *  would make `getByTestId('ws-status')` ambiguous. Defaults `true` (`Sidebar`'s own render,
   *  the sole copy above 960px, is unaffected). */
  readonly wsStatusTestId?: boolean;
}

/**
 * components/shell/Sidebar: product mark + workspace switcher / name + role badge at the top,
 * three labelled nav groups (S6-A0, docs/console-completion-plan.md §5.9 "壳与导航") — 使用 Use
 * (always visible), 治理 Govern (the per-workspace owner/operator pages + the Explorer link, for a
 * non-member workspace role with a workspace in scope), 平台 Platform (platform admin only) — with
 * inline icons and the live pending-approvals badge, and at the bottom the WS connection dot, the
 * kernel version, the current user and sign-out. Collapses to an icon rail in the (960px, 1100px]
 * range (styles/shell.css) — labels/sub-labels/section headers/footer lines hide, the
 * `title`/`aria-label`s below keep every control nameable. **≤960px this component is not
 * rendered at all** (S8 W1-A3, audit S2): `AppShell` swaps it for `MobileTopBar` + `NavDrawer`
 * below, which render the exact same nav content (via `SidebarContent`, the shared body this
 * component wraps in `<aside>`) inside a drawer instead of squeezing it into an ever-narrower
 * rail — the audit's complaint was 21 unlabeled, partly-duplicate icons with the workspace, role
 * and current user gone entirely. Visibility rules are the runbook's (web-console.md "角色与可见
 * 性"), unchanged by the regrouping.
 *
 * Role badge: a `{kind:'known'}` role (`get_workspace.caller.role`, the authoritative source as of
 * the S3.11 coordination addendum) renders as the same `StatusChip machine="role"` the Members
 * page already uses for every principal's own role chip — one color vocabulary, not two. A
 * `{kind:'inferred'}` role (the pre-existing 403/200 fallback, `lib/role.ts`) keeps its own
 * bucket-label badge (`Owner`/`Operator+`/`Member`/`—`) — those are honest uncertainty ranges, not
 * real `Role` enum values, so they never borrow the enum-backed chip's vocabulary.
 */
export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <SidebarContent {...props} />
    </aside>
  );
}

/**
 * components/shell/SidebarContent (S8 W1-A3): the brand row, three nav groups and footer that
 * `Sidebar` renders inside `<aside class="sidebar">` for the wide/rail layouts and `NavDrawer`
 * renders inside a `kit/sheet` for the ≤960px drawer — same props, same testids, same markup;
 * only the wrapping element differs (a fragment here, never its own DOM node, so neither caller's
 * existing structure/tests changed by this split).
 */
export function SidebarContent({
  active,
  pendingCount,
  wsStatus,
  workspaceName,
  role,
  authMode,
  onLogout,
  memberships,
  selectedWorkspaceId,
  onSwitchWorkspace,
  switchingWorkspace,
  platformRole,
  explorerAvailable,
  kernelVersion,
  currentUser,
  wsStatusTestId = true,
}: SidebarProps) {
  const t = useT();
  const showGovern =
    !isProvenMember(role) && (authMode === 'apiKey' || selectedWorkspaceId != null);
  const isAdmin = platformRole === 'admin';
  const showSwitcher = authMode === 'cookie' && memberships !== undefined && memberships.length > 1;
  return (
    <>
      <div className="sidebar-brand">
        <div className="sidebar-mark" aria-hidden>
          N
        </div>
        <div className="sidebar-brand-text">
          <span className="sidebar-product">NextTime AI</span>
          <span className="sidebar-workspace-row">
            {showSwitcher ? (
              <Select
                aria-label="Switch workspace"
                data-testid="workspace-switcher"
                value={selectedWorkspaceId ?? ''}
                disabled={switchingWorkspace === true}
                onChange={(event) => onSwitchWorkspace?.(event.target.value)}
              >
                {(memberships ?? []).map((m) => (
                  <option key={m.workspaceId} value={m.workspaceId}>
                    {m.workspaceName} ({roleLabel(m.role, t)})
                  </option>
                ))}
              </Select>
            ) : (
              <span className="sidebar-workspace" title={workspaceName}>
                {workspaceName}
              </span>
            )}
            {role.kind === 'known' ? (
              <span data-testid="role-badge" title={`Role: ${role.role}`}>
                <StatusChip machine="role" status={role.role} size="s" />
              </span>
            ) : (
              <span
                className={`role-badge ${ROLE_BADGE_CLASS[role.role]}`}
                data-testid="role-badge"
                title={`Inferred role: ${ROLE_BADGE_LABEL[role.role]}`}
              >
                {ROLE_BADGE_LABEL[role.role]}
              </span>
            )}
          </span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Sections">
        <NavSectionGroup titleZh="使用" titleEn="Use" testId="nav-section-use">
          {WORK_NAV.map((item) => renderNavItem(item, active, pendingCount))}
        </NavSectionGroup>

        {showGovern ? (
          <NavSectionGroup titleZh="治理" titleEn="Govern" testId="nav-section-govern">
            {GOVERN_NAV.map((item) => renderNavItem(item, active, pendingCount))}
            {explorerAvailable !== false ? renderExternalNavItem(EXPLORER_NAV) : null}
          </NavSectionGroup>
        ) : null}

        {isAdmin ? (
          <NavSectionGroup titleZh="平台" titleEn="Platform" testId="nav-section-platform">
            {PLATFORM_NAV.map((item) => renderNavItem(item, active, pendingCount))}
          </NavSectionGroup>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <div className="conn-status" title={`Kernel connection: ${STATUS_LABEL[wsStatus]}`}>
          <span className={`conn-dot conn-dot-${wsStatus}`} aria-hidden />
          <span
            className="conn-status-label"
            data-testid={wsStatusTestId ? 'ws-status' : undefined}
          >
            {STATUS_LABEL[wsStatus]}
          </span>
          {kernelVersion ? (
            <span
              className="sidebar-version mono"
              title={`Kernel version ${kernelVersion}`}
              data-testid="kernel-version"
            >
              {kernelVersion}
            </span>
          ) : null}
        </div>
        {currentUser ? (
          <div
            className="sidebar-user"
            title={
              currentUser.login
                ? `${currentUser.displayName} (${currentUser.login})`
                : currentUser.displayName
            }
            data-testid="current-user"
          >
            <Icon name="user" size="s" />
            <span className="sidebar-user-name truncate">{currentUser.displayName}</span>
          </div>
        ) : null}
        {authMode === 'cookie' ? (
          <Button variant="ghost" size="s" icon="logout" onClick={onLogout} title="Sign out">
            {t('登出', 'Sign out')}
          </Button>
        ) : (
          <Button variant="ghost" size="s" icon="logout" onClick={onLogout} title="Forget key">
            Forget key
          </Button>
        )}
        <LangSwitch />
      </div>
    </>
  );
}

export interface MobileTopBarProps {
  /** The current page's own name (`lib/nav.ts` `breadcrumbFor(active)`'s last crumb) — `AppShell`
   *  resolves this; kept a plain string here so this file need not import `lib/router.ts`'s
   *  `NavSection` just to re-derive it. */
  readonly pageTitle: string;
  readonly workspaceName: string;
  readonly role: WorkspaceRole;
  /** The WS connection dot + `data-testid="ws-status"` label — a product gap the S8 W1-A3 follow-up
   *  closed, not a testing convenience: at ≤960px the wide `<aside>` (the only place this used to
   *  render) is gone, so without it here the connection state was invisible on a narrow screen
   *  whenever the drawer is closed, which is most of the time. This is the sole `ws-status` in the
   *  DOM at this width — `NavDrawer` suppresses its own copy's testid (`SidebarContent`'s
   *  `wsStatusTestId={false}`) so opening the drawer never makes the testid ambiguous. */
  readonly wsStatus: WsConnectionStatus;
  /** Opens `NavDrawer`. `AppShell` owns the open/close state (both components are siblings, not
   *  parent/child) so a route change can close the drawer without this component knowing about
   *  routing. */
  readonly onOpenMenu: () => void;
}

function roleText(role: WorkspaceRole, t: Translate): string {
  return role.kind === 'known' ? roleLabel(role.role, t) : ROLE_BADGE_LABEL[role.role];
}

/**
 * components/shell/MobileTopBar (S8 W1-A3, audit S2 "≤960 侧栏收成 21 个无文字图标"): the ≤960px
 * replacement for the icon rail — a single sticky row with the menu button that opens `NavDrawer`
 * (`data-testid="nav-open"`, the hook Playwright/journey helpers use to reach the full nav at this
 * width), the current page's title as the prominent line, a second, smaller line carrying the
 * three pieces of identity the old rail dropped entirely (product name, workspace name, role), and
 * the WS connection indicator (see `MobileTopBarProps.wsStatus`'s own doc comment — a follow-up
 * fix, not part of the original S2 cut). Rendered by `AppShell` in place of `Sidebar` — never both
 * at once, so there is exactly one `nav-<section>` set of testids in the DOM at any given viewport
 * (the wide `<aside>`'s, or once opened, the drawer's).
 */
export function MobileTopBar({
  pageTitle,
  workspaceName,
  role,
  wsStatus,
  onOpenMenu,
}: MobileTopBarProps) {
  const t = useT();
  return (
    <header className="mobile-topbar">
      <Button
        variant="ghost"
        size="s"
        icon="menu"
        iconOnly
        aria-label={t('打开导航菜单', 'Open navigation menu')}
        data-testid="nav-open"
        onClick={onOpenMenu}
      />
      <div className="mobile-topbar-text">
        <span className="mobile-topbar-title truncate">{pageTitle}</span>
        <span className="mobile-topbar-sub truncate">
          NextTime AI · {workspaceName} · {roleText(role, t)}
        </span>
      </div>
      <div className="conn-status" title={`Kernel connection: ${STATUS_LABEL[wsStatus]}`}>
        <span className={`conn-dot conn-dot-${wsStatus}`} aria-hidden />
        <span className="conn-status-label" data-testid="ws-status">
          {STATUS_LABEL[wsStatus]}
        </span>
      </div>
    </header>
  );
}

export interface NavDrawerProps extends SidebarProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * components/shell/NavDrawer (S8 W1-A3, audit S2): the ≤960px drawer `MobileTopBar`'s menu button
 * opens — `kit/sheet` (Radix Dialog under the hood: focus trap, Esc, overlay-click-closes and
 * focus-returns-to-trigger all come from the primitive, none hand-rolled here) holding the exact
 * same `SidebarContent` the wide sidebar renders, so every group title, the workspace switcher,
 * the current user and sign-out that the icon rail hid are all present and labelled. `AppShell`
 * closes it on navigation (an effect keyed on `active`) — Radix's own auto-focus-on-close then
 * returns focus to whatever had it before open, which is always the top bar's menu button here
 * since nothing else can open this drawer.
 */
export function NavDrawer({ open, onOpenChange, ...sidebarProps }: NavDrawerProps) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Any nav link click closes the drawer — including the current page's own link, which
       *  changes no route (so `AppShell`'s close-on-`active`-change never fires) and would otherwise
       *  leave the drawer covering the page it just "navigated" to. */}
      <SheetContent
        side="left"
        className="nav-drawer"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a.nav-item')) onOpenChange(false);
        }}
      >
        <SheetTitle className="visually-hidden">{t('导航', 'Navigation')}</SheetTitle>
        {/* wsStatusTestId={false}: MobileTopBar (always mounted at this width, unlike this
         *  drawer) already carries the DOM's one `ws-status` testid — see its own doc comment. */}
        <SidebarContent {...sidebarProps} wsStatusTestId={false} />
      </SheetContent>
    </Sheet>
  );
}

function renderNavItem(item: NavItem, active: NavSection, pendingCount: number | null): ReactNode {
  const badge = item.section === 'approvals' && pendingCount !== null && pendingCount > 0;
  return (
    <a
      key={item.section}
      href={item.href}
      className="nav-item"
      aria-current={item.section === active ? 'page' : undefined}
      title={`${item.label} ${item.sub}`}
      data-testid={`nav-${item.section}`}
    >
      {/* item.icon is a plain string on NavItem (lib/nav.ts — that file must not import
       *  components/ui/Icon.js itself, scripts/guards/legacy-ui-importers.json only shrinks); cast
       *  back to IconName at this one render call. */}
      <Icon name={item.icon as IconName} />
      <span className="nav-label">
        {item.label}
        <span className="nav-label-sub">{item.sub}</span>
      </span>
      {badge ? (
        <span className="nav-badge" aria-label={`${pendingCount} pending approvals`}>
          {pendingCount > 99 ? '99+' : pendingCount}
        </span>
      ) : null}
    </a>
  );
}

function renderExternalNavItem(item: ExternalNavItem): ReactNode {
  return (
    <a
      key={item.testId}
      href={item.href}
      className="nav-item"
      title={`${item.label} ${item.sub}`}
      data-testid={item.testId}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Icon name={item.icon as IconName} />
      <span className="nav-label">
        {item.label}
        <span className="nav-label-sub">{item.sub}</span>
      </span>
    </a>
  );
}

function NavSectionGroup({
  titleZh,
  titleEn,
  testId,
  children,
}: {
  readonly titleZh: string;
  readonly titleEn: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="nav-section" data-testid={testId}>
      <div className="nav-section-title">
        <span>{titleZh}</span>
        <span className="nav-section-title-sub">{titleEn}</span>
      </div>
      {children}
    </div>
  );
}
