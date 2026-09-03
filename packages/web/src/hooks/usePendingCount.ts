import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { usePermissions } from './usePermissions.js';

/**
 * hooks/usePendingCount: the live badge on the Approvals nav item — `list_pending`'s row count,
 * refreshed on every `action.pending`/`action.updated` push. `null` while unknown or when the
 * caller may not call `list_pending` (403 → member role; the badge simply does not render, and
 * the denial is recorded for the Approvals page to explain).
 */
export function usePendingCount(http: CapabilityCaller, pushes: PushSource): number | null {
  const [count, setCount] = useState<number | null>(null);
  const permissions = usePermissions();
  const denied = permissions.isDenied('list_pending');
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (denied || inFlight.current) return;
    inFlight.current = true;
    try {
      const rows = await http.call<readonly unknown[]>('list_pending');
      setCount(rows.length);
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('list_pending');
      // Any other failure leaves the last known count in place — the Approvals page itself
      // surfaces load errors; the badge is a hint, not a second error channel.
    } finally {
      inFlight.current = false;
    }
  }, [http, denied, permissions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubPending = pushes.onActionPending(() => void refresh());
    const unsubUpdated = pushes.onActionUpdated(() => void refresh());
    return () => {
      unsubPending();
      unsubUpdated();
    };
  }, [pushes, refresh]);

  return denied ? null : count;
}
