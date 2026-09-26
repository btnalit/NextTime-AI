import type { GateInstanceWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityListResult } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';

export type InstancesPanel =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'gate'; readonly gateId: string };

export interface GateInstancesPanelState {
  readonly panel: InstancesPanel;
  readonly setPanel: (next: InstancesPanel) => void;
  readonly instances: CapabilityListResult<GateInstanceWire>;
  readonly rows: readonly GateInstanceWire[];
  readonly open: GateInstanceWire | undefined;
  readonly replace: (updated: GateInstanceWire) => void;
  readonly handleCreated: (created: GateInstanceWire) => void;
  readonly handleDeleted: (gateId: string) => void;
}

/**
 * components/platform/integrations/useGateInstancesPanel: `PlatformIntegrationsPage`'s 门实例 tab
 * state — split out of `GateInstancesTab` (console redesign P1) because it renders nothing and
 * needs nothing from `components/ui/*`. The route is the source of truth for which drawer is open
 * when the page is deep-linked (`#/platform/integrations/<gateId>`); a local open/close also
 * updates the hash through `onSelectGate` when the caller wires it.
 */
export function useGateInstancesPanel(
  http: CapabilityCaller,
  selectedGateId: string | undefined,
  onSelectGate: ((gateId: string | null) => void) | undefined,
): GateInstancesPanelState {
  const [panel, setPanelState] = useState<InstancesPanel>(() =>
    selectedGateId !== undefined ? { kind: 'gate', gateId: selectedGateId } : { kind: 'closed' },
  );
  useEffect(() => {
    if (selectedGateId !== undefined) setPanelState({ kind: 'gate', gateId: selectedGateId });
  }, [selectedGateId]);
  function setPanel(next: InstancesPanel): void {
    setPanelState(next);
    if (next.kind === 'gate') onSelectGate?.(next.gateId);
    else if (panel.kind === 'gate') onSelectGate?.(null);
  }
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', {});
  const rows = instances.state.status === 'ready' ? instances.state.data.items : [];
  const open = panel.kind === 'gate' ? rows.find((row) => row.gateId === panel.gateId) : undefined;

  function replace(updated: GateInstanceWire): void {
    instances.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.gateId === updated.gateId ? updated : row)),
    }));
  }

  /** `create_gate_instance` already answers with the full, current row — no reload needed before
   *  opening its detail drawer (the `PlatformWorkspacesPage`'s own `handleCreated` shape, minus
   *  the reload it does for a reason specific to that page). */
  function handleCreated(created: GateInstanceWire): void {
    instances.mutate((data) => ({ ...data, items: [created, ...data.items] }));
    setPanel({ kind: 'gate', gateId: created.gateId });
  }

  function handleDeleted(gateId: string): void {
    instances.mutate((data) => ({
      ...data,
      items: data.items.filter((row) => row.gateId !== gateId),
    }));
    setPanel({ kind: 'closed' });
  }

  return { panel, setPanel, instances, rows, open, replace, handleCreated, handleDeleted };
}
