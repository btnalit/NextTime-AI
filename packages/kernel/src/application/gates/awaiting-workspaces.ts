import type { GateAwaitingWorkspaceWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { setWorkspaceContext } from '../../adapters/db/platform-context.js';
import {
  listPublishedOperationsForGatekeepers,
  operationRecordDigestOrNull,
} from '../../governance/gatekeepers/index.js';
import {
  type GateRunningDefinitions,
  definitionRefusal,
  gateRunningDefinitions,
} from './definition-drift.js';
import {
  ENABLING_WORKSPACES_LIMIT,
  operationPlatformStatus,
  readGatekeeperPlatformPolicies,
} from './store.js';

/**
 * application/gates/awaiting-workspaces (legacy 223): which workspaces a platform gate instance
 * refuses some calls of until they align and publish — the platform administrator's view of the
 * to-dos an adopted manifest left in the workspaces (`confirm_gate_manifest` changes no workspace's
 * Operations, `platform-gates-handlers.ts`).
 *
 * A cross-plane read. `objects` has only its workspace-isolation policy (the platform plane cannot
 * read it, core 0045), so each enabling workspace is read in its own context (`setWorkspaceContext`,
 * as `computeCrossWorkspaceOverview` does), cleared again before returning. What leaves a workspace is its name (and id, as `enablingWorkspaces` already shows) and
 * the names of the Operations awaiting it: never a definition, a draft, a digest or who published
 * what. Run inside a platform transaction only (`withPlatform`, a `scope: 'platform'` capability).
 *
 * An Operation awaits its workspace on exactly the condition the workspace's own readiness reads
 * (`computeCapabilityReachability`): published there, not cut off by the connector's deny list,
 * and `definitionRefusal` says `workspace_revision` — the manifest in effect is what the gate runs,
 * the workspace's published definition is another one. Left out: `platform_adoption` (the held
 * announcement's `refusedOperations` already lists those, and no workspace step fixes them), and a
 * definition that declares a gate-owned param (no revision of it can be published, so it awaits
 * the gate's maintainer, not the workspace).
 */

export interface GateAwaitingWorkspaces {
  /** Up to `ENABLING_WORKSPACES_LIMIT`, by workspace name. */
  readonly items: readonly GateAwaitingWorkspaceWire[];
  /** How many there are uncut. */
  readonly count: number;
}

const NO_AWAITING: GateAwaitingWorkspaces = { items: [], count: 0 };

/** The placeholder principal a platform read runs a workspace's context under (it reads, writes
 *  nothing, and no row it reads is filtered on the principal). */
const PLATFORM_READER = '00000000-0000-0000-0000-000000000000';

/** `GateAwaitingWorkspaces` of each of `gateIds` (every one has an entry, empty when nothing
 *  awaits). Queries: one for the gates, one for their links, then three per enabling workspace. */
export async function readAwaitingWorkspaces(
  client: PoolClient,
  gateIds: readonly string[],
): Promise<ReadonlyMap<string, GateAwaitingWorkspaces>> {
  const awaiting = new Map<string, GateAwaitingWorkspaces>(
    gateIds.map((gateId) => [gateId, NO_AWAITING]),
  );
  if (gateIds.length === 0) return awaiting;

  const gates = await client.query<{
    gate_id: string;
    operations: unknown;
    pending_operations: unknown;
  }>(
    `select gate_id, operations, pending_operations from gate_instances
      where gate_id = any($1::text[])`,
    [[...gateIds]],
  );
  const definitionsByGate = new Map<string, GateRunningDefinitions>(
    gates.rows.map((row) => [row.gate_id, gateRunningDefinitions(row)]),
  );

  const links = await client.query<{
    gate_id: string;
    workspace_id: string;
    workspace_name: string;
    gatekeeper_object_id: string;
  }>(
    `select l.gate_id, l.workspace_id, w.name as workspace_name, l.gatekeeper_object_id
       from workspace_gate_links l
       join workspaces w on w.id = l.workspace_id
      where l.gate_id = any($1::text[])
      order by w.name, l.workspace_id, l.gate_id`,
    [[...gateIds]],
  );
  const workspaces = new Map<
    string,
    { readonly name: string; readonly gateByGatekeeper: Map<string, string> }
  >();
  for (const link of links.rows) {
    let workspace = workspaces.get(link.workspace_id);
    if (!workspace) {
      workspace = { name: link.workspace_name, gateByGatekeeper: new Map() };
      workspaces.set(link.workspace_id, workspace);
    }
    workspace.gateByGatekeeper.set(link.gatekeeper_object_id, link.gate_id);
  }

  const lists = new Map<string, GateAwaitingWorkspaceWire[]>();
  for (const [workspaceId, workspace] of workspaces) {
    await setWorkspaceContext(client, workspaceId, PLATFORM_READER);
    const published = await listPublishedOperationsForGatekeepers(client, workspaceId, [
      ...workspace.gateByGatekeeper.keys(),
    ]);
    const policies = await readGatekeeperPlatformPolicies(client, workspaceId);
    const namesByGate = new Map<string, Set<string>>();
    for (const operation of published) {
      const gateId = workspace.gateByGatekeeper.get(operation.gatekeeperId);
      const definitions = gateId === undefined ? undefined : definitionsByGate.get(gateId);
      if (gateId === undefined || definitions === undefined) continue;
      const policy = policies.get(operation.gatekeeperId);
      if (operationPlatformStatus(policy, operation.name).disabled) continue;
      const refusal = definitionRefusal(
        definitions,
        operation.name,
        operationRecordDigestOrNull(operation),
      );
      if (refusal !== 'workspace_revision') continue;
      if (definitions.runningGateOwned.has(operation.name)) continue;
      let names = namesByGate.get(gateId);
      if (!names) {
        names = new Set();
        namesByGate.set(gateId, names);
      }
      names.add(operation.name);
    }
    for (const [gateId, names] of namesByGate) {
      let list = lists.get(gateId);
      if (!list) {
        list = [];
        lists.set(gateId, list);
      }
      list.push({ id: workspaceId, name: workspace.name, operations: [...names].sort() });
    }
  }
  // Back to the platform plane for the rest of the transaction. Set with `is_local`, so a read
  // that fails above leaves nothing behind either: the transaction rolls back.
  await client.query("select set_config('app.workspace_id', '', true)");
  await client.query("select set_config('app.principal_id', '', true)");

  for (const [gateId, list] of lists) {
    awaiting.set(gateId, { items: list.slice(0, ENABLING_WORKSPACES_LIMIT), count: list.length });
  }
  return awaiting;
}
