import type { NavSection } from '../../lib/router.js';
import { hrefs } from '../../lib/router.js';
import type { WsConnectionStatus } from '../../lib/ws-client.js';
import { Button } from '../ui/Button.js';
import { Icon, type IconName } from '../ui/Icon.js';

const NAV: readonly {
  readonly section: NavSection;
  readonly label: string;
  readonly icon: IconName;
  readonly href: string;
}[] = [
  { section: 'chats', label: 'Chats', icon: 'chat', href: hrefs.chats() },
  { section: 'approvals', label: 'Approvals', icon: 'approvals', href: hrefs.approvals() },
  { section: 'tasks', label: 'Tasks', icon: 'tasks', href: hrefs.tasks() },
  { section: 'connections', label: 'Connections', icon: 'connections', href: hrefs.connections() },
];

const STATUS_LABEL: Readonly<Record<WsConnectionStatus, string>> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  closed: 'Disconnected',
};

export interface SidebarProps {
  readonly active: NavSection;
  readonly pendingCount: number | null;
  readonly wsStatus: WsConnectionStatus;
  readonly onForgetKey: () => void;
}

/**
 * components/shell/Sidebar: product mark + workspace line, the four sections with inline icons
 * and the live pending-approvals badge, and at the bottom the WS connection dot and "Forget key".
 * Collapses to an icon rail ≤1100px and a top bar ≤720px (styles/shell.css) — labels hide, the
 * `title`/`aria-label`s below keep every control nameable.
 */
export function Sidebar({ active, pendingCount, wsStatus, onForgetKey }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-mark" aria-hidden>
          N
        </div>
        <div className="sidebar-brand-text">
          <span className="sidebar-product">NextTime AI</span>
          <span className="sidebar-workspace">Workspace console</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Sections">
        {NAV.map((item) => {
          const badge = item.section === 'approvals' && pendingCount !== null && pendingCount > 0;
          return (
            <a
              key={item.section}
              href={item.href}
              className="nav-item"
              aria-current={item.section === active ? 'page' : undefined}
              title={item.label}
              data-testid={`nav-${item.section}`}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{item.label}</span>
              {badge ? (
                <span className="nav-badge" aria-label={`${pendingCount} pending approvals`}>
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              ) : null}
            </a>
          );
        })}
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
