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
  /** `null` for a platform action (P-A1, migration 0019 `audit_records_actor_shape`): then
   *  `actorPrincipalId` must be `null`. `actorUserId` is normally set too; 遗留 54 (migration core
   *  0032) legalizes exactly one platform row with no `actorUserId` — `action:
   *  'platform.workspace_purged'` with `payload.attributedActor: false`, the operator CLI's
   *  unattributed purge (`application/platform/purge-workspace.ts`'s own doc comment has the
   *  detail). Any other actor-less platform row is still rejected by the DB constraint — this
   *  interface does not enforce that narrower shape itself, so get it exactly right at the call
   *  site or the INSERT fails. */
  readonly workspaceId: string | null;
  /** FK to `principals` — the acting Principal (I13: for a Handle call, its `on_behalf_of`). */
  readonly actorPrincipalId: string | null;
  /** The acting platform user, for platform rows (`workspace_id is null`) — omitted only for the
   *  遗留 54 unattributed `platform.workspace_purged` case above. */
  readonly actorUserId?: string;
  /** The governed action name — the capability name for capability-dispatch audit rows. */
  readonly action: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  /** Arbitrary JSON context (e.g. channel, on_behalf_of, session id, call params). Never a credential. */
  readonly payload?: Record<string, unknown>;
}

export interface AuditRecordRow {
  readonly workspaceId: string | null;
  readonly id: string;
  readonly actorPrincipalId: string | null;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

interface AuditRecordDbRow {
  workspace_id: string | null;
  id: string;
  actor_principal_id: string | null;
  actor_user_id?: string | null;
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
    actorUserId: row.actor_user_id ?? null,
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
    `insert into audit_records (workspace_id, actor_principal_id, actor_user_id, action, resource_type, resource_id, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     returning workspace_id, id, actor_principal_id, actor_user_id, action, resource_type, resource_id, payload, created_at`,
    [
      record.workspaceId,
      record.actorPrincipalId,
      record.actorUserId ?? null,
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

/** Filters accepted by {@link queryAudit} / {@link queryAuditPage} — the `audit_query`
 *  capability's `filter` param (§9.3). */
export interface AuditQueryFilter {
  readonly actorPrincipalId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  /** Defaults to {@link DEFAULT_AUDIT_QUERY_LIMIT}; capped at {@link MAX_AUDIT_QUERY_LIMIT}. */
  readonly limit?: number;
  /** S6-A (docs/console-completion-plan.md §5.5 "`audit_query` 加 keyset 分页"): the opaque
   *  `nextCursor` a previous page returned. Malformed → treated as absent (first page), never an
   *  error — the same convention `search`/`query_decisions`/`list_action_requests` follow. */
  readonly cursor?: string;
}

export const DEFAULT_AUDIT_QUERY_LIMIT = 100;
export const MAX_AUDIT_QUERY_LIMIT = 1000;

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
    return DEFAULT_AUDIT_QUERY_LIMIT;
  return Math.min(Math.floor(limit), MAX_AUDIT_QUERY_LIMIT);
}

/**
 * `audit_query` keyset cursor (S6-A, docs/console-completion-plan.md §5.5; the leftover-23 pattern,
 * docs/STATUS.md §4 row 23): the page boundary is the last row's `(created_at, id)`, compared and
 * ordered on `date_trunc('milliseconds', created_at)` — the cursor's timestamp travels as an ISO
 * string with millisecond precision, so a microsecond-precision column compared raw would skip
 * every row written in the same millisecond as the boundary row (same-transaction audit rows are
 * exactly that case); truncating both sides and tie-breaking on `id` keeps the order total.
 * Opaque on the wire (base64url of `<iso>|<uuid>`) — another private copy of the encoding, the
 * same deliberate choice `governance/approval/reads.ts` records for its own cursor.
 */
const AUDIT_CURSOR_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeAuditCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeAuditCursor(
  cursor: string | undefined,
): { readonly createdAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const createdAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !AUDIT_CURSOR_UUID_PATTERN.test(id)) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface AuditQueryPage {
  readonly items: readonly AuditRecordRow[];
  /** Present only when a further page exists (the query over-fetches by one to know). */
  readonly nextCursor?: string;
}

/**
 * Reads one page of AuditRecords newest-first, narrowed by whichever `filter` fields are given,
 * keyset-paginated on `(date_trunc('milliseconds', created_at), id)` (see the cursor doc comment
 * above). `filter.limit` is clamped to `MAX_AUDIT_QUERY_LIMIT` here; whether to report that clamp
 * as `truncated: true` is the capability handler's concern (docs/wire-contract-conventions.md §3),
 * which knows the caller's original number.
 */
export async function queryAuditPage(
  client: PoolClient,
  workspaceId: string,
  filter: AuditQueryFilter = {},
): Promise<AuditQueryPage> {
  const limit = resolveLimit(filter.limit);
  const cursor = decodeAuditCursor(filter.cursor);
  const result = await client.query<AuditRecordDbRow>(
    `select workspace_id, id, actor_principal_id, action, resource_type, resource_id, payload, created_at
     from audit_records
     where workspace_id = $1
       and ($2::uuid is null or actor_principal_id = $2)
       and ($3::text is null or action = $3)
       and ($4::text is null or resource_type = $4)
       and ($5::uuid is null or resource_id = $5)
       and (
         $7::timestamptz is null
         or (date_trunc('milliseconds', created_at), id) < ($7::timestamptz, $8::uuid)
       )
     order by date_trunc('milliseconds', created_at) desc, id desc
     limit $6`,
    [
      workspaceId,
      filter.actorPrincipalId ?? null,
      filter.action ?? null,
      filter.resourceType ?? null,
      filter.resourceId ?? null,
      limit + 1,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
    ],
  );
  const rows = result.rows.slice(0, limit).map(mapAuditRecordRow);
  const last = rows[rows.length - 1];
  const nextCursor =
    result.rows.length > limit && last ? encodeAuditCursor(last.createdAt, last.id) : undefined;
  return nextCursor === undefined ? { items: rows } : { items: rows, nextCursor };
}

/** Reads AuditRecords newest-first, narrowed by whichever `filter` fields are given — the first
 *  page of {@link queryAuditPage} as a plain array, for the callers that only ever want a bounded
 *  newest-first scan (`reconstruct.ts`, `request-action-handler.ts`'s terminal-outcome read). Same
 *  rows as before S6-A's pagination; same-millisecond rows now tie-break on `id` instead of
 *  arbitrary physical order. */
export async function queryAudit(
  client: PoolClient,
  workspaceId: string,
  filter: AuditQueryFilter = {},
): Promise<readonly AuditRecordRow[]> {
  const page = await queryAuditPage(client, workspaceId, filter);
  return page.items;
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
