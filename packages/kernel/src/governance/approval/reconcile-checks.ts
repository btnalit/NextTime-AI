import type { ActionRequestReconcileCheckStatus, ObservationCheck } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';

/**
 * governance/approval/reconcile-checks (S11 GO3d, plan §4.7 "结果未知"): the platform's check of an
 * outcome-unknown ActionRequest — the observation its goal step declared, and where that check
 * stands (`action_request_reconcile_checks`, migrations/governance/0024). This module owns the
 * rows and their audit trail; when to create a check and when to run it is the goal's
 * (`application/goal/advance.ts`, `application/goal/reconcile-check.ts`), and the finding a
 * satisfied observation leads to is `reconcile.ts`'s `recordObservedReconciliation`.
 *
 * A check is created `pending` once per request ({@link ensureReconcileCheck}); a kernel claims it
 * for one attempt at a time ({@link claimReconcileCheck}: the attempt number grows and a lease
 * holds it — a kernel that dies mid-attempt leaves a lease that runs out, and the next claim is a
 * new attempt); the attempt either puts it back for later ({@link deferReconcileCheck}) or settles
 * it once ({@link settleReconcileCheck}) — `seen`, `not_seen`, `unavailable` or `preempted`. Every
 * attempt's end is audited (`action_request.reconcile_check`). The database guard holds the rest:
 * a settled check never changes, and `seen` / `preempted` agree with the request's own finding.
 */

