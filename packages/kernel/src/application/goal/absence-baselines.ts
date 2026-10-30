import { isDeepStrictEqual } from 'node:util';
import type {
  GoalAbsenceBaselineStatus,
  ObservationAbsenceCheck,
  StepRunStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { ACCEPTANCE_CHECK_ERROR_MAX } from './acceptance-checks.js';
import { GoalPlanSchema } from './plan.js';
import type { StepRunRow } from './types.js';

/**
 * application/goal/absence-baselines (S11 「门确认不存在」 B-c, goal/0012, I-AB1): the "it was there
 * before" baselines of a GoalRun's absence checks (`observe_absent`, B-b). The gate answering "not
 * there" says nothing about whether the thing ever was — params that name something that never
 * existed are answered so at once — so before the goal's work starts the platform looks with the
 * same call, and an absence check passes only on a baseline that saw the thing (the database holds
 * both tables to it). Making the observation is `absence-baseline.ts`'s; what a baseline means for
 * the run is the advance's (`advance.ts`, before phase D). This module owns the rows:
 *
 *   - {@link requiredAbsenceChecks} — the absence checks the plan in force declares that still
 *     need a baseline: the goal's own, and those of its steps that have not ended (a step that
 *     succeeded passed its checks; one skipped or cancelled will not be verified).
 *   - {@link ensureAbsenceBaselines} — a `pending` take for every such check whose latest take is
 *     missing, superseded or of another call (a revision changed the call), and — on the
 *     requester's resume (`retake`) — one that did not see the thing (`never_seen_present`,
 *     `unavailable`). A revision that keeps a check's call keeps its baseline: by then the goal's own
 *     work may have removed the thing, and a new look would say it never was. A pending take whose
 *     call the plan in force no longer declares is superseded.
 *   - {@link claimAbsenceBaseline} / {@link deferAbsenceBaseline} / {@link settleAbsenceBaseline}
 *     — the observation's attempts, as an acceptance check's (`acceptance-checks.ts`).
 *   - {@link supersedePendingAbsenceBaselines} — every pending take of a run, once it stops running
 *     (`moves.ts`): nothing is observed for a run that is not running, and its resume takes them
 *     again.
 *
 * Every take, end of an attempt and settlement is audited (`goal_run.absence_baseline`, on the
 * GoalRun, with the check's step key and key) — the goal's timeline.
 */

/** The `last_error` of an absence check (`observe_absent`) settled `unavailable` without a call:
 *  the run has no baseline of its call that saw the thing (I-AB1) — nothing its absence now could
 *  show was this goal's doing. */
export const NEVER_SEEN_PRESENT = 'never_seen_present';

/** The `last_error` of a take settled `unavailable` because the gate answered with data that does
 *  not show the thing there (`absence-baseline.ts` `presenceShown`, legacy 507). */
export const PRESENCE_NOT_CONFIRMED = 'presence_not_confirmed';

/** A step that ended needs no baseline any more: it passed its checks, or will not be verified. */
const ENDED_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  'succeeded',
  'skipped',
  'cancelled',
]);

/** A baseline that did not see the thing: the check it is for cannot pass on it. */
const FAILED_BASELINE_STATUSES: ReadonlySet<GoalAbsenceBaselineStatus> = new Set([
  'never_seen_present',
  'unavailable',
]);

/** An absence check of the plan in force, named as the plan names it. */
export interface AbsenceBaselineCheck {
  /** The step whose check this is; `null` for the goal's own. */
  readonly stepKey: string | null;
  readonly checkKey: string;
  readonly call: ObservationAbsenceCheck;
}

export interface AbsenceBaselineRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly goalRunId: string;
  readonly stepKey: string | null;
  readonly checkKey: string;
  /** Which time the platform takes this check's baseline: 1, then one more per retake. */
  readonly take: number;
  readonly call: ObservationAbsenceCheck;
  readonly status: GoalAbsenceBaselineStatus;
  readonly attempts: number;
  readonly firstAttemptAt: Date | null;
  readonly nextAttemptAt: Date;
  readonly leaseUntil: Date | null;
  /** What the gate answered — set once the baseline saw the thing or saw it was not there. */
  readonly observationId: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

