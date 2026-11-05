import type { PackRequirementState } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import { listAvailableGateInstances, readGatekeeperPlatformPolicies } from './store.js';

/**
 * application/gates/connector-standing: where a system — a connector, by name — stands in a
 * workspace, read from the gate catalog as the gates' own reads see it (`readGatekeeperPlatform
 * Policies`, `listAvailableGateInstances`); nothing is called and nothing is written. The one rule
 * for "the workspace's gates of that system" that a pack's requirements (`application/packs/
 * requirements.ts`, S11 P1-E) and a proposed Worker's systems (`application/change-plan/admin-
 * proposal-segments.ts`, S11 AA5f) share. `@nexttime/shared` `PACK_REQUIREMENT_STATE_VALUES` has
 * the states; the first that holds is the answer:
 *
 *   connected      — a Gatekeeper of the workspace runs on the connector and the platform has not
 *                    cut it off: a catalog instance it is linked to is `enabled`, or its own
 *                    connection is not suspended (`gatekeepers` lists them — the gates a Worker of
 *                    that system may be bound to);
 *   can_enable     — the platform offers an `enabled` instance of it the workspace has not linked
 *                    (`offered` lists them, for the owner to enable where they are);
 *   needs_platform — neither (no such connector, it is not offered to workspaces, or every instance
 *                    is off).
 *
 * Health is not read here: a list makes no outbound call. Verifying a change segment probes the
 * `connected` Gatekeepers' health (`application/gateway/change-verification.ts`).
 */

/** A Gatekeeper of the workspace, by id and the name people know it by. */
export interface ConnectorGate {
  readonly id: string;
  readonly name: string;
}

/** A platform gate instance the workspace may enable (`enable_gate_instance`). */
export interface ConnectorOffer {
  readonly gateId: string;
  readonly displayName: string;
}

export interface ConnectorStanding {
  readonly connector: string;
  readonly state: PackRequirementState;
  /** The workspace's Gatekeepers on it, for `connected` (in id order); empty otherwise. */
  readonly gatekeepers: readonly ConnectorGate[];
  /** The instances the platform offers, for `can_enable` (in the catalog's order); empty
   *  otherwise. */
  readonly offered: readonly ConnectorOffer[];
}

/** The standing of each of `connectors` in `workspaceId`, in their order. Not locked. */
export async function readConnectorStandings(
  client: PoolClient,
  workspaceId: string,
  connectors: readonly string[],
): Promise<readonly ConnectorStanding[]> {
  if (connectors.length === 0) return [];
  const policies = await readGatekeeperPlatformPolicies(client, workspaceId);
  const available = await listAvailableGateInstances(client, workspaceId);
  const standings: ConnectorStanding[] = [];
  for (const connector of connectors) {
    const gatekeeperIds = [...policies]
      .filter(([, policy]) =>
        policy.connector !== connector
          ? false
          : policy.origin === 'catalog'
            ? policy.instanceStatus === 'enabled'
            : !policy.suspended,
      )
      .map(([gatekeeperId]) => gatekeeperId)
      .sort();
    if (gatekeeperIds.length > 0) {
      const gatekeepers: ConnectorGate[] = [];
      for (const id of gatekeeperIds) {
        const gatekeeper = await getGatekeeper(client, workspaceId, id);
        gatekeepers.push({ id, name: gatekeeper?.name ?? id });
      }
      standings.push({ connector, state: 'connected', gatekeepers, offered: [] });
      continue;
    }
    const offered = available
      .filter(
        (instance) =>
          instance.connector === connector &&
          instance.status === 'enabled' &&
          instance.gatekeeperId === null,
      )
      .map((instance) => ({ gateId: instance.gateId, displayName: instance.displayName }));
    standings.push({
      connector,
      state: offered.length > 0 ? 'can_enable' : 'needs_platform',
      gatekeepers: [],
      offered,
    });
  }
  return standings;
}
