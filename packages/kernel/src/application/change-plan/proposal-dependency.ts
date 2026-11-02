import type {
  AdminProposalPlatformInstanceChangeWire,
  GateHostedDefinitionWire,
  GateInstanceDriftField,
  PlatformSegmentDependentWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { ADVISORY_LOCK_NAMESPACES } from '../../adapters/db/advisory-lock-namespaces.js';

/**
 * application/change-plan/proposal-dependency (S11 AA3c-2, the AA3c plan F-c4; migrations/governance
 * 0035): every workspace segment of an admin proposal with a platform segment depends on it —
 * applied only while the platform segment is applied and what it created is as it created it, and
 * the platform change segment that segment's apply recorded rolled back only while none of them is
 * applied. What both sides of that share lives here: the proposal's dependency lock, the comparison
 * of an instance with what an item created (the rollback's F-c3 comparison), and the two
 * `security definer` reads 0035 gives each side.
 */

/**
 * The proposal's dependency lock (`ADVISORY_LOCK_NAMESPACES.adminProposalDependency`), held until
 * the transaction ends: `shared` for applying one of its workspace segments, `exclusive` for rolling
 * back the platform change segment of its platform segment. Taken before any row lock on either
 * path — a workspace apply then locks its segment's row, a platform rollback the rows of every
 * workspace segment of the proposal — so the two never wait on each other in a cycle; 0035's
 * triggers take it again before they check (re-entrant here).
 */
export async function lockProposalDependency(
  client: PoolClient,
  proposalId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  await client.query(
    mode === 'shared'
      ? 'select pg_advisory_xact_lock_shared($1, hashtext($2::text))'
      : 'select pg_advisory_xact_lock($1, hashtext($2::text))',
    [ADVISORY_LOCK_NAMESPACES.adminProposalDependency, proposalId],
  );
}

/** A gate instance as a `gate_instance` item created it, or as it is now. */
export interface ComparedGateInstance {
  readonly connector: string;
  /** `null` now for an instance that is not gate-hosted any more. */
  readonly definition: GateHostedDefinitionWire | null;
}

const DEFINITION_DRIFT_FIELDS = [
  'transportKind',
  'target',
  'credentialMode',
  'manifestSource',
  'preset',
] as const satisfies readonly GateInstanceDriftField[];

/** The fields `now` changed since `created` (F-c3: `GATE_INSTANCE_DRIFT_FIELD_VALUES`, in that
 *  order). Its status, display name, trust, health and Operations are not compared. */
export function gateInstanceDrift(
  created: ComparedGateInstance,
  now: ComparedGateInstance,
): GateInstanceDriftField[] {
  const drift: GateInstanceDriftField[] = [];
  if (now.connector !== created.connector) drift.push('connector');
  for (const field of DEFINITION_DRIFT_FIELDS) {
    if ((now.definition?.[field] ?? null) !== (created.definition?.[field] ?? null)) {
      drift.push(field);
    }
  }
  return drift;
}

/** What the proposal's applied platform segment recorded, as a workspace it is addressed to reads
 *  it, compared with the instances now. */
export interface ProposalPlatformChange {
  readonly changeSegmentId: string;
  /** The digest the platform administrator reviewed for it (I-A8). */
  readonly reviewedDigest: string;
  /** The instances it created that changed since, in item order; empty when none did. */
  readonly changes: readonly AdminProposalPlatformInstanceChangeWire[];
}

/**
 * `admin_proposal_platform_change(proposal_id)` (governance 0035) — for the transaction's own
 * workspace, the target of one of the proposal's workspace segments — compared with each instance
 * now (`gate_instances`, which every workspace reads). `null` when the proposal's platform segment
 * is not applied (or its record was rolled back), or it has none.
 *
 * Not locked: a workspace may read an instance but not lock it (that takes the platform's update
 * policy), and nothing changes the compared fields of an instance in place — `update_gate_instance`
 * takes a name, a status and a trust level; only deleting it (while no workspace enabled it) and
 * creating another under its gate id does, which this reads as `gone` or drifted.
 */
export async function readProposalPlatformChange(
  client: PoolClient,
  proposalId: string,
): Promise<ProposalPlatformChange | null> {
  const recorded = await client.query<{
    change_segment_id: string;
    reviewed_digest: string;
    gate_id: string;
    connector: string;
    definition: GateHostedDefinitionWire;
  }>(
    `select change_segment_id, reviewed_digest, gate_id, connector, definition
       from admin_proposal_platform_change($1)
      order by ordinal`,
    [proposalId],
  );
  const first = recorded.rows[0];
  if (first === undefined) return null;
  const changes: AdminProposalPlatformInstanceChangeWire[] = [];
  for (const item of recorded.rows) {
    const now = await client.query<{
      connector: string;
      definition: GateHostedDefinitionWire | null;
    }>('select connector, definition from gate_instances where gate_id = $1', [item.gate_id]);
    const instance = now.rows[0];
    if (instance === undefined) {
      changes.push({ gateId: item.gate_id, gone: true, drift: [] });
      continue;
    }
    const drift = gateInstanceDrift(item, instance);
    if (drift.length > 0) changes.push({ gateId: item.gate_id, gone: false, drift });
  }
  return {
    changeSegmentId: first.change_segment_id,
    reviewedDigest: first.reviewed_digest,
    changes,
  };
}

/**
 * The workspace segments of `proposalId` applied now, from what their applies recorded in each
 * workspace (`admin_proposal_applied_workspace_changes`, governance 0035: platform plane only) — a
 * change segment of source `admin_proposal` not rolled back. Those records outlive the proposal, so
 * they are found after its trial workspace is purged too. In the order they were applied.
 */
export async function appliedDependents(
  client: PoolClient,
  proposalId: string,
): Promise<PlatformSegmentDependentWire[]> {
  const result = await client.query<{ workspace_id: string; admin_proposal_segment_id: string }>(
    'select workspace_id, admin_proposal_segment_id from admin_proposal_applied_workspace_changes($1)',
    [proposalId],
  );
  return result.rows.map((row) => ({
    segmentId: row.admin_proposal_segment_id,
    targetWorkspaceId: row.workspace_id,
    status: 'applied',
  }));
}
