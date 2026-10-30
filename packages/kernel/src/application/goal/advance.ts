import type {
  GoalRunEvent,
  GoalRunPauseReason,
  GoalRunStatus,
  StepRunEvent,
  StepRunFailureCategory,
  StepRunStatus,
  StepRunWaitingReason,
  TaskStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import {
  type StepActionOutcome,
  ensureReconcileCheck,
  listStepActionOutcomes,
  stepIdempotencyKey,
} from '../../governance/approval/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  type LiveGoalTask,
  type PreparedStepAttempt,
  type ReworkOf,
  type RunConfigSnapshot,
  type StepAttemptRefusal,
  type TaskRuntimeDeps,
  countStepAttemptsWithoutResult,
  createStepAttemptTask,
  listGoalRunLiveTaskSteps,
  listTaskWorkerRunTree,
  lockTaskQuotas,
  readGoalRunTokenHeadroom,
  readGoalRunUsage,
  readStepAttemptTask,
  startStepAttemptTask,
  terminateTaskWith,
} from '../task/index.js';
import {
  type AbsenceBaselineCheck,
  type AbsenceBaselineRow,
  NEVER_SEEN_PRESENT,
  ensureAbsenceBaselines,
  requiredAbsenceChecks,
} from './absence-baselines.js';
import {
  type AcceptanceCheckRow,
  FACT_NOT_OBSERVED,
  TARGET_STILL_PRESENT,
  openAcceptanceRound,
  openStepAcceptanceRound,
  readCurrentAcceptanceRound,
  readCurrentStepAcceptanceRound,
} from './acceptance-checks.js';
import { assembleStepInput } from './bindings.js';
import { type CancellingOptions, advanceCancellingGoalRun } from './cancelling.js';
import { type StepActionEffect, actionDisposition, stepActionEffect } from './disposition.js';
import { type GoalMoveActor, moveGoalRun, moveStepRun } from './moves.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  type PlanStep,
  isPlatformAcceptanceCheck,
  planStep,
  roundAcceptance,
  samePlanEntry,
} from './plan.js';
import { getPlanRevision, lockStepRuns } from './reads.js';
import { lockGoalRun } from './service.js';
import type { GoalRunRow, PlanRevisionRow, StepRunRow } from './types.js';

