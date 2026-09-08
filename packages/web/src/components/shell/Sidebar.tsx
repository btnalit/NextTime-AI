import type { InferredRole } from '../../lib/role.js';
import { ROLE_BADGE_LABEL } from '../../lib/role.js';
import type { NavSection } from '../../lib/router.js';
import { hrefs } from '../../lib/router.js';
import type { WsConnectionStatus } from '../../lib/ws-client.js';
import { Button } from '../ui/Button.js';
import { Icon, type IconName } from '../ui/Icon.js';

interface NavItem {
  readonly section: NavSection;
  readonly label: string;
  readonly sub: string;
  readonly icon: IconName;
  readonly href: string;
}

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
  readonly role: InferredRole;
  readonly onForgetKey: () => void;
}

/**
 * components/shell/Sidebar: product mark + workspace name/role badge, two nav sections (工作 Work,
 * 治理 Governance — S3.14) with inline icons and the live pending-approvals badge, and at the
 * bottom the WS connection dot and "Forget key". Collapses to an icon rail ≤1100px and a top bar
 * ≤720px (styles/shell.css) — labels/sub-labels/section headers hide, the `title`/`aria-label`s
 * below keep every control nameable.
 */
export function Sidebar({
  active,
  pendingCount,
  wsStatus,
  workspaceName,
  role,
  onForgetKey,
}: SidebarProps) {
  const showGovern = role !== 'member';
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-mark" aria-hidden>
          N
        </div>
        <div className="sidebar-brand-text">
          <span className="sidebar-product">NextTime AI</span>
          <span className="sidebar-workspace-row">
            <span className="sidebar-workspace" title={workspaceName}>
              {workspaceName}
            </span>
            <span
              className={`role-badge ${ROLE_BADGE_CLASS[role]}`}
              data-testid="role-badge"
              title={`Inferred role: ${ROLE_BADGE_LABEL[role]}`}
            >
              {ROLE_BADGE_LABEL[role]}
            </span>
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
        <Button variant="ghost" size="s" icon="logout" onClick={onForgetKey} title="Forget key">
          Forget key
        </Button>
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
}: {
  readonly titleZh: string;
  readonly titleEn: string;
  readonly items: readonly NavItem[];
  readonly active: NavSection;
  readonly pendingCount: number | null;
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
    </div>
  );
}
