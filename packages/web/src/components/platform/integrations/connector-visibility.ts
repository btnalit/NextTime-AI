import {
  type ConnectorModeWire,
  type ConnectorWire,
  type GateInstanceWire,
  isGenericConnector,
} from '@nexttime/shared';
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

/** How many workspaces already enabled it — they keep calling it whatever the connector mode
 *  (the mode decides only what `list_available_gate_instances` offers). An older kernel's row
 *  without the count reads as none. */
function enabledIn(instance: { readonly enabledWorkspaceCount?: number }): number {
  return instance.enabledWorkspaceCount ?? 0;
}

/** The short label for a 需要人处理 entry. UX acceptance of #567 P2: an instance some workspace
 *  already enabled keeps working there, so it is only the others that cannot see it. */
export function hiddenInstanceTitle(
  instance: Pick<GateInstanceWire, 'displayName'> & { readonly enabledWorkspaceCount?: number },
  t: Translate,
): string {
  const count = enabledIn(instance);
  return count > 0
    ? t(
        `门实例「${instance.displayName}」已在 ${count} 个工作区启用；其他工作区看不到它，也启用不了`,
        `Gate instance "${instance.displayName}" is enabled in ${count} workspace(s); no other workspace can see or enable it`,
      )
    : t(
        `门实例「${instance.displayName}」已启用，但工作区看不到它`,
        `Gate instance "${instance.displayName}" is enabled, but no workspace can see it`,
      );
}

/** Whether `workspaceId` is one of the workspaces that enabled `instance`: `undefined` when that
 *  cannot be told — no workspace in context, or the capped `enablingWorkspaces` list is cut short
 *  and does not name it (an older kernel's row without the list reads as none enabled). */
export function enabledHere(
  instance: {
    readonly enabledWorkspaceCount?: number;
    readonly enablingWorkspaces?: readonly { readonly id: string }[];
  },
  workspaceId: string | null | undefined,
): boolean | undefined {
  if (!workspaceId) return undefined;
  const listed = instance.enablingWorkspaces ?? [];
  if (listed.some((workspace) => workspace.id === workspaceId)) return true;
  return listed.length >= enabledIn(instance) ? false : undefined;
}

/** The list-row badge. With a workspace in context (the launcher on a workspace page), "the other
 *  workspaces" is said only when this one enabled it; one this workspace has not enabled is
 *  hidden from it too (review #501 on #571 ④). */
export function hiddenInstanceBadge(
  instance: {
    readonly enabledWorkspaceCount?: number;
    readonly enablingWorkspaces?: readonly { readonly id: string }[];
  },
  t: Translate,
  workspaceId?: string | null,
): string {
  const here = enabledHere(instance, workspaceId);
  if (here === false) return t('本工作区看不到', 'Hidden from this workspace');
  return enabledIn(instance) > 0
    ? t('其他工作区看不到', 'Hidden from other workspaces')
    : t('工作区看不到', 'Hidden from workspaces');
}

/** The drawer's first sentence, before `hiddenInstanceExplanation`. */
export function hiddenInstanceLead(
  instance: Pick<GateInstanceWire, 'status'> & { readonly enabledWorkspaceCount?: number },
  t: Translate,
): string {
  const count = enabledIn(instance);
  if (instance.status !== 'enabled') {
    return t('启用之后工作区也看不到它。', 'Even once enabled, no workspace will see it. ');
  }
  return count > 0
    ? t(
        `已在 ${count} 个工作区启用，那里照常使用；其他工作区看不到这个实例，也启用不了。`,
        `Enabled in ${count} workspace(s), which keep using it; no other workspace can see or enable this instance. `,
      )
    : t('工作区看不到这个实例。', 'No workspace can see this instance. ');
}

/** Why, and what to change — the instance drawer and the connector row say this. */
export function hiddenInstanceExplanation(
  connector: Pick<ConnectorWire, 'name' | 'packaged'>,
  mode: ConnectorModeWire,
  t: Translate,
): string {
  const why = t(
    `接入包「${connector.name}」是「${connectorModeLabel(mode, t)}」：只有「平台预置」接入包的实例才会出现在工作区的「待启用的平台实例」里，还没启用它的工作区看不到它，也启用不了。`,
    `Connector "${connector.name}" is ${connectorModeLabel(mode, t)}: only instances of a platform-preset connector show up in a workspace's “Platform instances pending enable”, so a workspace that has not enabled it yet can neither see nor enable it.`,
  );
  if (!canBePlatformPreset(connector.name)) {
    return `${why}${t(
      '这一类接入包不能设为「平台预置」（平台没有这一类的门宿主），工作区只能自己接入这一类系统。',
      ' This kind cannot be a platform preset (the platform has no gate host for it); workspaces can only connect such a system themselves.',
    )}`;
  }
  // Only a generic connector's mode also governs self-connections (R-40) — a packaged gate's, or
  // one named for a system's gate-host instances (P1), reaches the catalog alone.
  return `${why}${
    isGenericConnector(connector.name)
      ? t(
          `要让工作区启用它，到「接入包」把「${connector.name}」改成「平台预置」；之后工作区不能再自己接入这一类系统。`,
          ` To let workspaces enable it, set "${connector.name}" to platform preset under Connectors; workspaces then can no longer connect this kind of system themselves.`,
        )
      : t(
          `要让工作区启用它，到「接入包」把「${connector.name}」改成「平台预置」。`,
          ` To let workspaces enable it, set "${connector.name}" to platform preset under Connectors.`,
        )
  }`;
}

/** `list_connectors` keyed by name — `null` while it loads or when it cannot be read (then
 *  nothing is flagged rather than guessed). */
export function useConnectorsByName(
  http: CapabilityCaller,
  options: { readonly enabled?: boolean } = {},
): ReadonlyMap<string, ConnectorWire> | null {
  const connectors = useCapabilityList<ConnectorWire>(http, 'list_connectors', ALL, {
    enabled: options.enabled ?? true,
  });
  const items = connectors.state.status === 'ready' ? connectors.state.data.items : null;
  return useMemo(
    () => (items === null ? null : new Map(items.map((row) => [row.name, row]))),
    [items],
  );
}
