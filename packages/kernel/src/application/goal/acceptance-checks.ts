import type {
  GoalAcceptanceCheckKind,
  GoalAcceptanceCheckStatus,
  ObservationCheck,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import type { AcceptanceCheck } from './plan.js';

/**
 * application/goal/acceptance-checks (S11 GO4a, plan §4.6, I-G5): the rows of a GoalRun's
 * verification rounds (`goal_acceptance_checks`, migrations/goal/0005) and their audit trail. When a
 * round opens and what a settled round means is the advance's (`advance.ts` phase V); making an
 * observation is `acceptance-check.ts`'s; a person's confirmation is `acceptance.ts`'s. This module
 * owns the writes:
 *
 *   - {@link openAcceptanceRound} — a round, one `pending` row per check, as the run enters (or is
 *     found in) `verifying`; rows of earlier rounds still pending are superseded.
 *   - {@link claimAcceptanceCheck} / {@link deferAcceptanceCheck} / {@link settleAcceptanceCheck} —
 *     an observation's attempts, as for a reconcile check (`governance/approval/reconcile-checks.ts`:
 *     the attempt number grows, a lease covers the attempt, a kernel that dies mid-attempt leaves a
 *     lease that runs out).
 *   - {@link passAcceptanceConfirmation} — the requester's confirmation, on their Decision.
 *   - {@link supersedePendingAcceptanceChecks} — every pending row of a run, once it leaves
 *     `verifying` (`moves.ts` calls it on every such move, so no row of an ended round stays
 *     pending, and nothing is observed for a paused run).
 *
 * Every end of an attempt and every settlement is audited (`goal_run.acceptance_check`, on the
 * GoalRun, with the round and the check's key) — the goal's timeline. The database guard holds the
 * rest: created pending in the run's latest round while it is verifying on the plan the row names;
 * settled once; `passed` only on an Observation of this check that satisfied its predicate, or on
 * the requester's own Decision.
 */

export interface AcceptanceCheckRow {
  readonly workspaceId: string;
  readonly goalRunId: string;
  readonly round: number;
  readonly checkKey: string;
  readonly planRevision: number;
  readonly kind: GoalAcceptanceCheckKind;
  /** `observe_predicate`: what is observed; `null` for a confirmation. */
  readonly observationCheck: ObservationCheck | null;
  /** `requester_confirm`: what the requester is asked; `null` for an observation. */
  readonly prompt: string | null;
  readonly status: GoalAcceptanceCheckStatus;
  readonly attempts: number;
  readonly firstAttemptAt: Date | null;
  readonly nextAttemptAt: Date;
  readonly leaseUntil: Date | null;
  /** The latest Observation — the evidence a settled observation rests on. */
  readonly observationId: string | null;
  /** The requester's Decision a passed confirmation rests on. */
  readonly decisionId: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

interface AcceptanceCheckDbRow {
  workspace_id: string;
  goal_run_id: string;
  round: number;
  check_key: string;
  plan_revision: number;
  kind: GoalAcceptanceCheckKind;
  observation_check: ObservationCheck | null;
  prompt: string | null;
  status: GoalAcceptanceCheckStatus;
  attempts: number;
  first_attempt_at: Date | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  observation_id: string | null;
  decision_id: string | null;
  last_error: string | null;
  created_at: Date;
  settled_at: Date | null;
}

const ACCEPTANCE_CHECK_COLUMNS =
  'workspace_id, goal_run_id, round, check_key, plan_revision, kind, observation_check, prompt, ' +
  'status, attempts, first_attempt_at, next_attempt_at, lease_until, observation_id, decision_id, ' +
  'last_error, created_at, settled_at';

function mapRow(row: AcceptanceCheckDbRow): AcceptanceCheckRow {
  return {
    workspaceId: row.workspace_id,
    goalRunId: row.goal_run_id,
    round: row.round,
    checkKey: row.check_key,
    planRevision: row.plan_revision,
    kind: row.kind,
    observationCheck: row.observation_check,
    prompt: row.prompt,
    status: row.status,
    attempts: row.attempts,
    firstAttemptAt: row.first_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    observationId: row.observation_id,
    decisionId: row.decision_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/** The longest `last_error` kept (goal/0005's CHECK): a short code, never a gate's text. */
export const ACCEPTANCE_CHECK_ERROR_MAX = 200;

function clippedCode(code: string | undefined): string | null {
  if (code === undefined) return null;
  return [...code].slice(0, ACCEPTANCE_CHECK_ERROR_MAX).join('');
}

/** Every row of the run, by round and then key. */
export async function listAcceptanceChecks(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly AcceptanceCheckRow[]> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `select ${ACCEPTANCE_CHECK_COLUMNS} from goal_acceptance_checks
      where workspace_id = $1 and goal_run_id = $2
      order by round, check_key`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapRow);
}

/** The rows of the run's latest round that opened at or after `since` — the round of the run's
 *  current stay in `verifying` (`goal_runs.updated_at` is the time it entered; a round opens in
 *  that transaction or later) — by key; empty when there is none. A round older than `since`
 *  belongs to an earlier stay (left pending by a release that did not supersede it). */
export async function readCurrentAcceptanceRound(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  since: Date,
): Promise<readonly AcceptanceCheckRow[]> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `select ${ACCEPTANCE_CHECK_COLUMNS} from goal_acceptance_checks c
      where c.workspace_id = $1 and c.goal_run_id = $2 and c.created_at >= $3
        and c.round = (select max(m.round) from goal_acceptance_checks m
                        where m.workspace_id = $1 and m.goal_run_id = $2)
      order by c.check_key`,
    [workspaceId, goalRunId, since],
  );
  return result.rows.map(mapRow);
}

async function auditCheck(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheckRow,
  outcome: GoalAcceptanceCheckStatus | 'retry',
  actorPrincipalId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId,
    action: 'goal_run.acceptance_check',
    resourceType: 'goal_run',
    resourceId: check.goalRunId,
    payload: {
      outcome,
      round: check.round,
      checkKey: check.checkKey,
      kind: check.kind,
      ...(check.kind === 'observe_predicate' ? { attempt: check.attempts } : {}),
      ...(check.observationCheck
        ? {
            gatekeeperId: check.observationCheck.gatekeeperId,
            operation: check.observationCheck.operation,
          }
        : {}),
      ...extra,
    },
  });
}

