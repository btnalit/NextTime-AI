import {
  GOAL_RUN_TRANSITIONS,
  type GoalRunEvent,
  type GoalRunPauseReason,
  type GoalRunStatus,
  STEP_RUN_TRANSITIONS,
  type StepRunEvent,
  type StepRunFailureCategory,
  type StepRunStatus,
  type StepRunWaitingReason,
  type TaskStatus,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import { listStepActionOutcomes } from '../../governance/approval/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  type PreparedStepAttempt,
  type RunConfigSnapshot,
  type StepAttemptRefusal,
  type TaskRuntimeDeps,
  createStepAttemptTask,
  listTaskWorkerRunTree,
  readGoalRunUsage,
  readStepAttemptTask,
  startStepAttemptTask,
} from '../task/index.js';
import { type StepActionEffect, stepActionEffect } from './disposition.js';
import { DEFAULT_MAX_ATTEMPTS, type PlanStep, planStep, samePlanEntry } from './plan.js';
import { getPlanRevision } from './reads.js';
import { lockGoalRun } from './service.js';
import { recordGoalRunTransition, recordStepRunTransition } from './transition-log.js';
import {
  type GoalRunRow,
  STEP_RUN_ROW_COLUMNS,
  type StepRunDbRow,
  type StepRunRow,
  mapStepRunRow,
} from './types.js';

/**
 * application/goal/advance (S11 GO2; plan §4.2, §4.7, §4.9): one advance of one GoalRun — the
 * deterministic rules that move its steps, in one transaction under the requester's workspace
 * context, GoalRun row locked first (every writer under a GoalRun takes that lock before any
 * StepRun's; the guards take it too). The advancer calls no model and holds no credential: every
 * rule below reads rows and moves rows.
 *
 * Only a `running` or `paused` GoalRun is advanced; any other status just loses its `next_tick_at`
 * (verification is GO4, cancelling GO3). Then, in order:
 *
 *   A. **Record finished attempts** (running or paused). A `running` / `waiting` step whose current
 *      attempt Task has finished is judged by that Task and by what the ActionRequests raised by
 *      that attempt's own runs — nested children included — became (`stepActionEffect`, §4.7; an
 *      earlier attempt's requests never decide this one). A request still in flight or awaiting
 *      a reconcile holds the step in `waiting` (§4.8: the wait is on the step, not on the Worker);
 *      a reconcile also pauses the GoalRun `awaiting_reconcile` (the reconcile observation is
 *      GO3). Otherwise {@link judgeFinishedAttempt}: success, or a failure category — only
 *      `transient` is retried without a person; every other category pauses the GoalRun.
 *   B. **Retry transient failures** (running only). Under the step's attempt limit (plan
 *      `maxAttempts`, default 3), once no request of the step — of any attempt — is still in flight
 *      (I-G4: no new attempt beside an action that may still run), after an exponential backoff
 *      from the failure, and only if the step is still part of the current plan: `failed → ready`.
 *      Past the limit, the GoalRun pauses `needs_decision`.
 *   C. **Unblock** (running or paused). A `pending` step whose dependencies all succeeded becomes
 *      `ready` — after re-checking that its definition is still the current plan's entry (the
 *      database does not check this on `ready`).
 *   D. **Start** (running only). Every live step succeeded → `verifying` (GO4 runs the acceptance
 *      checks). Otherwise the budget is checked (I-G6: wall clock from confirmation, tokens used by
 *      the GoalRun's Tasks; past either → `paused(budget_exhausted)`, never failed), then each
 *      `ready` step starts one attempt while the step budget allows: `createStepAttemptTask` inserts
 *      the attempt's Task in this transaction and the step moves `ready → running` with
 *      `attempt_count + 1` (I-G1). A refusal leaves the step `ready`: the requester's concurrency
 *      quota retries after {@link DEFAULT_QUOTA_RETRY_MS}; the daily cost quota pauses
 *      `budget_exhausted`; lost authority pauses `authority_lost` (S9, I-G7); a pinned component no
 *      longer published pauses `needs_decision`.
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

export interface GoalAdvancerOptions {
  readonly retryBackoffMs?: (attempts: number) => number;
  readonly quotaRetryMs?: number;
  readonly blockedRetryRecheckMs?: number;
}

export interface GoalAdvanceDeps {
  readonly pool: PoolLike;
  /** Spawns the attempts' WorkerRuns after the advance commits. */
  readonly taskRuntime: TaskRuntimeDeps;
  readonly options?: GoalAdvancerOptions;
  /** Called when starting an attempt after the commit fails other than by a spawn failure (which
   *  `startStepAttemptTask` turns into a failed Task itself). */
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
  readonly nextTickAt: Date | null;
}

const FINISHED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);
const FINAL_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  'succeeded',
  'superseded',
  'cancelled',
  'skipped',
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
 * | failed | `fail(action_refused)` | failed `action_refused` |
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
  if (effect.kind === 'fail' && effect.failureCategory === 'action_refused') {
    return failVerdict('action_refused');
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
      if (refusal.code === 'daily_cost_exceeded') return 'budget_exhausted';
      return 'needs_decision';
  }
}

