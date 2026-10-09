import type { BlastRadius, OperationSummaryWire } from '@nexttime/shared';
import { useCapabilityList } from '../hooks/useCapability.js';
import type { CapabilityCaller } from './clients.js';

/**
 * lib/gate-operations: the "pick one of this gate's published Operations" data source behind the
 * policy editor's action kind and the Procedure editor's operation step (console-ux-2: both were
 * free text, so a typo saved a rule / step that silently never matched anything). Reads
 * `list_operations{gatekeeperId}` (member-visible, every status) the same way
 * `access/GrantGateForm` does, keeps only `published` rows — the only ones an agent can request,
 * and therefore the only names a policy's `actionKindTag` (the kernel's `action_kind`, which is the
 * Operation's own name — `request-action-handler.ts`) can ever meet.
 */

/** One pickable Operation name. With `scope: 'all'` the same name on several gates folds into one
 *  choice (`gateCount`), since a workspace-wide rule matches the name on every gate. */
export interface OperationChoice {
  readonly name: string;
  /** The Operation's declared blast radius; `null` when the gates that publish this name disagree. */
  readonly blastRadius: BlastRadius | null;
  readonly description?: string;
  readonly gateCount: number;
}

/** Published rows → one choice per name, sorted by name. */
export function operationChoices(items: readonly OperationSummaryWire[]): OperationChoice[] {
  const byName = new Map<
    string,
    { blastRadius: BlastRadius | null; description?: string; gates: Set<string> }
  >();
  for (const item of items) {
    if (item.status !== 'published') continue;
    const existing = byName.get(item.name);
    if (existing === undefined) {
      byName.set(item.name, {
        blastRadius: item.blastRadius,
        ...(item.description ? { description: item.description } : {}),
        gates: new Set([item.gatekeeperId]),
      });
      continue;
    }
    existing.gates.add(item.gatekeeperId);
    if (existing.blastRadius !== item.blastRadius) existing.blastRadius = null;
    if (existing.description === undefined && item.description) {
      existing.description = item.description;
    }
  }
  return [...byName.entries()]
    .map(([name, entry]) => ({
      name,
      blastRadius: entry.blastRadius,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      gateCount: entry.gates.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type GateOperationsState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly choices: readonly OperationChoice[] }
  | { readonly status: 'error'; readonly error: unknown };

export interface GateOperations {
  readonly state: GateOperationsState;
  readonly reload: () => void;
}

/** Which Operations to offer: one gate's, every gate's (a workspace-wide rule), or none yet
 *  (`null` — no gate chosen; nothing is requested). */
export type GateOperationsScope = { readonly gatekeeperId: string } | 'all' | null;

const NO_GATE_PARAMS = { gatekeeperId: '__none__' } as const;

export function useGateOperations(
  http: CapabilityCaller,
  scope: GateOperationsScope,
): GateOperations {
  const params =
    scope === null ? NO_GATE_PARAMS : scope === 'all' ? {} : { gatekeeperId: scope.gatekeeperId };
  const list = useCapabilityList<OperationSummaryWire>(http, 'list_operations', params, {
    autoLoadAll: true,
    load: scope === null ? async () => ({ items: [] }) : undefined,
  });
  const reload = (): void => void list.reload();
  if (scope === null) return { state: { status: 'idle' }, reload };
  const { state } = list;
  if (state.status === 'loading') return { state: { status: 'loading' }, reload };
  if (state.status === 'error') return { state: { status: 'error', error: state.error }, reload };
  return { state: { status: 'ready', choices: operationChoices(state.data.items) }, reload };
}
