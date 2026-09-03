import type { PoolClient } from 'pg';

/**
 * substrate/epistemic/sources: writes to the `sources`/`observations` tables (migrations/core/
 * 0002_substrate.sql), first used by S2.9's session-JSONL-as-Source path (design doc §7.3 "会话
 * JSONL 回流为私有 Source"). `sources.uri` is a pointer, not inline content — the kernel never
 * reads a Worker's session file itself (no kernel process needs filesystem access into a Worker's
 * workspace mount). Registering a Source alone leaves it unreachable from `explain` (which walks
 * an Activity's `observations`, not `sources` directly) — `recordSourceObservation` below writes
 * the one-row link a caller needs for `explain(activityId).observations[].source` to surface it,
 * same as `attachEvidence` in this package leaves Activity-level attachment to its own caller.
 */

export interface RegisterPrivateSourceInput {
  readonly kind: string;
  readonly ownerPrincipalId: string;
  readonly uri?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SourceRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly kind: string;
  readonly ownerPrincipalId: string;
  readonly visibility: 'private' | 'workspace';
  readonly uri: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

interface SourceDbRow {
  workspace_id: string;
  id: string;
  kind: string;
  owner_principal_id: string;
  visibility: 'private' | 'workspace';
  uri: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapSourceRow(row: SourceDbRow): SourceRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    kind: row.kind,
    ownerPrincipalId: row.owner_principal_id,
    visibility: row.visibility,
    uri: row.uri,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/** Registers a `visibility='private'` Source owned by `input.ownerPrincipalId` (§5.6:会话派生内容
 *  默认 private given the on_behalf_of user — always private here, never `workspace`; promoting
 *  visibility is a separate, human-channel-governed transition this function does not perform). */
export async function registerPrivateSource(
  client: PoolClient,
  workspaceId: string,
  input: RegisterPrivateSourceInput,
): Promise<SourceRow> {
  const result = await client.query<SourceDbRow>(
    `insert into sources (workspace_id, kind, owner_principal_id, visibility, uri, metadata)
     values ($1, $2, $3, 'private', $4, $5::jsonb)
     returning workspace_id, id, kind, owner_principal_id, visibility, uri, metadata, created_at`,
    [
      workspaceId,
      input.kind,
      input.ownerPrincipalId,
      input.uri ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('registerPrivateSource: INSERT ... RETURNING produced no row');
  }
  return mapSourceRow(row);
}

/** Links a Source to the Activity that used it (`observations.activity_id`) — the row `explain`
 *  already walks (`substrate/epistemic/explain.ts`'s `fetchObservationRefs`). `content` carries no
 *  PROV-O payload of its own here (S2.9's use is purely "this Activity used this Source"); left
 *  as an empty object rather than `null` to match the column's `not null default '{}'` shape. */
export async function recordSourceObservation(
  client: PoolClient,
  workspaceId: string,
  input: { readonly sourceId: string; readonly activityId: string },
): Promise<{ readonly id: string }> {
  const result = await client.query<{ id: string }>(
    `insert into observations (workspace_id, source_id, activity_id, content)
     values ($1, $2, $3, '{}'::jsonb)
     returning id`,
    [workspaceId, input.sourceId, input.activityId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('recordSourceObservation: INSERT ... RETURNING produced no row');
  }
  return row;
}
