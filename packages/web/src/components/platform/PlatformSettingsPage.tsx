import type { CapabilityCaller } from '../../lib/clients.js';
import { EmptyState } from '../ui/EmptyState.js';
import { PageHeader } from '../ui/PageHeader.js';

export interface PlatformSettingsPageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/platform/PlatformSettingsPage: 平台设置 Platform settings (`/platform/settings`,
 * design doc §6.6) — stub. The editor (site name, announcement, default workspace/model/budget,
 * password policy, `NEXTTIME_PLATFORM_ADMINS` read-only display) lands in a later P-A1 wave; this
 * page only exists so the route compiles and the Sidebar's 管理 → 平台设置 item has somewhere to
 * go. Reachable only for `platformRole === 'admin'` (gated in `App.tsx`'s `Routed`).
 */
export function PlatformSettingsPage(_props: PlatformSettingsPageProps) {
  return (
    <div className="page">
      <PageHeader
        title="平台设置 Platform settings"
        description="Site name, announcement, defaults, and password policy for this platform."
      />
      <EmptyState
        icon="grid"
        title="即将到来 Coming in this wave"
        testId="platform-settings-stub"
      />
    </div>
  );
}
