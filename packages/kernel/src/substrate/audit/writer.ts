import type { PoolClient } from 'pg';

/**
 * substrate/audit/writer: append-only writes to and filtered reads of `audit_records`
 * (migrations/core/0004_audit.sql; design doc §5.1.4 AuditRecord, §5.4 I11, §7.1 audit module,
 * §12; docs/development-tasks.md S1.3).
 *
 * `writeAudit` never opens its own transaction — the caller (application/gateway/dispatch.ts)
 * always passes a `client` already inside the same `withWorkspace()` transaction as the write it
 * is auditing, so a failure here (e.g. a `resource_id` that doesn't exist, or any other
 * constraint violation) rolls back that write too (I11: "所有受治理转移写 AuditRecord", enforced
 * here by sharing one transaction rather than by a separate mechanism).
 */

export interface AuditRecordInput {
  readonly workspaceId: string;
  /** FK to `principals` — the acting Principal (I13: for a Handle call, its `on_behalf_of`). */
  readonly actorPrincipalId: string;
  /** The governed action name — the capability name for capability-dispatch audit rows. */
  readonly action: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  /** Arbitrary JSON context (e.g. channel, on_behalf_of, session id, call params). Never a credential. */
  readonly payload?: Record<string, unknown>;
}

export interface AuditRecordRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

interface AuditRecordDbRow {
  workspace_id: string;
  id: string;
  actor_principal_id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapAuditRecordRow(row: AuditRecordDbRow): AuditRecordRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    actorPrincipalId: row.actor_principal_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

/** Appends one AuditRecord. Throws (and, per the caller's transaction, rolls it back) on failure. */
export async function writeAudit(
  client: PoolClient,
  record: AuditRecordInput,
): Promise<AuditRecordRow> {
  const result = await client.query<AuditRecordDbRow>(
    `insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload, created_at`,
    [
      record.workspaceId,
      record.actorPrincipalId,
      record.action,
      record.resourceType ?? null,
      record.resourceId ?? null,
      JSON.stringify(record.payload ?? {}),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('writeAudit: INSERT ... RETURNING produced no row');
  return mapAuditRecordRow(row);
}

/** Filters accepted by {@link queryAudit} — the `audit_query` capability's `filter` param (§9.3). */
export interface AuditQueryFilter {
  readonly actorPrincipalId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  /** Defaults to {@link DEFAULT_AUDIT_QUERY_LIMIT}; capped at {@link MAX_AUDIT_QUERY_LIMIT}. */
  readonly limit?: number;
}

export const DEFAULT_AUDIT_QUERY_LIMIT = 100;
export const MAX_AUDIT_QUERY_LIMIT = 1000;

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
    return DEFAULT_AUDIT_QUERY_LIMIT;
  return Math.min(Math.floor(limit), MAX_AUDIT_QUERY_LIMIT);
}

/** Reads AuditRecords newest-first, narrowed by whichever `filter` fields are given. */
export async function queryAudit(
  client: PoolClient,
  workspaceId: string,
  filter: AuditQueryFilter = {},
): Promise<readonly AuditRecordRow[]> {
  const result = await client.query<AuditRecordDbRow>(
    `select workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload, created_at
     from audit_records
     where workspace_id = $1
       and ($2::uuid is null or actor_principal_id = $2)
       and ($3::text is null or action = $3)
       and ($4::text is null or resource_type = $4)
       and ($5::uuid is null or resource_id = $5)
     order by created_at desc
     limit $6`,
    [
      workspaceId,
      filter.actorPrincipalId ?? null,
      filter.action ?? null,
      filter.resourceType ?? null,
      filter.resourceId ?? null,
      resolveLimit(filter.limit),
    ],
  );
  return result.rows.map(mapAuditRecordRow);
}