/**
 * application/goal/advance (S11 GO2; plan §4.2, §4.7, §4.9): one advance of one GoalRun — the
 * deterministic rules that move its steps, in one transaction under the requester's workspace
 * context, GoalRun row locked first (every writer under a GoalRun takes that lock before any
 * StepRun's; the guards take it too). The advancer calls no model and holds no credential: every
 * rule below reads rows and moves rows.
 *
 * A `cancelling` GoalRun is advanced by `cancelling.ts` (S11 GO3a): it waits for its Tasks to end
 * — terminating them after the commit — and its executing actions to end, then is `cancelled`. A
 * `verifying` one goes straight to phase V below (S11 GO4a). Otherwise only a `running` or `paused`
 * GoalRun is advanced; any other status just loses its `next_tick_at`. Then, in order:
 *
 *   0. **Stop revised-away work** (running or paused; S11 GO3b, `revise.ts`). The live Tasks of a
 *      step a revision superseded — its attempt and nested child Tasks — are terminated after the
 *      commit, like a cancelling run's, unless the revision let that step finish
 *      (`plan_revisions.removals`, goal/0004). A superseded step itself never moves again.
 *   A. **Record finished attempts** (running or paused). A `running` / `waiting` step whose current
 *      attempt Task has finished — once no other Task of the step still runs: a nested child Task
 *      can outlive its caller and still raise requests the step owns (GO3b) — is judged by that
 *      Task and by what the ActionRequests raised by that attempt's own runs — nested children
 *      included — became (`stepActionEffect`, §4.7; an earlier attempt's requests never decide
 *      this one). A request still in flight or awaiting a reconcile holds the step in `waiting`
 *      (§4.8: the wait is on the step, not on the Worker). A reconcile is first the platform's
 *      when the step declared a check for that action (GO3d, `plan.ts` `reconcile`): the check is
 *      created here, `reconcile-check.ts` makes the observation outside this transaction, and the
 *      run keeps running while it is pending — a satisfied check records `effect_seen` and sets
 *      the run due. Otherwise — no declaration, or a check that did not see the effect or could
 *      not be made — the GoalRun pauses `awaiting_reconcile` until a person records what they
 *      found (GO3c, `reconcile.ts`; `effect_seen` counts as executed, `effect_absent` fails the
 *      step `outcome_unknown` for a person, a re-execute decision fails it `transient` for a new
 *      attempt — `disposition.ts`) and the requester resumes it: the advancer never lifts that
 *      pause itself (review #493 on #642 — a person's pause laid over it, or one left by a lifted
 *      hold, could not be told from it). Otherwise {@link judgeFinishedAttempt}:
 *      success, or a failure category — only `transient` is retried without a person, and the
 *      step's first attempt that ended without an accepted result (`contract_violation`, S11
 *      GO5d-1, §4.7, legacy 358) is reworked once; every other category pauses the GoalRun. A step
 *      no longer part of the current plan is not judged at all (I-G2: a late result is kept on
 *      its Task, it moves nothing) and the GoalRun pauses `needs_decision`.
 *      **A step's acceptance** (S11 GO4b, plan §4.5, §4.6): a successful attempt of a step that
 *      declares acceptance checks does not succeed yet — the step waits on them
 *      (`waiting(acceptance)`) and a verification round of its declared checks opens for that
 *      attempt (`acceptance-checks.ts` `openStepAcceptanceRound`; the platform makes them,
 *      `acceptance-check.ts`, and a settled one sets the run due). Then, on every advance: a check
 *      still pending → wait; one made that did not pass → the step fails `verification_failed`
 *      and the run pauses `needs_decision` (a retry redoes the work, so only a person sends it);
 *      none of those but one that could not be made → the step waits on a person
 *      (`waiting(acceptance_unavailable)`), the run pauses `needs_decision`, and resuming it
 *      verifies the step again in a new round, the work not redone; every check passed → the
 *      step succeeds and the steps after it may start (the database refuses its success
 *      otherwise, goal/0006). A run that stops running supersedes its steps' pending checks
 *      (`moves.ts`): a paused run observes nothing, and resuming it opens a new round for each
 *      step whose round lost a check that way, or never opened (its attempt finished under the
 *      pause); a round settled in full before the pause stands, and the step goes by it.
 *   B. **Retry transient failures, rework a contract violation once** (running only). Under the
 *      step's attempt limit (plan `maxAttempts`, default 3), once no request of the step — of any
 *      attempt — is still in flight and no Task of it still runs (I-G4: no new attempt beside an
 *      action that may still run), after an exponential backoff from a transient failure (none
 *      before a rework: nothing outside the Worker has to settle), and only if the step is still
 *      part of the current plan: `failed → ready`. A rework is the step's next attempt, counted
 *      against `maxAttempts` and the goal's step budget like any other; its Task carries what it
 *      redoes (`rework_of`: the attempt and its last refused report), which the Worker reads
 *      (`get_task`). Past the limit, the GoalRun pauses `needs_decision`.
 *   C. **Unblock** (running or paused). A `pending` step whose dependencies all succeeded becomes
 *      `ready` — after re-checking that its definition is still the current plan's entry (the
 *      database does not check this on `ready`). A skipped dependency counts as done.
 *   Before D, **absence baselines** (running only; S11 「门确认不存在」 B-c, I-AB1). Every absence
 *      check (`observe_absent`) the plan in force declares — the goal's, and those of its steps that
 *      have not ended — gets a baseline before anything else starts (`absence-baselines.ts`: a
 *      `pending` take where its latest is missing, superseded or of another call; a revision that
 *      keeps the call keeps the baseline), and the platform looks with the check's call
 *      (`absence-baseline.ts`, outside this transaction; a settled take sets the run due). While one
 *      is pending, phase D does nothing — no attempt starts and the run does not verify; attempts
 *      already running go on. One that did not see the thing — the gate answered "not there"
 *      already (`never_seen_present`), or the look could not be made (`unavailable`) — pauses the
 *      run `needs_decision` naming it: an absence check on that call could never show this goal
 *      removed the thing. A check a revision adds or re-calls once steps have started is looked at
 *      before the run goes on, not before its work — the pause then says an earlier step may have
 *      removed the thing. The requester revises the check's params, or resumes, which looks again
 *      (`control.ts`). Every one that saw the thing → phase D.
 *   D. **Start** (running only). Every live step succeeded → `verifying`, a verification round
 *      opened and phase V run at once — once nothing of the run is left running: no Task of it (a
 *      step let finish after a revision) and no request of a superseded step still in flight (one
 *      released, or executing when the revision came); one whose outcome is unknown pauses
 *      `awaiting_reconcile` first (GO3b). Otherwise the budget is checked (I-G6: wall clock from
 *      confirmation, tokens used by the GoalRun's Tasks; past either → `paused(budget_exhausted)`,
 *      never failed), then each
 *      `ready` step starts one attempt while the step budget allows, the attempts of one advance
 *      splitting the goal's token headroom (`readGoalRunTokenHeadroom`: the budget less what every
 *      Task of the run holds — a live Task its own budget), so the live Tasks' budgets together
 *      never exceed what is left of the goal's: `createStepAttemptTask` inserts the attempt's
 *      Task in this transaction — with the step's `outputSchema` and the input its bindings make
 *      (`bindings.ts`, S11 GO5d-1: a value not there, or one the credential review counts, pauses
 *      `needs_decision` naming the binding) — and the step moves `ready → running` with
 *      `attempt_count + 1` (I-G1). No attempt starts while a request of any superseded step —
 *      whatever key the revision gave its work — has an unknown outcome: the run pauses
 *      `awaiting_reconcile` (review #493 on #633). A step whose key a revision redefined does not
 *      start while the StepRun it replaced still has a Task running or a request in flight (I-G4
 *      across the revision: the new definition does not run beside the old one's actions). A
 *      refusal leaves the step `ready`: the requester's concurrency quota retries after
 *      {@link DEFAULT_QUOTA_RETRY_MS}; the daily cost quota pauses `budget_exhausted`; lost
 *      authority pauses `authority_lost` (S9, I-G7); a pinned component no longer published
 *      pauses `needs_decision`.
 *   E. **Stuck** (running only; legacy 393). No live step is ready, running or waiting, none failed
 *      `transient` or due its rework (phase B starts those or pauses), and one failed for a
 *      person — a category the advancer never retries (or a contract violation after its rework):
 *      the run pauses `needs_decision` now instead of waiting for its wall
 *      clock (`next_tick_at` would be the deadline, then `budget_exhausted`). This is where a
 *      resume that names no failed step in `retrySteps` (`control.ts`) comes back to: what the run
 *      waits for is the requester retrying a failed step (one with an action found to have no
 *      effect after their re-execute decision, GO3c), revising the plan or cancelling — the pause
 *      names every failed step and what each waits for. A branch of the plan that still moves
 *      keeps the run going until it stops too.
 *   V. **Verify** (verifying only; S11 GO4a, plan §4.6, I-G5). A run is verified in rounds: each
 *      stay in `verifying` has one (`acceptance-checks.ts` `openAcceptanceRound`), opened as the
 *      run enters it — or by the first advance that finds none, for a run that entered it under a
 *      release without verification — with one row per acceptance check of the plan in force
 *      (`plan.ts` `roundAcceptance`: its `acceptance`, or one `requester_confirm` asking about the
 *      goal statement). The platform makes the observations and judges the Facts (S11 GO4c)
 *      (`acceptance-check.ts`, outside this transaction; a settled one sets the run due) and the
 *      requester gives the confirmation (`acceptance.ts`, asked only once every check the platform
 *      makes passed). Then: such a check still pending → wait; one `failed` or `unavailable` →
 *      `paused(needs_decision)`, the checks named in the pause (the evidence is on their rows);
 *      the confirmation pending → wait; every check passed → `completed(achieved)`, on
 *      `verified_by_check` when the platform checked anything, else on the requester's word
 *      (`requester`, their confirmation's Decision). The database refuses any other way to
 *      `achieved` (goal/0005, goal/0007). Leaving
 *      `verifying` supersedes the round's pending checks (`moves.ts`), so a paused, held or
 *      cancelled run observes nothing, and a resume verifies in a new round. No budget is checked
 *      while verifying: an observation is bounded by its own attempts and duration, and waiting
 *      for the requester spends nothing.
 *
 * A paused GoalRun keeps its first reason (the guard refuses changing it while paused); a further
 * cause is in the audit log (`goal_run.pause_noted`, once per pause for each reason and detail),
 * not on the row. The advance ends by writing `next_tick_at`: the earliest retry, quota retry,
 * blocked-retry re-check or wall-clock deadline while running, otherwise
 * `null` — then only an event (`TaskUpdated`, `ActionRequestUpdated`), the reconcile scan or a
 * person moves the run. Attempts are started (`startStepAttemptTask`: the WorkerRun spawned, the
 * Task `running`) after the transaction commits, so the Worker's Handle is committed before its
 * container uses it; a kernel that dies in between leaves a `queued` Task that the reaper fails
 * `spawn_lost`, which comes back here as a transient failure.
 *
 * Every transition goes through the shared transition tables and `transition-log.ts` (audit row +
 * `GoalRunUpdated` / `StepRunUpdated`), with the requester as actor and `by: 'advancer'` in the
 * payload. Times are the database's `now()` — the transaction's start — so a backoff measured from
 * `step_runs.updated_at` never mixes two clocks.
 */

/** What a `failed` acceptance check saw, and why it was not met — for a pause's detail (the
 *  evidence is on the row). An absence check (S11 「门确认不存在」 B) found the thing still there. */
function unmetEvidence(check: AcceptanceCheckRow): string {
  if (check.kind === 'fact_predicate') return 'the Fact it saw did not satisfy the predicate';
  if (check.kind === 'observe_absent') {
    return `its observation found the thing still there (${TARGET_STILL_PRESENT}): the gate answered with it, not that it does not exist`;
  }
  return 'its observation did not satisfy the predicate';
}

/** A pause's detail for an `unavailable` absence check that had no baseline seeing the thing (S11
 *  「门确认不存在」 B-c, I-AB1) — not a check the gate refused. `null` for any other check. */
function neverSeenPresent(check: AcceptanceCheckRow): string | null {
  return check.kind === 'observe_absent' && check.lastError === NEVER_SEEN_PRESENT
    ? `acceptance check ${check.checkKey}: the platform has no look with this call that saw the thing there (${NEVER_SEEN_PRESENT}), so its absence now does not show this goal removed it`
    : null;
}

/** A pause's detail for an absence check whose baseline did not see the thing (S11 「门确认不存在」
 *  B-c, before phase D). `afterWork`: a step of the run had started before this look — the plan
 *  changed the check after the work began — so an earlier step may have removed the thing. */
function unseenBaseline(
  check: AbsenceBaselineCheck,
  baseline: AbsenceBaselineRow,
  afterWork: boolean,
): string {
  const named = `acceptance check ${check.checkKey}${check.stepKey !== null ? ` of step ${check.stepKey}` : ''}`;
  if (baseline.status === 'never_seen_present') {
    return afterWork
      ? `${named}: the platform first looked after the goal's steps had started (the plan changed the check) and the gate answered that the thing is not there (${NEVER_SEEN_PRESENT}) — an earlier step may have removed it, or the params name something else; either way the check could never show this goal removed it`
      : `${named}: before the goal's work the gate already answered that the thing is not there (${NEVER_SEEN_PRESENT}), so the check could never show this goal removed it`;
  }
  return `${named}: the platform could not look before the goal's work ${afterWork ? 'went on' : 'started'} (${baseline.lastError ?? 'no reason recorded'})`;
}

