import type { ConnectorModeWire, ConnectorWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../../lib/clients.js';

export interface ConnectorModeState {
  readonly savingMode: boolean;
  readonly modeError: unknown | null;
  readonly pendingMode: ConnectorModeWire | null;
  readonly modeConfirmOpen: boolean;
  readonly disablingInUse: boolean;
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
 * `disablingInUse` (stated in the confirm's own description, not just chosen silently): switching a
 * connector *to* `disabled` while it has live gate instances cuts every one of them off
 * platform-wide at once — that is the one case worth the extra retype-to-confirm friction.
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

  async function changeMode(mode: ConnectorModeWire): Promise<void> {
    if (savingMode) return;
    setSavingMode(true);
    setModeError(null);
    try {
      onChanged(
        await http.call<ConnectorWire>('set_connector_mode', { name: connector.name, mode }),
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
    setModeConfirmOpen(true);
  }

  function onModeConfirmOpenChange(open: boolean): void {
    setModeConfirmOpen(open);
    if (!open) setPendingMode(null);
  }

  const disablingInUse = pendingMode === 'disabled' && connector.instanceCount > 0;

  return {
    savingMode,
    modeError,
    pendingMode,
    modeConfirmOpen,
    disablingInUse,
    requestModeChange,
    changeMode,
    onModeConfirmOpenChange,
  };
}
