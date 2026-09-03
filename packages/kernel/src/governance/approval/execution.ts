import { ACTION_REQUEST_TRANSITIONS, type ActionRequestStatus, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { getActionRequest, getActionRequestOrThrow } from './reads.js';
import { recordTransition } from './transition-log.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  type ActionRequestDbRow,
  ActionRequestNotFoundError,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/execution: the execution-lifecycle transitions (design doc §5.5 ActionRequest
 * state graph; docs/development-tasks.md S2.3 "`expire`（reaper）；`mark_executed` / `mark_failed` /
 * `compensate`（called by the gate execution path — S2.4 — expose them as service methods now）").
 * `startActionRequestExecution` is called by `drainer.ts`; `markActionRequestExecuted`/
 * `markActionRequestFailed`/`compensateActionRequest` are called by both the drainer and,
 * eventually, S2.4's real Gatekeeper execution path directly.
 */

async function updateStatus(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  next: {
    readonly status: ActionRequestStatus;
    readonly executedAt?: Date;
    readonly failedAt?: Date;
  },
): Promise<ActionRequestRow> {
  const result = await client.query<ActionRequestDbRow>(
    `update action_requests
     set status = $3,
         executed_at = coalesce($4::timestamptz, executed_at),
         failed_at = coalesce($5::timestamptz, failed_at)
     where workspace_id = $1 and id = $2
     returning ${ACTION_REQUEST_ROW_COLUMNS}`,
    [workspaceId, actionRequestId, next.status, next.executedAt ?? null, next.failedAt ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return mapActionRequestRow(row);
}

// -------------------------------------------------------------------------------------------
// expire — reaper
// -------------------------------------------------------------------------------------------

/**
 * Reaper transition (`pending_approval -> expired`). Idempotent-by-precondition: returns `null`
 * (no-op, no audit/outbox write) if the row does not exist or is no longer `pending_approval` —
 * e.g. a human approved/rejected it in the window between the reaper's scan query and this call —
 * rather than throwing `IllegalTransition`, since "already resolved by someone else" is an
 * expected race, not an error.
 */
export async function expireActionRequest(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow | null> {
  const existing = await getActionRequest(client, workspaceId, actionRequestId);
  if (!existing || existing.status !== 'pending_approval') return null;

  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'expire');
  const updated = await updateStatus(client, workspaceId, existing.id, { status: nextStatus });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: existing.onBehalfOf,
    action: 'action_request.expire',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
  });

  return updated;
}

/** Minimal `pg.Pool`-shaped port (structurally satisfied by a real `pg.Pool`) — declared locally
 *  rather than imported from `adapters/db/pool.ts`'s `PoolLike` so this module never crosses the
 *  governance→adapters layer boundary (§7.10). `expireOverduePendingApprovals` is the one function
 *  in this module that needs to open its own connections (a cross-workspace scan, like
 *  `application/outbox/dispatcher.ts` and `application/chat/recovery.ts`'s
 *  `interruptStaleRunningTurns` — same "exactly one kernel process, not one per workspace"
 *  reasoning those two modules' own doc comments give). */
export interface MinimalPool {
  connect(): Promise<PoolClient>;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h — configurable per call.

export interface ExpireOverdueOptions {
  /** A `pending_approval` row older than this (by `requested_at`) is expired. Default
   *  `DEFAULT_APPROVAL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * Scans every workspace for `pending_approval` ActionRequests older than `options.timeoutMs` and
 * expires each in its own short transaction (deliberately not one transaction for the whole batch
 * — mirrors `application/outbox/dispatcher.ts`'s per-row rationale: one slow/failing row must not
 * block the rest). Does not call `withWorkspace()`/switch role — every query below is explicitly
 * `workspace_id`-scoped in its own WHERE clause (the same "superuser bypasses RLS by design, but
 * every statement still names its workspace" pattern `interruptStaleRunningTurns` uses). Resolves
 * with the number of rows actually expired.
 */
export async function expireOverduePendingApprovals(
  pool: MinimalPool,
  options: ExpireOverdueOptions = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();

  const scanClient = await pool.connect();
  let candidates: readonly { workspace_id: string; id: string }[];
  try {
    const result = await scanClient.query<{ workspace_id: string; id: string }>(
      `select workspace_id, id from action_requests
       where status = 'pending_approval' and requested_at < $1::timestamptz`,
      [cutoff],
    );
    candidates = result.rows;
  } finally {
    scanClient.release();
  }

  let expiredCount = 0;
  for (const candidate of candidates) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await expireActionRequest(client, candidate.workspace_id, candidate.id);
      await client.query('COMMIT');
      if (result) expiredCount += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return expiredCount;
}

// -------------------------------------------------------------------------------------------
// start_execution / mark_executed / mark_failed / compensate
// -------------------------------------------------------------------------------------------

/** `auto_approved|approved -> executing`. */
export async function startActionRequestExecution(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow> {
  const existing = await getActionRequestOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'start_execution');
  const updated = await updateStatus(client, workspaceId, existing.id, { status: nextStatus });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: existing.onBehalfOf,
    action: 'action_request.start_execution',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
  });

  return updated;
}

export interface ActionRequestActorOptions {
  readonly actorPrincipalId?: string;
}

export interface MarkExecutedOptions extends ActionRequestActorOptions {
  /** Free-form result metadata (S2.4's Gatekeeper `apply` response) — no dedicated column on
   *  `action_requests` for it, so it is recorded in the AuditRecord payload instead
   *  (`transition-log.ts`'s `extraAuditPayload`), same treatment as `MarkFailedOptions.reason`. */
  readonly resultMetadata?: Record<string, unknown>;
}

/** `executing -> executed`. */
export async function markActionRequestExecuted(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  options: MarkExecutedOptions = {},
): Promise<ActionRequestRow> {
  const existing = await getActionRequestOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'complete');
  const updated = await updateStatus(client, workspaceId, existing.id, {
    status: nextStatus,
    executedAt: new Date(),
  });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: options.actorPrincipalId ?? existing.onBehalfOf,
    action: 'action_request.complete',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
    extraAuditPayload: options.resultMetadata
      ? { resultMetadata: options.resultMetadata }
      : undefined,
  });

  return updated;
}

export interface MarkFailedOptions extends ActionRequestActorOptions {
  readonly reason?: string;
}

/** `executing -> failed`. */
export async function markActionRequestFailed(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  options: MarkFailedOptions = {},
): Promise<ActionRequestRow> {
  const existing = await getActionRequestOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'fail');
  const updated = await updateStatus(client, workspaceId, existing.id, {
    status: nextStatus,
    failedAt: new Date(),
  });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: options.actorPrincipalId ?? existing.onBehalfOf,
    action: 'action_request.fail',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
    extraAuditPayload: options.reason ? { reason: options.reason } : undefined,
  });

  return updated;
}

/** `failed -> compensated`. */
export async function compensateActionRequest(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  options: ActionRequestActorOptions = {},
): Promise<ActionRequestRow> {
  const existing = await getActionRequestOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'compensate');
  const updated = await updateStatus(client, workspaceId, existing.id, { status: nextStatus });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: options.actorPrincipalId ?? existing.onBehalfOf,
    action: 'action_request.compensate',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
  });

  return updated;
}
