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

/** 图 Explorer — the read-only graph/decision/provenance UI (kernel `interfaces/explorer-
 *  contract`), an unmodified third-party static bundle served by caddy at `/explorer/` on this
 *  same origin. Opens in a new tab; same visibility as 治理 Governance (`showGovern`) since every
 *  Explorer endpoint requires at least the same role. */
const EXPLORER_NAV: ExternalNavItem = {
  testId: 'nav-explorer',
  label: '图',
  sub: 'Explorer',
  icon: 'search',
  href: '/explorer/',
};

/** 工作 Work — always visible, every role. 我的智能体 (S3.13 placeholder) sits here rather than in
 *  a third section: S3.11's own background note only ever describes two nav groups ("member 只见
 *  工作区 + 「我的智能体」"), and it is per-user configuration, not governance. */
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
  { section: 'agent', label: '我的智能体', sub: 'My Agent', icon: 'user', href: hrefs.agent() },
  // S4.1: sits right next to 我的智能体 — both are per-user "我的" settings, not governance.
  { section: 'account', label: '我的账户', sub: 'My Account', icon: 'user', href: hrefs.account() },
];

/** 治理 Governance — hidden for a *proven* member (S3.11: "member 只见工作区 + 「我的智能体」"), shown
 *  otherwise (owner/operator, or role not yet known this session — see `lib/role.ts` and this
 *  task's own contract note: "show governance nav to everyone and let the kernel's 403 render as
 *  an inline state — never invent a capability"). */
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
   *  has nothing to switch to, same as `showGovern`'s "nothing to show, don't show it" rule. */
  readonly memberships?: readonly WireMembership[];
  readonly selectedWorkspaceId?: string | null;
  readonly onSwitchWorkspace?: (workspaceId: string) => void;
  readonly switchingWorkspace?: boolean;
}

/**
 * components/shell/Sidebar: product mark + workspace name/role badge, two nav sections (工作 Work,
 * 治理 Governance — S3.14) with inline icons and the live pending-approvals badge, and at the
 * bottom the WS connection dot and "Forget key". Collapses to an icon rail ≤1100px and a top bar
 * ≤720px (styles/shell.css) — labels/sub-labels/section headers hide, the `title`/`aria-label`s
 * below keep every control nameable.
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
}: SidebarProps) {
  const showGovern = !isProvenMember(role);
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
        <NavSectionGroup
          titleZh="工作"
          titleEn="Work"
          items={WORK_NAV}
          active={active}
          pendingCount={pendingCount}
        />
        {showGovern ? (
          <NavSectionGroup
            titleZh="治理"
            titleEn="Governance"
            items={GOVERN_NAV}
            active={active}
            pendingCount={pendingCount}
            extra={EXPLORER_NAV}
          />
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <div className="conn-status" title={`Kernel connection: ${STATUS_LABEL[wsStatus]}`}>
          <span className={`conn-dot conn-dot-${wsStatus}`} aria-hidden />
          <span className="conn-status-label" data-testid="ws-status">
            {STATUS_LABEL[wsStatus]}
          </span>
        </div>
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

function NavSectionGroup({
  titleZh,
  titleEn,
  items,
  active,
  pendingCount,
  extra,
}: {
  readonly titleZh: string;
  readonly titleEn: string;
  readonly items: readonly NavItem[];
  readonly active: NavSection;
  readonly pendingCount: number | null;
  /** An external nav entry (opens in a new tab) rendered after `items`, still inside this
   *  section's own visual group. */
  readonly extra?: ExternalNavItem;
}) {
  return (
    <div className="nav-section">
      <div className="nav-section-title">
        <span>{titleZh}</span>
        <span className="nav-section-title-sub">{titleEn}</span>
      </div>
      {items.map((item) => {
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
      })}
      {extra ? (
        <a
          href={extra.href}
          className="nav-item"
          title={`${extra.label} ${extra.sub}`}
          data-testid={extra.testId}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name={extra.icon} />
          <span className="nav-label">
            {extra.label}
            <span className="nav-label-sub">{extra.sub}</span>
          </span>
        </a>
      ) : null}
    </div>
  );
}
