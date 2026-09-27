import { useCallback } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import type { GatekeeperListRow, PrincipalRow } from '../../lib/governance.js';
import { useRefNames } from '../ui/RefChip.js';

/**
 * components/approvals/useDirectoryNames (S6-A B3 — docs/console-completion-plan.md §5.8 "id →
 * 名称", §5.9 principle 3 "id 永不裸露"): the id → name maps the approvals / tasks / audit pages
 * feed their `RefChip`s, resolved client-side from the list capabilities that already exist
 * (`list_principals`, `list_gatekeepers`) — never a new kernel read.
 *
 * `list_principals` is `minRole: 'operator'` (packages/shared/src/capabilities.ts) and the
 * kernel's role rule is exact-match below owner, so a member *or an auditor* is refused: that
 * one is loaded through a guarded `useResource` loader (the same shape `TasksPage` used for its
 * `list_pending` read) that answers `[]` once the session has learned the 403, instead of
 * re-firing a request that can only fail again on every mount. Any other failure also degrades
 * to `[]` — the chip then shows the grey bare id (visibly a fallback), never an error state on a
 * page whose subject is something else. S8 W1-C (#243) made `list_principals` keyset-paginated
 * (default 100, max 500); the loader below walks every page — a name resolution directory that
 * silently stopped at page one would start showing bare-id chips for real members once a
 * workspace grew past 100, which is a correctness regression, not an acceptable degradation. The
 * member-level gatekeeper list goes through `useCapabilityList` (cached per session, permissions
 * marked by the hook itself); Worker definition names come from `lib/tasks.ts`'s `definitionName`
 * over the list the pages load.
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
 *  actor selector). See the module doc for why this read is guarded, and walks every page. */
export function usePrincipalDirectory(http: CapabilityCaller): PrincipalDirectory {
  const permissions = usePermissions();
  const denied = permissions.isDenied('list_principals');
  const markDenied = permissions.markDenied;
  const load = useCallback(async (): Promise<PrincipalLoad> => {
    if (denied) return { items: [], failed: true };
    try {
      let items: readonly PrincipalRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await http.call<{ items: readonly PrincipalRow[]; nextCursor?: string }>(
          'list_principals',
          cursor ? { cursor } : {},
        );
        items = [...items, ...page.items];
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { items, failed: false };
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

export interface GatekeeperDirectory {
  /** `undefined` while loading (or on error/forbidden) — same "degrade to a fallback" shape every
   *  caller here already had before this hook existed: `catalog/ProcedureEditorHost` and `catalog/
   *  WorkerEditorHost` pass this straight through so their editors can still tell "still loading"
   *  from "this workspace has none" (typed-id fallback vs. an empty picker) — see the module doc
   *  comment on `list_gatekeepers` not needing `usePrincipalDirectory`'s own guarded-403/keyset-walk
   *  treatment (it is member-readable and small enough not to paginate past page one in practice). */
  readonly rows: readonly GatekeeperListRow[] | undefined;
  readonly names: ReadonlyMap<string, string>;
}

/**
 * `list_gatekeepers` as rows + names — the one shared read every page that used to open its own
 * `useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers')` now calls instead (closing wave
 * C6, G7 — `kernel-console-coverage-2026-09-26.md`'s "list_gatekeepers ×7" structural-debt note).
 * `useCapabilityList`'s own per-`(name, params)` cache (`hooks/useCapability.ts`) already meant
 * every one of those call sites shared the same underlying read (and the same push-driven
 * invalidation) — this hook does not add new caching, it removes the seven copies of the same
 * `state.status === 'ready' ? … : fallback` unwrap around it. `GrantGateForm`'s own gate *picker*
 * (`list_gatekeepers` with a live `q` search term, `autoLoadAll`, and a `load` override that skips
 * the read entirely when `lockedGatekeeper` is given) stays on its own `useCapabilityList` call —
 * a different shape (per-keystroke params, not a static directory) this hook does not generalize
 * to without either losing that behavior or growing an API only one caller would use.
 */
export function useGatekeeperDirectory(http: CapabilityCaller): GatekeeperDirectory {
  const gatekeepers = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const rows = gatekeepers.state.status === 'ready' ? gatekeepers.state.data.items : undefined;
  return { rows, names: useRefNames(rows) };
}

export function useGatekeeperNames(http: CapabilityCaller): ReadonlyMap<string, string> {
  return useGatekeeperDirectory(http).names;
}

/** A `RefChip`-ready `name` for `id`: the resolved name, or `null` (bare-id fallback). */
export function nameOf(names: ReadonlyMap<string, string> | undefined, id: string): string | null {
  return (names ?? NONE).get(id) ?? null;
}