interface AbsenceBaselineDbRow {
  workspace_id: string;
  id: string;
  goal_run_id: string;
  step_key: string | null;
  check_key: string;
  take: number;
  observation_check: ObservationAbsenceCheck;
  status: GoalAbsenceBaselineStatus;
  attempts: number;
  first_attempt_at: Date | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  observation_id: string | null;
  last_error: string | null;
  created_at: Date;
  settled_at: Date | null;
}

const COLUMNS =
  'workspace_id, id, goal_run_id, step_key, check_key, take, observation_check, status, ' +
  'attempts, first_attempt_at, next_attempt_at, lease_until, observation_id, last_error, ' +
  'created_at, settled_at';

function mapRow(row: AbsenceBaselineDbRow): AbsenceBaselineRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    goalRunId: row.goal_run_id,
    stepKey: row.step_key,
    checkKey: row.check_key,
    take: row.take,
    call: row.observation_check,
    status: row.status,
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

function clippedCode(code: string | undefined): string | null {
  if (code === undefined) return null;
  return [...code].slice(0, ACCEPTANCE_CHECK_ERROR_MAX).join('');
}

/** One check's name: its step's key (empty for the goal's own — a step key never is) and its own. */
function checkName(check: { readonly stepKey: string | null; readonly checkKey: string }): string {
  return `${check.stepKey ?? ''}\u0000${check.checkKey}`;
}

/** Whether two calls are the same — compared as JSON values, as goal/0012 compares them. */
export function sameAbsenceCall(a: ObservationAbsenceCheck, b: ObservationAbsenceCheck): boolean {
  return isDeepStrictEqual(a, b);
}

/** Every absence check `plan` (a stored `plan_revisions.plan`) declares — the goal's own, then each
 *  step's in plan order — or `null` when the stored plan is not a valid plan. */
export function declaredAbsenceChecks(plan: unknown): readonly AbsenceBaselineCheck[] | null {
  const parsed = GoalPlanSchema.safeParse(plan);
  if (!parsed.success) return null;
  const checks: AbsenceBaselineCheck[] = [];
  for (const check of parsed.data.acceptance ?? []) {
    if (check.kind === 'observe_absent') {
      checks.push({ stepKey: null, checkKey: check.key, call: check.check });
    }
  }
  for (const entry of parsed.data.steps) {
    for (const check of entry.acceptance ?? []) {
      if (check.kind === 'observe_absent') {
        checks.push({ stepKey: entry.key, checkKey: check.key, call: check.check });
      }
    }
  }
  return checks;
}

/** The absence checks `plan` (the one in force) declares that still need a baseline: the goal's
 *  own, and each step's whose StepRun (of `steps`, the run's) has not ended — or `null` when the
 *  stored plan is not a valid plan. */
export function requiredAbsenceChecks(
  plan: unknown,
  steps: readonly StepRunRow[],
): readonly AbsenceBaselineCheck[] | null {
  const declared = declaredAbsenceChecks(plan);
  if (!declared) return null;
  return declared.filter((check) => {
    if (check.stepKey === null) return true;
    const step = steps.find((s) => s.stepKey === check.stepKey && s.status !== 'superseded');
    return !step || !ENDED_STEP_STATUSES.has(step.status);
  });
}