/** A pause's detail for an `unavailable` fact check that saw no Fact it may rest on — told apart
 *  from a check that could not be made, since what is missing is an observation from outside the
 *  goal (GO6's console offers its own next step for it). `null` for any other check. */
function noFactSeen(check: AcceptanceCheckRow): string | null {
  return check.kind === 'fact_predicate' && check.lastError === FACT_NOT_OBSERVED
    ? `acceptance check ${check.checkKey}: saw no Fact it may rest on (${FACT_NOT_OBSERVED}) — none confirmed since the round opened by a collector, or by a gate this goal did not drive`
    : null;
}

/** Delay before attempt `attempts + 1` of a step whose attempt `attempts` failed transiently:
 *  30 s, doubling, at most 10 minutes. */
export function defaultRetryBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 10 * 60 * 1000);
}

/** How long a step refused by the requester's concurrency quota waits before the next try. */
export const DEFAULT_QUOTA_RETRY_MS = 30_000;

/** When a retry held back by a request still in flight is looked at again. The request's
 *  `ActionRequestUpdated` normally wakes the run first; this bounds a lost wake to one reconcile
 *  period (S12) instead of the wall-clock deadline — the reconcile scan does not look for it. */
export const DEFAULT_BLOCKED_RETRY_RECHECK_MS = 60 * 1000;

export interface GoalAdvancerOptions extends CancellingOptions {
  readonly retryBackoffMs?: (attempts: number) => number;
  readonly quotaRetryMs?: number;
  readonly blockedRetryRecheckMs?: number;
  /** Failed advances in a row after which a running run pauses for a person (legacy 356;
   *  `advancer.ts` `DEFAULT_MAX_CONSECUTIVE_ADVANCE_FAILURES`). */
  readonly maxConsecutiveAdvanceFailures?: number;
}

export interface GoalAdvanceDeps {
  readonly pool: PoolLike;
  /** Spawns the attempts' WorkerRuns after the advance commits. */
  readonly taskRuntime: TaskRuntimeDeps;
  readonly options?: GoalAdvancerOptions;
  /** Called when starting an attempt after the commit fails other than by a spawn failure (which
   *  `startStepAttemptTask` turns into a failed Task itself), or when terminating a cancelled
   *  run's Task fails (the next advance tries again). */
  readonly onStartError?: (error: unknown) => void;
}

export interface GoalAdvanceTarget {
  readonly workspaceId: string;
  readonly goalRunId: string;
  /** The GoalRun's requester (`on_behalf_of`): the advance runs in their workspace context and
   *  acts with their authority. */
  readonly requesterId: string;
}

export interface GoalAdvanceOutcome {
  /** The GoalRun's status after the advance — `null` when it does not exist. */
  readonly status: GoalRunStatus | null;
  /** The attempt Tasks this advance created (started after the commit). */
  readonly startedTaskIds: readonly string[];
  /** A cancelling run's Tasks this advance terminates after the commit. */
  readonly terminatedTaskIds: readonly string[];
  readonly nextTickAt: Date | null;
}

/** What one advance's transaction decided, and the work it leaves for after the commit. */
interface AdvanceResult {
  readonly outcome: GoalAdvanceOutcome;
  readonly attempts: readonly PreparedStepAttempt[];
}

const FINISHED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);
const DONE_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set(['succeeded', 'skipped']);
/** Steps that move on without a person: started, or about to be (phase E). */
const MOVING_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set(['ready', 'running', 'waiting']);

/** What a finished attempt means for its step once none of its requests holds it (§4.7). */
export type AttemptVerdict =
  | { readonly kind: 'succeed' }
  | {
      readonly kind: 'fail';
      readonly category: StepRunFailureCategory;
      /** Why the GoalRun pauses — `null` for a transient failure under the advancer's own retry. */
      readonly pause: GoalRunPauseReason | null;
    };

function failVerdict(category: StepRunFailureCategory): AttemptVerdict {
  return {
    kind: 'fail',
    category,
    pause:
      category === 'transient'
        ? null
        : category === 'authority_lost'
          ? 'authority_lost'
          : 'needs_decision',
  };
}

/**
 * The verdict on a finished attempt Task (`completed` / `failed` / `cancelled`) whose requests no
 * longer hold the step (`effect` is not `wait`):
 *
 * | Task | requests | verdict |
 * |---|---|---|
 * | completed | clear | succeed (then the step's acceptance, GO4b; `report_task_result` already held the output to the step's schema, GO5d-1) |
 * | completed | `fail(c)` | failed `c` — a refused request needs a person; a request that never reached its gate is transient |
 * | failed | `fail(action_refused)` or `fail(outcome_unknown)` | failed with that category — a person decides, whatever became of the Task (GO3c: an action found to have had no effect is never retried on its own) |
 * | failed `no_result` | otherwise | failed `contract_violation` — the step's first such attempt is reworked once (§4.7, legacy 358: phase B, no pause); after that, a person |
 * | failed `budget_exhausted` | otherwise | failed `transient`, GoalRun paused `budget_exhausted` — the attempt's budget is what was left of the goal's |
 * | failed, any other reason | otherwise | failed `transient` — spawn failed or lost, run lost, Worker crashed, timed out or terminated |
 * | cancelled | any | failed `transient`, GoalRun paused `needs_decision` — someone stopped the Task outside the goal |
 */
export function judgeFinishedAttempt(
  task: { readonly status: TaskStatus; readonly failureReason: string | null },
  effect: Exclude<StepActionEffect, { readonly kind: 'wait' }>,
  /** How many earlier attempts of the step also ended `failed / no_result`. */
  earlierWithoutResult = 0,
): AttemptVerdict {
  if (task.status === 'completed') {
    return effect.kind === 'fail' ? failVerdict(effect.failureCategory) : { kind: 'succeed' };
  }
  if (task.status === 'cancelled') {
    return { kind: 'fail', category: 'transient', pause: 'needs_decision' };
  }
  if (effect.kind === 'fail' && effect.failureCategory !== 'transient') {
    return failVerdict(effect.failureCategory);
  }
  if (task.failureReason === 'no_result') {
    return earlierWithoutResult === 0
      ? { kind: 'fail', category: 'contract_violation', pause: null }
      : failVerdict('contract_violation');
  }
  if (task.failureReason === 'budget_exhausted') {
    return { kind: 'fail', category: 'transient', pause: 'budget_exhausted' };
  }
  return failVerdict('transient');
}

/** The pause a refused attempt start causes, or `null` for a quota that clears by itself. */
export function refusalPause(refusal: StepAttemptRefusal): GoalRunPauseReason | null {
  switch (refusal.kind) {
    case 'authority_lost':
      return 'authority_lost';
    case 'unavailable':
      return 'needs_decision';
    case 'quota':
      if (refusal.code === 'concurrency_exceeded') return null;
      if (refusal.code === 'daily_cost_exceeded' || refusal.code === 'goal_budget_exhausted') {
        return 'budget_exhausted';
      }
      return 'needs_decision';
  }
}

