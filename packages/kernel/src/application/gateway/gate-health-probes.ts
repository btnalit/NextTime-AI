import type { PoolClient } from 'pg';
import { getGatekeeper } from '../../governance/gatekeepers/index.js';
import type { GateHealth } from '../gates/index.js';
import {
  readCatalogGateHealths,
  readGatekeeperPlatformPolicies,
  selfConnectionSuspended,
} from '../gates/index.js';
import { type ResolvedGateTarget, resolveGateTarget } from './gate-target.js';
import { probeGatekeeperHealth } from './gatekeeper-read-handlers.js';

/**
 * application/gateway/gate-health-probes: how a list of the workspace's gates stands right now,
 * for a read that was asked for it — `get_agent_profile` with `includeGateHealth` (legacy 200, My
 * Agent's system list) and `execution_readiness` with `includeGateHealth` (legacy 253, the
 * readiness strip and the system cards). One place, so both reads give the same gate the same
 * value. Two sources:
 *
 *   - a gate the workspace enabled from the platform catalog: its instance's stored health
 *     (`readCatalogGateHealths`, kept by the gate's own announcements) — `stored`, no call to the
 *     gate;
 *   - any other: the gate's own `/gate/health`, probed as `get_gatekeeper` probes it, through the
 *     credential every call to that gate uses (`resolveGateTarget`) — `probes`, run by
 *     `probeGateHealths` after the transaction (review of #1389: a probe can wait 3 s, and must
 *     not hold a pooled connection and an open transaction meanwhile).
 *
 * The caller decides which gates to ask about. A gate the platform suspended (legacy 675) gets
 * neither, whoever asks: the kernel does not contact it on the workspace's behalf while every call
 * to it is refused, and an old stored or probed "ok" next to the suspension would say it works
 * (legacy 872, review of #1510). `get_gatekeeper` leaves it unprobed the same way.
 */

/** The gates `planGateHealths` found to probe, each with the target and credential every call to
 *  it uses — probed by `probeGateHealths` once the read's transaction has ended. */
export type GateHealthProbes = readonly {
  readonly gatekeeperId: string;
  readonly target: ResolvedGateTarget;
}[];

/** Only reads the database; the gates are not called here. `stored` names only gates of
 *  `gatekeeperIds`; a listed id that is no registered Gatekeeper, or whose connection the platform
 *  suspended, gets neither. */
export async function planGateHealths(
  client: PoolClient,
  workspaceId: string,
  gatekeeperIds: readonly string[],
): Promise<{
  readonly stored: ReadonlyMap<string, GateHealth>;
  readonly probes: GateHealthProbes;
}> {
  const catalog = await readCatalogGateHealths(client, workspaceId);
  const policies = await readGatekeeperPlatformPolicies(client, workspaceId);
  const stored = new Map<string, GateHealth>();
  const probes: { readonly gatekeeperId: string; readonly target: ResolvedGateTarget }[] = [];
  for (const gatekeeperId of gatekeeperIds) {
    if (selfConnectionSuspended(policies.get(gatekeeperId))) continue;
    const health = catalog.get(gatekeeperId);
    if (health !== undefined) {
      stored.set(gatekeeperId, health);
      continue;
    }
    const gatekeeper = await getGatekeeper(client, workspaceId, gatekeeperId);
    if (!gatekeeper) continue;
    probes.push({ gatekeeperId, target: await resolveGateTarget(client, workspaceId, gatekeeper) });
  }
  return { stored, probes };
}

/** `planGateHealths`' probes, all at once (`probeGatekeeperHealth`: 3 s timeout, never throws), so
 *  a read waits at most as long as its slowest gate. A probe asks whether the gate is up and never
 *  runs an Operation. */
export async function probeGateHealths(
  probes: GateHealthProbes,
): Promise<ReadonlyMap<string, GateHealth>> {
  const probed = await Promise.all(
    probes.map(
      async ({ gatekeeperId, target }) =>
        [gatekeeperId, await probeGatekeeperHealth(target)] as const,
    ),
  );
  return new Map<string, GateHealth>(probed);
}
