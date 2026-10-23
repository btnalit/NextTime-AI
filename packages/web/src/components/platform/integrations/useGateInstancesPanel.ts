import type { GateInstanceWire } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityListResult } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { hrefs, readConnectorPresetLink } from '../../../lib/router.js';

export type InstancesPanel =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create'; readonly preset?: string }
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
  const [panel, setPanelState] = useState<InstancesPanel>(() => {
    if (selectedGateId !== undefined) return { kind: 'gate', gateId: selectedGateId };
    const preset = readConnectorPresetLink(window.location.hash);
    return preset !== null ? { kind: 'create', preset } : { kind: 'closed' };
  });
  useEffect(() => {
    if (selectedGateId !== undefined) setPanelState({ kind: 'gate', gateId: selectedGateId });
  }, [selectedGateId]);
  // S11 P1-F: `hrefs.platformConnectorPreset` (a pack's 需要平台接入 system) opens 新建门宿主实例 on
  // that preset. The query is dropped once read, so closing the drawer and reloading does not open
  // it again; a link followed while this tab is already mounted opens it too.
  useEffect(() => {
    function consume(): void {
      const preset = readConnectorPresetLink(window.location.hash);
      if (preset === null) return;
      setPanelState({ kind: 'create', preset });
      window.history.replaceState(null, '', hrefs.platformIntegrationsTab('instances'));
    }
    consume();
    window.addEventListener('hashchange', consume);
    return () => window.removeEventListener('hashchange', consume);
  }, []);
  function setPanel(next: InstancesPanel): void {
    setPanelState(next);
    if (next.kind === 'gate') onSelectGate?.(next.gateId);
    else if (panel.kind === 'gate') onSelectGate?.(null);
  }
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', {});
  const rows = instances.state.status === 'ready' ? instances.state.data.items : [];
  const panelGateId = panel.kind === 'gate' ? panel.gateId : undefined;
  const listMatch =
    panelGateId !== undefined ? rows.find((row) => row.gateId === panelGateId) : undefined;

  // G4 (kernel-console-coverage-2026-09-26, closing wave C6): `list_gate_instances` above has no
  // `autoLoadAll` — a browsable table intentionally only loads its first page. A deep link
  // (`#/platform/integrations/<gateId>`, `PlatformIntegrationsPage`'s own `selectedGateId`) naming
  // an instance outside that page used to leave the drawer silently closed forever (`open` stayed
  // `undefined`). Falls back to the dedicated single-object getter exactly for that miss, once the
  // list has actually finished loading (so this never races the ordinary, in-page `setPanel`
  // click, which always finds its row already in `rows`). A `not_found`/`forbidden` on the
  // fallback itself degrades the same way it always did — drawer stays closed, no new error UI.
  const [fallback, setFallback] = useState<{
    readonly gateId: string;
    readonly row: GateInstanceWire;
  } | null>(null);
  const hasListMatch = listMatch !== undefined;
  const instancesReady = instances.state.status === 'ready';
  useEffect(() => {
    if (panelGateId === undefined || hasListMatch || !instancesReady) return;
    let cancelled = false;
    void http
      .call<GateInstanceWire>('get_gate_instance', { gateId: panelGateId })
      .then((row) => {
        if (!cancelled) setFallback({ gateId: panelGateId, row });
      })
      .catch(() => {
        /* not_found / forbidden — leave the drawer closed, same as before this fallback existed. */
      });
    return () => {
      cancelled = true;
    };
  }, [panelGateId, hasListMatch, instancesReady, http]);

  const open =
    listMatch ?? (fallback !== null && fallback.gateId === panelGateId ? fallback.row : undefined);

  function replace(updated: GateInstanceWire): void {
    instances.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.gateId === updated.gateId ? updated : row)),
    }));
    // A row `open` only via the G4 fallback above (not in the loaded page) is not in `data.items`
    // for the `mutate` above to reach — keep it in sync too, or an edit inside the deep-linked
    // drawer would silently revert to the pre-edit fallback row on the next render.
    setFallback((current) =>
      current !== null && current.gateId === updated.gateId
        ? { gateId: updated.gateId, row: updated }
        : current,
    );
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
