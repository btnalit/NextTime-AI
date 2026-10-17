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
  listStepActionOutcomes,
  listUnresolvedStepActions,
} from '../../governance/approval/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  type LiveGoalTask,
  type PreparedStepAttempt,
  type RunConfigSnapshot,
  type StepAttemptRefusal,
  type TaskRuntimeDeps,
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
import { type CancellingOptions, advanceCancellingGoalRun } from './cancelling.js';
import { type StepActionEffect, stepActionEffect } from './disposition.js';
import { type GoalMoveActor, moveGoalRun, moveStepRun } from './moves.js';
import { DEFAULT_MAX_ATTEMPTS, type PlanStep, planStep, samePlanEntry } from './plan.js';
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
 * — terminating them after the commit — and its executing actions to end, then is `cancelled`.
 * Otherwise only a `running` or `paused` GoalRun is advanced; any other status just loses its
 * `next_tick_at` (verification is GO4). Then, in order:
 *
 *   0. **Stop revised-away work** (running or paused; S11 GO3b, `revise.ts`). The live Tasks of a
 *      step a revision superseded — its attempt and nested child Tasks — are terminated after the
 *      commit, like a cancelling run's, unless the revision let that step finish
 *      (`plan_revisions.removals`, goal/0004). A superseded step itself never moves again.
 *   R. **Lift a reconcile pause** (S11 GO3c). The advancer's own `awaiting_reconcile` pause —
 *      someone has to check a target system first — ends once no request of any step of the run
 *      (superseded ones included) still awaits a finding (`reconcile.ts`; GO3d adds the platform's
 *      reconcile observation): the run goes back to `running` and the phases below judge its
 *      steps again, so `effect_seen` lets the run go on, `effect_absent` pauses it
 *      `needs_decision` (the reason the shared vocabulary gives a reconcile that saw no effect)
 *      and a re-execute starts a new attempt. A person's pause (`requested`, an owner's hold) is
 *      never lifted here.
 *   A. **Record finished attempts** (running or paused). A `running` / `waiting` step whose current
 *      attempt Task has finished — once no other Task of the step still runs: a nested child Task
 *      can outlive its caller and still raise requests the step owns (GO3b) — is judged by that
 *      Task and by what the ActionRequests raised by that attempt's own runs — nested children
 *      included — became (`stepActionEffect`, §4.7; an earlier attempt's requests never decide
 *      this one). A request still in flight or awaiting a reconcile holds the step in `waiting`
 *      (§4.8: the wait is on the step, not on the Worker); a reconcile also pauses the GoalRun
 *      `awaiting_reconcile` until a person records what they found (GO3c, `reconcile.ts`;
 *      `effect_seen` counts as executed, `effect_absent` fails the step `outcome_unknown` for a
 *      person, a re-execute decision fails it `transient` for a new attempt — `disposition.ts`;
 *      the platform's reconcile observation is GO3d). Otherwise {@link judgeFinishedAttempt}:
 *      success, or a failure category — only `transient` is retried without a person; every
 *      other category pauses the GoalRun. A step
 *      no longer part of the current plan is not judged at all (I-G2: a late result is kept on
 *      its Task, it moves nothing) and the GoalRun pauses `needs_decision`.
 *   B. **Retry transient failures** (running only). Under the step's attempt limit (plan
 *      `maxAttempts`, default 3), once no request of the step — of any attempt — is still in flight
 *      and no Task of it still runs (I-G4: no new attempt beside an action that may still run),
 *      after an exponential backoff from the failure, and only if the step is still part of the
 *      current plan: `failed → ready`.
 *      Past the limit, the GoalRun pauses `needs_decision`.
 *   C. **Unblock** (running or paused). A `pending` step whose dependencies all succeeded becomes
 *      `ready` — after re-checking that its definition is still the current plan's entry (the
 *      database does not check this on `ready`). A skipped dependency counts as done.
 *   D. **Start** (running only). Every live step succeeded → `verifying` (GO4 runs the acceptance
 *      checks) — once nothing of the run is left running: no Task of it (a step let finish after a
 *      revision) and no request of a superseded step still in flight (one released, or executing
 *      when the revision came); one whose outcome is unknown pauses `awaiting_reconcile` first
 *      (GO3b). Otherwise the budget is checked (I-G6: wall clock from confirmation, tokens used by
 *      the GoalRun's Tasks; past either → `paused(budget_exhausted)`, never failed), then each
 *      `ready` step starts one attempt while the step budget allows, the attempts of one advance
 *      splitting the goal's token headroom (`readGoalRunTokenHeadroom`: the budget less what every
 *      Task of the run holds — a live Task its own budget), so the live Tasks' budgets together
 *      never exceed what is left of the goal's: `createStepAttemptTask` inserts
 *      the attempt's Task in this transaction and the step moves `ready → running` with
 *      `attempt_count + 1` (I-G1). No attempt starts while a request of any superseded step —
 *      whatever key the revision gave its work — has an unknown outcome: the run pauses
 *      `awaiting_reconcile` (review #493 on #633). A step whose key a revision redefined does not
 *      start while the StepRun it replaced still has a Task running or a request in flight (I-G4
 *      across the revision: the new definition does not run beside the old one's actions). A
 *      refusal leaves the step `ready`: the requester's concurrency quota retries after
 *      {@link DEFAULT_QUOTA_RETRY_MS}; the daily cost quota pauses `budget_exhausted`; lost
 *      authority pauses `authority_lost` (S9, I-G7); a pinned component no longer published
 *      pauses `needs_decision`.
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
 * | completed | clear | succeed (GO4 adds the step's acceptance, GO5 its output schema) |
 * | completed | `fail(c)` | failed `c` — a refused request needs a person; a request that never reached its gate is transient |
 * | failed | `fail(action_refused)` or `fail(outcome_unknown)` | failed with that category — a person decides, whatever became of the Task (GO3c: an action found to have had no effect is never retried on its own) |
 * | failed `no_result` | otherwise | failed `contract_violation` — needs a person (§4.7 allows one rework; W1 asks instead, see the PR) |
 * | failed `budget_exhausted` | otherwise | failed `transient`, GoalRun paused `budget_exhausted` — the attempt's budget is what was left of the goal's |
 * | failed, any other reason | otherwise | failed `transient` — spawn failed or lost, run lost, Worker crashed, timed out or terminated |
 * | cancelled | any | failed `transient`, GoalRun paused `needs_decision` — someone stopped the Task outside the goal |
 */
export function judgeFinishedAttempt(
  task: { readonly status: TaskStatus; readonly failureReason: string | null },
  effect: Exclude<StepActionEffect, { readonly kind: 'wait' }>,
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
  if (task.failureReason === 'no_result') return failVerdict('contract_violation');
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
      if (goal.status === 'running' || goal.status === 'paused' || goal.status === 'cancelling') {
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
      if (goal.status !== 'running' && goal.status !== 'paused') {
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
    const steps = await this.lockSteps();
    this.liveTasks = await listGoalRunLiveTaskSteps(this.client, this.ws, this.goal.id);
    await this.stopSupersededWork(steps);
    await this.liftReconcilePause(steps);
    for (const step of steps) {
      if (step.status === 'running' || step.status === 'waiting') await this.recordAttempt(step);
    }
    if (this.status === 'running') {
      for (const step of await this.lockSteps()) {
        if (this.status !== 'running') break;
        if (step.status === 'failed' && step.failureCategory === 'transient') {
          await this.retryStep(step);
        }
      }
    }
    await this.unblockSteps(await this.lockSteps());
    if (this.status === 'running') await this.startSteps(await this.lockSteps());

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

  // ----- R ------------------------------------------------------------------------------------

  /** Before phase A: a run paused this way judges its steps as a running one does, so a step that
   *  now fails pauses the run with its own reason. */
  private async liftReconcilePause(steps: readonly StepRunRow[]): Promise<void> {
    if (
      this.status !== 'paused' ||
      this.goal.pauseReason !== 'awaiting_reconcile' ||
      this.goal.pausedBy !== null
    ) {
      return;
    }
    const unresolved = await listUnresolvedStepActions(
      this.client,
      this.ws,
      steps.map((step) => step.id),
    );
    if (unresolved.some((action) => action.reconciliation === null)) return;
    await this.moveGoal('resume', null, {
      pauseReason: 'awaiting_reconcile',
      reason: 'reconciled',
    });
  }

  // ----- A ------------------------------------------------------------------------------------

  private async recordAttempt(step: StepRunRow): Promise<void> {
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
    const effect = stepActionEffect(
      await listStepActionOutcomes(this.client, this.ws, step.id, { raisedBy: runs }),
    );
    if (effect.kind === 'wait') {
      await this.holdStep(step, effect.waitingReason, task.id);
      if (effect.waitingReason === 'reconcile') {
        await this.pause(
          'awaiting_reconcile',
          `step ${step.stepKey}: an action of attempt ${step.attemptCount} may have run (outcome unknown)`,
        );
      }
      return;
    }
    const verdict = judgeFinishedAttempt(task, effect);
    const audit = {
      taskId: task.id,
      attempt: step.attemptCount,
      taskStatus: task.status,
      taskFailureReason: task.failureReason,
    };
    if (verdict.kind === 'succeed') {
      await this.moveStep(step, 'succeed', { audit });
      return;
    }
    await this.moveStep(step, 'fail', { failureCategory: verdict.category, audit });
    if (verdict.pause) {
      await this.pause(
        verdict.pause,
        `step ${step.stepKey}: attempt ${step.attemptCount} failed (${verdict.category})`,
      );
    }
  }

  /** `running → waiting(reason)`; a step already waiting for another reason resumes and waits
   *  again (the waiting reason is set by the transition into waiting). */
  private async holdStep(
    step: StepRunRow,
    reason: Extract<StepRunWaitingReason, 'approval' | 'reconcile'>,
    taskId: string,
  ): Promise<void> {
    if (step.status === 'waiting' && step.waitingReason === reason) return;
    const audit = { taskId, attempt: step.attemptCount };
    const running =
      step.status === 'waiting' ? await this.moveStep(step, 'resume', { audit }) : step;
    await this.moveStep(running, 'wait', { waitingReason: reason, audit });
  }

  // ----- B ------------------------------------------------------------------------------------

  private async retryStep(step: StepRunRow): Promise<void> {
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
    if (due > this.now.getTime()) {
      this.timers.push(due);
      return;
    }
    if (!(await this.inCurrentPlan(step))) {
      await this.pause('needs_decision', `step ${step.stepKey}: no longer in the current plan`);
      return;
    }
    await this.moveStep(step, 'retry', { audit: { attempts: step.attemptCount } });
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

  // ----- D ------------------------------------------------------------------------------------

  private async startSteps(steps: readonly StepRunRow[]): Promise<void> {
    const live = steps.filter((step) => step.status !== 'superseded');
    if (live.length > 0 && live.every((step) => DONE_STEP_STATUSES.has(step.status))) {
      if (await this.settled(steps)) await this.moveGoal('verify', null, { steps: live.length });
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
      if (!(await this.startAttempt(step, share))) return;
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
   *  starts in this advance. */
  private async startAttempt(step: StepRunRow, tokenCap: number): Promise<boolean> {
    const entry = await this.entry(step);
    if (!entry || !(await this.inCurrentPlan(step))) {
      await this.pause('needs_decision', `step ${step.stepKey}: no longer in the current plan`);
      return false;
    }
    let previous: RunConfigSnapshot | null = null;
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
      input: entry.input,
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
      audit: { taskId: result.attempt.task.id, attempt },
    });
    this.started.push(result.attempt);
    return true;
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

  /** Pauses a running GoalRun. A paused one keeps its reason (the guard refuses changing it); the
   *  later cause is only audited — once per pause: a cause already recorded since the run paused
   *  (by the pause itself or an earlier note, same reason and detail) is not written again, so a
   *  paused run advanced by every wake does not repeat it. */
  private async pause(reason: GoalRunPauseReason, detail: string): Promise<void> {
    if (this.status !== 'running') {
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
    event: Extract<GoalRunEvent, 'pause' | 'resume' | 'verify'>,
    pauseReason: GoalRunPauseReason | null,
    audit: Record<string, unknown>,
  ): Promise<void> {
    this.status = await moveGoalRun(this.client, this.actor, this.goal, this.status, event, {
      ...(pauseReason ? { pauseReason } : {}),
      audit,
    });
  }
}
