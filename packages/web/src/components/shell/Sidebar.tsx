import type { ReactNode } from 'react';
import type { WireMembership } from '../../lib/auth-api.js';
import type { InferredRole, WorkspaceRole } from '../../lib/role.js';
import { ROLE_BADGE_LABEL, isProvenMember } from '../../lib/role.js';
import type { NavSection } from '../../lib/router.js';
import { hrefs } from '../../lib/router.js';
import type { WsConnectionStatus } from '../../lib/ws-client.js';
import { Button } from '../ui/Button.js';
import { Select } from '../ui/Field.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { StatusChip } from '../ui/StatusChip.js';

interface NavItem {
  readonly section: NavSection;
  readonly label: string;
  readonly sub: string;
  readonly icon: IconName;
  readonly href: string;
}

/** A nav entry that opens outside the console's own hash-routed shell — no `section` (it never
 *  matches `NavSection`/`aria-current`), always `target="_blank"`. Rendered separately from
 *  `NavItem`s rather than folding it into `NavSection` (`lib/router.ts`), which is one-to-one with
 *  an internal hash route. */
interface ExternalNavItem {
  readonly testId: string;
  readonly label: string;
  readonly sub: string;
  readonly icon: IconName;
  readonly href: string;
}

/** Explorer（第三方）— the read-only graph/decision/provenance UI (kernel `interfaces/explorer-
 *  contract`), an unmodified third-party static bundle served by caddy at `/explorer/` on this
 *  same origin. Opens in a new tab; same visibility as the 治理 group (`showGovern`) since
 *  every Explorer endpoint requires at least the same role. S6-C / S6-D: the console's own 图谱
 *  page (`WORK_NAV`) is the primary graph entry; this link is rendered only while the bundle is
 *  built (`explorerAvailable !== false`, `lib/explorer-probe.ts`). */
const EXPLORER_NAV: ExternalNavItem = {
  testId: 'nav-explorer',
  label: '打开 Explorer',
  sub: 'third-party',
  icon: 'search',
  href: '/explorer/',
};

/** 使用 Use (design doc §2/§5 "使用面") — always visible, every role. 我的智能体 (S3.13 placeholder)
 *  sits here rather than in a separate section: it is per-user configuration, not governance. */
const WORK_NAV: readonly NavItem[] = [
  { section: 'chats', label: '对话', sub: 'Chats', icon: 'chat', href: hrefs.chats() },
  {
    section: 'approvals',
    label: '待我审批',
    sub: 'Approvals',
    icon: 'approvals',
    href: hrefs.approvals(),
  },
  { section: 'tasks', label: '任务', sub: 'Tasks', icon: 'tasks', href: hrefs.tasks() },
  // S6-D: the native 图谱 page (object browser on search / state_at / explain) replaces the
  // third-party Explorer bundle as the console's graph entry.
  { section: 'graph', label: '图谱', sub: 'Graph', icon: 'link', href: hrefs.graph() },
  { section: 'agent', label: '我的智能体', sub: 'My Agent', icon: 'user', href: hrefs.agent() },
  // S4.1: sits right next to 我的智能体 — both are per-user "我的" settings, not governance.
  { section: 'account', label: '我的账户', sub: 'My Account', icon: 'user', href: hrefs.account() },
];

/** 治理 Govern (S6-A0 §5.9 "壳与导航": 使用 / 治理 / 平台) — the per-workspace owner/operator pages,
 *  hidden for a *proven* member (S3.11: "member 只见工作区 + 「我的智能体」"), shown otherwise
 *  (owner/operator, or role not yet known this session — see `lib/role.ts` and the runbook's
 *  "角色与可见性": show governance nav to everyone and let the kernel's 403 render as an inline
 *  state — never invent a capability) and only once a workspace is in scope (`showGovern` — an
 *  apiKey session always has one implicitly; a cookie session needs `selectedWorkspaceId`, since a
 *  platform admin with zero memberships has nothing here to configure). */
const GOVERN_NAV: readonly NavItem[] = [
  { section: 'members', label: '成员与授权', sub: 'Members', icon: 'users', href: hrefs.members() },
  { section: 'access', label: '访问', sub: 'Access', icon: 'key', href: hrefs.access() },
  {
    section: 'systems',
    label: '系统接入',
    sub: 'Systems',
    icon: 'connections',
    href: hrefs.systems(),
  },
  { section: 'catalog', label: '能力目录', sub: 'Catalog', icon: 'grid', href: hrefs.catalog() },
  { section: 'models', label: '模型与配额', sub: 'Models', icon: 'cpu', href: hrefs.models() },
  { section: 'audit', label: '审计', sub: 'Audit', icon: 'search', href: hrefs.audit() },
];

