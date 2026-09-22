import type { ActionRequestStatus, Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { queryAuditActionOperationStats } from '../../substrate/audit/index.js';
import { GATEKEEPER_GRANT_CAPABILITY, hasActiveGrant } from '../capability/index.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  type ActionRequestDbRow,
  ActionRequestNotFoundError,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/reads: every read-only query `service.ts`/`drainer.ts` need (design doc §9.3
 * `list_pending`/`get_action`, §5.4 I14, S2.3 drain-queue ordering; S5.5 leftover 21 —
 * `listActionRequestsForApprover`, the `list_action_requests` "审批历史" read). Split out per the
 * design doc's file-size guidance.
 */

export async function getActionRequest(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow | null> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests where workspace_id = $1 and id = $2`,
    [workspaceId, actionRequestId],
  );
  const row = result.rows[0];
  return row ? mapActionRequestRow(row) : null;
}

export async function findActionRequestByIdempotencyKey(
  client: PoolClient,
  workspaceId: string,
  idempotencyKey: string,
): Promise<ActionRequestRow | null> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests where workspace_id = $1 and idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? mapActionRequestRow(row) : null;
}

/**
 * `list_pending` (§9.3, I14): the caller's own queue — the workspace owner sees every
 * `pending_approval` row; a non-owner sees only rows whose `action_kind`/`resource_scope` matches
 * one of their active `capability_grants` (a correlated `exists`, not an N+1 query per row). The
 * `exists` clause's OR-branch mirrors `governance/capability/grants.ts`'s `MATCHING_GRANT_WHERE`
 * (item 2's "gatekeeper grant satisfies I14" decision) so this queue and `approve`/`reject`'s own
 * `approverHasScope` precheck never disagree — a row that shows up here must also be approvable,
 * and vice versa.
 */
export async function listPendingForApprover(
  client: PoolClient,
  workspaceId: string,
  approver: { readonly principalId: string; readonly role: Role },
): Promise<readonly ActionRequestRow[]> {
  if (approver.role === 'owner') {
    const result = await client.query<ActionRequestDbRow>(
      `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
       where workspace_id = $1 and status = 'pending_approval'
       order by requested_at asc`,
      [workspaceId],
    );
    return result.rows.map(mapActionRequestRow);
  }

  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests ar
     where ar.workspace_id = $1
       and ar.status = 'pending_approval'
       and exists (
         select 1 from capability_grants cg
         where cg.workspace_id = ar.workspace_id
           and cg.principal_id = $2
           and cg.status = 'active'
           and (cg.expires_at is null or cg.expires_at > now())
           and (
             (cg.resource_type = ar.action_kind
              and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope))
             or (
               ar.resource_scope is not null
               and cg.resource_type = '${GATEKEEPER_GRANT_CAPABILITY}'
               and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope)
             )
           )
       )
     order by ar.requested_at asc`,
    [workspaceId, approver.principalId],
  );
  return result.rows.map(mapActionRequestRow);
}

/**
 * `list_action_requests` keyset cursor (S5.5 leftover 21): the page boundary is the last row's
 * `(requestedAt, id)` — `action_requests` (migrations/governance/0003_action_requests.sql) has no
 * `updated_at`/`created_at` column, only `requested_at`, so that is this list's creation-order
 * column, the same role `updated_at` plays for `search`'s own cursor
 * (`substrate/graph/queries.ts`'s `encodeSearchCursor`/`buildSearchQuery`, PR #132). Opaque on the
 * wire (base64url of `<iso>|<uuid>`) — same encoding, deliberately another private copy rather
 * than a shared helper (that file's own doc comment: "a fourth private copy, deliberately — no
 * shared helper refactor").
 */