/** One advance — see the module doc comment. */
export async function advanceGoalRun(
  deps: GoalAdvanceDeps,
  target: GoalAdvanceTarget,
): Promise<GoalAdvanceOutcome> {
  const { outcome, attempts } = await withWorkspace<AdvanceResult>(
    deps.pool,
    { workspaceId: target.workspaceId, principalId: target.requesterId },
    async (client) => {
      const goal = await lockGoalRun(client, target.workspaceId, target.goalRunId);
      if (!goal) {
        return {
          outcome: { status: null, startedTaskIds: [], terminatedTaskIds: [], nextTickAt: null },
          attempts: [],
        };
      }
      const now = await databaseNow(client);
      if (
        goal.status === 'running' ||
        goal.status === 'paused' ||
        goal.status === 'verifying' ||
        goal.status === 'cancelling'
      ) {
        await clearAdvanceFailures(client, goal);
      }
      if (goal.status === 'cancelling') {
        const cancelling = await advanceCancellingGoalRun(client, goal, now, deps.options ?? {});
        await writeNextTick(client, goal, cancelling.nextTickAt);
        return {
          outcome: { ...cancelling, startedTaskIds: [] },
          attempts: [],
        };
      }
      if (goal.status !== 'running' && goal.status !== 'paused' && goal.status !== 'verifying') {
        if (goal.nextTickAt !== null) await writeNextTick(client, goal, null);
        return {
          outcome: {
            status: goal.status,
            startedTaskIds: [],
            terminatedTaskIds: [],
            nextTickAt: null,
          },
          attempts: [],
        };
      }
      const advance = new Advance(client, goal, now, deps.options ?? {});
      return advance.run();
    },
  );
  for (const attempt of attempts) {
    try {
      await startStepAttemptTask(deps.taskRuntime, target.workspaceId, attempt);
    } catch (err) {
      deps.onStartError?.(err);
    }
  }
  for (const taskId of outcome.terminatedTaskIds) {
    try {
      await terminateTaskWith(deps.taskRuntime, target.workspaceId, target.requesterId, taskId);
    } catch (err) {
      deps.onStartError?.(err);
    }
  }
  return outcome;
}

async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>('select now() as now');
  const now = result.rows[0]?.now;
  if (!now) throw new Error('advanceGoalRun: select now() returned no row');
  return now;
}

/** Legacy 356: an advance that commits ends the run's streak of failed ones (`advance_failures`,
 *  goal/0004). Written in the advance's transaction, so an advance that throws keeps the streak —
 *  the advancer counts it (`advancer.ts`). Scheduling-like: no `updated_at`, no event. */
async function clearAdvanceFailures(client: PoolClient, goal: GoalRunRow): Promise<void> {
  if (goal.advanceFailures === 0) return;
  await client.query(
    'update goal_runs set advance_failures = 0 where workspace_id = $1 and id = $2',
    [goal.workspaceId, goal.id],
  );
}

async function writeNextTick(client: PoolClient, goal: GoalRunRow, at: Date | null): Promise<void> {
  // Scheduling only: `updated_at` stays the time of the run's last transition.
  await client.query('update goal_runs set next_tick_at = $3 where workspace_id = $1 and id = $2', [
    goal.workspaceId,
    goal.id,
    at,
  ]);
}

class Advance {
  private readonly client: PoolClient;
  private readonly goal: GoalRunRow;
  private readonly now: Date;
  private readonly retryBackoffMs: (attempts: number) => number;
  private readonly quotaRetryMs: number;
  private readonly blockedRetryRecheckMs: number;
  private status: GoalRunStatus;
  private readonly timers: number[] = [];
  private readonly started: PreparedStepAttempt[] = [];
  private readonly terminated: string[] = [];
  private readonly revisions = new Map<number, PlanRevisionRow | null>();
  /** The run's live Tasks as the advance began. Only phase D creates Tasks, after its last read. */
  private liveTasks: readonly LiveGoalTask[] = [];

  constructor(client: PoolClient, goal: GoalRunRow, now: Date, options: GoalAdvancerOptions) {
    this.client = client;
    this.goal = goal;
    this.now = now;
    this.retryBackoffMs = options.retryBackoffMs ?? defaultRetryBackoffMs;
    this.quotaRetryMs = options.quotaRetryMs ?? DEFAULT_QUOTA_RETRY_MS;
    this.blockedRetryRecheckMs = options.blockedRetryRecheckMs ?? DEFAULT_BLOCKED_RETRY_RECHECK_MS;
    this.status = goal.status;
  }

  private get ws(): string {
    return this.goal.workspaceId;
  }

  private get requester(): string {
    return this.goal.onBehalfOf;
  }

  /** `confirmed_at` + the wall-clock budget (I-G6). A running or paused run is confirmed (CHECK). */
  private get deadline(): number {
    const confirmed = this.goal.confirmedAt ?? this.goal.createdAt;
    return confirmed.getTime() + this.goal.budget.maxWallClockSeconds * 1000;
  }

  async run(): Promise<AdvanceResult> {
    if (this.status === 'verifying') {
      await this.verify(false);
    } else {
      const steps = await this.lockSteps();
      this.liveTasks = await listGoalRunLiveTaskSteps(this.client, this.ws, this.goal.id);
      await this.stopSupersededWork(steps);
      for (const step of steps) {
        if (step.status === 'running' || step.status === 'waiting') await this.recordAttempt(step);
      }
      if (this.status === 'running') {
        for (const step of await this.lockSteps()) {
          if (this.status !== 'running') break;
          if (step.status !== 'failed') continue;
          if (step.failureCategory === 'transient') await this.retryStep(step, false);
          else if (await this.reworkDue(step)) await this.retryStep(step, true);
        }
      }
      await this.unblockSteps(await this.lockSteps());
      if (this.status === 'running' && (await this.absenceBaselinesSeen(await this.lockSteps()))) {
        await this.startSteps(await this.lockSteps());
      }
      if (this.status === 'running') await this.pauseIfStuck(await this.lockSteps());
    }

    const nextTickAt =
      this.status === 'running' ? new Date(Math.min(this.deadline, ...this.timers)) : null;
    await writeNextTick(this.client, this.goal, nextTickAt);
    return {
      outcome: {
        status: this.status,
        startedTaskIds: this.started.map((attempt) => attempt.task.id),
        terminatedTaskIds: this.terminated,
        nextTickAt,
      },
      attempts: this.started,
    };
  }

  /** Every StepRun of the run, superseded ones included, locked after the GoalRun row (lock order:
   *  GoalRun, then its StepRuns), in creation order. Read again between phases: a phase moves rows
   *  the next one judges. */
  private async lockSteps(): Promise<readonly StepRunRow[]> {
    return lockStepRuns(this.client, this.ws, this.goal.id);
  }

  private async revision(revision: number): Promise<PlanRevisionRow | null> {
    if (!this.revisions.has(revision)) {
      this.revisions.set(
        revision,
        await getPlanRevision(this.client, this.ws, this.goal.id, revision),
      );
    }
    return this.revisions.get(revision) ?? null;
  }

  private async plan(revision: number): Promise<unknown> {
    return (await this.revision(revision))?.plan ?? null;
  }

  /** The step's Tasks that have not ended — its attempt and nested child Tasks. */
  private liveTasksOf(step: StepRunRow): readonly string[] {
    return this.liveTasks.filter((task) => task.stepRunId === step.id).map((task) => task.taskId);
  }

  /** The step's definition: its entry in the revision that introduced it. */
  private async entry(step: StepRunRow): Promise<PlanStep | null> {
    return planStep(await this.plan(step.introducedInRevision), step.stepKey);
  }

  /** Whether the step is still part of the current plan, unchanged (I-G2). */
  private async inCurrentPlan(step: StepRunRow): Promise<boolean> {
    const current = this.goal.currentRevision;
    if (current === null || step.supersededInRevision !== null) return false;
    return samePlanEntry(
      await this.plan(step.introducedInRevision),
      await this.plan(current),
      step.stepKey,
    );
  }

  // ----- 0 ------------------------------------------------------------------------------------

  /** The live Tasks of superseded steps, unless the superseding revision let the step finish, go
   *  to the advancer to terminate after the commit (terminating an ended Task is a no-op, so a
   *  Task that ends meanwhile is harmless). */
  private async stopSupersededWork(steps: readonly StepRunRow[]): Promise<void> {
    for (const step of steps) {
      if (step.status !== 'superseded' || step.supersededInRevision === null) continue;
      const tasks = this.liveTasksOf(step);
      if (tasks.length === 0) continue;
      const removal = (await this.revision(step.supersededInRevision))?.removals[step.stepKey];
      if (removal?.mode === 'let_finish') continue;
      this.terminated.push(...tasks);
    }
  }

  // ----- A ------------------------------------------------------------------------------------