/** 平台 Platform (S6-A0 §5.9) — platform-admin only (`platformRole === 'admin'`), independent of
 *  workspace role/selection: an administrator configures workspaces they are not a member of,
 *  manages users and platform settings with zero memberships. Overview first (the control tower
 *  of §5.9 "页面对照原型"), then the four management pages, then the platform audit stream —
 *  the former 管理 → 工作区配置 / 用户 / 平台设置 and 维护 groups folded into one labelled group. */
const PLATFORM_NAV: readonly NavItem[] = [
  {
    section: 'platformOverview',
    label: '概览',
    sub: 'Overview',
    icon: 'info',
    href: hrefs.platformOverview(),
  },
  {
    section: 'platformWorkspaces',
    label: '工作区',
    sub: 'Workspaces',
    icon: 'grid',
    href: hrefs.platformWorkspaces(),
  },
  {
    section: 'platformUsers',
    label: '用户',
    sub: 'Users',
    icon: 'users',
    href: hrefs.platformUsers(),
  },
  {
    section: 'platformIntegrations',
    label: '集成',
    sub: 'Integrations',
    icon: 'connections',
    href: hrefs.platformIntegrations(),
  },
  // P-B2b (design §6.4): modules — versioned domain packs, install counts, default modules.
  {
    section: 'platformModules',
    label: '模块',
    sub: 'Modules',
    icon: 'grid',
    href: hrefs.platformModules(),
  },
  // S6-B (design §6.2): providers are platform-level; the page talks to llm-proxy's admin API.
  {
    section: 'platformModels',
    label: '模型与供应商',
    sub: 'Models & providers',
    icon: 'cpu',
    href: hrefs.platformModels(),
  },
  {
    section: 'platformSettings',
    label: '平台设置',
    sub: 'Platform settings',
    icon: 'grid',
    href: hrefs.platformSettings(),
  },
  // S7-E (design §6.5 / §6.7, P-C): 运行层 / 运行状态 — which pi/image/extension version is
  // running and whether every service is healthy.
  {
    section: 'platformRuntime',
    label: '运行层',
    sub: 'Runtime',
    icon: 'cpu',
    href: hrefs.platformRuntime(),
  },
  {
    section: 'platformStatus',
    label: '运行状态',
    sub: 'Status',
    icon: 'shield',
    href: hrefs.platformStatus(),
  },
  {
    section: 'platformAudit',
    label: '平台审计',
    sub: 'Platform audit',
    icon: 'search',
    href: hrefs.platformAudit(),
  },
];

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
}

/**
 * components/shell/Sidebar: product mark + workspace switcher / name + role badge at the top,
 * three labelled nav groups (S6-A0, docs/console-completion-plan.md §5.9 "壳与导航") — 使用 Use
 * (always visible), 治理 Govern (the per-workspace owner/operator pages + the Explorer link, for a
 * non-member workspace role with a workspace in scope), 平台 Platform (platform admin only) — with
 * inline icons and the live pending-approvals badge, and at the bottom the WS connection dot, the
 * kernel version, the current user and sign-out. Collapses to an icon rail ≤1100px and a top bar
 * ≤720px (styles/shell.css) — labels/sub-labels/section headers/footer lines hide, the
 * `title`/`aria-label`s below keep every control nameable. Visibility rules are the runbook's
 * (web-console.md "角色与可见性"), unchanged by the regrouping.
 *
 * Role badge: a `{kind:'known'}` role (`get_workspace.caller.role`, the authoritative source as of
 * the S3.11 coordination addendum) renders as the same `StatusChip machine="role"` the Members
 * page already uses for every principal's own role chip — one color vocabulary, not two. A
 * `{kind:'inferred'}` role (the pre-existing 403/200 fallback, `lib/role.ts`) keeps its own
 * bucket-label badge (`Owner`/`Operator+`/`Member`/`—`) — those are honest uncertainty ranges, not
 * real `Role` enum values, so they never borrow the enum-backed chip's vocabulary.
 */
export function Sidebar({
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
}: SidebarProps) {
  const showGovern =
    !isProvenMember(role) && (authMode === 'apiKey' || selectedWorkspaceId != null);
  const isAdmin = platformRole === 'admin';
  const showSwitcher = authMode === 'cookie' && memberships !== undefined && memberships.length > 1;
  return (
    <aside className="sidebar">
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
                    {m.workspaceName} ({m.role})
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
          <span className="conn-status-label" data-testid="ws-status">
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
            登出 Sign out
          </Button>
        ) : (
          <Button variant="ghost" size="s" icon="logout" onClick={onLogout} title="Forget key">
            Forget key
          </Button>
        )}
      </div>
    </aside>
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
      <Icon name={item.icon} />
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
      <Icon name={item.icon} />
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
