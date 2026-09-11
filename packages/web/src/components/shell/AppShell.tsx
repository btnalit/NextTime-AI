import type { ReactNode } from 'react';
import { usePendingCount } from '../../hooks/usePendingCount.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import { useWsStatus } from '../../hooks/useWsStatus.js';
import type { WireMembership } from '../../lib/auth-api.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import type { NavSection } from '../../lib/router.js';
import { Sidebar } from './Sidebar.js';

export interface AppShellProps {
  readonly active: NavSection;
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly authMode: 'apiKey' | 'cookie';
  readonly onLogout: () => void;
  /** Cookie-mode only (S4.1) — see `Sidebar`'s own doc comment on the workspace switcher. */
  readonly memberships?: readonly WireMembership[];
  readonly selectedWorkspaceId?: string | null;
  readonly onSwitchWorkspace?: (workspaceId: string) => void;
  /** A switch is in flight — the Sidebar disables its switcher so a second pick cannot race. */
  readonly switchingWorkspace?: boolean;
  /** P-A1: `session.user?.platformRole` — `undefined` for an apiKey session. Threaded straight to
   *  the Sidebar, which uses it to gate 管理 → 用户/平台设置 and all of 维护. */
  readonly platformRole?: 'admin' | 'user';
  readonly children: ReactNode;
}

/** components/shell/AppShell: sidebar + main. Pages render inside `main` and own their `.page`. */
export function AppShell({
  active,
  http,
  pushes,
  authMode,
  onLogout,
  memberships,
  selectedWorkspaceId,
  onSwitchWorkspace,
  switchingWorkspace,
  platformRole,
  children,
}: AppShellProps) {
  const pendingCount = usePendingCount(http, pushes);
  const wsStatus = useWsStatus(pushes);
  const { workspaceName, role } = useWorkspaceIdentity(http);
  return (
    <div className="shell">
      <Sidebar
        active={active}
        pendingCount={pendingCount}
        wsStatus={wsStatus}
        workspaceName={workspaceName}
        role={role}
        authMode={authMode}
        onLogout={onLogout}
        memberships={memberships}
        selectedWorkspaceId={selectedWorkspaceId}
        onSwitchWorkspace={onSwitchWorkspace}
        switchingWorkspace={switchingWorkspace}
        platformRole={platformRole}
      />
      <main className="main">{children}</main>
    </div>
  );
}