  private async recordAttempt(step: StepRunRow): Promise<void> {
    // GO4b: the attempt's work was judged done when the step started waiting on its acceptance.
    if (
      step.status === 'waiting' &&
      (step.waitingReason === 'acceptance' || step.waitingReason === 'acceptance_unavailable')
    ) {
      await this.verifyStep(step);
      return;
    }
    const task = await readStepAttemptTask(this.client, this.ws, step.id, step.attemptCount);
    if (!task) {
      await this.pause(
        'needs_decision',
        `step ${step.stepKey}: attempt ${step.attemptCount} has no Task (I-G1)`,
      );
      return;
    }
    if (!FINISHED_TASK_STATUSES.has(task.status)) return;
    // A nested child Task of the attempt still runs, and may still raise requests the step owns:
    // judged once it ends (its `TaskUpdated` wakes the run).
    if (this.liveTasksOf(step).length > 0) return;
    // I-G2: a step out of the current plan is not judged — its attempt's result stays on its Task
    // and moves nothing (review #493 on #619). A revision supersedes such a step first (GO3b), so
    // this is the backstop.
    if (!(await this.inCurrentPlan(step))) {
      await this.pause('needs_decision', `step ${step.stepKey}: no longer in the current plan`);
      return;
    }
    // GO3c: a request of the step's identity (I-G4) that an earlier attempt raised and this one
    // repeated was replayed to it, and is not among `runs`' requests — only one that ran (or was
    // found to have) can be: while one is in flight or its outcome is open, no new attempt starts
    // (phase B, `control.ts`). So it changes no verdict here.
    const runs = await listTaskWorkerRunTree(this.client, this.ws, task.id);
    const outcomes = await listStepActionOutcomes(this.client, this.ws, step.id, {
      raisedBy: runs,
    });
    const effect = stepActionEffect(outcomes);
    if (effect.kind === 'wait') {
      await this.holdStep(step, effect.waitingReason, { taskId: task.id });
      if (effect.waitingReason === 'reconcile') {
        const forPerson = await this.reconcileByPlatform(step, outcomes);
        if (forPerson !== null) await this.pause('awaiting_reconcile', forPerson);
      }
      return;
    }
    const verdict = judgeFinishedAttempt(
      task,
      effect,
      task.failureReason === 'no_result'
        ? (await countStepAttemptsWithoutResult(this.client, this.ws, step.id)) - 1
        : 0,
    );
    const audit = {
      taskId: task.id,
      attempt: step.attemptCount,
      taskStatus: task.status,
      taskFailureReason: task.failureReason,
    };
    if (verdict.kind === 'succeed') {
      const entry = await this.entry(step);
      if (!entry) {
        await this.pause('needs_decision', `step ${step.stepKey}: its plan entry is unreadable`);
        return;
      }
      if ((entry.acceptance ?? []).length > 0) {
        await this.holdStep(step, 'acceptance', audit);
        // A paused run observes nothing: its resume opens the round (`verifyStep`).
        if (this.status === 'running') await this.openStepRound(step, entry);
        return;
      }
      await this.moveStep(step, 'succeed', { audit });
      return;
    }
    await this.moveStep(step, 'fail', {
      failureCategory: verdict.category,
      audit:
        verdict.category === 'contract_violation' ? { ...audit, rework: !verdict.pause } : audit,
    });
    if (verdict.pause) {
      await this.pause(
        verdict.pause,
        verdict.category === 'contract_violation'
          ? `step ${step.stepKey}: attempt ${step.attemptCount} ended without an accepted result again (contract_violation), after the step was reworked once — retry it (the Worker is told what was refused), revise the plan or cancel`
          : `step ${step.stepKey}: attempt ${step.attemptCount} failed (${verdict.category})`,
      );
    }
  }

  /**
   * GO3d: the outcome-unknown requests among `outcomes` that the step declared a reconcile check
   * for (`plan.ts`, matched by business identity, I-G4) get the platform's check
   * (`ensureReconcileCheck`; `reconcile-check.ts` runs it while the step waits in a running run,
   * and its result sets the run due). Returns `null` when every such request has a check still
   * pending — the step waits and the run does not pause; otherwise why a person is needed: a
   * request with no declaration, or a check that settled without seeing the effect (`not_seen`)
   * or could not be made (`unavailable`). The checks of the others are created all the same: they
   * run once the requester resumes the run.
   */
  private async reconcileByPlatform(
    step: StepRunRow,
    outcomes: readonly StepActionOutcome[],
  ): Promise<string | null> {
    const declarations = (await this.entry(step))?.reconcile ?? [];
    const declarationOf = (request: StepActionOutcome) =>
      declarations.find(
        (declaration) =>
          request.idempotencyKey ===
          stepIdempotencyKey({
            stepRunId: step.id,
            gatekeeperId: declaration.action.gatekeeperId,
            actionKind: declaration.action.operation,
            params: declaration.action.params,
          }),
      );
    let forPerson: string | null = null;
    for (const request of outcomes) {
      if (actionDisposition(request) !== 'reconcile') continue;
      const declaration = declarationOf(request);
      if (!declaration) {
        forPerson ??= `step ${step.stepKey}: an action of attempt ${step.attemptCount} may have run (outcome unknown)`;
        continue;
      }
      const check = await ensureReconcileCheck(this.client, this.ws, {
        actionRequestId: request.id,
        observationCheck: declaration.check,
      });
      if (check.status !== 'pending') {
        forPerson ??= `step ${step.stepKey}: the platform's reconcile check of an action of attempt ${step.attemptCount} ${check.status === 'not_seen' ? 'did not see its effect' : 'could not be made'}`;
      }
    }
    return forPerson;
  }

  /** `running → waiting(reason)`; a step already waiting for another reason resumes and waits
   *  again (the waiting reason is set by the transition into waiting). */
  private async holdStep(
    step: StepRunRow,
    reason: StepRunWaitingReason,
    audit: Record<string, unknown>,
  ): Promise<void> {
    if (step.status === 'waiting' && step.waitingReason === reason) return;
    const withAttempt = { ...audit, attempt: step.attemptCount };
    const running =
      step.status === 'waiting'
        ? await this.moveStep(step, 'resume', { audit: withAttempt })
        : step;
    await this.moveStep(running, 'wait', { waitingReason: reason, audit: withAttempt });
  }

  /**
   * GO4b: a step waiting on its acceptance — see the module comment, phase A. Its current round is
   * the latest one opened since it started waiting; a round with a superseded check ended under a
   * pause, so the run verifies the step again in a new one once it runs.
   */
  private async verifyStep(step: StepRunRow): Promise<void> {
    if (step.waitingReason === 'acceptance_unavailable') {
      // Waits on a person, for whom the run paused: their resume verifies the step again.
      if (this.status !== 'running') return;
      const entry = await this.entry(step);
      if (!entry) {
        await this.pause('needs_decision', `step ${step.stepKey}: its plan entry is unreadable`);
        return;
      }
      await this.holdStep(step, 'acceptance', { reverify: true });
      await this.openStepRound(step, entry);
      return;
    }
    const round = await readCurrentStepAcceptanceRound(
      this.client,
      this.ws,
      step.id,
      step.updatedAt,
    );
    if (round.length === 0 || round.some((check) => check.status === 'superseded')) {
      if (this.status !== 'running') return;
      const entry = await this.entry(step);
      if (!entry) {
        await this.pause('needs_decision', `step ${step.stepKey}: its plan entry is unreadable`);
        return;
      }
      await this.openStepRound(step, entry);
      return;
    }
    // The platform's settlement of each sets the run due.
    if (round.some((check) => check.status === 'pending')) return;
    const roundNumber = round[0]?.round;
    const failed = round.filter((check) => check.status === 'failed');
    const unavailable = round.filter((check) => check.status === 'unavailable');
    const audit = {
      round: roundNumber,
      attempt: step.attemptCount,
      ...(failed.length > 0 ? { failedChecks: failed.map((check) => check.checkKey) } : {}),
      ...(unavailable.length > 0
        ? { unavailableChecks: unavailable.map((check) => check.checkKey) }
        : {}),
    };
    const named = [...failed, ...unavailable].map((check) =>
      check.status === 'failed'
        ? `acceptance check ${check.checkKey}: ${unmetEvidence(check)}`
        : (noFactSeen(check) ??
          neverSeenPresent(check) ??
          `acceptance check ${check.checkKey}: could not be made (${check.lastError ?? 'no reason recorded'})`),
    );
    if (failed.length > 0) {
      await this.moveStep(step, 'fail', { failureCategory: 'verification_failed', audit });
      await this.pause(
        'needs_decision',
        `step ${step.stepKey}: attempt ${step.attemptCount}: ${named.join('; ')}; retry the step (its work is done again), revise the plan or cancel`,
      );
      return;
    }
    if (unavailable.length > 0) {
      await this.holdStep(step, 'acceptance_unavailable', audit);
      await this.pause(
        'needs_decision',
        `step ${step.stepKey}: attempt ${step.attemptCount}: ${named.join('; ')}; resume the run to verify the step again, revise the plan or cancel`,
      );
      return;
    }
    await this.moveStep(step, 'succeed', {
      audit: { ...audit, checks: round.map((check) => check.checkKey) },
    });
  }

