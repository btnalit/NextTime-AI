import type { PoolClient } from 'pg';
import type { Fact, GraphObject, GraphStore } from '../graph/index.js';
import { SqlGraphStore } from '../graph/index.js';
import type { AuditRecordRow } from './writer.js';
import { queryAudit } from './writer.js';

/**
 * substrate/audit/reconstruct: an Object's history — its current-as-of-`at` state (via
 * `GraphStore.stateAt`, substrate/graph's public service interface — no direct query against
 * `links`/`objects`, per the module contract in design doc §7.10) plus the AuditRecords that
 * touched it up to `at` (design doc §7.1 audit module "reconstruct"; §12 "reconstruct"; the
 * `reconstruct` capability, packages/shared/src/capabilities.ts `audit` group).
 *
 * The wire capability's params are `{entityId}` (no `at`) — the HTTP dispatch handler
 * (application/gateway) defaults `at` to the call time, i.e. "this object's full history up to
 * now". This function itself takes an optional `at` so it stays independently useful (e.g. a
 * future audit tool asking "what did this object look like, and what happened to it, as of last
 * Tuesday").
 */

export interface ReconstructInput {
  readonly objectId: string;
  /** Defaults to "now" (`new Date()`) when omitted. */
  readonly at?: Date;
}

export interface ReconstructResult {
  readonly object: GraphObject | null;
  /** Facts touching `objectId` that were current as of `at` (§5.5 bitemporal — see `stateAt`). */
  readonly facts: readonly Fact[];
  /** AuditRecords whose `resource_id` is `objectId`, recorded at or before `at`, newest first. */
  readonly auditRecords: readonly AuditRecordRow[];
}

/** Reconstructs an Object's state-at-`at` plus its audit trail up to `at`. */
export async function reconstruct(
  client: PoolClient,
  workspaceId: string,
  input: ReconstructInput,
  graphStore: GraphStore = new SqlGraphStore(),
): Promise<ReconstructResult> {
  const at = input.at ?? new Date();

  const state = await graphStore.stateAt(client, workspaceId, { objectId: input.objectId, at });

  // The `at` cutoff is part of the query, not a filter over its capped newest-first page (legacy
  // 291): with more than MAX_RECONSTRUCT_AUDIT_RECORDS rows newer than `at`, that page held none
  // of the rows this call is asked for.
  const auditRecords = await queryAudit(client, workspaceId, {
    resourceId: input.objectId,
    createdAtOrBefore: at,
    limit: MAX_RECONSTRUCT_AUDIT_RECORDS,
  });

  return { object: state.object, facts: state.facts, auditRecords };
}

/** Upper bound on AuditRecords scanned per `reconstruct` call (mirrors `MAX_AUDIT_QUERY_LIMIT`). */
const MAX_RECONSTRUCT_AUDIT_RECORDS = 1000;
