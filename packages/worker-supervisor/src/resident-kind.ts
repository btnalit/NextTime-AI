/**
 * resident-kind (S11 AA4c-2; the AA4c plan's D8): the two kinds of resident container one
 * Principal may have, and everything that tells them apart. A person has their **entry** agent in
 * every workspace they are a member of; a platform administrator also has an **admin agent** in a
 * trial workspace (`purpose = 'admin_trial'`), which must never share the entry agent's container:
 * the two run under different Handles (the admin agent's carries the admin agent ceiling and lives
 * at most an hour), different system prompts, a different extension mode, and the admin agent has
 * no egress at all.
 *
 * So each kind has its own container name, role label, extension mode, egress source id and host
 * directories. The entry kind keeps exactly the names it had before this module existed, so an
 * upgrade leaves every running entry container as it is. The admin kind's are chosen so that an
 * older supervisor, after a rollback, never mistakes an admin container for an entry one: it lists
 * only `nexttime.role=entry`, and nothing it builds can collide with `nexttime-admin-<id>` or the
 * `.admin` / `admin-agents` directories (Principal ids are UUIDs, `config.ts` `IdClaimSchema`).
 *
 * On the wire (`/resident/*`, agent-host's start frames) the kind travels as an optional
 * `agentKind: 'admin_agent'`; absent means the entry agent, as every caller before AA4c-2 meant.
 */

import { adminSourceId, entrySourceId } from './egress-map.js';

/** Every kind of resident container, in `ResidentInventoryEntry.agentKind`'s terms. */
export const RESIDENT_AGENT_KINDS = ['entry', 'admin_agent'] as const;
export type ResidentAgentKind = (typeof RESIDENT_AGENT_KINDS)[number];

/** The value `nexttime.role` (`spawn-spec.ts` `ENTRY_ROLE_LABEL`) carries for each kind. */
const ROLE_VALUES: Readonly<Record<ResidentAgentKind, string>> = {
  entry: 'entry',
  admin_agent: 'admin',
};

/** `NEXTTIME_MODE` for each kind (`deploy/worker-runtime/entrypoint.sh`, and
 *  `@nexttime/platform-extension`'s mode switch). */
const EXTENSION_MODES: Readonly<Record<ResidentAgentKind, string>> = {
  entry: 'entry',
  admin_agent: 'admin',
};

/** The kind `kind` resolves to from an optional wire value: absent is the entry agent. */
export function residentAgentKindOf(agentKind: 'admin_agent' | undefined): ResidentAgentKind {
  return agentKind ?? 'entry';
}

/** The registry key of one resident container: a Principal has at most one of each kind. */
export function residentKey(kind: ResidentAgentKind, principalId: string): string {
  return `${kind}:${principalId}`;
}

export function residentRoleValue(kind: ResidentAgentKind): string {
  return ROLE_VALUES[kind];
}

/** The kind a container's `nexttime.role` label names, or `undefined` for a Worker container or
 *  anything else. */
export function residentKindOfRole(roleValue: string | undefined): ResidentAgentKind | undefined {
  for (const kind of RESIDENT_AGENT_KINDS) {
    if (ROLE_VALUES[kind] === roleValue) return kind;
  }
  return undefined;
}

export function residentExtensionMode(kind: ResidentAgentKind): string {
  return EXTENSION_MODES[kind];
}

export function residentContainerName(kind: ResidentAgentKind, principalId: string): string {
  return kind === 'entry' ? `nexttime-entry-${principalId}` : `nexttime-admin-${principalId}`;
}

/** The egress source id this kind's container is registered under (`egress-map.ts`). The kernel
 *  parses both back into `{workspaceId, principalId}` to attribute an observation
 *  (`packages/kernel/src/application/host-bridge/egress-observations.ts`). */
export function residentSourceId(
  kind: ResidentAgentKind,
  workspaceId: string,
  principalId: string,
): string {
  return kind === 'entry'
    ? entrySourceId(workspaceId, principalId)
    : adminSourceId(workspaceId, principalId);
}

/** Whether this kind's container may reach anything through egress-proxy. The admin agent may
 *  not: it reads and proposes through the kernel alone (I-A2), so its source is registered
 *  deny-all, and a container whose deny-all registration failed is never left running. */
export function residentEgressDenyAll(kind: ResidentAgentKind): boolean {
  return kind === 'admin_agent';
}
