import { useEffect, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';

/** The `platform_overview` slice the sidebar footer needs (`PlatformOverviewWire.version`). */
interface OverviewVersion {
  readonly version: { readonly kernel: string };
}

/**
 * components/shell/useKernelVersion (S6-A0, docs/console-completion-plan.md §5.9 "壳与导航" —
 * "底部连接状态 + 真实版本号 + 当前用户"): the kernel version string for the sidebar footer, read
 * from `platform_overview` — the only capability that reports it today. That capability is
 * platform-scope (administrator only), so the read is gated on `enabled` (= the signed-in user
 * is a platform admin); a non-admin shell never calls it, which keeps the 403 out of
 * `usePermissions`'s denied closure and out of the kernel's audit log. Renders whatever the
 * kernel returns — B1 (the git tag + commit injected at image build) is another lane's fix to
 * the *value*, not to this reader. `null` = not known (not enabled, still loading, or failed —
 * the footer simply omits the line; a version is never blocking).
 */
export function useKernelVersion(caller: CapabilityCaller, enabled: boolean): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      setVersion(null);
      return;
    }
    let cancelled = false;
    caller
      .call<OverviewVersion>('platform_overview')
      .then((overview) => {
        if (!cancelled) setVersion(overview.version.kernel);
      })
      .catch(() => {
        if (!cancelled) setVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [caller, enabled]);
  return version;
}
