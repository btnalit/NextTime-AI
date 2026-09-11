import type { CapabilityCaller } from '../../lib/clients.js';
import { EmptyState } from '../ui/EmptyState.js';
import { PageHeader } from '../ui/PageHeader.js';

export interface PlatformUsersPageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/platform/PlatformUsersPage: 用户 Users (`/platform/users`, design doc §5/§6.1) —
 * stub. The directory (list/create/edit/reset password/membership drawer/budget/merge
 * "待激活" users) lands in a later P-A1 wave; this page only exists so the route compiles and the
 * Sidebar's 管理 → 用户 item has somewhere to go. Reachable only for `platformRole === 'admin'`
 * (gated in `App.tsx`'s `Routed`).
 */
export function PlatformUsersPage(_props: PlatformUsersPageProps) {
  return (
    <div className="page">
      <PageHeader
        title="用户 Users"
        description="Who can sign in, which workspaces they belong to, and their budgets."
      />
      <EmptyState icon="users" title="即将到来 Coming in this wave" testId="platform-users-stub" />
    </div>
  );
}
