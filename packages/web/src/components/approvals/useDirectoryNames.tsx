import { useCallback } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import type { GatekeeperListRow, PrincipalRow } from '../../lib/governance.js';
import type { WorkerDefinitionSummary } from '../../lib/tasks.js';
import { useRefNames } from '../ui/RefChip.js';

/**
 * components/approvals/useDirectoryNames (S6-A B3 — docs/console-completion-plan.md §5.8 "id →
 * 名称", §5.9 principle 3 "id 永不裸露"): the id → name maps the approvals / tasks / audit pages
 * feed their `RefChip`s, resolved client-side from the list capabilities that already exist
 * (`list_principals`, `list_gatekeepers`, `list_worker_definitions`) — never a new kernel read.
 *
 * `list_principals` is `minRole: 'operator'` (packages/shared/src/capabilities.ts) and the
 * kernel's role rule is exact-match below owner, so a member *or an auditor* is refused: that
 * one is loaded through a guarded `useResource` loader (the same shape `TasksPage` used for its
 * `list_pending` read) that answers `[]` once the session has learned the 403, instead of
 * re-firing a request that can only fail again on every mount. Any other failure also degrades
 * to `[]` — the chip then shows the grey bare id (visibly a fallback), never an error state on a
 * page whose subject is something else. The two member-level lists go through
 * `useCapabilityList` (cached per session, permissions marked by the hook itself).
 */
const NONE: ReadonlyMap<string, string> = new Map();

export interface PrincipalDirectory {
  /** The rows, once loaded; `undefined` while loading. Empty when the read was refused or
   *  failed (`failed` tells the two apart from a genuinely empty workspace). */
  readonly rows: readonly PrincipalRow[] | undefined;
  readonly names: ReadonlyMap<string, string>;
  readonly failed: boolean;
}

interface PrincipalLoad {
  readonly items: readonly PrincipalRow[];
  readonly failed: boolean;
}

/** `list_principals` as rows + names — for a page that also needs the rows (the audit page's
 *  actor selector). See the module doc for why this read is guarded. */
export function usePrincipalDirectory(http: CapabilityCaller): PrincipalDirectory {
  const permissions = usePermissions();
  const denied = permissions.isDenied('list_principals');
  const markDenied = permissions.markDenied;
  const load = useCallback(async (): Promise<PrincipalLoad> => {
    if (denied) return { items: [], failed: true };
    try {
      const page = await http.call<{ items: readonly PrincipalRow[] }>('list_principals');
      return { items: page.items, failed: false };
    } catch (err) {
      if (isForbiddenError(err)) markDenied('list_principals');
      return { items: [], failed: true };
    }
  }, [http, denied, markDenied]);
  const principals = useResource(load);
  const loaded = principals.state.status === 'ready' ? principals.state.data : undefined;
  const names = useRefNames(loaded?.items);
  return { rows: loaded?.items, names, failed: loaded?.failed ?? false };
}

export function usePrincipalNames(http: CapabilityCaller): ReadonlyMap<string, string> {
  return usePrincipalDirectory(http).names;
}

export function useGatekeeperNames(http: CapabilityCaller): ReadonlyMap<string, string> {
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  return useRefNames(gatekeepers.state.status === 'ready' ? gatekeepers.state.data : undefined);
}

export function useWorkerDefinitionNames(http: CapabilityCaller): ReadonlyMap<string, string> {
  const definitions = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    {},
  );
  return useRefNames(definitions.state.status === 'ready' ? definitions.state.data : undefined);
}

/** A `RefChip`-ready `name` for `id`: the resolved name, or `null` (bare-id fallback). */
export function nameOf(names: ReadonlyMap<string, string> | undefined, id: string): string | null {
  return (names ?? NONE).get(id) ?? null;
}
