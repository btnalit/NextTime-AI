import type { PackRequirementState } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import {
  listAvailableGateInstances,
  readConnectorOccupancy,
  readGatekeeperPlatformPolicies,
} from '../gates/index.js';

/**
 * application/packs/requirements: where each system a pack version needs (`requires.connectors`,
 * `manifest.ts`) stands in a workspace (S11 P1-E; S10 plan §3.3 I-P3 — a gate is a code component
 * the platform deploys, so a pack only checks it is in place). Read from the gate catalog as the
 * gates' own reads see it (`readGatekeeperPlatformPolicies`, `listAvailableGateInstances`); nothing
 * is called and nothing is written. `@nexttime/shared` `PACK_REQUIREMENT_STATE_VALUES` has the
 * states; the first that holds is the answer:
 *
 *   connected      — a Gatekeeper of the workspace runs on the connector and the platform has not
 *                    cut it off: a catalog instance it is linked to is `enabled`, or its own
 *                    connection is not suspended (`gatekeepers` lists them — the gates a pack's
 *                    Worker of that system may be bound to, `install.ts`);
 *   can_enable     — the platform offers an `enabled` instance of it the workspace has not linked
 *                    (`offered` lists them, for the owner to enable from the pack, P1-E2);
 *   needs_platform — neither (no such connector, it is not offered to workspaces, or every instance
 *                    is off). A workspace connects only the generic transports itself
 *                    (`create_connection`), and a pack never requires one, so a pack's system is
 *                    never one the owner could connect on their own.
 *
 * Health is not read here: a list of packs makes no outbound call. Verifying a segment probes the
 * `connected` Gatekeepers' health (`application/gateway/change-verification.ts`).
 *
 * `platformPreset` (S11 P1-F): for a `needs_platform` system, the platform ships a connector preset
 * of its name (`application/gates/presets.ts`) and no packaged gate holds its connector — a platform
 * administrator can connect it from that preset by typing its address and key.
 */

/** A Gatekeeper of the workspace, by id and the name people know it by. */
export interface PackRequirementGate {
  readonly id: string;
  readonly name: string;
}

/** A platform gate instance the workspace may enable (`enable_gate_instance`). */
export interface PackRequirementOffer {
  readonly gateId: string;
  readonly displayName: string;
}

export interface PackRequirementStatus {
  readonly connector: string;
  readonly state: PackRequirementState;
  /** The workspace's Gatekeepers on it, for `connected` (in id order); empty otherwise. */
  readonly gatekeepers: readonly PackRequirementGate[];
  /** The instances the platform offers, for `can_enable` (in the catalog's order); empty
   *  otherwise. */
  readonly offered: readonly PackRequirementOffer[];
  /** For `needs_platform`: a platform administrator can connect it from a preset (see above);
   *  `false` otherwise. */
  readonly platformPreset: boolean;
}

/** The state of each of `connectors` in `workspaceId`, in their order. `presets` names the
 *  connector presets this deployment ships (`loadConnectorPresets`); left out, none is assumed and
 *  `platformPreset` is `false` throughout — the readers that only need the state (installing,
 *  verifying) skip reading them. */
export async function readPackRequirements(
  client: PoolClient,
  workspaceId: string,
  connectors: readonly string[],
  presets: ReadonlySet<string> = new Set(),
): Promise<readonly PackRequirementStatus[]> {
  if (connectors.length === 0) return [];
  const policies = await readGatekeeperPlatformPolicies(client, workspaceId);
  const available = await listAvailableGateInstances(client, workspaceId);
  const occupancy = await readConnectorOccupancy(
    client,
    connectors.filter((connector) => presets.has(connector)),
  );
  const statuses: PackRequirementStatus[] = [];
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
      const gatekeepers: PackRequirementGate[] = [];
      for (const id of gatekeeperIds) {
        const gatekeeper = await getGatekeeper(client, workspaceId, id);
        gatekeepers.push({ id, name: gatekeeper?.name ?? id });
      }
      statuses.push({
        connector,
        state: 'connected',
        gatekeepers,
        offered: [],
        platformPreset: false,
      });
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
    const state = offered.length > 0 ? 'can_enable' : 'needs_platform';
    statuses.push({
      connector,
      state,
      gatekeepers: [],
      offered,
      platformPreset:
        state === 'needs_platform' &&
        presets.has(connector) &&
        occupancy.get(connector)?.packaged !== true,
    });
  }
  return statuses;
}
