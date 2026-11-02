import type { ReceivedAdminProposalCountsWire } from '@nexttime/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { usePermissions } from './usePermissions.js';
import { useRoleCan } from './useRoleCan.js';

/**
 * hooks/useAdminProposalCount (S11 AA4e, journey ⑨ / UX P2-3 on #945): how many admin proposals
 * addressed to this workspace wait for its owner — `get_admin_proposal_segment_counts`' `proposed`,
 * which the kernel counts in the owner's own scope (the same rows `list_admin_proposal_segments`
 * lists under 待确认; no list is fetched to be filtered here). The owner learns of a proposal from
 * the badge on 能力目录, the count on its 管理员提案 tab and the note on 待我审批 — the console's own
 * todo marks; nothing is sent outside it.
 *
 * `null` while unknown, and for anyone the capability is not theirs (not the owner: 403, recorded
 * like `usePendingCount` records `list_pending`'s). No push carries proposals, so it is read again
 * when the reader moves in the console (a hash change), comes back to the tab, after a WS
 * reconnect, and when the owner decides one here ({@link notifyAdminProposalsDecided}). A refresh
 * asked for while one is in flight runs once more when it settles, as in `usePendingCount`.
 */
export function useAdminProposalCount(http: CapabilityCaller, pushes: PushSource): number | null {
  const [count, setCount] = useState<number | null>(null);
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const reads = can('get_admin_proposal_segment_counts') === true;
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
          const counts = await http.call<ReceivedAdminProposalCountsWire>(
            'get_admin_proposal_segment_counts',
          );
          setCount(counts.proposed);
        } catch (err) {
          if (isForbiddenError(err)) {
            permissions.markDenied('get_admin_proposal_segment_counts');
            again.current = false;
          }
          // Any other failure keeps the last count: the tab itself shows load errors.
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
    const onChange = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const unsubResynced = pushes.onResynced(onChange);
    window.addEventListener('hashchange', onChange);
    window.addEventListener(DECIDED_EVENT, onChange);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubResynced();
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener(DECIDED_EVENT, onChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pushes, refresh]);

  return reads ? count : null;
}

const DECIDED_EVENT = 'nexttime:admin-proposal-decided';

/** An owner applied or rejected a segment here: the count is read again. */
export function notifyAdminProposalsDecided(): void {
  window.dispatchEvent(new Event(DECIDED_EVENT));
}

const AdminProposalCountContext = createContext<number | null>(null);

/** AppShell provides the one count it reads, so the pages under it show the same number. */
export const AdminProposalCountProvider = AdminProposalCountContext.Provider;

/** The count `AppShell` read — `null` outside it, while unknown, or for a reader who is not the
 *  owner. */
export function useAdminProposalCountValue(): number | null {
  return useContext(AdminProposalCountContext);
}
