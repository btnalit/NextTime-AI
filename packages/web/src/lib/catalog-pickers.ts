import { CAPABILITY_MODE_VALUES } from '@nexttime/shared';
import { egressDenyHost } from './catalog-input.js';
import type { Translate } from './i18n.js';

/**
 * lib/catalog-pickers (console-ux-3): the "pick it, don't type it" data shaping behind the catalog
 * editors — the Worker editor's capability checklist grouped by the `mode` every
 * `list_capability_names` row already carries, and its egress-deny host suggestions from this
 * workspace's enabled gate instances (`list_available_gate_instances`' `target`).
 */

const MODE_LABELS: Readonly<Record<string, { readonly zh: string; readonly en: string }>> = {
  observe: { zh: '观察（只读）', en: 'Observe (read-only)' },
  propose: { zh: '提议', en: 'Propose' },
  write: { zh: '写入', en: 'Write' },
  execute: { zh: '执行', en: 'Execute' },
};

export function capabilityModeLabel(mode: string, t: Translate): string {
  const label = MODE_LABELS[mode];
  return label ? t(label.zh, label.en) : mode;
}

export interface CapabilityGroup<Row> {
  readonly mode: string;
  readonly rows: readonly Row[];
}

/** Rows grouped by `mode` in the registry's own mode order (observe → write → propose → execute;
 *  a mode outside it comes last, by name), names sorted within a group. `filter` keeps rows whose
 *  name contains it (case-insensitive); groups left empty are dropped. */
export function groupCapabilitiesByMode<
  Row extends { readonly name: string; readonly mode: string },
>(rows: readonly Row[], filter = ''): readonly CapabilityGroup<Row>[] {
  const needle = filter.trim().toLowerCase();
  const byMode = new Map<string, Row[]>();
  for (const row of rows) {
    if (needle !== '' && !row.name.toLowerCase().includes(needle)) continue;
    const list = byMode.get(row.mode) ?? [];
    list.push(row);
    byMode.set(row.mode, list);
  }
  const known: readonly string[] = CAPABILITY_MODE_VALUES;
  const order = [
    ...known.filter((mode) => byMode.has(mode)),
    ...[...byMode.keys()].filter((mode) => !known.includes(mode)).sort(),
  ];
  return order.map((mode) => ({
    mode,
    rows: (byMode.get(mode) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export interface EgressHostSuggestion {
  readonly host: string;
  /** The gate instances whose target is this host (display names). */
  readonly systems: readonly string[];
}

/** Hosts of the systems this workspace has enabled (`gatekeeperId !== null`), reduced the same way
 *  a typed deny entry is (`egressDenyHost`), minus hosts already on the list. A target with no
 *  host (a unix socket, a bare service name that is not a host) yields nothing. */
export function egressHostSuggestions(
  instances: readonly {
    readonly target: string;
    readonly displayName: string;
    readonly gatekeeperId: string | null;
  }[],
  current: readonly string[],
): readonly EgressHostSuggestion[] {
  const taken = new Set(current.map((entry) => egressDenyHost(entry)));
  const byHost = new Map<string, string[]>();
  for (const instance of instances) {
    if (instance.gatekeeperId === null) continue;
    const host = egressDenyHost(instance.target);
    if (host === '' || taken.has(host)) continue;
    const systems = byHost.get(host) ?? [];
    if (!systems.includes(instance.displayName)) systems.push(instance.displayName);
    byHost.set(host, systems);
  }
  return [...byHost.entries()]
    .map(([host, systems]) => ({ host, systems }))
    .sort((a, b) => a.host.localeCompare(b.host));
}
