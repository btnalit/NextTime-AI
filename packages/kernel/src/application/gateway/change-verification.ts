import type { PoolClient } from 'pg';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import type {
  ChangeSource,
  CheckSourceRequirements,
  RequirementCheck,
  RequirementGateCheck,
} from '../change-plan/index.js';
import {
  type PackRegistryOptions,
  loadPackRegistry,
  readPackRequirements,
} from '../packs/index.js';
import { resolveGateTarget } from './gate-target.js';
import { probeGatekeeperHealth } from './gatekeeper-read-handlers.js';

/**
 * application/gateway/change-verification: what a segment's verification needs from outside the
 * ChangePlan core (S11 P1-E, `application/change-plan/verify.ts`) — the systems its source needs
 * and how each stands now. For a pack: its version's `requires.connectors`
 * (`application/packs`), where each stands in the workspace (`readPackRequirements`), and the live
 * health of each `connected` Gatekeeper, probed exactly as `get_gatekeeper` probes it — the gate's
 * own `/gate/health`, through `resolveGateTarget` and the short-timeout client of
 * `gatekeeper-read-handlers.ts`. No new call path to a gate, no new credential: the probe asks a
 * gate whether it is up, never runs an Operation.
 *
 * The source version counts as found only when this deployment ships it with the same content
 * (name, version and digest): what it needs is then known.
 */

async function probeGates(
  client: PoolClient,
  workspaceId: string,
  gatekeeperIds: readonly string[],
): Promise<RequirementGateCheck[]> {
  const targets = [];
  for (const id of gatekeeperIds) {
    const gatekeeper = await getGatekeeper(client, workspaceId, id);
    if (!gatekeeper) continue;
    targets.push({
      id,
      name: gatekeeper.name,
      target: await resolveGateTarget(client, workspaceId, gatekeeper),
    });
  }
  // Each probe has its own short timeout and never throws; in parallel, so a run takes as long as
  // its slowest gate.
  return Promise.all(
    targets.map(async ({ id, name, target }) => ({
      id,
      name,
      health: await probeGatekeeperHealth(target),
    })),
  );
}

/** `CheckSourceRequirements` for a segment of `workspaceId` (see this module's comment).
 *  `registry` says where the packs are, for tests; the deployment's own by default. */
export function sourceRequirementsChecker(
  client: PoolClient,
  workspaceId: string,
  registry: PackRegistryOptions = {},
): CheckSourceRequirements {
  return async (source: ChangeSource) => {
    const packs = await loadPackRegistry(registry);
    const version = packs
      .get(source.name)
      ?.versions.find(
        (candidate) =>
          String(candidate.version) === source.version && candidate.digest === source.digest,
      );
    if (!version) return { sourceFound: false, requirements: [] };
    const statuses = await readPackRequirements(client, workspaceId, version.requiredConnectors);
    const requirements: RequirementCheck[] = [];
    for (const status of statuses) {
      requirements.push({
        connector: status.connector,
        state: status.state,
        gates: await probeGates(
          client,
          workspaceId,
          status.gatekeepers.map((gate) => gate.id),
        ),
      });
    }
    return { sourceFound: true, requirements };
  };
}
