import type { ReactNode } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import { usePendingCount } from '../../hooks/usePendingCount.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import { useWsStatus } from '../../hooks/useWsStatus.js';
import type { WireMembership, WireUser } from '../../lib/auth-api.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import { useExplorerAvailable } from '../../lib/explorer-probe.js';
import type { WorkspaceInfo } from '../../lib/governance.js';
import type { NavSection } from '../../lib/router.js';
import { Sidebar } from './Sidebar.js';
import { useKernelVersion } from './useKernelVersion.js';

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
   *  the Sidebar, which uses it to gate the 平台 group. */
  readonly platformRole?: 'admin' | 'user';
  /** S6-A0: the signed-in cookie user (`session.user`) for the footer's "current user" line. An
   *  apiKey session has none — the shell then falls back to `get_workspace.caller.displayName`. */
  readonly user?: WireUser | null;
  readonly children: ReactNode;
}

/** components/shell/AppShell: sidebar + main. Pages render inside `main` and own their `.page`.
 *  S6-A0 (§5.9 "壳与导航"): also resolves the footer's kernel version (admin only —
 *  `useKernelVersion`) and current user for the Sidebar. */
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
  user,
  children,
}: AppShellProps) {
  const pendingCount = usePendingCount(http, pushes);
  const wsStatus = useWsStatus(pushes);
  const { workspaceName, role } = useWorkspaceIdentity(http);
  const kernelVersion = useKernelVersion(http, platformRole === 'admin');
  // S6-C (§5.7): hide the third-party Explorer link while caddy serves the "bundle not built"
  // placeholder; the native 图谱 page is always there.
  const explorerAvailable = useExplorerAvailable();
  // A second read of the same key as `useWorkspaceIdentity`'s `get_workspace` — served warm from
  // hooks/useCapability's per-caller cache while it refreshes, so the footer never flashes, but
  // still one extra request per shell mount. `caller.displayName` is the apiKey session's only
  // source of "who am I"; exposing it from `useWorkspaceIdentity` (hooks/, another lane) would
  // remove this read.
  const workspace = useCapability<WorkspaceInfo>(http, 'get_workspace');
  const currentUser = user
    ? { displayName: user.displayName, login: user.login }
    : workspace.state.status === 'ready'
      ? { displayName: workspace.state.data.caller.displayName }
      : null;
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
        explorerAvailable={explorerAvailable}
        kernelVersion={kernelVersion}
        currentUser={currentUser}
      />
      <main className="main">{children}</main>
    </div>
  );
}