  /** Opens a verification round of `step`'s declared checks for its current attempt. */
  private async openStepRound(step: StepRunRow, entry: PlanStep): Promise<void> {
    await openStepAcceptanceRound(this.client, this.ws, {
      goalRunId: this.goal.id,
      stepRunId: step.id,
      stepKey: step.stepKey,
      stepAttempt: step.attemptCount,
      planRevision: step.introducedInRevision,
      checks: entry.acceptance ?? [],
      actorPrincipalId: this.requester,
    });
  }

  // ----- B ------------------------------------------------------------------------------------

  /** Whether a step that failed `contract_violation` is due its one rework (§4.7, legacy 358):
   *  the attempt it failed by is the first of the step to end without an accepted result. */
  private async reworkDue(step: StepRunRow): Promise<boolean> {
    if (step.status !== 'failed' || step.failureCategory !== 'contract_violation') return false;
    return (await countStepAttemptsWithoutResult(this.client, this.ws, step.id)) === 1;
  }

  /** A new attempt of a failed step — a transient failure's retry, or (`rework`) the one rework of
   *  a contract violation. See the module comment, phase B. */
  private async retryStep(step: StepRunRow, rework: boolean): Promise<void> {
    const entry = await this.entry(step);
    if (!entry) {
      await this.pause('needs_decision', `step ${step.stepKey}: its plan entry is unreadable`);
      return;
    }
    const maxAttempts = entry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (step.attemptCount >= maxAttempts) {
      await this.pause(
        'needs_decision',
        `step ${step.stepKey}: ${step.attemptCount} of ${maxAttempts} attempts failed`,
      );
      return;
    }
    // A Task of the step still running (a nested child of the failed attempt): its end wakes the
    // run; the re-check bounds a lost wake.
    if (this.liveTasksOf(step).length > 0) {
      this.timers.push(this.now.getTime() + this.blockedRetryRecheckMs);
      return;
    }
    // Every request of the step, of every attempt (I-G4): none may still run beside a new attempt.
    const all = stepActionEffect(await listStepActionOutcomes(this.client, this.ws, step.id));
    // Nor one found to have had no effect that nobody decided to run again (GO3c): a new attempt
    // would only be replayed it, and could report the step done although it never ran. A person's
    // retry refuses the same (`control.ts`).
    if (all.kind === 'fail' && all.failureCategory === 'outcome_unknown') {
      await this.pause(
        'needs_decision',
        `step ${step.stepKey}: an earlier action was found to have no effect; decide to run it again or revise the plan`,
      );
      return;
    }
    if (all.kind === 'wait') {
      if (all.waitingReason === 'reconcile') {
        await this.pause(
          'awaiting_reconcile',
          `step ${step.stepKey}: an earlier action may have run (outcome unknown)`,
        );
      } else {
        // The request's `ActionRequestUpdated` wakes the run when it ends; the re-check bounds a
        // lost wake (the reconcile scan does not look for a held-back retry).
        this.timers.push(this.now.getTime() + this.blockedRetryRecheckMs);
      }
      return;
    }
    const due = step.updatedAt.getTime() + this.retryBackoffMs(step.attemptCount);
    if (!rework && due > this.now.getTime()) {
      this.timers.push(due);
      return;
    }
    if (!(await this.inCurrentPlan(step))) {
      await this.pause('needs_decision', `step ${step.stepKey}: no longer in the current plan`);
      return;
    }
    await this.moveStep(step, 'retry', {
      audit: { attempts: step.attemptCount, ...(rework ? { rework: true } : {}) },
    });
  }

  // ----- C ------------------------------------------------------------------------------------

  private async unblockSteps(steps: readonly StepRunRow[]): Promise<void> {
    // A dependency is met by a step that succeeded or was skipped (review #493 on #619).
    const done = new Set(
      steps.filter((step) => DONE_STEP_STATUSES.has(step.status)).map((step) => step.stepKey),
    );
    for (const step of steps) {
      if (step.status !== 'pending') continue;
      const entry = await this.entry(step);
      if (!entry) {
        await this.pause('needs_decision', `step ${step.stepKey}: its plan entry is unreadable`);
        continue;
      }
      if (!(entry.dependsOn ?? []).every((key) => done.has(key))) continue;
      if (!(await this.inCurrentPlan(step))) {
        await this.pause('needs_decision', `step ${step.stepKey}: no longer in the current plan`);
        continue;
      }
      await this.moveStep(step, 'unblock', {});
    }
  }

  // ----- before D -----------------------------------------------------------------------------

  /** S11 「门确认不存在」 B-c — see the module comment, before phase D. Whether every absence check
   *  that needs a baseline has one that saw the thing; one still pending makes the run wait (its
   *  settlement sets the run due), one that did not see it pauses the run for the requester. */
  private async absenceBaselinesSeen(steps: readonly StepRunRow[]): Promise<boolean> {
    const current = this.goal.currentRevision;
    if (current === null) throw new Error('advanceGoalRun: a running goal run has no revision');
    const checks = requiredAbsenceChecks(await this.plan(current), steps);
    if (!checks) {
      await this.pause('needs_decision', `revision ${current}: its plan is unreadable`);
      return false;
    }
    if (checks.length === 0) return true;
    const baselines = await ensureAbsenceBaselines(this.client, this.ws, {
      goalRunId: this.goal.id,
      checks,
      retake: false,
      actorPrincipalId: this.requester,
    });
    const unseen = baselines.filter(
      ({ baseline }) =>
        baseline.status === 'never_seen_present' || baseline.status === 'unavailable',
    );
    if (unseen.length > 0) {
      // No attempt starts while a look is pending, so one started at all started before this look.
      const afterWork = steps.some((step) => step.attemptCount > 0);
      await this.pause(
        'needs_decision',
        `${unseen.map(({ check, baseline }) => unseenBaseline(check, baseline, afterWork)).join('; ')}; revise the check's params or the plan, resume to look again, ${afterWork ? "end the run on the requester's word (end_goal), " : ''}or cancel`,
      );
      return false;
    }
    return baselines.every(({ baseline }) => baseline.status === 'seen_present');
  }

  // ----- D ------------------------------------------------------------------------------------