/** Every take of the run, by step key (the goal's first), key and take. */
export async function listAbsenceBaselines(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly AbsenceBaselineRow[]> {
  const result = await client.query<AbsenceBaselineDbRow>(
    `select ${COLUMNS} from goal_absence_baselines
      where workspace_id = $1 and goal_run_id = $2
      order by coalesce(step_key, ''), check_key, take`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapRow);
}

/** The latest take of each of the run's checks, by {@link checkName}. */
async function latestTakes(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<Map<string, AbsenceBaselineRow>> {
  const latest = new Map<string, AbsenceBaselineRow>();
  for (const row of await listAbsenceBaselines(client, workspaceId, goalRunId)) {
    latest.set(checkName(row), row);
  }
  return latest;
}

/** A check's current baseline with `look`: which look with that call it is — the looks made
 *  before it with the same call, takes superseded before they settled not counted, plus one. A take
 *  counts per check, so after the call changed the first look is take 2 or later, yet look 1
 *  (#786 UX P3). */
export type AbsenceBaselineLook = AbsenceBaselineRow & { readonly look: number };

/** The baseline each of `checks` goes by: its latest take, when that take is of the call the check
 *  makes — otherwise none (the run has not taken one since the call changed). */
export async function currentAbsenceBaselines(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  checks: readonly AbsenceBaselineCheck[],
): Promise<ReadonlyMap<string, AbsenceBaselineLook>> {
  const takes = new Map<string, AbsenceBaselineRow[]>();
  for (const row of await listAbsenceBaselines(client, workspaceId, goalRunId)) {
    const own = takes.get(checkName(row)) ?? [];
    own.push(row);
    takes.set(checkName(row), own);
  }
  const current = new Map<string, AbsenceBaselineLook>();
  for (const check of checks) {
    const own = takes.get(checkName(check)) ?? [];
    const row = own.at(-1);
    if (!row || !sameAbsenceCall(row.call, check.call)) continue;
    const before = own
      .slice(0, -1)
      .filter((take) => take.status !== 'superseded' && sameAbsenceCall(take.call, check.call));
    current.set(checkName(check), { ...row, look: before.length + 1 });
  }
  return current;
}

/** The baseline {@link currentAbsenceBaselines} keeps for `check`, if any. */
export function baselineOf(
  current: ReadonlyMap<string, AbsenceBaselineLook>,
  check: { readonly stepKey: string | null; readonly checkKey: string },
): AbsenceBaselineLook | undefined {
  return current.get(checkName(check));
}

async function audit(
  client: PoolClient,
  workspaceId: string,
  row: AbsenceBaselineRow,
  outcome: GoalAbsenceBaselineStatus | 'opened' | 'retry',
  actorPrincipalId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId,
    action: 'goal_run.absence_baseline',
    resourceType: 'goal_run',
    resourceId: row.goalRunId,
    payload: {
      outcome,
      ...(row.stepKey !== null ? { stepKey: row.stepKey } : {}),
      checkKey: row.checkKey,
      take: row.take,
      ...(outcome !== 'opened' ? { attempt: row.attempts } : {}),
      gatekeeperId: row.call.gatekeeperId,
      operation: row.call.operation,
      ...extra,
    },
  });
}

/**
 * The baselines the run's `checks` (`requiredAbsenceChecks` of the plan in force) go by, a take
 * opened `pending` for each that needs one — see the module comment; `retake`: the requester
 * resumed the run, so a check whose baseline did not see the thing is looked at again. Called with
 * the GoalRun locked, while it is running (the database refuses a take otherwise). Returns each
 * check with its baseline, in `checks`' order.
 */
export async function ensureAbsenceBaselines(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly goalRunId: string;
    readonly checks: readonly AbsenceBaselineCheck[];
    readonly retake: boolean;
    readonly actorPrincipalId: string;
  },
): Promise<
  readonly { readonly check: AbsenceBaselineCheck; readonly baseline: AbsenceBaselineRow }[]
> {
  const latest = await latestTakes(client, workspaceId, input.goalRunId);
  const declared = new Map(input.checks.map((check) => [checkName(check), check]));
  for (const [name, row] of latest) {
    if (row.status !== 'pending') continue;
    const check = declared.get(name);
    if (check && sameAbsenceCall(row.call, check.call)) continue;
    const superseded = await supersedeTake(client, workspaceId, row, input.actorPrincipalId, {
      reason: 'not_in_plan',
    });
    if (superseded) latest.set(name, superseded);
  }
  const baselines: { check: AbsenceBaselineCheck; baseline: AbsenceBaselineRow }[] = [];
  for (const check of input.checks) {
    const row = latest.get(checkName(check));
    const fresh =
      !row ||
      row.status === 'superseded' ||
      !sameAbsenceCall(row.call, check.call) ||
      (input.retake && FAILED_BASELINE_STATUSES.has(row.status));
    if (!fresh) {
      baselines.push({ check, baseline: row });
      continue;
    }
    const inserted = await client.query<AbsenceBaselineDbRow>(
      `insert into goal_absence_baselines
         (workspace_id, goal_run_id, step_key, check_key, take, observation_check)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       returning ${COLUMNS}`,
      [
        workspaceId,
        input.goalRunId,
        check.stepKey,
        check.checkKey,
        (row?.take ?? 0) + 1,
        JSON.stringify(check.call),
      ],
    );
    const created = inserted.rows[0];
    if (!created) throw new Error('ensureAbsenceBaselines: INSERT ... RETURNING produced no row');
    const baseline = mapRow(created);
    await audit(client, workspaceId, baseline, 'opened', input.actorPrincipalId, {
      ...(row ? { after: { take: row.take, status: row.status } } : {}),
      ...(input.retake && row && FAILED_BASELINE_STATUSES.has(row.status) ? { retake: true } : {}),
    });
    latest.set(checkName(check), baseline);
    baselines.push({ check, baseline });
  }
  return baselines;
}

