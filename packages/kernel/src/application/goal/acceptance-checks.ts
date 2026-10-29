import type {
  FactCheck,
  GoalAcceptanceCheckKind,
  GoalAcceptanceCheckStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import type { AcceptanceCheck, StepAcceptanceCheck } from './plan.js';
import type { PlatformObservationCall } from './platform-observation.js';

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
 * settled once; `passed` only on an Observation of this check that satisfied its predicate — or,
 * for an absence check (S11 「门确认不存在」 B, `observe_absent`, goal/0011), one in which the gate
 * confirmed the thing is not there — on a Fact the database takes as its evidence (a fact check,
 * S11 GO4c, goal/0007), or on the requester's own Decision.
 *
 * **A step's checks** (S11 GO4b, `step_acceptance_checks`, goal/0006) are rows of the same shape,
 * the platform's checks only (observations, Facts), in rounds of their StepRun:
 * {@link openStepAcceptanceRound} as the step starts waiting on its acceptance (`advance.ts` phase
 * A), {@link supersedePendingStepAcceptanceChecks} once its round ends — the step stops waiting on
 * it, or the run stops running (`moves.ts`). An observation's claim, lock, deferral and settlement
 * are the functions above, for a key that names the StepRun
 * ({@link AcceptanceCheckKey}`.stepRunId`). Audited as `goal_run.step_acceptance_check` and
 * `goal_run.step_acceptance_round`, on the GoalRun with the step's key. The database holds a row to
 * its step's declared checks, its round to the step waiting on its acceptance at the attempt the
 * row verifies in a running run, and the step's success to every check of its latest round passed.
 *
 * **A fact check** (S11 GO4c, `fact_predicate`) is claimed, deferred and settled the same way: its
 * `fact_id` is the Fact it saw (the latest, while it is retried; the one it rests on, settled)
 * where an observation's `observation_id` is its Observation.
 */

/** The `observation_check` a check's row carries: the call of an observation (`observe_predicate`,
 *  `observe_absent`), as JSON; `null` for any other kind. */
function observationCallOf(check: AcceptanceCheck | StepAcceptanceCheck): string | null {
  return check.kind === 'observe_predicate' || check.kind === 'observe_absent'
    ? JSON.stringify(check.check)
    : null;
}

/** The `last_error` of a fact check's attempt that found no Fact that may serve as evidence — kept
 *  apart from a check that could not be made (a refusal) and from one that saw a Fact that did not
 *  satisfy its predicate (`failed`), in the rows, the audit and a pause's detail. */
export const FACT_NOT_OBSERVED = 'fact_not_observed';

/** The `last_error` of an absence check's attempt (S11 「门确认不存在」 B, `observe_absent`) in
 *  which the gate answered with data: the thing looked up is still there — seen, and not so, as a
 *  predicate that is not met; never a check that could not be made. */
export const TARGET_STILL_PRESENT = 'target_still_present';

export interface AcceptanceCheckRow {
  readonly workspaceId: string;
  readonly goalRunId: string;
  /** A step's check (S11 GO4b): its StepRun, and the attempt whose work it verifies; `null` for the
   *  goal's own. */
  readonly stepRunId: string | null;
  readonly stepAttempt: number | null;
  readonly round: number;
  readonly checkKey: string;
  readonly planRevision: number;
  readonly kind: GoalAcceptanceCheckKind;
  /** `observe_predicate` / `observe_absent`: what is observed — with its predicate, or (an
   *  absence check) none; `null` otherwise. */
  readonly observationCheck: PlatformObservationCall | null;
  /** `fact_predicate` (S11 GO4c): the Fact judged; `null` otherwise. */
  readonly factCheck: FactCheck | null;
  /** `requester_confirm`: what the requester is asked; `null` for an observation. */
  readonly prompt: string | null;
  readonly status: GoalAcceptanceCheckStatus;
  readonly attempts: number;
  readonly firstAttemptAt: Date | null;
  readonly nextAttemptAt: Date;
  readonly leaseUntil: Date | null;
  /** The latest Observation — the evidence a settled observation rests on. */
  readonly observationId: string | null;
  /** The latest Fact seen — the evidence a settled fact check rests on. */
  readonly factId: string | null;
  /** The requester's Decision a passed confirmation rests on. */
  readonly decisionId: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

interface AcceptanceCheckDbRow {
  workspace_id: string;
  goal_run_id: string;
  step_run_id: string | null;
  step_attempt: number | null;
  round: number;
  check_key: string;
  plan_revision: number;
  kind: GoalAcceptanceCheckKind;
  observation_check: PlatformObservationCall | null;
  fact_check: FactCheck | null;
  prompt: string | null;
  status: GoalAcceptanceCheckStatus;
  attempts: number;
  first_attempt_at: Date | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  observation_id: string | null;
  fact_id: string | null;
  decision_id: string | null;
  last_error: string | null;
  created_at: Date;
  settled_at: Date | null;
}

const ACCEPTANCE_CHECK_COLUMNS =
  'workspace_id, goal_run_id, null::uuid as step_run_id, null::int as step_attempt, round, ' +
  'check_key, plan_revision, kind, observation_check, fact_check, prompt, status, attempts, ' +
  'first_attempt_at, next_attempt_at, lease_until, observation_id, fact_id, decision_id, ' +
  'last_error, created_at, settled_at';

/** A step's row in the shape of a goal's: it has no prompt and no decision. */
const STEP_ACCEPTANCE_CHECK_COLUMNS =
  'workspace_id, goal_run_id, step_run_id, step_attempt, round, check_key, plan_revision, kind, ' +
  'observation_check, fact_check, null::text as prompt, status, attempts, first_attempt_at, ' +
  'next_attempt_at, lease_until, observation_id, fact_id, null::uuid as decision_id, last_error, ' +
  'created_at, settled_at';

/** One row: the goal's own check, or — with `stepRunId` — a step's (S11 GO4b). */
export interface AcceptanceCheckKey {
  readonly goalRunId: string;
  readonly stepRunId?: string | null;
  readonly round: number;
  readonly checkKey: string;
}

/** The table, columns and key condition (`$1` the workspace, `$2`–`$4` from {@link keyValues}) of
 *  `key`'s row. */
function rowOf(key: AcceptanceCheckKey): {
  readonly table: string;
  readonly columns: string;
  readonly where: string;
} {
  return key.stepRunId
    ? {
        table: 'step_acceptance_checks',
        columns: STEP_ACCEPTANCE_CHECK_COLUMNS,
        where: 'workspace_id = $1 and step_run_id = $2 and round = $3 and check_key = $4',
      }
    : {
        table: 'goal_acceptance_checks',
        columns: ACCEPTANCE_CHECK_COLUMNS,
        where: 'workspace_id = $1 and goal_run_id = $2 and round = $3 and check_key = $4',
      };
}

function keyValues(workspaceId: string, key: AcceptanceCheckKey): unknown[] {
  return [workspaceId, key.stepRunId || key.goalRunId, key.round, key.checkKey];
}

function mapRow(row: AcceptanceCheckDbRow): AcceptanceCheckRow {
  return {
    workspaceId: row.workspace_id,
    goalRunId: row.goal_run_id,
    stepRunId: row.step_run_id,
    stepAttempt: row.step_attempt,
    round: row.round,
    checkKey: row.check_key,
    planRevision: row.plan_revision,
    kind: row.kind,
    observationCheck: row.observation_check,
    factCheck: row.fact_check,
    prompt: row.prompt,
    status: row.status,
    attempts: row.attempts,
    firstAttemptAt: row.first_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    observationId: row.observation_id,
    factId: row.fact_id,
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
    action: check.stepRunId ? 'goal_run.step_acceptance_check' : 'goal_run.acceptance_check',
    resourceType: 'goal_run',
    resourceId: check.goalRunId,
    payload: {
      outcome,
      ...(check.stepRunId ? { stepRunId: check.stepRunId, stepAttempt: check.stepAttempt } : {}),
      round: check.round,
      checkKey: check.checkKey,
      kind: check.kind,
      ...(check.kind !== 'requester_confirm' ? { attempt: check.attempts } : {}),
      ...(check.observationCheck
        ? {
            gatekeeperId: check.observationCheck.gatekeeperId,
            operation: check.observationCheck.operation,
          }
        : {}),
      ...(check.factCheck ? { linkType: check.factCheck.linkType } : {}),
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
          fact_check, prompt)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       returning ${ACCEPTANCE_CHECK_COLUMNS}`,
      [
        workspaceId,
        input.goalRunId,
        round,
        check.key,
        input.planRevision,
        check.kind,
        observationCallOf(check),
        check.kind === 'fact_predicate' ? JSON.stringify(check.fact) : null,
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

/** Claims a check the platform makes (an observation, a fact check) for one attempt: `pending`,
 *  due, not leased — or `null`. The attempt number grows by one, the first claim sets
 *  `first_attempt_at`, and the lease runs `leaseMs`. */
export async function claimAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  key: AcceptanceCheckKey,
  leaseMs: number,
): Promise<AcceptanceCheckRow | null> {
  const row = rowOf(key);
  const result = await client.query<AcceptanceCheckDbRow>(
    `update ${row.table}
        set attempts = attempts + 1,
            first_attempt_at = coalesce(first_attempt_at, now()),
            lease_until = now() + make_interval(secs => $5::double precision)
      where ${row.where}
        and kind in ('observe_predicate', 'observe_absent', 'fact_predicate')
        and status = 'pending'
        and next_attempt_at <= now()
        and (lease_until is null or lease_until <= now())
      returning ${row.columns}`,
    [...keyValues(workspaceId, key), leaseMs / 1000],
  );
  const claimed = result.rows[0];
  return claimed ? mapRow(claimed) : null;
}

/** The row, locked `for update` — `null` when there is none. */
export async function lockAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  key: AcceptanceCheckKey,
): Promise<AcceptanceCheckRow | null> {
  const row = rowOf(key);
  const result = await client.query<AcceptanceCheckDbRow>(
    `select ${row.columns} from ${row.table} where ${row.where} for update`,
    keyValues(workspaceId, key),
  );
  const locked = result.rows[0];
  return locked ? mapRow(locked) : null;
}

/** Puts a claimed check back: due again in `delayMs`, the lease released, `lastError` the code of
 *  what went wrong this time, and `observationId` / `factId` — when this attempt saw something
 *  without the predicate holding — the row's latest observation or Fact. Audited as a `retry`
 *  (with `detail`: a fact check's evaluation). */
export async function deferAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheckRow,
  input: {
    readonly delayMs: number;
    readonly lastError: string;
    readonly observationId?: string;
    readonly factId?: string;
    readonly detail?: Record<string, unknown>;
  },
  actorPrincipalId: string,
  error?: string | null,
): Promise<void> {
  const row = rowOf(check);
  await client.query(
    `update ${row.table}
        set next_attempt_at = now() + make_interval(secs => $5::double precision),
            lease_until = null, last_error = $6, observation_id = coalesce($7, observation_id),
            fact_id = coalesce($8, fact_id)
      where ${row.where}`,
    [
      ...keyValues(workspaceId, check),
      input.delayMs / 1000,
      clippedCode(input.lastError),
      input.observationId ?? null,
      input.factId ?? null,
    ],
  );
  await auditCheck(client, workspaceId, check, 'retry', actorPrincipalId, {
    code: clippedCode(input.lastError),
    retryInMs: input.delayMs,
    ...(input.observationId ? { observationId: input.observationId } : {}),
    ...(input.factId ? { factId: input.factId } : {}),
    ...(input.detail ?? {}),
    ...(error ? { error } : {}),
  });
}

/** Settles a pending check the platform makes once: `passed` (this attempt's `observationId` /
 *  `factId` satisfied the predicate), `failed` (the latest one seen did not — this attempt's, or
 *  an earlier one's) or `unavailable` (`lastError` says why). Audited with `detail`: a fact check's
 *  evaluation. */
export async function settleAcceptanceCheck(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheckRow,
  input: {
    readonly status: 'passed' | 'failed' | 'unavailable';
    readonly observationId?: string;
    readonly factId?: string;
    readonly lastError?: string;
    readonly detail?: Record<string, unknown>;
  },
  actorPrincipalId: string,
  error?: string | null,
): Promise<void> {
  const row = rowOf(check);
  await client.query(
    `update ${row.table}
        set status = $5, observation_id = coalesce($6, observation_id), last_error = $7,
            fact_id = coalesce($8, fact_id), lease_until = null, settled_at = now()
      where ${row.where}`,
    [
      ...keyValues(workspaceId, check),
      input.status,
      input.observationId ?? null,
      clippedCode(input.lastError),
      input.factId ?? null,
    ],
  );
  const observationId = input.observationId ?? check.observationId;
  const factId = input.factId ?? check.factId;
  await auditCheck(client, workspaceId, check, input.status, actorPrincipalId, {
    ...(observationId ? { observationId } : {}),
    ...(factId ? { factId } : {}),
    ...(input.lastError ? { code: clippedCode(input.lastError) } : {}),
    ...(input.detail ?? {}),
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

// ----- a step's checks (S11 GO4b) -----------------------------------------------------------

/** Every row of the run's steps, by StepRun, round and then key. */
export async function listStepAcceptanceChecks(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly AcceptanceCheckRow[]> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `select ${STEP_ACCEPTANCE_CHECK_COLUMNS} from step_acceptance_checks
      where workspace_id = $1 and goal_run_id = $2
      order by created_at, step_run_id, round, check_key`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapRow);
}

/** The rows of the step's latest round that opened at or after `since` — the round of the step's
 *  current wait on its acceptance (`step_runs.updated_at` is the time it started waiting; a round
 *  opens in that transaction or later) — by key; empty when there is none. */
export async function readCurrentStepAcceptanceRound(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
  since: Date,
): Promise<readonly AcceptanceCheckRow[]> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `select ${STEP_ACCEPTANCE_CHECK_COLUMNS} from step_acceptance_checks c
      where c.workspace_id = $1 and c.step_run_id = $2 and c.created_at >= $3
        and c.round = (select max(m.round) from step_acceptance_checks m
                        where m.workspace_id = $1 and m.step_run_id = $2)
      order by c.check_key`,
    [workspaceId, stepRunId, since],
  );
  return result.rows.map(mapRow);
}

/**
 * Opens round `latest + 1` of a step waiting on its acceptance: one `pending` row per check of
 * `checks` (the step's declared `acceptance`, as its plan entry has them), for attempt
 * `stepAttempt`. Rows of the step's earlier rounds still pending are then superseded. Audited once,
 * as `goal_run.step_acceptance_round`. Returns the new rows.
 */
export async function openStepAcceptanceRound(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly goalRunId: string;
    readonly stepRunId: string;
    readonly stepKey: string;
    readonly stepAttempt: number;
    /** The revision that introduced the step: its definition. */
    readonly planRevision: number;
    readonly checks: readonly StepAcceptanceCheck[];
    readonly actorPrincipalId: string;
  },
): Promise<readonly AcceptanceCheckRow[]> {
  const latest = await client.query<{ round: number | null }>(
    `select max(round) as round from step_acceptance_checks
      where workspace_id = $1 and step_run_id = $2`,
    [workspaceId, input.stepRunId],
  );
  const round = (latest.rows[0]?.round ?? 0) + 1;
  const rows: AcceptanceCheckRow[] = [];
  for (const check of input.checks) {
    const inserted = await client.query<AcceptanceCheckDbRow>(
      `insert into step_acceptance_checks
         (workspace_id, goal_run_id, step_run_id, step_attempt, round, check_key, plan_revision,
          kind, observation_check, fact_check)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       returning ${STEP_ACCEPTANCE_CHECK_COLUMNS}`,
      [
        workspaceId,
        input.goalRunId,
        input.stepRunId,
        input.stepAttempt,
        round,
        check.key,
        input.planRevision,
        check.kind,
        observationCallOf(check),
        check.kind === 'fact_predicate' ? JSON.stringify(check.fact) : null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('openStepAcceptanceRound: INSERT ... RETURNING produced no row');
    rows.push(mapRow(row));
  }
  const superseded = await supersedePendingStepAcceptanceChecks(client, workspaceId, {
    goalRunId: input.goalRunId,
    stepRunId: input.stepRunId,
    actorPrincipalId: input.actorPrincipalId,
    reason: 'newer_round',
    beforeRound: round,
  });
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actorPrincipalId,
    action: 'goal_run.step_acceptance_round',
    resourceType: 'goal_run',
    resourceId: input.goalRunId,
    payload: {
      by: 'advancer',
      stepRunId: input.stepRunId,
      stepKey: input.stepKey,
      stepAttempt: input.stepAttempt,
      round,
      planRevision: input.planRevision,
      checks: input.checks.map((check) => ({ key: check.key, kind: check.kind })),
      ...(superseded > 0 ? { supersededChecks: superseded } : {}),
    },
  });
  return rows;
}

/**
 * Supersedes the `pending` rows of the run's steps — of one step (`stepRunId`) or of all of them:
 * once a step stops waiting on its acceptance (`step_moved`) or the run stops running
 * (`goal_moved`; both `moves.ts`, in the transaction that moves it), one an earlier release left
 * behind (`step_left_acceptance`, `acceptance-check.ts`), or those of a step's rounds before
 * `beforeRound` as that round opens (`newer_round`). Each row is audited. Returns how many.
 */
export async function supersedePendingStepAcceptanceChecks(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly goalRunId: string;
    readonly stepRunId?: string;
    readonly actorPrincipalId: string;
    readonly reason: 'goal_moved' | 'step_moved' | 'newer_round' | 'step_left_acceptance';
    readonly beforeRound?: number;
  },
): Promise<number> {
  const result = await client.query<AcceptanceCheckDbRow>(
    `update step_acceptance_checks
        set status = 'superseded', lease_until = null, settled_at = now()
      where workspace_id = $1 and goal_run_id = $2 and status = 'pending'
        and ($3::uuid is null or step_run_id = $3::uuid)
        and ($4::int is null or round < $4::int)
      returning ${STEP_ACCEPTANCE_CHECK_COLUMNS}`,
    [workspaceId, input.goalRunId, input.stepRunId ?? null, input.beforeRound ?? null],
  );
  for (const row of result.rows) {
    await auditCheck(client, workspaceId, mapRow(row), 'superseded', input.actorPrincipalId, {
      reason: input.reason,
    });
  }
  return result.rows.length;
}