  private async startSteps(steps: readonly StepRunRow[]): Promise<void> {
    const live = steps.filter((step) => step.status !== 'superseded');
    if (live.length > 0 && live.every((step) => DONE_STEP_STATUSES.has(step.status))) {
      if (await this.settled(steps)) {
        await this.moveGoal('verify', null, { steps: live.length });
        await this.verify(true);
      }
      return;
    }
    if (this.now.getTime() >= this.deadline) {
      await this.pause(
        'budget_exhausted',
        `wall clock: ${this.goal.budget.maxWallClockSeconds} s since confirmation`,
      );
      return;
    }
    const usage = await readGoalRunUsage(this.client, this.ws, this.goal.id);
    if (usage.tokens >= this.goal.budget.maxTokens) {
      await this.pause(
        'budget_exhausted',
        `tokens: ${usage.tokens} of ${this.goal.budget.maxTokens}`,
      );
      return;
    }
    const ready = live.filter((step) => step.status === 'ready');
    if (ready.length === 0) return;
    // Review #493 on #633: a request of any superseded step whose outcome is unknown holds every
    // new attempt, whatever key the revision gave the work — renaming a step must not re-run an
    // action that may have run. (A request still in flight holds only the step that took over its
    // key, `predecessorBusy`: a renamed step running beside it is the person's choice, nothing in
    // doubt.)
    const inDoubt = await this.supersededInDoubt(steps);
    if (inDoubt) {
      await this.pause(
        'awaiting_reconcile',
        `step ${inDoubt.stepKey} (revised away): an action of it may have run (outcome unknown)`,
      );
      return;
    }
    let attemptsSoFar = usage.steps;
    if (attemptsSoFar >= this.goal.budget.maxSteps) {
      await this.pause(
        'budget_exhausted',
        `steps: ${attemptsSoFar} of ${this.goal.budget.maxSteps} attempts started`,
      );
      return;
    }
    // #619 deviation 6 (I-G6): the attempts this advance starts split what the goal can still hand
    // out, read under the quota lock that every Task of the requester is created under — a nested
    // child Task's `invoke_worker` included — so nothing claims the same tokens twice.
    await lockTaskQuotas(this.client, this.ws, this.requester);
    const headroom = await readGoalRunTokenHeadroom(this.client, this.ws, this.goal.id);
    const starting = Math.min(ready.length, this.goal.budget.maxSteps - attemptsSoFar);
    const share = Math.floor(headroom / starting);
    if (share < 1) {
      // Held by live Tasks: their unspent budget comes back when they end, and their end wakes
      // the run. Otherwise the goal's tokens are all but spent.
      if (this.liveTasks.length === 0) {
        await this.pause(
          'budget_exhausted',
          `tokens: ${headroom} left of ${this.goal.budget.maxTokens}, not enough for ${starting} attempt(s)`,
        );
      }
      return;
    }
    for (const step of ready) {
      if (attemptsSoFar >= this.goal.budget.maxSteps) {
        await this.pause(
          'budget_exhausted',
          `steps: ${attemptsSoFar} of ${this.goal.budget.maxSteps} attempts started`,
        );
        return;
      }
      const predecessor = await this.predecessorBusy(steps, step);
      if (predecessor === 'reconcile') {
        await this.pause(
          'awaiting_reconcile',
          `step ${step.stepKey}: an action of the step it replaces may have run (outcome unknown)`,
        );
        return;
      }
      if (predecessor === 'busy') {
        this.timers.push(this.now.getTime() + this.blockedRetryRecheckMs);
        continue;
      }
      if (!(await this.startAttempt(step, share, steps))) return;
      attemptsSoFar += 1;
    }
  }

  /** Whether the run may verify: no Task of it still runs (a step let finish after a revision) and
   *  no request of a superseded step is still in flight — released, or executing when the revision
   *  came. An outcome-unknown one pauses the run `awaiting_reconcile`. Otherwise the run looks
   *  again when the Task or the request ends (its event wakes the run; the re-check bounds a lost
   *  wake). */
  private async settled(steps: readonly StepRunRow[]): Promise<boolean> {
    let busy = this.liveTasks.length > 0;
    for (const step of steps) {
      if (step.status !== 'superseded') continue;
      const effect = stepActionEffect(await listStepActionOutcomes(this.client, this.ws, step.id));
      if (effect.kind !== 'wait') continue;
      if (effect.waitingReason === 'reconcile') {
        await this.pause(
          'awaiting_reconcile',
          `step ${step.stepKey} (revised away): an action of it may have run (outcome unknown)`,
        );
        return false;
      }
      busy = true;
    }
    if (busy) this.timers.push(this.now.getTime() + this.blockedRetryRecheckMs);
    return !busy;
  }

  /** The first StepRun a revision superseded — under any key — with a request whose outcome is
   *  unknown, or `null`. */
  private async supersededInDoubt(steps: readonly StepRunRow[]): Promise<StepRunRow | null> {
    for (const step of steps) {
      if (step.status !== 'superseded') continue;
      const effect = stepActionEffect(await listStepActionOutcomes(this.client, this.ws, step.id));
      if (effect.kind === 'wait' && effect.waitingReason === 'reconcile') return step;
    }
    return null;
  }

  /** What the StepRuns a revision superseded under `step`'s key still have running: `busy` (a Task,
   *  or a request in flight), `reconcile` (a request whose outcome is unknown — found by
   *  {@link supersededInDoubt} before any attempt starts; one that turned so since) or `null`. */
  private async predecessorBusy(
    steps: readonly StepRunRow[],
    step: StepRunRow,
  ): Promise<'busy' | 'reconcile' | null> {
    let busy = false;
    for (const before of steps) {
      if (before.status !== 'superseded' || before.stepKey !== step.stepKey) continue;
      if (this.liveTasksOf(before).length > 0) busy = true;
      const effect = stepActionEffect(
        await listStepActionOutcomes(this.client, this.ws, before.id),
      );
      if (effect.kind !== 'wait') continue;
      if (effect.waitingReason === 'reconcile') return 'reconcile';
      busy = true;
    }
    return busy ? 'busy' : null;
  }

  /** Starts one attempt of a `ready` step with at most `tokenCap` tokens; `false` when nothing more
   *  starts in this advance. `steps`: the run's StepRuns, which the step's bindings take from. */
  private async startAttempt(
    step: StepRunRow,
    tokenCap: number,
    steps: readonly StepRunRow[],
  ): Promise<boolean> {
    const entry = await this.entry(step);
    if (!entry || !(await this.inCurrentPlan(step))) {
      await this.pause('needs_decision', `step ${step.stepKey}: no longer in the current plan`);
      return false;
    }
    let previous: RunConfigSnapshot | null = null;
    // GO5d-1: an attempt after one that ended without an accepted result redoes it — the Worker
    // reads what was refused (`get_task`), whoever started the attempt (a rework, a person's retry).
    let reworkOf: ReworkOf | null = null;
    if (step.attemptCount > 0) {
      const last = await readStepAttemptTask(this.client, this.ws, step.id, step.attemptCount);
      if (!last?.runConfig) {
        await this.pause(
          'needs_decision',
          `step ${step.stepKey}: attempt ${step.attemptCount} has no readable configuration snapshot`,
        );
        return false;
      }
      previous = last.runConfig;
      if (last.status === 'failed' && last.failureReason === 'no_result') {
        reworkOf = {
          taskId: last.id,
          attempt: step.attemptCount,
          rejectedOutput: last.rejectedOutput,
        };
      }
    }
    const input = await assembleStepInput(this.client, this.ws, entry, steps);
    if (input.kind === 'blocked') {
      await this.pause('needs_decision', input.detail);
      return false;
    }
    const currentRevision = this.goal.currentRevision;
    if (currentRevision === null)
      throw new Error('advanceGoalRun: a running goal run has no revision');
    const attempt = step.attemptCount + 1;
    const result = await createStepAttemptTask(this.client, this.ws, this.requester, {
      goalRunId: this.goal.id,
      stepRunId: step.id,
      planRevision: currentRevision,
      stepAttempt: attempt,
      worker: entry.worker,
      input: input.input,
      outputSchema: entry.outputSchema ?? null,
      reworkOf,
      nested: entry.nested ?? false,
      previous,
      tokenCap,
      durationCapSec: Math.max(1, Math.floor((this.deadline - this.now.getTime()) / 1000)),
    });
    if (result.kind === 'refused') {
      const pause = refusalPause(result.refusal);
      if (pause) {
        await this.pause(pause, `step ${step.stepKey}: ${result.refusal.detail}`);
      } else {
        this.timers.push(this.now.getTime() + this.quotaRetryMs);
      }
      return false;
    }
    await this.moveStep(step, 'start', {
      audit: {
        taskId: result.attempt.task.id,
        attempt,
        ...(reworkOf ? { reworkOf: reworkOf.taskId } : {}),
        ...((entry.bindings ?? []).length > 0 ? { bound: (entry.bindings ?? []).length } : {}),
      },
    });
    this.started.push(result.attempt);
    return true;
  }

