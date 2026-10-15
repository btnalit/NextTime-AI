import type { ConnectorModeWire, ConnectorWire, GateInstanceWire } from '@nexttime/shared';
import { useMemo } from 'react';
import { useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import type { Translate } from '../../../lib/i18n.js';
import { connectorModeLabel } from '../../../lib/labels.js';

/**
 * components/platform/integrations/connector-visibility (UX acceptance of #538, out of scope there):
 * a workspace sees a platform gate instance — in 「待启用的平台实例」, and `enable_gate_instance`
 * accepts it — only while the instance is enabled AND its connector is `platform_preset`
 * (`listAvailableGateInstances` / `requireAvailable`, application/gates/store.ts and
 * gate-instance-handlers.ts). An administrator who enabled an instance of a `self_serve` (or
 * `disabled`) connector used to get no word that no workspace could see it. Every platform-side
 * place that shows such an instance — the instance list, its drawer, the connector row, the mode
 * switch, the overview's 需要人处理 — reads this one judgment and this one wording.
 */

const ALL: Readonly<Record<string, unknown>> = {};

/** Generic connectors the platform cannot run as presets (no gate host for the kind) —
 *  `set_connector_mode` refuses `platform_preset` for them (`connector_mode_not_allowed`). */
const NEVER_PRESET: ReadonlySet<string> = new Set(['cli', 'ssh']);

/** Whether `set_connector_mode` accepts `platform_preset` for this connector at all. */
export function canBePlatformPreset(connectorName: string): boolean {
  return !NEVER_PRESET.has(connectorName);
}

/** The connector mode that hides an enabled instance from every workspace, or `null` when it is
 *  visible (or not enabled at all, or its connector is not known yet). */
export function hiddenFromWorkspaces(
  instance: Pick<GateInstanceWire, 'status' | 'connector'>,
  connectors: ReadonlyMap<string, ConnectorWire> | null,
): ConnectorModeWire | null {
  if (instance.status !== 'enabled' || connectors === null) return null;
  const mode = connectors.get(instance.connector)?.mode;
  return mode === undefined || mode === 'platform_preset' ? null : mode;
}

/** The short label for a list row or a 需要人处理 entry. */
export function hiddenInstanceTitle(displayName: string, t: Translate): string {
  return t(
    `门实例「${displayName}」已启用，但工作区看不到它`,
    `Gate instance "${displayName}" is enabled, but no workspace can see it`,
  );
}

/** Why, and what to change — the instance drawer and the connector row say this. */
export function hiddenInstanceExplanation(
  connector: Pick<ConnectorWire, 'name' | 'packaged'>,
  mode: ConnectorModeWire,
  t: Translate,
): string {
  const why = t(
    `接入包「${connector.name}」是「${connectorModeLabel(mode, t)}」：只有「平台预置」接入包的实例才会出现在工作区的「待启用的平台实例」里，所以已启用的实例工作区看不到，也启用不了。`,
    `Connector "${connector.name}" is ${connectorModeLabel(mode, t)}: only instances of a platform-preset connector show up in a workspace's “Platform instances pending enable”, so no workspace can see or enable an enabled instance of it.`,
  );
  if (!canBePlatformPreset(connector.name)) {
    return `${why}${t(
      '这一类接入包不能设为「平台预置」（平台没有这一类的门宿主），工作区只能自己接入这一类系统。',
      ' This kind cannot be a platform preset (the platform has no gate host for it); workspaces can only connect such a system themselves.',
    )}`;
  }
  return `${why}${
    connector.packaged
      ? t(
          `要让工作区启用它，到「接入包」把「${connector.name}」改成「平台预置」。`,
          ` To let workspaces enable it, set "${connector.name}" to platform preset under Connectors.`,
        )
      : t(
          `要让工作区启用它，到「接入包」把「${connector.name}」改成「平台预置」；之后工作区不能再自己接入这一类系统。`,
          ` To let workspaces enable it, set "${connector.name}" to platform preset under Connectors; workspaces then can no longer connect this kind of system themselves.`,
        )
  }`;
}

/** `list_connectors` keyed by name — `null` while it loads or when it cannot be read (then
 *  nothing is flagged rather than guessed). */
export function useConnectorsByName(
  http: CapabilityCaller,
): ReadonlyMap<string, ConnectorWire> | null {
  const connectors = useCapabilityList<ConnectorWire>(http, 'list_connectors', ALL);
  const items = connectors.state.status === 'ready' ? connectors.state.data.items : null;
  return useMemo(
    () => (items === null ? null : new Map(items.map((row) => [row.name, row]))),
    [items],
  );
}