async function supersedeTake(
  client: PoolClient,
  workspaceId: string,
  row: AbsenceBaselineRow,
  actorPrincipalId: string,
  extra: Record<string, unknown>,
): Promise<AbsenceBaselineRow | null> {
  const result = await client.query<AbsenceBaselineDbRow>(
    `update goal_absence_baselines
        set status = 'superseded', lease_until = null, settled_at = now()
      where workspace_id = $1 and id = $2 and status = 'pending'
      returning ${COLUMNS}`,
    [workspaceId, row.id],
  );
  const superseded = result.rows[0];
  if (!superseded) return null;
  const mapped = mapRow(superseded);
  await audit(client, workspaceId, mapped, 'superseded', actorPrincipalId, extra);
  return mapped;
}

/** Supersedes every pending take of the run — once it stops running (`goal_moved`: `moves.ts`, in
 *  the transaction that moves it; `goal_not_running`: one an earlier release left behind,
 *  `absence-baseline.ts`). Each is audited. Returns how many. */
export async function supersedePendingAbsenceBaselines(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly goalRunId: string;
    readonly actorPrincipalId: string;
    readonly reason: 'goal_moved' | 'goal_not_running';
  },
): Promise<number> {
  const result = await client.query<AbsenceBaselineDbRow>(
    `update goal_absence_baselines
        set status = 'superseded', lease_until = null, settled_at = now()
      where workspace_id = $1 and goal_run_id = $2 and status = 'pending'
      returning ${COLUMNS}`,
    [workspaceId, input.goalRunId],
  );
  for (const row of result.rows) {
    await audit(client, workspaceId, mapRow(row), 'superseded', input.actorPrincipalId, {
      reason: input.reason,
    });
  }
  return result.rows.length;
}

/** Claims a pending, due, unleased take for one attempt — or `null`. The attempt number grows by
 *  one, the first claim sets `first_attempt_at`, and the lease runs `leaseMs`. */
export async function claimAbsenceBaseline(
  client: PoolClient,
  workspaceId: string,
  id: string,
  leaseMs: number,
): Promise<AbsenceBaselineRow | null> {
  const result = await client.query<AbsenceBaselineDbRow>(
    `update goal_absence_baselines
        set attempts = attempts + 1,
            first_attempt_at = coalesce(first_attempt_at, now()),
            lease_until = now() + make_interval(secs => $3::double precision)
      where workspace_id = $1 and id = $2 and status = 'pending'
        and next_attempt_at <= now()
        and (lease_until is null or lease_until <= now())
      returning ${COLUMNS}`,
    [workspaceId, id, leaseMs / 1000],
  );
  const claimed = result.rows[0];
  return claimed ? mapRow(claimed) : null;
}

/** The take, locked `for update` — `null` when there is none. */
export async function lockAbsenceBaseline(
  client: PoolClient,
  workspaceId: string,
  id: string,
): Promise<AbsenceBaselineRow | null> {
  const result = await client.query<AbsenceBaselineDbRow>(
    `select ${COLUMNS} from goal_absence_baselines where workspace_id = $1 and id = $2 for update`,
    [workspaceId, id],
  );
  const locked = result.rows[0];
  return locked ? mapRow(locked) : null;
}