/** One advance — see the module doc comment. */
export async function advanceGoalRun(
  deps: GoalAdvanceDeps,
  target: GoalAdvanceTarget,
): Promise<GoalAdvanceOutcome> {
  const { outcome, attempts } = await withWorkspace(
    deps.pool,
    { workspaceId: target.workspaceId, principalId: target.requesterId },
    async (client) => {
      const goal = await lockGoalRun(client, target.workspaceId, target.goalRunId);
      if (!goal) {
        return {
          outcome: { status: null, startedTaskIds: [], nextTickAt: null },
          attempts: [] as PreparedStepAttempt[],
        };
      }
      if (goal.status !== 'running' && goal.status !== 'paused') {
        if (goal.nextTickAt !== null) await writeNextTick(client, goal, null);
        return {
          outcome: { status: goal.status, startedTaskIds: [], nextTickAt: null },
          attempts: [] as PreparedStepAttempt[],
        };
      }
      const advance = new Advance(client, goal, await databaseNow(client), deps.options ?? {});
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
  return outcome;
}

async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>('select now() as now');
  const now = result.rows[0]?.now;
  if (!now) throw new Error('advanceGoalRun: select now() returned no row');
  return now;
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
  private readonly plans = new Map<number, unknown>();

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

  async run(): Promise<{ outcome: GoalAdvanceOutcome; attempts: PreparedStepAttempt[] }> {
    for (const step of await this.lockSteps()) {
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
        nextTickAt,
      },
      attempts: this.started,
    };
  }

  /** Every StepRun of the run, superseded ones included, locked after the GoalRun row (lock order:
   *  GoalRun, then its StepRuns), in creation order. Read again between phases: a phase moves rows
   *  the next one judges. */
  private async lockSteps(): Promise<readonly StepRunRow[]> {
    const result = await this.client.query<StepRunDbRow>(
      `select ${STEP_RUN_ROW_COLUMNS} from step_runs
       where workspace_id = $1 and goal_run_id = $2
       order by created_at, id
       for no key update`,
      [this.ws, this.goal.id],
    );
    return result.rows.map(mapStepRunRow);
  }

  private async plan(revision: number): Promise<unknown> {
    if (!this.plans.has(revision)) {
      const row = await getPlanRevision(this.client, this.ws, this.goal.id, revision);
      this.plans.set(revision, row?.plan ?? null);
    }
    return this.plans.get(revision);
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
    // Every request of the step, of every attempt (I-G4): none may still run beside a new attempt.
    const all = stepActionEffect(await listStepActionOutcomes(this.client, this.ws, step.id));
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
    const succeeded = new Set(
      steps.filter((step) => step.status === 'succeeded').map((step) => step.stepKey),
    );
    for (const step of steps) {
      if (step.status !== 'pending') continue;
      const entry = await this.entry(step);
      if (!entry) {
        await this.pause('needs_decision', `step ${step.stepKey}: its plan entry is unreadable`);
        continue;
      }
      if (!(entry.dependsOn ?? []).every((key) => succeeded.has(key))) continue;
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
      await this.moveGoal('verify', null, { steps: live.length });
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
    let attemptsSoFar = usage.steps;
    for (const step of live) {
      if (step.status !== 'ready') continue;
      if (attemptsSoFar >= this.goal.budget.maxSteps) {
        await this.pause(
          'budget_exhausted',
          `steps: ${attemptsSoFar} of ${this.goal.budget.maxSteps} attempts started`,
        );
        return;
      }
      if (!(await this.startAttempt(step, usage.tokens))) return;
      attemptsSoFar += 1;
    }
  }

  /** Starts one attempt of a `ready` step; `false` when nothing more starts in this advance. */
  private async startAttempt(step: StepRunRow, tokensUsed: number): Promise<boolean> {
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
      tokenCap: this.goal.budget.maxTokens - tokensUsed,
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

  private async moveStep(
    step: StepRunRow,
    event: StepRunEvent,
    params: {
      readonly waitingReason?: StepRunWaitingReason;
      readonly failureCategory?: StepRunFailureCategory;
      readonly audit?: Record<string, unknown>;
    },
  ): Promise<StepRunRow> {
    const to = transition(STEP_RUN_TRANSITIONS, step.status, event);
    const result = await this.client.query<StepRunDbRow>(
      `update step_runs
          set status = $3, waiting_reason = $4, failure_category = $5,
              attempt_count = attempt_count + $6, updated_at = now(),
              ended_at = case when $7 then now() else null end
        where workspace_id = $1 and id = $2 and status = $8
        returning ${STEP_RUN_ROW_COLUMNS}`,
      [
        this.ws,
        step.id,
        to,
        to === 'waiting' ? (params.waitingReason ?? null) : null,
        to === 'failed' ? (params.failureCategory ?? null) : null,
        event === 'start' ? 1 : 0,
        FINAL_STEP_STATUSES.has(to),
        step.status,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`advanceGoalRun: step run ${step.id} is no longer ${step.status}`);
    }
    await recordStepRunTransition(this.client, this.ws, {
      actorPrincipalId: this.requester,
      action: `step_run.${event}`,
      goalRunId: this.goal.id,
      stepRunId: step.id,
      resultingStatus: to,
      extraAuditPayload: {
        by: 'advancer',
        stepKey: step.stepKey,
        ...(to === 'waiting' ? { waitingReason: params.waitingReason } : {}),
        ...(to === 'failed' ? { failureCategory: params.failureCategory } : {}),
        ...params.audit,
      },
    });
    return mapStepRunRow(row);
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
    event: Extract<GoalRunEvent, 'pause' | 'verify'>,
    pauseReason: GoalRunPauseReason | null,
    audit: Record<string, unknown>,
  ): Promise<void> {
    const to = transition(GOAL_RUN_TRANSITIONS, this.status, event);
    await this.client.query(
      `update goal_runs set status = $3, pause_reason = $4, updated_at = now()
        where workspace_id = $1 and id = $2`,
      [this.ws, this.goal.id, to, pauseReason],
    );
    await recordGoalRunTransition(this.client, this.ws, {
      actorPrincipalId: this.requester,
      action: `goal_run.${event}`,
      goalRunId: this.goal.id,
      resultingStatus: to,
      extraAuditPayload: { by: 'advancer', ...audit },
    });
    this.status = to;
  }
}
