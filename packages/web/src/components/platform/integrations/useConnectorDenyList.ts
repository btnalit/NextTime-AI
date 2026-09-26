import type { ConnectorWire, GateInstanceWire } from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityListResult } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';

export interface ConnectorDenyListState {
  readonly instances: CapabilityListResult<GateInstanceWire>;
  readonly names: readonly string[];
  /** The connector's own deny list, pending save — the wire shape (`set_connector_mode`'s
   *  `disabledOperations` param) stays this either way; only the checklist's own checkbox sense is
   *  inverted (`checked` = allowed, see this file's own module doc comment). */
  readonly disabled: readonly string[];
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: unknown | null;
  readonly toggle: (name: string) => void;
  /** Saves immediately, no confirm — used by `requestSave` itself when nothing would be newly
   *  disabled, and kept exported for anything that wants the un-gated save directly. */
  readonly save: () => Promise<void>;
  /** Names that are in `disabled` (pending) but were not in the connector's own current
   *  `disabledOperations` — i.e. would newly stop working for every workspace that enabled an
   *  instance of this connector. Non-empty is exactly the condition `requestSave` gates on a
   *  confirm for. */
  readonly newlyDisabled: readonly string[];
  readonly confirmOpen: boolean;
  readonly onConfirmOpenChange: (open: boolean) => void;
  /** The checklist's own "保存 Save" button calls this, never `save` directly — opens a confirm
   *  when `newlyDisabled` is non-empty, otherwise saves right away. */
  readonly requestSave: () => void;
  /** The confirm's own `onConfirm` — same request as `save`, but throws on failure so `Confirm`'s
   *  own inline error banner shows it (`components/kit/confirm.tsx`'s `onConfirm` contract) instead
   *  of this hook's `error` state, which only the un-gated `save` path renders through. */
  readonly confirmSave: () => Promise<void>;
  /** Total `enabledWorkspaceCount` across every live instance of this connector — cheap because
   *  `instances` is already loaded for the checklist itself; the confirm's own impact line. */
  readonly enabledWorkspaceCount: number;
}

/**
 * components/platform/integrations/useConnectorDenyList: the per-Operation allow checklist for one
 * connector — split out of `PlatformIntegrationsPage`'s `ConnectorDenyList` (console redesign P1)
 * because it renders nothing and needs nothing from `components/ui/*`. The checklist's name
 * universe is the union of every live instance's announced Operations *and* the connector's
 * already-disabled names, so a name no instance announces right now (one that went `lost`, or was
 * renamed) stays visible and can still be un-disabled.
 *
 * Production incident 2026-09-26 UX fix: the checklist used to render CHECKED = DISABLED (a deny
 * list rendered as itself), which reads backwards next to every other checklist in this console and
 * invites exactly the mistake that caused the incident (an admin ticking every box meaning to
 * "select the operations to review", disabling all five). It is now an ALLOW list — checked = the
 * agent may call it, default all checked — while the wire payload underneath is unchanged
 * (`disabled`/`set_connector_mode`'s `disabledOperations` still name what is *refused*; only the
 * checkbox's rendered sense in `PlatformIntegrationsPage.tsx` inverts). Unticking something that
 * every linked workspace could already call needs a confirm (`requestSave`/`newlyDisabled` above) —
 * re-ticking something back on needs none, since that only ever restores access, never removes it.
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
  const [confirmOpen, setConfirmOpen] = useState(false);

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
  const newlyDisabled = disabled.filter((name) => !connector.disabledOperations.includes(name));
  const enabledWorkspaceCount =
    instances.state.status === 'ready'
      ? instances.state.data.items.reduce(
          (sum, instance) => sum + instance.enabledWorkspaceCount,
          0,
        )
      : 0;

  function toggle(name: string): void {
    setDisabled((prev) =>
      prev.includes(name) ? prev.filter((existing) => existing !== name) : [...prev, name],
    );
  }

  /** Throws on failure — the shared body for both `save` (catches, for the un-gated direct path)
   *  and `confirmSave` (left to throw, for `Confirm`'s own error banner). */
  async function commitSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const result = await http.call<ConnectorWire>('set_connector_mode', {
        name: connector.name,
        disabledOperations: [...disabled],
      });
      onChanged(result);
    } finally {
      setSaving(false);
    }
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    try {
      await commitSave();
    } catch (err) {
      setError(err);
    }
  }

  async function confirmSave(): Promise<void> {
    await commitSave();
  }

  function requestSave(): void {
    if (!dirty || saving) return;
    if (newlyDisabled.length > 0) {
      setConfirmOpen(true);
    } else {
      void save();
    }
  }

  function onConfirmOpenChange(open: boolean): void {
    setConfirmOpen(open);
  }

  return {
    instances,
    names,
    disabled,
    dirty,
    saving,
    error,
    toggle,
    save,
    newlyDisabled,
    confirmOpen,
    onConfirmOpenChange,
    requestSave,
    confirmSave,
    enabledWorkspaceCount,
  };
}