/** Puts a claimed take back: due again in `delayMs`, the lease released, `lastError` the code of
 *  what went wrong this time. Audited as a `retry`. */
export async function deferAbsenceBaseline(
  client: PoolClient,
  workspaceId: string,
  row: AbsenceBaselineRow,
  input: { readonly delayMs: number; readonly lastError: string },
  actorPrincipalId: string,
  error?: string | null,
): Promise<void> {
  await client.query(
    `update goal_absence_baselines
        set next_attempt_at = now() + make_interval(secs => $3::double precision),
            lease_until = null, last_error = $4
      where workspace_id = $1 and id = $2`,
    [workspaceId, row.id, input.delayMs / 1000, clippedCode(input.lastError)],
  );
  await audit(client, workspaceId, row, 'retry', actorPrincipalId, {
    code: clippedCode(input.lastError),
    retryInMs: input.delayMs,
    ...(error ? { error } : {}),
  });
}

/** Settles a pending take once: `seen_present` / `never_seen_present` on the Observation of this
 *  attempt, or `unavailable` (`lastError` says why). Audited. */
export async function settleAbsenceBaseline(
  client: PoolClient,
  workspaceId: string,
  row: AbsenceBaselineRow,
  input:
    | {
        readonly status: 'seen_present' | 'never_seen_present';
        readonly observationId: string;
      }
    | { readonly status: 'unavailable'; readonly lastError: string },
  actorPrincipalId: string,
  error?: string | null,
): Promise<void> {
  const observationId = 'observationId' in input ? input.observationId : null;
  const lastError = 'lastError' in input ? clippedCode(input.lastError) : null;
  await client.query(
    `update goal_absence_baselines
        set status = $3, observation_id = $4, last_error = $5, lease_until = null,
            settled_at = now()
      where workspace_id = $1 and id = $2`,
    [workspaceId, row.id, input.status, observationId, lastError],
  );
  await audit(client, workspaceId, row, input.status, actorPrincipalId, {
    ...(observationId ? { observationId } : {}),
    ...(lastError ? { code: lastError } : {}),
    ...(error ? { error } : {}),
  });
}

/** Whether the run saw what an absence check looks for before now — the goal's (`stepRunId`
 *  `null`) or its StepRun's: a `seen_present` baseline of the check, by its step's key, with the call
 *  it makes (goal/0012's `goal_absence_seen_before`, the rule the database holds a passing absence
 *  check to — I-AB1). */
export async function absenceSeenBefore(
  client: PoolClient,
  workspaceId: string,
  check: {
    readonly goalRunId: string;
    readonly stepRunId: string | null;
    readonly checkKey: string;
    readonly call: ObservationAbsenceCheck;
  },
): Promise<boolean> {
  const result = await client.query<{ seen: boolean }>(
    `select coalesce(goal_absence_seen_before(
              $1, $2,
              (select s.step_key from step_runs s where s.workspace_id = $1 and s.id = $3::uuid),
              $4, $5::jsonb, now()), false) as seen`,
    [workspaceId, check.goalRunId, check.stepRunId, check.checkKey, JSON.stringify(check.call)],
  );
  return result.rows[0]?.seen === true;
}

/** Whether the run saw what a reconcile check's absence call looks for before the action it
 *  reconciles was raised — a `seen_present` baseline, of the action's step or of the goal, with the
 *  same call, on an Observation older than the ActionRequest (governance/0029's
 *  `action_request_absence_seen_before`, the rule the database holds the platform's `effect_seen`
 *  on a "not there" answer to — I-AB1). A plan makes such a call only as an `observe_absent`
 *  acceptance check's (`plan.ts`), so its baseline was taken before the step started. */
export async function absenceSeenBeforeAction(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  call: ObservationAbsenceCheck,
): Promise<boolean> {
  const result = await client.query<{ seen: boolean }>(
    'select coalesce(action_request_absence_seen_before($1, $2, $3::jsonb), false) as seen',
    [workspaceId, actionRequestId, JSON.stringify(call)],
  );
  return result.rows[0]?.seen === true;
}