const ACTION_REQUEST_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeActionRequestCursor(requestedAt: Date, id: string): string {
  return Buffer.from(`${requestedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Same "never throws on a malformed cursor" convention as `search`/`query_decisions`/
 *  `list_conflicts` — an unparseable cursor reads as "no cursor" (first page), never a 500. */
export function decodeActionRequestCursor(
  cursor: string | undefined,
): { readonly requestedAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const requestedAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (
      !requestedAt ||
      Number.isNaN(Date.parse(requestedAt)) ||
      !ACTION_REQUEST_UUID_PATTERN.test(id)
    ) {
      return null;
    }
    return { requestedAt, id };
  } catch {
    return null;
  }
}

/** Same defaults as `search` (`substrate/graph/store.ts` `DEFAULT_SEARCH_LIMIT`/
 *  `MAX_SEARCH_LIMIT`) — the `list_action_requests` registry entry's own doc comment
 *  (packages/shared/src/capabilities.ts) says explicitly to match them. */
export const DEFAULT_ACTION_REQUEST_LIST_LIMIT = 50;
export const MAX_ACTION_REQUEST_LIST_LIMIT = 200;

export interface ListActionRequestsFilter {
  readonly status?: ActionRequestStatus | readonly ActionRequestStatus[];
  readonly gatekeeperId?: string;
  /** S6-A C28: `parent_worker_run_id in (...)`. `undefined` = no narrowing; an *empty* array
   *  matches nothing (the handler passes `[]` for a `taskId` with no WorkerRuns or that does not
   *  exist). Task → WorkerRun resolution is the caller's job (`application/task`'s
   *  `getTaskWithWorkerRuns`) — `worker_runs` is that module's table, not read from here. */
  readonly parentWorkerRunIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ActionRequestListPage {
  readonly items: readonly ActionRequestRow[];
  readonly nextCursor?: string;
}

/**
 * `list_action_requests` (S5.5 leftover 21, docs/STATUS.md row 21): the console's "审批历史" read —
 * every ActionRequest regardless of status (unlike `listPendingForApprover` above, hardcoded to
 * `status = 'pending_approval'`), optionally narrowed by `status`/`gatekeeperId`/
 * `parentWorkerRunIds` (S6-A C28), keyset-paginated
 * on `(requested_at, id)` the same way `search` paginates on `(updated_at, id)` (see this file's
 * own cursor doc comment above; `truncated`-on-clamp is the caller's concern, same as `search`'s
 * own handler).
 *
 * Visibility mirrors `listPendingForApprover` exactly (I14, design doc §8.5 "用户 B 看不到也批不了"):
 * the workspace owner sees every row; any other role sees only rows whose `action_kind`/
 * `resource_scope` matches one of their own active `capability_grants` (the same `exists` clause
 * `listPendingForApprover` uses, copied rather than factored into a shared SQL fragment — this
 * module has no query-builder layer, unlike `substrate/graph/queries.ts`). An ActionRequest a
 * caller may not see must not appear here even once it is no longer pending — this list is a
 * superset of `list_pending` by status, not by visibility.
 */
export async function listActionRequestsForApprover(
  client: PoolClient,
  workspaceId: string,
  approver: { readonly principalId: string; readonly role: Role },
  filter: ListActionRequestsFilter,
): Promise<ActionRequestListPage> {
  const limit = Math.min(
    Math.max(filter.limit ?? DEFAULT_ACTION_REQUEST_LIST_LIMIT, 1),
    MAX_ACTION_REQUEST_LIST_LIMIT,
  );
  const statuses =
    filter.status === undefined
      ? null
      : Array.isArray(filter.status)
        ? [...filter.status]
        : [filter.status];
  const cursor = decodeActionRequestCursor(filter.cursor);
  const isOwner = approver.role === 'owner';

  // Over-fetch by one: a (limit + 1)th row proves there is a next page without a second query
  // (same convention `SqlGraphStore.searchPage` uses for `search`).
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests ar
     where ar.workspace_id = $1
       and ($2::text[] is null or ar.status = any($2::text[]))
       and ($3::uuid is null or ar.gatekeeper_id = $3::uuid)
       and ($9::uuid[] is null or ar.parent_worker_run_id = any($9::uuid[]))
       and (
         $5::timestamptz is null
         or (date_trunc('milliseconds', ar.requested_at), ar.id) < ($5::timestamptz, $6::uuid)
       )
       and (
         $7::boolean
         or exists (
           select 1 from capability_grants cg
           where cg.workspace_id = ar.workspace_id
             and cg.principal_id = $8
             and cg.status = 'active'
             and (cg.expires_at is null or cg.expires_at > now())
             and (
               (cg.resource_type = ar.action_kind
                and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope))
               or (
                 ar.resource_scope is not null
                 and cg.resource_type = '${GATEKEEPER_GRANT_CAPABILITY}'
                 and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope)
               )
             )
         )
       )
     order by date_trunc('milliseconds', ar.requested_at) desc, ar.id desc
     limit $4`,
    [
      workspaceId,
      statuses,
      filter.gatekeeperId ?? null,
      limit + 1,
      cursor?.requestedAt ?? null,
      cursor?.id ?? null,
      isOwner,
      approver.principalId,
      filter.parentWorkerRunIds === undefined ? null : [...filter.parentWorkerRunIds],
    ],
  );

  const rows = result.rows.slice(0, limit);
  const items = rows.map(mapActionRequestRow);
  const last = items[items.length - 1];
  const nextCursor =
    result.rows.length > limit && last
      ? encodeActionRequestCursor(last.requestedAt, last.id)
      : undefined;
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

// -------------------------------------------------------------------------------------------
// readApprovalDecisions — S6-A C25 (docs/console-completion-plan.md §5.8, §6 `approve{reason?}`):
// the human decision behind `ActionRequestRow.approvalDecisionId`, for the wire projection's
// `decisionReason` / `decidedBy` / `decidedAt` (application/gateway/handlers.ts's
// `withApprovalDecision`). A separate keyed read rather than a LEFT JOIN folded into
// `ACTION_REQUEST_ROW_COLUMNS`: that column list feeds ~10 queries in this module including
// `returning` clauses and `select ... for update` (which cannot take the nullable side of an outer
// join), and `ActionRequestRow` is the internal row every mutator reads and writes — widening it
// for a read-side display concern would touch all of them. `decide.ts`'s `writeApprovalDecision`
// is what writes these rows (`rationale.reason`, `decided_by`, `decided_at`); they have no
// `source_id`, so the `decisions_visibility` policy (migrations/core/0002) shows them
// workspace-wide — exactly the audience `get_action`/`list_action_requests` already serve.
// -------------------------------------------------------------------------------------------

export interface ApprovalDecisionSummary {
  readonly decisionId: string;
  /** `rationale.reason` as `decide.ts` stored it — `null` for a reason-less low/medium approve
   *  or a reason-less reject. */
  readonly reason: string | null;
  readonly decidedBy: string;
  readonly decidedAt: Date;
}

interface ApprovalDecisionDbRow {
  id: string;
  reason: string | null;
  decided_by: string;
  decided_at: Date;
}

/** Keyed by decision id; ids with no row (deleted, or not visible) are simply absent. Empty input
 *  short-circuits without a round trip. */
export async function readApprovalDecisions(
  client: PoolClient,
  workspaceId: string,
  decisionIds: readonly string[],
): Promise<ReadonlyMap<string, ApprovalDecisionSummary>> {
  const unique = [...new Set(decisionIds)];
  if (unique.length === 0) return new Map();
  const result = await client.query<ApprovalDecisionDbRow>(
    `select id, rationale ->> 'reason' as reason, decided_by, decided_at
     from decisions
     where workspace_id = $1 and id = any($2::uuid[]) and decided_by is not null and decided_at is not null`,
    [workspaceId, unique],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        decisionId: row.id,
        reason: row.reason,
        decidedBy: row.decided_by,
        decidedAt: row.decided_at,
      },
    ]),
  );
}

