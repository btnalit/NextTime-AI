import type { ExecutionReadinessWire } from '@nexttime/shared';
import { useMemo } from 'react';
import { useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';

export type MemberReadinessMap = ReadonlyMap<string, ExecutionReadinessWire>;

export interface MemberReachabilityResult {
  /** One `execution_readiness` response per principal id that resolved successfully. */
  readonly byPrincipal: MemberReadinessMap;
  /** `true` while the current id set's first load is in flight (`useResource`'s own `loading`) —
   *  a later refetch (the id set changed) keeps the previous map visible instead of blanking it. */
  readonly loading: boolean;
  /** Ids whose own `execution_readiness{principalId}` call failed (network/transient — a 403
   *  should not happen here since every id comes from an owner/operator-readable `list_grants`
   *  row and the reader has already proven at least operator by reading that list). */
  readonly failed: ReadonlySet<string>;
}

const EMPTY_MAP: MemberReadinessMap = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * components/systems/useMemberReachability (console redesign P2, docs/console-redesign-plan-
 * 2026-09-25.md §4 "系统与授权"): one `execution_readiness{principalId}` call per distinct member
 * who holds a grant somewhere in this workspace — not per (member, system) pair, since a single
 * response already carries every gate's reachability for that principal. This is still N calls for
 * N members (no batched read model exists yet for "many principals' readiness at once") — noted in
 * this lane's PR report as a candidate follow-up once a real need for it shows up at scale.
 *
 * Refetches only when the *set* of ids changes (a grant/revoke that adds or removes a grantee),
 * not on every render — `idsKey` is the effect/loader's real dependency, the same pattern
 * `components/approvals/useDirectoryNames.tsx`'s own loaders use for a similarly dynamic id list.
 */
export function useMemberReachability(
  http: CapabilityCaller,
  principalIds: readonly string[],
): MemberReachabilityResult {
  const idsKey = useMemo(() => [...new Set(principalIds)].sort().join(','), [principalIds]);

  const loader = useMemo(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',');
    return async () => {
      const failed = new Set<string>();
      const byPrincipal = new Map<string, ExecutionReadinessWire>();
      await Promise.all(
        ids.map(async (id) => {
          try {
            const result = await http.call<ExecutionReadinessWire>('execution_readiness', {
              principalId: id,
            });
            byPrincipal.set(id, result);
          } catch {
            failed.add(id);
          }
        }),
      );
      return { byPrincipal, failed };
    };
  }, [http, idsKey]);

  const resource = useResource(loader);

  if (resource.state.status === 'ready') {
    return {
      byPrincipal: resource.state.data.byPrincipal,
      loading: false,
      failed: resource.state.data.failed,
    };
  }
  return {
    byPrincipal: EMPTY_MAP,
    loading: resource.state.status === 'loading',
    failed: EMPTY_SET,
  };
}
