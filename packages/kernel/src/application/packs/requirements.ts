import type { PackRequirementState } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  listAvailableGateInstances,
  readConnectorMode,
  readGatekeeperPlatformPolicies,
} from '../gates/index.js';

/**
 * application/packs/requirements: where each system a pack version needs (`requires.connectors`,
 * `manifest.ts`) stands in a workspace (S11 P1-E; S10 plan §3.3 I-P3 — a gate is a code component
 * the platform deploys, so a pack only checks it is in place). Read from the gate catalog as the
 * gates' own reads see it (`readGatekeeperPlatformPolicies`, `listAvailableGateInstances`); nothing
 * is called and nothing is written. `@nexttime/shared` `PACK_REQUIREMENT_STATE_VALUES` has the four
 * states; the first that holds is the answer:
 *
 *   connected      — a Gatekeeper of the workspace runs on the connector and the platform has not
 *                    cut it off: a catalog instance it is linked to is `enabled`, or its own
 *                    connection is not suspended (`gatekeeperIds` lists them);
 *   can_enable     — the platform offers an `enabled` instance of it the workspace has not linked;
 *   can_connect    — the connector is `self_serve`: the owner connects it themselves;
 *   needs_platform — none of these (no such connector, it is `disabled`, or every instance is off).
 *
 * Health is not read here: a list of packs makes no outbound call. Verifying a segment probes the
 * `connected` Gatekeepers' health (`application/gateway/change-verification.ts`).
 */

export interface PackRequirementStatus {
  readonly connector: string;
  readonly state: PackRequirementState;
  /** The workspace's Gatekeepers on it, for `connected` (in id order); empty otherwise. */
  readonly gatekeeperIds: readonly string[];
}

/** The state of each of `connectors` in `workspaceId`, in their order. */
export async function readPackRequirements(
  client: PoolClient,
  workspaceId: string,
  connectors: readonly string[],
): Promise<readonly PackRequirementStatus[]> {
  if (connectors.length === 0) return [];
  const policies = await readGatekeeperPlatformPolicies(client, workspaceId);
  const available = await listAvailableGateInstances(client, workspaceId);
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
      statuses.push({ connector, state: 'connected', gatekeeperIds });
      continue;
    }
    const offered = available.some(
      (instance) =>
        instance.connector === connector &&
        instance.status === 'enabled' &&
        instance.gatekeeperId === null,
    );
    const state: PackRequirementState = offered
      ? 'can_enable'
      : (await readConnectorMode(client, connector)) === 'self_serve'
        ? 'can_connect'
        : 'needs_platform';
    statuses.push({ connector, state, gatekeeperIds: [] });
  }
  return statuses;
}