/**
 * Opens round `latest + 1` of a `verifying` run on `planRevision`: one `pending` row per check of
 * `checks` (`plan.ts` `roundAcceptance`). Rows still pending from earlier rounds are then
 * superseded (the guard lets a row of a round go only once a newer one exists). Audited once, as
 * `goal_run.acceptance_round`. Returns the new rows.
 */
export async function openAcceptanceRound(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly goalRunId: string;
    readonly planRevision: number;
    readonly checks: readonly AcceptanceCheck[];
    readonly actorPrincipalId: string;
  },
): Promise<readonly AcceptanceCheckRow[]> {
  const latest = await client.query<{ round: number | null }>(
    `select max(round) as round from goal_acceptance_checks
      where workspace_id = $1 and goal_run_id = $2`,
    [workspaceId, input.goalRunId],
  );
  const round = (latest.rows[0]?.round ?? 0) + 1;
  const rows: AcceptanceCheckRow[] = [];
  for (const check of input.checks) {
    const inserted = await client.query<AcceptanceCheckDbRow>(
      `insert into goal_acceptance_checks
         (workspace_id, goal_run_id, round, check_key, plan_revision, kind, observation_check,
          prompt)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       returning ${ACCEPTANCE_CHECK_COLUMNS}`,
      [
        workspaceId,
        input.goalRunId,
        round,
        check.key,
        input.planRevision,
        check.kind,
        check.kind === 'observe_predicate' ? JSON.stringify(check.check) : null,
        check.kind === 'requester_confirm' ? check.prompt : null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('openAcceptanceRound: INSERT ... RETURNING produced no row');
    rows.push(mapRow(row));
  }
  const superseded = await supersedePendingAcceptanceChecks(client, workspaceId, {
    goalRunId: input.goalRunId,
    actorPrincipalId: input.actorPrincipalId,
    reason: 'newer_round',
    beforeRound: round,
  });
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actorPrincipalId,
    action: 'goal_run.acceptance_round',
    resourceType: 'goal_run',
    resourceId: input.goalRunId,
    payload: {
      by: 'advancer',
      round,
      planRevision: input.planRevision,
      checks: input.checks.map((check) => ({ key: check.key, kind: check.kind })),
      ...(superseded > 0 ? { supersededChecks: superseded } : {}),
    },
  });
  return rows;
}

/**
 * Supersedes the `pending` rows of the run: all of them once the run left `verifying`
 * (`goal_moved`: `moves.ts`, in the transaction that moves it; `goal_left_verifying`: one an
 * earlier release left behind, `acceptance-check.ts`), or those of rounds before `beforeRound` as
 * that round opens (`newer_round`). Each row is audited. Returns how many.
 */
export async function supersedePendingAcceptanceChecks(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly goalRunId: string;
    readonly actorPrincipalId: string;
    readonly reason: 'goal_moved' | 'newer_round' | 'goal_left_verifying';
    readonly beforeRound?: number;
  },
): Promise<number> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `update goal_acceptance_checks
        set status = 'superseded', lease_until = null, settled_at = now()
      where workspace_id = $1 and goal_run_id = $2 and status = 'pending'
        and ($3::int is null or round < $3::int)
      returning ${ACCEPTANCE_CHECK_COLUMNS}`,
    [workspaceId, input.goalRunId, input.beforeRound ?? null],
  );
  for (const row of result.rows) {
    await auditCheck(client, workspaceId, mapRow(row), 'superseded', input.actorPrincipalId, {
      reason: input.reason,
    });
  }
  return result.rows.length;
}

