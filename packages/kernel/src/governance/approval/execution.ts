import { ACTION_REQUEST_TRANSITIONS, namesASecretField, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  redactSuspectedSecrets,
  redactedForAudit,
  scrubSecretLiterals,
  scrubSecretLiteralsIn,
  secretFieldLiterals,
} from '../redaction/index.js';
import { getActionRequestForUpdate, getActionRequestForUpdateOrThrow } from './reads.js';
import { updateActionRequestStatusConditional } from './status-transition.js';
import { recordTransition } from './transition-log.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  type ActionRequestDbRow,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

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

export interface DrainableGatekeeper {
  readonly workspaceId: string;
  readonly gatekeeperId: string;
}

/**
 * The periodic-tick half of S2.4's drainer wiring ("... and on a periodic tick", docs/development-
 * tasks.md): every distinct `(workspace_id, gatekeeper_id)` pair currently carrying an executable
 * (`auto_approved`/`approved`) row, across every workspace — the same cross-workspace admin-mode
 * scan shape as `expireOverduePendingApprovals` above (one `MinimalPool` connection, no
 * `withWorkspace`/RLS). `packages/kernel/src/index.ts`'s periodic drain tick calls this, then
 * `ApprovalDrainer.drainGatekeeper` for each pair returned — kept as a separate, single-purpose
 * query here (governance/approval owns `action_requests`) rather than a raw `SELECT` in
 * `application/gateway` (§7.10 module contract: other modules must not query this table directly).
 */
export async function listDistinctExecutableGatekeepers(
  pool: MinimalPool,
): Promise<readonly DrainableGatekeeper[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ workspace_id: string; gatekeeper_id: string }>(
      `select distinct workspace_id, gatekeeper_id from action_requests
       where status in ('auto_approved', 'approved')`,
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      gatekeeperId: row.gatekeeper_id,
    }));
  } finally {
    client.release();
  }
}

export const DEFAULT_STALE_EXECUTING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface StaleExecutingScanOptions {
  /** An `executing` row older than this (by `executing_at`) is a candidate — default
   *  `DEFAULT_STALE_EXECUTING_TIMEOUT_MS`. */
  readonly staleAfterMs?: number;
}

/**
 * P1-3 fix (review job 652a4abc: "crash/DB failure between apply success and
 * markActionRequestExecuted leaves row `executing` forever; not drainable, no reaper, no event,
 * parent Task never resumes"): every workspace's `executing` ActionRequests older than
 * `options.staleAfterMs` (by `executing_at` — migrations/governance/
 * 0006_action_request_executing_at.sql's own doc comment explains why not `requested_at`) — the
 * same cross-workspace admin-mode scan shape as `expireOverduePendingApprovals`/
 * `listDistinctExecutableGatekeepers` above. Returns full rows (not just ids) because
 * `application/gateway/action-executor.ts`'s `reapStaleExecutingActionRequests` needs
 * `gatekeeperId`/`actionKind`/`params`/`onBehalfOf` to replay `apply` — that function lives in
 * `application/gateway` (governance may not depend on `adapters/gatekeeper-client`, §7.10), so
 * this module only ever hands back data, never calls the gate itself.
 */
export async function listStaleExecutingActionRequests(
  pool: MinimalPool,
  options: StaleExecutingScanOptions = {},
): Promise<readonly ActionRequestRow[]> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_EXECUTING_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();

  const client = await pool.connect();
  try {
    const result = await client.query<ActionRequestDbRow>(
      `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
       where status = 'executing' and executing_at < $1::timestamptz`,
      [cutoff],
    );
    return result.rows.map(mapActionRequestRow);
  } finally {
    client.release();
  }
}

/** R-48: how many times the stale-executing reaper replays one row's `apply` without getting an
 *  answer about it (the gate still applying, unreachable, or timing out again) before it marks the
 *  row `failed` with an `outcome_unknown` reason for a person to reconcile. At the default 5-minute
 *  reaper tick this is about 15 minutes of replays after the row first went stale. */
