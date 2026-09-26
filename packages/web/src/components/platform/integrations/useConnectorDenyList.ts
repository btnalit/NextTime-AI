import type { ConnectorWire, GateInstanceWire } from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityListResult } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';

export interface ConnectorDenyListState {
  readonly instances: CapabilityListResult<GateInstanceWire>;
  readonly names: readonly string[];
  readonly disabled: readonly string[];
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: unknown | null;
  readonly toggle: (name: string) => void;
  readonly save: () => Promise<void>;
}

/**
 * components/platform/integrations/useConnectorDenyList: the per-Operation deny checklist for one
 * connector — split out of `PlatformIntegrationsPage`'s `ConnectorDenyList` (console redesign P1)
 * because it renders nothing and needs nothing from `components/ui/*`. The checklist's name
 * universe is the union of every live instance's announced Operations *and* the connector's
 * already-disabled names, so a name no instance announces right now (one that went `lost`, or was
 * renamed) stays visible and can still be un-disabled.
 */
export function useConnectorDenyList(
  http: CapabilityCaller,
  connector: ConnectorWire,
  onChanged: (connector: ConnectorWire) => void,
): ConnectorDenyListState {
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', {
    connector: connector.name,
  });
  const [disabled, setDisabled] = useState<readonly string[]>(connector.disabledOperations);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const liveNames =
    instances.state.status === 'ready'
      ? instances.state.data.items.flatMap((instance) =>
          instance.operations.map((operation) => operation.name),
        )
      : [];
  const names = Array.from(new Set([...liveNames, ...connector.disabledOperations])).sort();
  const dirty =
    disabled.length !== connector.disabledOperations.length ||
    disabled.some((name) => !connector.disabledOperations.includes(name));

  function toggle(name: string): void {
    setDisabled((prev) =>
      prev.includes(name) ? prev.filter((existing) => existing !== name) : [...prev, name],
    );
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      onChanged(
        await http.call<ConnectorWire>('set_connector_mode', {
          name: connector.name,
          disabledOperations: [...disabled],
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return { instances, names, disabled, dirty, saving, error, toggle, save };
}
