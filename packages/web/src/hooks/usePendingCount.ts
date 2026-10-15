import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { usePermissions } from './usePermissions.js';
import { useRoleCan } from './useRoleCan.js';

/**
 * hooks/usePendingCount: the live badge on the Approvals nav item — `list_pending`'s row count,
 * refreshed on every `action.pending`/`action.updated` push, and after a WS reconnect (R-63:
 * pushes sent while the socket was down are lost). `null` while unknown or when the caller may not
 * call `list_pending` (403 → member role; the badge simply does not render, and the denial is
 * recorded for the Approvals page to explain). A refresh asked for while one is in flight runs
 * once more when it settles (L7a-16): the in-flight read may predate the change that asked.
 */
export function usePendingCount(http: CapabilityCaller, pushes: PushSource): number | null {
  const [count, setCount] = useState<number | null>(null);
  const permissions = usePermissions();
  // Held until the reader's role is known: only an operator or the owner reads the queue.
  const can = useRoleCan(http);
  const reads = can('list_pending') === true;
  const inFlight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (!reads) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        try {
          const page = await http.call<{ items: readonly unknown[] }>('list_pending');
          setCount(page.items.length);
        } catch (err) {
          if (isForbiddenError(err)) {
            permissions.markDenied('list_pending');
            again.current = false;
          }
          // Any other failure leaves the last known count in place — the Approvals page itself
          // surfaces load errors; the badge is a hint, not a second error channel.
        }
      } while (again.current);
    } finally {
      inFlight.current = false;
    }
  }, [http, reads, permissions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubPending = pushes.onActionPending(() => void refresh());
    const unsubUpdated = pushes.onActionUpdated(() => void refresh());
    const unsubResynced = pushes.onResynced(() => void refresh());
    return () => {
      unsubPending();
      unsubUpdated();
      unsubResynced();
    };
  }, [pushes, refresh]);

  return reads ? count : null;
}
