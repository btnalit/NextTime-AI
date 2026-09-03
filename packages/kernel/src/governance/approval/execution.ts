import { ACTION_REQUEST_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { getActionRequestForUpdate, getActionRequestForUpdateOrThrow } from './reads.js';
import { updateActionRequestStatusConditional } from './status-transition.js';
import { recordTransition } from './transition-log.js';
import type { ActionRequestRow } from './types.js';

/**
 * governance/approval/execution: the execution-lifecycle transitions (design doc §5.4 I6/I11,
 * §5.5 ActionRequest state graph; docs/development-tasks.md S2.3 "`expire`（reaper）；
 * `mark_executed` / `mark_failed` / `compensate`（called by the gate execution path — S2.4 —
 * expose them as service methods now）"). `startActionRequestExecution` is called by `drainer.ts`;
 * `markActionRequestExecuted`/`markActionRequestFailed`/`compensateActionRequest` are called by
 * both the drainer and, eventually, S2.4's real Gatekeeper execution path directly.
 *
 * Every transition here follows the same lock -> transition-check -> conditional-UPDATE ->
 * `recordTransition` order `decide.ts` uses (see that file's own doc comment for the full
 * rationale) — minus the Approval Decision step, since none of these write one. `expire` is the
 * one exception: it locks the row too, but treats "not found" or "no longer pending_approval" as
 * a benign no-op (`null`, no throw) rather than an error — see its own doc comment.
 */

// -------------------------------------------------------------------------------------------
// expire — reaper
// -------------------------------------------------------------------------------------------

/**
 * Reaper transition (`pending_approval -> expired`). Idempotent-by-precondition: returns `null`
 * (no-op, no audit/outbox write) if the row does not exist or is no longer `pending_approval` at
 * lock time — e.g. a human approved/rejected it in the window between the reaper's scan query and
 * this call — rather than throwing `IllegalTransition`, since "already resolved by someone else"
 * is an expected, routine race for a background reaper, not an error. Still takes the row lock
 * (`getActionRequestForUpdate`) before deciding that, so a concurrent `approve`/`reject`/`expire`
 * on the same row serializes against this one rather than racing it.
 */
export async function expireActionRequest(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow | null> {
  const existing = await getActionRequestForUpdate(client, workspaceId, actionRequestId);
  if (!existing || existing.status !== 'pending_approval') return null;

  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'expire');
  const updated = await updateActionRequestStatusConditional(client, workspaceId, existing.id, {
    status: nextStatus,
    expectedStatus: existing.status,
  });

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
  const existing = await getActionRequestForUpdateOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'start_execution');
  const updated = await updateActionRequestStatusConditional(client, workspaceId, existing.id, {
    status: nextStatus,
    expectedStatus: existing.status,
  });

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
  const existing = await getActionRequestForUpdateOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'complete');
  const updated = await updateActionRequestStatusConditional(client, workspaceId, existing.id, {
    status: nextStatus,
    expectedStatus: existing.status,
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
  const existing = await getActionRequestForUpdateOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'fail');
  const updated = await updateActionRequestStatusConditional(client, workspaceId, existing.id, {
    status: nextStatus,
    expectedStatus: existing.status,
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
  const existing = await getActionRequestForUpdateOrThrow(client, workspaceId, actionRequestId);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'compensate');
  const updated = await updateActionRequestStatusConditional(client, workspaceId, existing.id, {
    status: nextStatus,
    expectedStatus: existing.status,
  });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: options.actorPrincipalId ?? existing.onBehalfOf,
    action: 'action_request.compensate',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
  });

  return updated;
}
