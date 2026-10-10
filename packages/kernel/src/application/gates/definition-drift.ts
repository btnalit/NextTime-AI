import { operationDefinitionDigest } from '@nexttime/gatekeeper-base';
import { type DefinitionAwaiting, OperationSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * application/gates/definition-drift (legacy K, UX acceptance of #538): which Operations a platform
 * gate refuses right now because it runs another definition than the one approved, and whose step
 * it is to fix that. The one derivation every surface reads — the platform's held-manifest notice,
 * the overview's attention list, the workspace's reachability and readiness, and the align
 * preview — so none of them guesses on its own.
 *
 * What the gate runs is what it last announced: the held announcement (`pending_operations`,
 * R-18) when the platform has not adopted it yet, else the manifest in effect (`operations`). Any
 * change to a field the digest covers is a reviewed change, so it is always held first. The gate
 * checks every call's approved digest against its own (`@nexttime/gatekeeper-base`
 * `operation-digest.ts`), which is exactly the comparison below.
 *
 *   - `platform_adoption`: the gate runs a held announcement that defines the Operation
 *     differently from the manifest in effect. Nothing a workspace does fixes it: aligning reads
 *     the manifest in effect, which still holds the old definition. A platform admin adopts first.
 *   - `workspace_revision`: the manifest in effect is what the gate runs, but the workspace's
 *     published definition is another one (or does not parse). The workspace aligns, which opens a
 *     revision draft, and publishes it.
 *
 * Only platform gates (a `workspace_gate_links` row) are covered: for a gate the workspace
 * connected itself the kernel has no record of what it runs.
 */

export type { DefinitionAwaiting };

export interface GateRunningDefinitions {
  /** Operation name → digest of the definition the gate runs now. */
  readonly running: ReadonlyMap<string, string>;
  /** Operation name → digest in the manifest in effect (adopted). */
  readonly adopted: ReadonlyMap<string, string>;
  /** Whether a held announcement exists (`pending_operations` is set). */
  readonly pending: boolean;
}

/** Name → digest of each Operation in a stored manifest. An entry that does not parse is left
 *  out, as `store.ts`'s `operationsOf` leaves it out of everything else. */
function digestsOf(stored: unknown): Map<string, string> {
  const digests = new Map<string, string>();
  if (!Array.isArray(stored)) return digests;
  for (const entry of stored) {
    const parsed = OperationSchema.safeParse(entry);
    if (!parsed.success) continue;
    try {
      digests.set(parsed.data.name, operationDefinitionDigest(parsed.data));
    } catch {
      // Parsed as an Operation, so its definition parses too; kept defensive all the same.
    }
  }
  return digests;
}

export function gateRunningDefinitions(row: {
  readonly operations: unknown;
  readonly pending_operations: unknown;
}): GateRunningDefinitions {
  const adopted = digestsOf(row.operations);
  const pending = row.pending_operations !== null && row.pending_operations !== undefined;
  return { running: pending ? digestsOf(row.pending_operations) : adopted, adopted, pending };
}

/**
 * Whether the gate refuses a call to `operationName` made under `approvedDigest`, and whose step
 * it is: `null` when the gate runs that definition. `approvedDigest` `null`: the workspace's copy
 * does not parse, so the kernel refuses the call itself until a corrected revision is published.
 * An Operation the gate does not announce at all is not a definition mismatch (the gate answers
 * `operation_not_found`), except while a held announcement drops one the manifest in effect still
 * has: then adopting it is the next step either way.
 */
export function definitionRefusal(
  defs: GateRunningDefinitions,
  operationName: string,
  approvedDigest: string | null,
): DefinitionAwaiting | null {
  const running = defs.running.get(operationName);
  if (running === undefined) {
    return defs.pending && defs.adopted.has(operationName) ? 'platform_adoption' : null;
  }
  if (approvedDigest !== null && approvedDigest === running) return null;
  if (defs.pending && defs.adopted.get(operationName) !== running) return 'platform_adoption';
  return 'workspace_revision';
}

/** The platform's side: Operations of the manifest in effect the gate refuses until the held
 *  announcement is adopted (and each enabling workspace then publishes a revision). Sorted. */
export function operationsRefusedUntilAdopted(defs: GateRunningDefinitions): string[] {
  return [...defs.adopted]
    .filter(([name, digest]) => definitionRefusal(defs, name, digest) === 'platform_adoption')
    .map(([name]) => name)
    .sort();
}

/** `gateRunningDefinitions` for every platform gate this workspace linked, keyed by the
 *  workspace's own Gatekeeper Object id — one query, for a caller checking the whole workspace
 *  (`computeCapabilityReachability`). A self-connected gate has no entry. */
export async function readGateDefinitionsForWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<ReadonlyMap<string, GateRunningDefinitions>> {
  const result = await client.query<{
    gatekeeper_object_id: string;
    operations: unknown;
    pending_operations: unknown;
  }>(
    `select l.gatekeeper_object_id, g.operations, g.pending_operations
       from workspace_gate_links l
       join gate_instances g on g.gate_id = l.gate_id
      where l.workspace_id = $1`,
    [workspaceId],
  );
  const byGatekeeperId = new Map<string, GateRunningDefinitions>();
  for (const row of result.rows) {
    byGatekeeperId.set(row.gatekeeper_object_id, gateRunningDefinitions(row));
  }
  return byGatekeeperId;
}

/** `gateRunningDefinitions` of one platform gate instance, with when its held announcement came
 *  in — `null` for an unknown `gateId`. */
export async function readGateDefinitions(
  client: PoolClient,
  gateId: string,
): Promise<(GateRunningDefinitions & { readonly pendingAnnouncedAt: Date | null }) | null> {
  const result = await client.query<{
    operations: unknown;
    pending_operations: unknown;
    pending_announced_at: Date | null;
    updated_at: Date;
  }>(
    `select operations, pending_operations, pending_announced_at, updated_at
       from gate_instances where gate_id = $1`,
    [gateId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const defs = gateRunningDefinitions(row);
  return {
    ...defs,
    pendingAnnouncedAt: defs.pending ? (row.pending_announced_at ?? row.updated_at) : null,
  };
}
