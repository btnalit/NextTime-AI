import type { ConnectorModeWire, ConnectorWire, GateInstanceWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../../lib/clients.js';

export interface ConnectorModeState {
  readonly savingMode: boolean;
  readonly modeError: unknown | null;
  readonly pendingMode: ConnectorModeWire | null;
  readonly modeConfirmOpen: boolean;
  /** R-41: the pending switch is to `disabled` while the connector has instances — the case where
   *  the confirm offers `alsoDisableOperations` as the real cut-off. */
  readonly disablingInUse: boolean;
  /** R-41 (maintainer decision D-19(a)): the confirm's "also disable every Operation" opt-in —
   *  the deny list is what stops workspaces that already enabled the connector; the mode alone does
   *  not. Reset every time the confirm opens or closes. */
  readonly alsoDisableOperations: boolean;
  readonly setAlsoDisableOperations: (value: boolean) => void;
  readonly requestModeChange: (mode: ConnectorModeWire) => void;
  readonly changeMode: (mode: ConnectorModeWire) => Promise<void>;
  readonly onModeConfirmOpenChange: (open: boolean) => void;
}

/**
 * components/platform/integrations/useConnectorMode: one connector row's mode-switch confirm
 * (S8 W1-A7, audit S13/PI1) — split out of `PlatformIntegrationsPage`'s `ConnectorRow` (console
 * redesign P1) because it renders nothing and needs nothing from `components/ui/*`. The select no
 * longer applies on change — it stashes the attempted value and opens a confirm next to itself;
 * cancelling (Escape, Cancel, outside click) leaves `pendingMode` null, so the select's own `value`
 * falls back to `connector.mode` and visually reverts. `set_connector_mode` fires only from the
 * confirm's own `onConfirm` (the page's `changeMode` call).
 *
 * R-41 (review 2026-10-02, maintainer decision D-19(a)): switching a connector to `disabled` is
 * catalog visibility plus a gate on NEW connections — the catalog stops listing it, workspaces can
 * no longer enable its instances or (generic kinds) connect one themselves — and it never touches
 * workspaces that already enabled it. The kernel's real cut-off is the connector's Operation deny
 * list, so the same confirm offers `alsoDisableOperations`: when ticked, `changeMode('disabled')`
 * reads every Operation name this connector's instances announce (plus the names it already
 * refuses) and sends them as `disabledOperations` in the same `set_connector_mode` call. Operations
 * announced later are not covered; the row's allow checklist re-enables names one by one.
 */
export function useConnectorMode(
  http: CapabilityCaller,
  connector: ConnectorWire,
  onChanged: (connector: ConnectorWire) => void,
): ConnectorModeState {
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<unknown | null>(null);
  const [pendingMode, setPendingMode] = useState<ConnectorModeWire | null>(null);
  const [modeConfirmOpen, setModeConfirmOpen] = useState(false);
  const [alsoDisableOperations, setAlsoDisableOperations] = useState(false);

  /** Every Operation name the connector's instances announce, plus the ones it already refuses —
   *  the same name universe the allow checklist (`useConnectorDenyList`) renders. */
  async function everyOperationName(): Promise<string[]> {
    const instances = await http.call<{ items: readonly GateInstanceWire[] }>(
      'list_gate_instances',
      { connector: connector.name },
    );
    const names = instances.items.flatMap((instance) =>
      instance.operations.map((operation) => operation.name),
    );
    return [...new Set([...names, ...connector.disabledOperations])].sort();
  }

  async function changeMode(mode: ConnectorModeWire): Promise<void> {
    if (savingMode) return;
    setSavingMode(true);
    setModeError(null);
    try {
      const disabledOperations =
        mode === 'disabled' && alsoDisableOperations ? await everyOperationName() : undefined;
      onChanged(
        await http.call<ConnectorWire>('set_connector_mode', {
          name: connector.name,
          mode,
          ...(disabledOperations !== undefined ? { disabledOperations } : {}),
        }),
      );
      setPendingMode(null);
    } catch (err) {
      setModeError(err);
      throw err;
    } finally {
      setSavingMode(false);
    }
  }

  function requestModeChange(mode: ConnectorModeWire): void {
    if (mode === connector.mode) return;
    setPendingMode(mode);
    setAlsoDisableOperations(false);
    setModeConfirmOpen(true);
  }

  function onModeConfirmOpenChange(open: boolean): void {
    setModeConfirmOpen(open);
    if (!open) {
      setPendingMode(null);
      setAlsoDisableOperations(false);
    }
  }

  const disablingInUse = pendingMode === 'disabled' && connector.instanceCount > 0;

  return {
    savingMode,
    modeError,
    pendingMode,
    modeConfirmOpen,
    disablingInUse,
    alsoDisableOperations,
    setAlsoDisableOperations,
    requestModeChange,
    changeMode,
    onModeConfirmOpenChange,
  };
}