  // ----- E ------------------------------------------------------------------------------------

  /** Legacy 393: nothing of the run moves on its own and a step failed for a person — see the
   *  module comment, phase E. */
  private async pauseIfStuck(steps: readonly StepRunRow[]): Promise<void> {
    const live = steps.filter((step) => step.status !== 'superseded');
    let moving = live.some(
      (step) =>
        MOVING_STEP_STATUSES.has(step.status) ||
        (step.status === 'failed' && step.failureCategory === 'transient'),
    );
    for (const step of live) {
      if (moving) break;
      moving = await this.reworkDue(step);
    }
    // By key, so the same run always reads the same.
    const failed = live
      .filter((step) => step.status === 'failed')
      .sort((a, b) => (a.stepKey < b.stepKey ? -1 : a.stepKey > b.stepKey ? 1 : 0));
    if (moving || failed.length === 0) return;
    // Every failed step is named with what it waits for (review #493 on #657). An action found to
    // have no effect needs the requester's re-execute decision before a retry is accepted (GO3c,
    // `control.ts`): say so rather than send them to a retry that is refused.
    const waits: string[] = [];
    for (const step of failed) {
      const outcomes = await listStepActionOutcomes(this.client, this.ws, step.id);
      waits.push(
        outcomes.some((outcome) => actionDisposition(outcome) === 'unconfirmed')
          ? `step ${step.stepKey}: an action of it was found to have no effect and is not run again on its own — decide to run it again, then retry the step`
          : step.failureCategory === 'verification_failed'
            ? `step ${step.stepKey}: attempt ${step.attemptCount} did not pass its acceptance checks and is not retried on its own — retry it (its work is done again)`
            : `step ${step.stepKey}: attempt ${step.attemptCount} failed (${step.failureCategory}) and is not retried on its own — retry it`,
      );
    }
    await this.pause('needs_decision', `${waits.join('; ')}; or revise the plan or cancel`);
  }

  // ----- V ------------------------------------------------------------------------------------

  /** Phase V — see the module comment. `entered`: this advance moved the run into `verifying`, so
   *  its round is opened now. */
  private async verify(entered: boolean): Promise<void> {
    let round = entered
      ? []
      : await readCurrentAcceptanceRound(this.client, this.ws, this.goal.id, this.goal.updatedAt);
    if (round.length === 0) {
      const opened = await this.openRound();
      if (!opened) return;
      round = opened;
    }
    const platformChecks = round.filter((check) => isPlatformAcceptanceCheck(check.kind));
    if (platformChecks.some((check) => check.status === 'pending')) return;
    const unmet = round.filter((check) => check.status !== 'passed' && check.status !== 'pending');
    if (unmet.length > 0) {
      const named = unmet.map((check) =>
        check.status === 'failed'
          ? `acceptance check ${check.checkKey}: ${unmetEvidence(check)}`
          : (noFactSeen(check) ??
            neverSeenPresent(check) ??
            `acceptance check ${check.checkKey}: ${check.status} (${check.lastError ?? 'no reason recorded'})`),
      );
      await this.pause(
        'needs_decision',
        `round ${round[0]?.round}: ${named.join('; ')}; end the goal as not achieved (or as achieved, on your word), revise the plan, resume to verify again, or cancel`,
      );
      return;
    }
    // Every check the platform makes passed: what is left is the requester's confirmation, if the
    // round asks.
    if (round.some((check) => check.status === 'pending')) return;
    const confirmation = round.find((check) => check.kind === 'requester_confirm');
    const byCheck = platformChecks.length > 0;
    this.status = await moveGoalRun(this.client, this.actor, this.goal, 'verifying', 'complete', {
      outcome: {
        outcome: 'achieved',
        basis: byCheck ? 'verified_by_check' : 'requester',
        ...(!byCheck && confirmation?.decisionId ? { decisionId: confirmation.decisionId } : {}),
      },
      audit: { round: round[0]?.round, checks: round.map((check) => check.checkKey) },
    });
  }

  /** Opens a round on the plan in force — or pauses the run when the plan's acceptance cannot be
   *  read (a stored plan is validated, so this is a broken row, not a person's mistake). */
  private async openRound(): Promise<readonly AcceptanceCheckRow[] | null> {
    const revision = this.goal.currentRevision;
    if (revision === null) throw new Error('advanceGoalRun: a verifying goal run has no revision');
    const checks = roundAcceptance(await this.plan(revision), this.goal.statement);
    if (!checks) {
      await this.pause('needs_decision', `revision ${revision}: its acceptance is unreadable`);
      return null;
    }
    return openAcceptanceRound(this.client, this.ws, {
      goalRunId: this.goal.id,
      planRevision: revision,
      checks,
      actorPrincipalId: this.requester,
    });
  }

  // ----- transitions --------------------------------------------------------------------------

  private get actor(): GoalMoveActor {
    return { principalId: this.requester, by: 'advancer' };
  }

  private async moveStep(
    step: StepRunRow,
    event: StepRunEvent,
    params: {
      readonly waitingReason?: StepRunWaitingReason;
      readonly failureCategory?: StepRunFailureCategory;
      readonly audit?: Record<string, unknown>;
    },
  ): Promise<StepRunRow> {
    return moveStepRun(this.client, this.actor, step, event, params);
  }

  /** Pauses a running or verifying GoalRun. A paused one keeps its reason (the guard refuses changing it); the
   *  later cause is only audited — once per pause: a cause already recorded since the run paused
   *  (by the pause itself or an earlier note, same reason and detail) is not written again, so a
   *  paused run advanced by every wake does not repeat it. */
  private async pause(reason: GoalRunPauseReason, detail: string): Promise<void> {
    if (this.status !== 'running' && this.status !== 'verifying') {
      if (await this.pauseCauseRecorded(reason, detail)) return;
      // Not a transition: an audit row only, no `GoalRunUpdated`.
      await writeAudit(this.client, {
        workspaceId: this.ws,
        actorPrincipalId: this.requester,
        action: 'goal_run.pause_noted',
        resourceType: 'goal_run',
        resourceId: this.goal.id,
        payload: { by: 'advancer', status: this.status, reason, detail },
      });
      return;
    }
    await this.moveGoal('pause', reason, { reason, detail });
  }

  /** Whether `reason` / `detail` is already in the audit log since the run last changed status
   *  (`updated_at` is written by transitions only; a paused run's is its pause). Reads by
   *  `resource_id` (`audit_records_resource_idx`, core/0044). */
  private async pauseCauseRecorded(reason: GoalRunPauseReason, detail: string): Promise<boolean> {
    const result = await this.client.query(
      `select 1 from audit_records
        where workspace_id = $1 and resource_id = $2 and created_at >= $3
          and action in ('goal_run.pause', 'goal_run.pause_noted')
          and payload ->> 'reason' = $4 and payload ->> 'detail' = $5
        limit 1`,
      [this.ws, this.goal.id, this.goal.updatedAt, reason, detail],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async moveGoal(
    event: Extract<GoalRunEvent, 'pause' | 'verify'>,
    pauseReason: GoalRunPauseReason | null,
    audit: Record<string, unknown>,
  ): Promise<void> {
    this.status = await moveGoalRun(this.client, this.actor, this.goal, this.status, event, {
      ...(pauseReason ? { pauseReason } : {}),
      audit,
    });
  }
}