/**
 * Every ActionRequest for one Gatekeeper not yet in a terminal/execution-started state
 * (`auto_approved`/`approved`/`pending_approval`), ascending `requested_at` — `drainer.ts`'s queue:
 * it processes `auto_approved`/`approved` rows and stops at the first `pending_approval` one, so a
 * later row never executes ahead of an earlier one still awaiting a human decision (design doc
 * S2.3 "drain 每 Gatekeeper 单飞、升序、遇 pending 停").
 */
export async function listExecutableQueue(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<readonly ActionRequestRow[]> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
     where workspace_id = $1 and gatekeeper_id = $2
       and status in ('auto_approved', 'approved', 'pending_approval')
     order by requested_at asc`,
    [workspaceId, gatekeeperId],
  );
  return result.rows.map(mapActionRequestRow);
}

/** I14: the workspace owner counts as holding every scope; every other role must hold a matching
 *  active `capability_grants` row. Role gates *entry to the queue*
 *  (`application/gateway/authorize.ts`'s `minRole: 'operator'` on `approve`/`reject` — a `member`
 *  never reaches this function); this decides *which* pending ActionRequests that operator/owner
 *  may actually approve (§5.8 "角色 operator 只是进队列；能批哪条由 capability 范围决定"). */
export async function approverHasScope(
  client: PoolClient,
  workspaceId: string,
  approver: { readonly principalId: string; readonly role: Role },
  target: { readonly actionKind: string; readonly resourceScope: string | null },
): Promise<boolean> {
  if (approver.role === 'owner') return true;
  return hasActiveGrant(client, workspaceId, {
    principalId: approver.principalId,
    resourceType: target.actionKind,
    resourceId: target.resourceScope,
  });
}

export async function getActionRequestOrThrow(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow> {
  const row = await getActionRequest(client, workspaceId, actionRequestId);
  if (!row) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return row;
}

/**
 * I6/I11 concurrency hardening: same read as `getActionRequest`, but takes `SELECT ... FOR UPDATE`
 * — a row-level lock held for the rest of the caller's transaction. Every governed transition that
 * mutates an *existing* row (`decide.ts`'s `approve`/`reject`, `execution.ts`'s `start_execution`/
 * `mark_executed`/`mark_failed`/`compensate`/`expire`) must read through this (or the null-tolerant
 * `expire` case, which locks first and then decides "not found" is a benign no-op rather than an
 * error) before computing its next status — never the lock-free `getActionRequest`/
 * `getActionRequestOrThrow` above. Locking here makes a second concurrent caller on the same row
 * block until the first commits, then see the *already-updated* status and fail at the ordinary
 * `transition()` table-lookup step (a plain `IllegalTransition`) instead of wastefully writing an
 * Approval Decision that the conditional UPDATE (`status-transition.ts`) would then discard.
 * `drainer.ts`'s per-Gatekeeper queue read (`listExecutableQueue` above) is deliberately excluded
 * — it only decides *what to process next*, never mutates a row itself.
 */
export async function getActionRequestForUpdate(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow | null> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests where workspace_id = $1 and id = $2 for update`,
    [workspaceId, actionRequestId],
  );
  const row = result.rows[0];
  return row ? mapActionRequestRow(row) : null;
}