export const DEFAULT_MAX_REPLAY_ATTEMPTS = 3;

/**
 * R-48: counts one reaper replay of an `executing` row (migrations/governance/
 * 0013_action_request_replay_attempts.sql) and returns the new count — persisted *before* the
 * replay runs, so a replay that throws still counts and the bound survives a kernel restart.
 * Returns `null` without counting when the row is no longer `executing` (another path resolved it
 * since the scan — the same benign race the reaper already tolerates). Not a state transition: no
 * audit or outbox write; the terminal `fail` the cap leads to is audited with its reason.
 */
export async function recordActionRequestReplayAttempt(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<number | null> {
  const result = await client.query<{ replay_attempts: number }>(
    `update action_requests set replay_attempts = replay_attempts + 1
     where workspace_id = $1 and id = $2 and status = 'executing'
     returning replay_attempts`,
    [workspaceId, actionRequestId],
  );
  return result.rows[0]?.replay_attempts ?? null;
}

// -------------------------------------------------------------------------------------------
// start_execution / mark_executed / mark_failed / compensate
// -------------------------------------------------------------------------------------------

/** `auto_approved|approved -> executing`. Sets `executing_at` (P1-3 fix) — the staleness anchor
 *  `reapStaleExecutingActionRequests` scans on, see migrations/governance/
 *  0006_action_request_executing_at.sql's own doc comment for why this, and not `requested_at`,
 *  is the correct signal. */
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
    executingAt: new Date(),
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
   *  (`transition-log.ts`'s `extraAuditPayload`), same treatment as `MarkFailedOptions.reason`.
   *  Recorded redacted (`resultAuditFields`). */
  readonly resultMetadata?: Record<string, unknown>;
}

/**
 * The audit fields of a gate's `apply` output (legacy 187). A gate can return what it issued — a
 * token, a deploy key, a generated password — and an AuditRecord is append-only (I11), so the copy
 * it keeps is the call-argument rule's (`redactSuspectedSecrets`: a field named after a secret, at
 * any depth, and every secret-looking value) — the rule every capability call's `params` copy
 * follows (#532) — and, first, the request's own secret param values (`secretFieldLiterals`)
 * wherever the output repeats them ("created user bob with password …"). `resultRedaction:
 * { redactedValues, paths }` says how many values were hidden, and where — field names only.
 *
 * This copy is also what the caller gets back: `request_action` reads a terminal request's outcome
 * from this row (application/gateway's `readTerminalOutcome`), so an agent sees `[redacted]` in
 * place of an issued credential too — the agent and kernel hold no credentials (design floor), and
 * a credential that reached the agent would go on to its model provider.
 */
export function resultAuditFields(
  resultMetadata: Record<string, unknown>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const quoted = scrubSecretLiteralsIn(
    resultMetadata,
    secretFieldLiterals(params, namesASecretField),
  );
  const redacted = redactSuspectedSecrets(quoted.value, { secretFields: true });
  const redactedValues = quoted.redactedValues + redacted.count;
  return {
    resultMetadata: redacted.value,
    ...(redactedValues > 0 ? { resultRedaction: { redactedValues, paths: redacted.paths } } : {}),
  };
}

/** The audit field of a failure's `reason` — a gate's or the executor's error text, which can quote
 *  what the gate sent or got back (an MCP server echoing its arguments, a command's stderr): the
 *  request's own secret param values hidden as literals, then the rule of the `params` copy
 *  (`redactedForAudit`). The caller reads it back from this row too (`resultAuditFields`). */
export function reasonAuditFields(
  reason: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const quoted = scrubSecretLiterals(reason, secretFieldLiterals(params, namesASecretField));
  return redactedForAudit({ reason: quoted.value });
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
      ? resultAuditFields(options.resultMetadata, existing.params)
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
    extraAuditPayload: options.reason
      ? reasonAuditFields(options.reason, existing.params)
      : undefined,
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
