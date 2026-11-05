import type { PoolClient } from 'pg';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import type {
  ChangeGateRef,
  ChangeSource,
  CheckSourceRequirements,
  RequirementCheck,
  RequirementGateCheck,
} from '../change-plan/index.js';
import { type GatekeeperPlatformPolicy, readGatekeeperPlatformPolicies } from '../gates/index.js';
import {
  type PackRegistryOptions,
  loadPackRegistry,
  readPackDependencies,
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
 * gate whether it is up, never runs an Operation. And (S11 P1-F) its version's `requires.packs`,
 * each with how the workspace has that pack now (`readPackDependencies`).
 *
 * The source version counts as found only when this deployment ships it with the same content
 * (name, version and digest): what it needs is then known.
 *
 * An admin proposal's segment (S11 AA3b-2) is its own source, so it is always found, and builds on
 * no pack. It names no systems either: what it needs is the gates what it wrote runs through
 * (legacy 630, AA5 plan F5(a) — `verify.ts`' `gatesWrittenThrough`: each Operation item's gate,
 * the gates each Worker item's version names), so its requirements are those gates, one per
 * system they belong to (`gateRequirements`), each probed the same way. The verification then
 * needs every one of them to answer (`verify.ts`).
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

/** Whether a workspace Gatekeeper can be acted through now, by the platform's cut-offs — the rule
 *  `readPackRequirements` connects a system by: a catalog gate whose instance is enabled, a
 *  self-connected one not suspended. One with neither record (registered directly, never by a
 *  deployment's own paths) has no cut-off. */
function gateUsable(policy: GatekeeperPlatformPolicy | undefined): boolean {
  if (policy === undefined) return true;
  return policy.origin === 'catalog' ? policy.instanceStatus === 'enabled' : !policy.suspended;
}

/** An admin proposal segment's requirements (see this module's comment): the gates it runs
 *  through, grouped by the system each belongs to (a gate with no platform record goes by its own
 *  name), in system order. A system is `connected` while every one of its listed gates can be acted
 *  through, each probed; one cut off by the platform (its instance disabled, its connection
 *  suspended) or no longer there makes the system `needs_platform` — only a platform
 *  administrator brings it back — and is not probed, so the requirement is not met. */
async function gateRequirements(
  client: PoolClient,
  workspaceId: string,
  segmentGates: readonly ChangeGateRef[],
): Promise<RequirementCheck[]> {
  if (segmentGates.length === 0) return [];
  const policies = await readGatekeeperPlatformPolicies(client, workspaceId);
  const systems = new Map<string, { usable: string[]; cutOff: boolean }>();
  for (const gate of segmentGates) {
    const gatekeeper = await getGatekeeper(client, workspaceId, gate.id);
    const policy = policies.get(gate.id);
    const connector = policy?.connector ?? gatekeeper?.name ?? gate.name;
    const system = systems.get(connector) ?? { usable: [], cutOff: false };
    systems.set(connector, system);
    if (gatekeeper !== null && gateUsable(policy)) system.usable.push(gate.id);
    else system.cutOff = true;
  }
  const requirements: RequirementCheck[] = [];
  for (const connector of [...systems.keys()].sort()) {
    const system = systems.get(connector);
    if (!system) continue;
    requirements.push({
      connector,
      state: system.cutOff ? 'needs_platform' : 'connected',
      gates: await probeGates(client, workspaceId, system.usable),
    });
  }
  return requirements;
}

/** `CheckSourceRequirements` for a segment of `workspaceId` (see this module's comment).
 *  `registry` says where the packs are, for tests; the deployment's own by default. */
export function sourceRequirementsChecker(
  client: PoolClient,
  workspaceId: string,
  registry: PackRegistryOptions = {},
): CheckSourceRequirements {
  return async (source: ChangeSource, segmentGates: readonly ChangeGateRef[]) => {
    // S11 AA3b-2: an admin proposal's segment is its own source (the record keeps its digest), so
    // it is found; it builds on no pack, and needs the gates what it wrote runs through (legacy 630).
    if (source.kind === 'admin_proposal') {
      return {
        sourceFound: true,
        requirements: await gateRequirements(client, workspaceId, segmentGates),
        dependencies: [],
      };
    }
    const packs = await loadPackRegistry(registry);
    const version = packs
      .get(source.name)
      ?.versions.find(
        (candidate) =>
          String(candidate.version) === source.version && candidate.digest === source.digest,
      );
    if (!version) return { sourceFound: false, requirements: [], dependencies: [] };
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
    const dependencies = (
      await readPackDependencies(client, workspaceId, packs, version.requiredPacks)
    ).map(({ name, minVersion, status, installedVersion }) => ({
      name,
      minVersion,
      status,
      installedVersion,
    }));
    return { sourceFound: true, requirements, dependencies };
  };
}