export async function getActionRequestForUpdateOrThrow(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow> {
  const row = await getActionRequestForUpdate(client, workspaceId, actionRequestId);
  if (!row) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return row;
}

/** `get_operation_stats` (S3.12 catalog-usage follow-up; S3.8 closes the observe-class attribution
 *  gap its own capability-registry doc comment left documented). One row per `{gatekeeperId,
 *  operationName}` (`action_kind`, the Operation's own name, `manifest.ts`'s own doc comment) with
 *  at least one call in the trailing `days` window — from either source below:
 *
 *   - **execute-class**: at least one `action_requests` row. `approved`/`rejected`/`autoApproved`/
 *     `failed` count rows *currently* in that literal `status` — see this module's own
 *     capability-registry entry (`packages/shared/src/capabilities.ts`) for why that is a live
 *     snapshot, not cumulative decision history. `observeCalls` is always `0` for a row sourced
 *     this way.
 *   - **observe-class**: at least one `observe_operation` AuditRecord (the capability behind every
 *     `<gate>.<op>` observe tool call, `application/gateway/request-action-handler.ts`'s own doc
 *     comment) — `substrate/audit`'s `queryAuditActionOperationStats` (S3.8). These Operations
 *     never create an `action_requests` row at all (§11 "观察免审"), so `approved`/`rejected`/
 *     `autoApproved`/`failed` are always `0` for a row sourced this way; `observeCalls` carries
 *     the count instead, and `calls` includes it (see the merge note below).
 *
 *  A `{gatekeeperId, operationName}` key present in *both* sources (not expected in practice — a
 *  published Operation has exactly one `mode`, design doc §5.5 — but not something this read
 *  enforces) merges: `calls` sums both sources, `observeCalls` carries only the observe-side count,
 *  `approved`/`rejected`/`autoApproved`/`failed` come only from the execute side, and
 *  `lastCalledAt` is the later of the two.
 *
 *  **Known, documented scope boundary**: a Worker's `request_action` call that resolves to an
 *  observe-mode Operation (the rare fallthrough path in `request-action-handler.ts` — a Worker
 *  normally only calls `request_action` for execute-class needs) writes its AuditRecord under
 *  `action = 'request_action'`, not `'observe_operation'` — indistinguishable, from this table
 *  alone, from every other `request_action` call without cross-referencing the invoked Operation's
 *  current `mode` (a `governance/gatekeepers` concern this read does not reach into). Left
 *  uncounted rather than approximated — the primary `<gate>.<op>` observe path (this read's actual
 *  target) always audits under `observe_operation` regardless. */
export interface OperationStatsRow {
  readonly gatekeeperId: string;
  readonly operationName: string;
  readonly calls: number;
  readonly approved: number;
  readonly rejected: number;
  readonly autoApproved: number;
  readonly failed: number;
  /** Observe-class calls within the window (a subset of `calls` — see this interface's own doc
   *  comment for the merge rule). `0` for a purely execute-class row. */
  readonly observeCalls: number;
  readonly lastCalledAt: Date;
}

interface OperationStatsDbRow {
  gatekeeper_id: string;
  action_kind: string;
  calls: string;
  approved: string;
  rejected: string;
  auto_approved: string;
  failed: string;
  last_called_at: Date;
}

export interface GetOperationStatsFilter {
  readonly gatekeeperId?: string;
  /** Days back from now — the capability's own paramsSchema already clamps this to [1, 90]; not
   *  re-validated here (this function trusts its caller, same convention every other read in this
   *  module already follows). */
  readonly days: number;
}

/** The capability behind every `<gate>.<op>` observe tool call (`request-action-handler.ts`'s own
 *  doc comment) — the `action` value `dispatch.ts` audits observe-class Operation calls under. */
const OBSERVE_OPERATION_AUDIT_ACTION = 'observe_operation';

function operationStatsKey(gatekeeperId: string, operationName: string): string {
  return `${gatekeeperId}::${operationName}`;
}

export async function getOperationStats(
  client: PoolClient,
  workspaceId: string,
  filter: GetOperationStatsFilter,
): Promise<readonly OperationStatsRow[]> {
  // S5.5 leftover 34: one client, one query at a time (pg@9 rejects concurrent queries on a client).
  const executeResult = await client.query<OperationStatsDbRow>(
    `select gatekeeper_id, action_kind,
            count(*)::bigint as calls,
            count(*) filter (where status = 'approved')::bigint as approved,
            count(*) filter (where status = 'rejected')::bigint as rejected,
            count(*) filter (where status = 'auto_approved')::bigint as auto_approved,
            count(*) filter (where status = 'failed')::bigint as failed,
            max(requested_at) as last_called_at
     from action_requests
     where workspace_id = $1
       and requested_at >= now() - make_interval(days => $2::int)
       and ($3::uuid is null or gatekeeper_id = $3)
     group by gatekeeper_id, action_kind
     order by gatekeeper_id, action_kind`,
    [workspaceId, filter.days, filter.gatekeeperId ?? null],
  );
  const observeRows = await queryAuditActionOperationStats(client, workspaceId, {
    actions: [OBSERVE_OPERATION_AUDIT_ACTION],
    sinceDays: filter.days,
    gatekeeperId: filter.gatekeeperId,
  });

  const merged = new Map<string, OperationStatsRow>();
  for (const row of executeResult.rows) {
    merged.set(operationStatsKey(row.gatekeeper_id, row.action_kind), {
      gatekeeperId: row.gatekeeper_id,
      operationName: row.action_kind,
      calls: Number(row.calls),
      approved: Number(row.approved),
      rejected: Number(row.rejected),
      autoApproved: Number(row.auto_approved),
      failed: Number(row.failed),
      observeCalls: 0,
      lastCalledAt: row.last_called_at,
    });
  }
  for (const row of observeRows) {
    const key = operationStatsKey(row.gatekeeperId, row.operationName);
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, {
        ...existing,
        calls: existing.calls + row.calls,
        observeCalls: row.calls,
        lastCalledAt:
          row.lastCalledAt > existing.lastCalledAt ? row.lastCalledAt : existing.lastCalledAt,
      });
    } else {
      merged.set(key, {
        gatekeeperId: row.gatekeeperId,
        operationName: row.operationName,
        calls: row.calls,
        approved: 0,
        rejected: 0,
        autoApproved: 0,
        failed: 0,
        observeCalls: row.calls,
        lastCalledAt: row.lastCalledAt,
      });
    }
  }

  return [...merged.values()].sort((a, b) =>
    a.gatekeeperId === b.gatekeeperId
      ? a.operationName.localeCompare(b.operationName)
      : a.gatekeeperId.localeCompare(b.gatekeeperId),
  );
}