export interface ReconcileCheckRow {
  readonly workspaceId: string;
  readonly actionRequestId: string;
  readonly status: ActionRequestReconcileCheckStatus;
  readonly observationCheck: ObservationCheck;
  readonly attempts: number;
  /** When the first attempt was claimed — `null` before it. The retries' duration cap counts
   *  from here (`application/goal/reconcile-check.ts`). */
  readonly firstAttemptAt: Date | null;
  readonly nextAttemptAt: Date;
  readonly leaseUntil: Date | null;
  readonly observationId: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

interface ReconcileCheckDbRow {
  workspace_id: string;
  action_request_id: string;
  status: ActionRequestReconcileCheckStatus;
  observation_check: ObservationCheck;
  attempts: number;
  first_attempt_at: Date | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  observation_id: string | null;
  last_error: string | null;
  created_at: Date;
  settled_at: Date | null;
}

const RECONCILE_CHECK_COLUMNS =
  'workspace_id, action_request_id, status, observation_check, attempts, first_attempt_at, ' +
  'next_attempt_at, lease_until, observation_id, last_error, created_at, settled_at';

function mapRow(row: ReconcileCheckDbRow): ReconcileCheckRow {
  return {
    workspaceId: row.workspace_id,
    actionRequestId: row.action_request_id,
    status: row.status,
    observationCheck: row.observation_check,
    attempts: row.attempts,
    firstAttemptAt: row.first_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    observationId: row.observation_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/** The longest `last_error` kept (governance/0024's CHECK): a short code, never a gate's text. */
export const RECONCILE_CHECK_ERROR_MAX = 200;

/** The check of `actionRequestId`, created `pending` with `observationCheck` unless one exists —
 *  the existing one is returned as it is (one check per request, whatever was declared later).
 *  The request must be a goal step's, `failed` + `outcome_unknown` and not reconciled (the guard). */
export async function ensureReconcileCheck(
  client: PoolClient,
  workspaceId: string,
  input: { readonly actionRequestId: string; readonly observationCheck: ObservationCheck },
): Promise<ReconcileCheckRow> {
  await client.query(
    `insert into action_request_reconcile_checks (workspace_id, action_request_id, observation_check)
     values ($1, $2, $3::jsonb)
     on conflict (workspace_id, action_request_id) do nothing`,
    [workspaceId, input.actionRequestId, JSON.stringify(input.observationCheck)],
  );
  const row = (await readReconcileChecks(client, workspaceId, [input.actionRequestId])).get(
    input.actionRequestId,
  );
  if (!row) throw new Error('ensureReconcileCheck: the check is not there after its insert');
  return row;
}

/** The checks of `actionRequestIds` that exist, by request id. */
export async function readReconcileChecks(
  client: PoolClient,
  workspaceId: string,
  actionRequestIds: readonly string[],
): Promise<ReadonlyMap<string, ReconcileCheckRow>> {
  if (actionRequestIds.length === 0) return new Map();
  const result = await client.query<ReconcileCheckDbRow>(
    `select ${RECONCILE_CHECK_COLUMNS} from action_request_reconcile_checks
      where workspace_id = $1 and action_request_id = any($2::uuid[])`,
    [workspaceId, [...actionRequestIds]],
  );
  return new Map(result.rows.map((row) => [row.action_request_id, mapRow(row)]));
}

/** Claims the check for one attempt: `pending`, due, and not leased — or `null` (another kernel
 *  has it, it settled, or it is not due). The attempt number grows by one, the first claim sets
 *  `first_attempt_at`, and the lease runs `leaseMs`. A concurrent claim waits on the row and then
 *  finds it leased. `closed`: the check's run or step ended, so it is claimed to be settled
 *  without a call, due or not (a cancel stops the retries). */
export async function claimReconcileCheck(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  leaseMs: number,
  closed = false,
): Promise<ReconcileCheckRow | null> {
  const result = await client.query<ReconcileCheckDbRow>(
    `update action_request_reconcile_checks
        set attempts = attempts + 1,
            first_attempt_at = coalesce(first_attempt_at, now()),
            lease_until = now() + make_interval(secs => $3::double precision)
      where workspace_id = $1 and action_request_id = $2
        and status = 'pending' and ($4 or next_attempt_at <= now())
        and (lease_until is null or lease_until <= now())
      returning ${RECONCILE_CHECK_COLUMNS}`,
    [workspaceId, actionRequestId, leaseMs / 1000, closed],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The check, locked `for update` — `null` when there is none. */
export async function lockReconcileCheck(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ReconcileCheckRow | null> {
  const result = await client.query<ReconcileCheckDbRow>(
    `select ${RECONCILE_CHECK_COLUMNS} from action_request_reconcile_checks
      where workspace_id = $1 and action_request_id = $2
      for update`,
    [workspaceId, actionRequestId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** What an attempt's audit row carries besides the check's own fields — ids for the goal's
 *  timeline, and the error a person reads (already redacted and clipped by the caller). */
export interface ReconcileCheckAuditContext {
  readonly actorPrincipalId: string;
  readonly stepRunId: string | null;
  readonly goalRunId?: string;
  readonly error?: string;
}

function clippedCode(code: string | undefined): string | null {
  if (code === undefined) return null;
  return [...code].slice(0, RECONCILE_CHECK_ERROR_MAX).join('');
}

async function auditAttempt(
  client: PoolClient,
  workspaceId: string,
  check: ReconcileCheckRow,
  outcome: ActionRequestReconcileCheckStatus | 'retry',
  context: ReconcileCheckAuditContext,
  extra: Record<string, unknown>,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: context.actorPrincipalId,
    action: 'action_request.reconcile_check',
    resourceType: 'action_request',
    resourceId: check.actionRequestId,
    payload: {
      outcome,
      attempt: check.attempts,
      gatekeeperId: check.observationCheck.gatekeeperId,
      operation: check.observationCheck.operation,
      stepRunId: context.stepRunId,
      ...(context.goalRunId ? { goalRunId: context.goalRunId } : {}),
      ...(context.error ? { error: context.error } : {}),
      ...extra,
    },
  });
}

/** Puts a claimed check back: due again in `delayMs`, the lease released, `lastError` the code of
 *  what went wrong this time, and `observationId` — when this attempt observed without seeing the
 *  effect — the check's latest observation. Audited as a `retry`. */
export async function deferReconcileCheck(
  client: PoolClient,
  workspaceId: string,
  check: ReconcileCheckRow,
  input: { readonly delayMs: number; readonly lastError: string; readonly observationId?: string },
  context: ReconcileCheckAuditContext,
): Promise<void> {
  await client.query(
    `update action_request_reconcile_checks
        set next_attempt_at = now() + make_interval(secs => $3::double precision),
            lease_until = null, last_error = $4, observation_id = coalesce($5, observation_id)
      where workspace_id = $1 and action_request_id = $2`,
    [
      workspaceId,
      check.actionRequestId,
      input.delayMs / 1000,
      clippedCode(input.lastError),
      input.observationId ?? null,
    ],
  );
  await auditAttempt(client, workspaceId, check, 'retry', context, {
    code: clippedCode(input.lastError),
    retryInMs: input.delayMs,
    ...(input.observationId ? { observationId: input.observationId } : {}),
  });
}

/** Settles a pending check once — see the module comment. `observationId` is this attempt's
 *  observation; without one the check keeps its latest (an earlier attempt's) — required, one way
 *  or the other, for `seen` and `not_seen` (the evidence). `lastError` says why it is
 *  `unavailable`, or why the last attempt of a `not_seen` one did not observe. */
export async function settleReconcileCheck(
  client: PoolClient,
  workspaceId: string,
  check: ReconcileCheckRow,
  input: {
    readonly status: Exclude<ActionRequestReconcileCheckStatus, 'pending'>;
    readonly observationId?: string;
    readonly lastError?: string;
  },
  context: ReconcileCheckAuditContext,
): Promise<void> {
  await client.query(
    `update action_request_reconcile_checks
        set status = $3, observation_id = coalesce($4, observation_id), last_error = $5,
            lease_until = null,
            settled_at = now()
      where workspace_id = $1 and action_request_id = $2`,
    [
      workspaceId,
      check.actionRequestId,
      input.status,
      input.observationId ?? null,
      clippedCode(input.lastError),
    ],
  );
  const observationId = input.observationId ?? check.observationId;
  await auditAttempt(client, workspaceId, check, input.status, context, {
    ...(observationId ? { observationId } : {}),
    ...(input.lastError ? { code: clippedCode(input.lastError) } : {}),
  });
}
