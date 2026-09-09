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

/**
 * `queryAuditActionOperationStats` (S3.8, `get_operation_stats`'s observe-class attribution gap —
 * packages/shared/src/capabilities.ts's own `get_operation_stats` doc comment: "`substrate/audit`'s
 * own `queryAudit` service interface ... has no date-range filter and no payload-path grouping, so
 * an efficient per-operation, `days`-windowed observe count is not achievable through it ... out of
 * scope"). This is that extension — a date-range, grouped read scoped to a caller-chosen set of
 * `action` values (the capability name `dispatch.ts` audits under, e.g. `observe_operation`), with
 * `gatekeeperId`/`operationName` pulled out of `payload.params` (the parsed capability params
 * `dispatch.ts` always writes verbatim there unless redacted — see that module's own doc comment;
 * `observe_operation`'s `paramsSchema` is `{gatekeeperId, operation, params}`, has no
 * `redactedParamKeys`, so both fields are always present verbatim for a real call).
 *
 * Kept generic (grouped by `action` too, not hardcoded to one capability name) rather than a
 * single-purpose "observe operation stats" query — `governance/approval/reads.ts`'s
 * `getOperationStats` is the first caller, filtering to `['observe_operation']`, but nothing here
 * assumes that.
 */
export interface AuditActionOperationStatsFilter {
  /** `audit_records.action` values to include (an exact-match `= any(...)`, not a pattern). */
  readonly actions: readonly string[];
  /** Trailing window size in days from now — clamped to [1, `MAX_AUDIT_ACTION_STATS_DAYS`], same
   *  defense-in-depth convention {@link resolveLimit} already applies to `queryAudit`'s `limit`. */
  readonly sinceDays: number;
  readonly gatekeeperId?: string;
}

export interface AuditActionOperationStatsRow {
  readonly action: string;
  readonly gatekeeperId: string;
  readonly operationName: string;
  readonly calls: number;
  readonly lastCalledAt: Date;
}

interface AuditActionOperationStatsDbRow {
  action: string;
  gatekeeper_id: string;
  operation_name: string;
  calls: string;
  last_called_at: Date;
}

export const DEFAULT_AUDIT_ACTION_STATS_DAYS = 30;
export const MAX_AUDIT_ACTION_STATS_DAYS = 90;

function resolveSinceDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_AUDIT_ACTION_STATS_DAYS;
  return Math.min(Math.floor(days), MAX_AUDIT_ACTION_STATS_DAYS);
}

/** Reads `audit_records` grouped by `(action, gatekeeperId, operationName)` within the trailing
 *  `filter.sinceDays` window — `gatekeeperId`/`operationName` are read out of
 *  `payload->'params'->>'gatekeeperId'`/`...->>'operation'`; a row missing either (defensive —
 *  every real caller's `paramsSchema` requires both) is excluded rather than surfaced as a
 *  `null`-keyed group. Empty `filter.actions` short-circuits to `[]` without a round trip — an
 *  `= any('{}')` would already return nothing, but this avoids the query entirely. */
export async function queryAuditActionOperationStats(
  client: PoolClient,
  workspaceId: string,
  filter: AuditActionOperationStatsFilter,
): Promise<readonly AuditActionOperationStatsRow[]> {
  if (filter.actions.length === 0) return [];

  const result = await client.query<AuditActionOperationStatsDbRow>(
    `select action,
            payload->'params'->>'gatekeeperId' as gatekeeper_id,
            payload->'params'->>'operation' as operation_name,
            count(*)::bigint as calls,
            max(created_at) as last_called_at
     from audit_records
     where workspace_id = $1
       and action = any($2::text[])
       and created_at >= now() - make_interval(days => $3::int)
       and payload->'params'->>'gatekeeperId' is not null
       and payload->'params'->>'operation' is not null
       and ($4::uuid is null or payload->'params'->>'gatekeeperId' = $4::text)
     group by action, gatekeeper_id, operation_name
     order by action, gatekeeper_id, operation_name`,
    [workspaceId, filter.actions, resolveSinceDays(filter.sinceDays), filter.gatekeeperId ?? null],
  );
  return result.rows.map((row) => ({
    action: row.action,
    gatekeeperId: row.gatekeeper_id,
    operationName: row.operation_name,
    calls: Number(row.calls),
    lastCalledAt: row.last_called_at,
  }));
}