/** Claims an observation for one attempt: `pending`, due, not leased — or `null`. The attempt
 *  number grows by one, the first claim sets `first_attempt_at`, and the lease runs `leaseMs`. */
export async function claimAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  key: { readonly goalRunId: string; readonly round: number; readonly checkKey: string },
  leaseMs: number,
): Promise<AcceptanceCheckRow | null> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `update goal_acceptance_checks
        set attempts = attempts + 1,
            first_attempt_at = coalesce(first_attempt_at, now()),
            lease_until = now() + make_interval(secs => $5::double precision)
      where workspace_id = $1 and goal_run_id = $2 and round = $3 and check_key = $4
        and kind = 'observe_predicate' and status = 'pending' and next_attempt_at <= now()
        and (lease_until is null or lease_until <= now())
      returning ${ACCEPTANCE_CHECK_COLUMNS}`,
    [workspaceId, key.goalRunId, key.round, key.checkKey, leaseMs / 1000],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The row, locked `for update` — `null` when there is none. */
export async function lockAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  key: { readonly goalRunId: string; readonly round: number; readonly checkKey: string },
): Promise<AcceptanceCheckRow | null> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `select ${ACCEPTANCE_CHECK_COLUMNS} from goal_acceptance_checks
      where workspace_id = $1 and goal_run_id = $2 and round = $3 and check_key = $4
      for update`,
    [workspaceId, key.goalRunId, key.round, key.checkKey],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Puts a claimed observation back: due again in `delayMs`, the lease released, `lastError` the
 *  code of what went wrong this time, and `observationId` — when this attempt observed without the
 *  predicate holding — the row's latest observation. Audited as a `retry`. */
export async function deferAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheckRow,
  input: { readonly delayMs: number; readonly lastError: string; readonly observationId?: string },
  actorPrincipalId: string,
  error?: string | null,
): Promise<void> {
  await client.query(
    `update goal_acceptance_checks
        set next_attempt_at = now() + make_interval(secs => $5::double precision),
            lease_until = null, last_error = $6, observation_id = coalesce($7, observation_id)
      where workspace_id = $1 and goal_run_id = $2 and round = $3 and check_key = $4`,
    [
      workspaceId,
      check.goalRunId,
      check.round,
      check.checkKey,
      input.delayMs / 1000,
      clippedCode(input.lastError),
      input.observationId ?? null,
    ],
  );
  await auditCheck(client, workspaceId, check, 'retry', actorPrincipalId, {
    code: clippedCode(input.lastError),
    retryInMs: input.delayMs,
    ...(input.observationId ? { observationId: input.observationId } : {}),
    ...(error ? { error } : {}),
  });
}

/** Settles a pending observation once: `passed` (this attempt's `observationId` satisfied the
 *  predicate), `failed` (the latest observation did not — this attempt's, or an earlier one's) or
 *  `unavailable` (`lastError` says why). */
export async function settleAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheckRow,
  input: {
    readonly status: 'passed' | 'failed' | 'unavailable';
    readonly observationId?: string;
    readonly lastError?: string;
  },
  actorPrincipalId: string,
  error?: string | null,
): Promise<void> {
  await client.query(
    `update goal_acceptance_checks
        set status = $5, observation_id = coalesce($6, observation_id), last_error = $7,
            lease_until = null, settled_at = now()
      where workspace_id = $1 and goal_run_id = $2 and round = $3 and check_key = $4`,
    [
      workspaceId,
      check.goalRunId,
      check.round,
      check.checkKey,
      input.status,
      input.observationId ?? null,
      clippedCode(input.lastError),
    ],
  );
  const observationId = input.observationId ?? check.observationId;
  await auditCheck(client, workspaceId, check, input.status, actorPrincipalId, {
    ...(observationId ? { observationId } : {}),
    ...(input.lastError ? { code: clippedCode(input.lastError) } : {}),
    ...(error ? { error } : {}),
  });
}

/** Passes a pending `requester_confirm` row on the requester's Decision `decisionId`. */
export async function passAcceptanceConfirmation(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheckRow,
  decisionId: string,
  actorPrincipalId: string,
): Promise<void> {
  await client.query(
    `update goal_acceptance_checks
        set status = 'passed', decision_id = $5, settled_at = now()
      where workspace_id = $1 and goal_run_id = $2 and round = $3 and check_key = $4`,
    [workspaceId, check.goalRunId, check.round, check.checkKey, decisionId],
  );
  await auditCheck(client, workspaceId, check, 'passed', actorPrincipalId, {
    by: 'person',
    decisionId,
  });
}
