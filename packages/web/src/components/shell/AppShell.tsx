import type { ReactNode } from 'react';
import { usePendingCount } from '../../hooks/usePendingCount.js';
import { useWsStatus } from '../../hooks/useWsStatus.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import type { NavSection } from '../../lib/router.js';
import { Sidebar } from './Sidebar.js';

export interface AppShellProps {
  readonly active: NavSection;
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly onForgetKey: () => void;
  readonly children: ReactNode;
}

/** components/shell/AppShell: sidebar + main. Pages render inside `main` and own their `.page`. */
export function AppShell({ active, http, pushes, onForgetKey, children }: AppShellProps) {
  const pendingCount = usePendingCount(http, pushes);
  const wsStatus = useWsStatus(pushes);
  return (
    <div className="shell">
      <Sidebar
        active={active}
        pendingCount={pendingCount}
        wsStatus={wsStatus}
        onForgetKey={onForgetKey}
      />
      <main className="main">{children}</main>
    </div>
  );
}
