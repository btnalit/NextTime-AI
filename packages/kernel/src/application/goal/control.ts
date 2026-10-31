import type { GoalRunPauseAuthority, GoalRunStatus, StepRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { listStepActionOutcomes, withdrawStepActions } from '../../governance/approval/index.js';
import { listStepLiveTasks } from '../task/index.js';
import { ensureAbsenceBaselines, requiredAbsenceChecks } from './absence-baselines.js';
import { GOAL_CANCELLED_WITHDRAW_REASON } from './cancelling.js';
import { actionDisposition, stepActionEffect } from './disposition.js';
import { type GoalMoveActor, moveGoalRun, moveStepRun } from './moves.js';
import { samePlanEntry } from './plan.js';
import { closePlanning } from './planning-rounds.js';
import { getPlanRevision, lockStepRuns } from './reads.js';
import {
  GoalRunForbiddenError,
  GoalRunNotFoundError,
  GoalRunStateError,
  lockGoalRun,
} from './service.js';
import { recordGoalRunTransition } from './transition-log.js';
import type { GoalControlActor, GoalRunRow, StepRunRow } from './types.js';

/**
 * application/goal/control (S11 GO3a; plan §4.1, §4.8): a person stopping a GoalRun — pause,
 * resume, cancel. The capabilities that expose them (`pause_goal`, `resume_goal`, `cancel_goal`,
 * `release_goal_hold`, S11 GO5b: `application/gateway/goal-handlers.ts`) take the actor from the
 * authenticated caller; like `confirmGoalRun`, these run in the caller's transaction and enforce
 * what a capability must not be able to skip. Each takes the GoalRun lock first, then its StepRuns'.
 *
 * Who may: stopping — pause, cancel — is the requester's or a workspace owner's (an owner may stop
 * anything in the workspace, the rule `cancel_task` applies, D-21). Resuming is the requester's
 * alone: it lets the run spend and act again with the requester's authority (propose → authorize
 * → execute, §4.3), which nobody decides for them.
 *
 * S11 GO3b (goal/0004): a pause records who paused and the authority it carries — `requester`
 * (the requester, also when they are an owner too) or `owner` (a workspace owner pausing someone
 * else's run). An owner's pause is a **hold**: the requester cannot resume the run until a
 * workspace owner lifts the hold ({@link releaseGoalRunHold}); otherwise an owner's stop would be
 * undone by the person it was meant to stop. The database refuses resuming a held run too.
 *
 *   - {@link pauseGoalRun}: `running | verifying → paused(requested)`. No new attempt starts and
 *     no retry runs; attempts already running finish and are recorded, their requests still
 *     decided and run (cancel is what stops those). An owner pausing someone else's run that is
 *     already paused — by the advancer or by its requester — places the hold on it (the run and
 *     its pause reason stay as they are).
 *     S11 GO9a: a hold abandons the goal planner's running round (`planning-rounds.ts`), and the
 *     run is due so the advance terminates its Task; a revision it proposed stays undecided.
 *   - {@link releaseGoalRunHold}: a workspace owner lifts the hold; the run stays paused, for the
 *     requester to resume (or to revise, `revise.ts`, or cancel).
 *   - {@link resumeGoalRun}: `paused → running`, due at once, unless a workspace owner holds the
 *     run; the advance then checks the budget and the plan again (§4.8 "恢复时复查"), with a fresh
 *     count of failed advances (legacy 356). `retrySteps` names failed steps a person sends back
 *     to `ready` — the "person's decision" retry of the StepRun table, past the attempt limit too —
 *     each only with no request of the step still in flight (I-G4), none of its Tasks — the
 *     attempt's nested child Tasks included — still running, and still part of the current plan
 *     (I-G2). A failed step it does not name stays failed: once nothing else of the run moves, the
 *     advance pauses it `needs_decision` again (legacy 393, `advance.ts` phase E) rather than let
 *     it wait for its wall clock. The run's absence checks (S11 「门确认不存在」 B-c) get a new
 *     baseline where the last one did not see the thing, so the platform looks again before any
 *     step starts. S11 GO9a: resuming ends the planning of the pause (`closePlanning`): a round
 *     still running is abandoned, and a revision the planner proposed that nobody decided is
 *     rejected on the requester's behalf.
 *   - {@link cancelGoalRun}: `running | paused | verifying → cancelling`, due at once. In the same
 *     transaction every step not yet ended is `cancelled` and every request of the run's steps that
 *     has not started is `withdrawn` (I-G9) — read under its row lock, so one the drainer started
 *     meanwhile stays `executing` and ends the R-48 way. The advance of the cancelling run
 *     (`cancelling.ts`) terminates the Tasks and waits for the executing requests. Its planning
 *     ends as on a resume.
 *
 * A call that finds the run already where it asks for (paused, cancelling or cancelled) changes
 * nothing; any other status it does not apply to is a {@link GoalRunStateError}, and a caller who
 * may not make the call a {@link GoalRunForbiddenError}.
 */

export type { GoalControlActor };

export interface GoalControlInput {
  readonly goalRunId: string;
  readonly actor: GoalControlActor;
}

export interface GoalControlResult {
  readonly status: GoalRunStatus;
  /** `false` when the run already was where the call asked for. */
  readonly changed: boolean;
}

const ENDED_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  'succeeded',
  'superseded',
  'cancelled',
  'skipped',
]);

async function lockControlledRun(
  client: PoolClient,
  workspaceId: string,
  input: GoalControlInput,
  may: 'stop' | 'resume',
): Promise<GoalRunRow> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  const requester = goal.onBehalfOf === input.actor.principalId;
  if (!requester && !(may === 'stop' && input.actor.role === 'owner')) {
    throw new GoalRunForbiddenError(
      may === 'stop'
        ? 'only the requester or a workspace owner stops a goal run'
        : 'only the requester resumes a goal run',
    );
  }
  return goal;
}

function personOf(input: GoalControlInput): GoalMoveActor {
  return { principalId: input.actor.principalId, by: 'person' };
}

/** The authority a stop by `input.actor` carries on `goal`: the requester's own, or a workspace
 *  owner's over someone else's run (`lockControlledRun` admitted nobody else). */
function stopAuthority(goal: GoalRunRow, input: GoalControlInput): GoalRunPauseAuthority {
  return goal.onBehalfOf === input.actor.principalId ? 'requester' : 'owner';
}

export async function pauseGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: GoalControlInput,
): Promise<GoalControlResult> {
  const goal = await lockControlledRun(client, workspaceId, input, 'stop');
  const authority = stopAuthority(goal, input);
  if (goal.status === 'paused') {
    if (authority !== 'owner' || goal.pausedByAuthority === 'owner') {
      return { status: goal.status, changed: false };
    }
    // Not a transition: the run stays paused with its reason; who paused changes to the owner
    // (the guard allows exactly this while paused). `updated_at` stays the pause's time.
    await client.query(
      `update goal_runs set paused_by = $3, paused_by_authority = 'owner'
        where workspace_id = $1 and id = $2 and status = 'paused'`,
      [goal.workspaceId, goal.id, input.actor.principalId],
    );
    await recordGoalRunTransition(client, goal.workspaceId, {
      actorPrincipalId: input.actor.principalId,
      change: 'hold',
      goalRunId: goal.id,
      resultingStatus: 'paused',
      extraAuditPayload: {
        by: 'person',
        pauseReason: goal.pauseReason,
        previouslyPausedBy: goal.pausedBy,
        previousAuthority: goal.pausedByAuthority,
      },
    });
    // S11 GO9a: a hold stops the planner too — its round is abandoned and the run due, so the
    // advance terminates its Task now. A revision it proposed stays for the requester to decide.
    const closed = await closePlanning(
      client,
      workspaceId,
      goal.id,
      input.actor.principalId,
      'run_left_pause',
      { rejectProposals: false },
    );
    if (closed.abandonedRoundIds.length > 0) {
      await client.query(
        "update goal_runs set next_tick_at = now() where workspace_id = $1 and id = $2 and status = 'paused'",
        [goal.workspaceId, goal.id],
      );
    }
    return { status: goal.status, changed: true };
  }
  if (goal.status !== 'running' && goal.status !== 'verifying') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is ${goal.status}; only a running or verifying run pauses`,
    );
  }
  const status = await moveGoalRun(client, personOf(input), goal, goal.status, 'pause', {
    pauseReason: 'requested',
    pausedBy: { principalId: input.actor.principalId, authority },
  });
  return { status, changed: true };
}

/** A workspace owner lifts the hold on a paused run (see the module doc comment). A run nobody
 *  holds is left as it is (`changed: false`). */
export async function releaseGoalRunHold(
  client: PoolClient,
  workspaceId: string,
  input: GoalControlInput,
): Promise<GoalControlResult> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  if (input.actor.role !== 'owner') {
    throw new GoalRunForbiddenError('only a workspace owner lifts a hold on a goal run');
  }
  if (goal.status !== 'paused' || goal.pausedByAuthority !== 'owner') {
    return { status: goal.status, changed: false };
  }
  await client.query(
    `update goal_runs set paused_by = null, paused_by_authority = null
      where workspace_id = $1 and id = $2 and status = 'paused'`,
    [goal.workspaceId, goal.id],
  );
  await recordGoalRunTransition(client, goal.workspaceId, {
    actorPrincipalId: input.actor.principalId,
    change: 'release_hold',
    goalRunId: goal.id,
    resultingStatus: 'paused',
    extraAuditPayload: { by: 'person', pauseReason: goal.pauseReason, heldBy: goal.pausedBy },
  });
  return { status: goal.status, changed: true };
}

export async function resumeGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: GoalControlInput & { readonly retrySteps?: readonly string[] },
): Promise<GoalControlResult & { readonly retriedStepRunIds: readonly string[] }> {
  const goal = await lockControlledRun(client, workspaceId, input, 'resume');
  if (goal.status === 'running') {
    if ((input.retrySteps ?? []).length > 0) {
      throw new GoalRunStateError(`goal run ${goal.id} is running; steps are retried on resume`);
    }
    return { status: goal.status, changed: false, retriedStepRunIds: [] };
  }
  if (goal.status !== 'paused') {
    throw new GoalRunStateError(`goal run ${goal.id} is ${goal.status}, not paused`);
  }
  if (goal.pausedByAuthority === 'owner') {
    throw new GoalRunStateError(
      `goal run ${goal.id}: a workspace owner holds it; it resumes once an owner lifts the hold`,
    );
  }
  const actor = personOf(input);
  const steps = await lockStepRuns(client, workspaceId, goal.id);
  const retried: string[] = [];
  for (const key of new Set(input.retrySteps ?? [])) {
    const step = steps.find((s) => s.stepKey === key && s.status !== 'superseded');
    if (!step || step.status !== 'failed') {
      throw new GoalRunStateError(
        `step ${key}: ${step ? `is ${step.status}` : 'not found'}; only a failed step is retried`,
      );
    }
    await assertRetryable(client, goal, step);
    await moveStepRun(client, actor, step, 'retry', {
      audit: { attempts: step.attemptCount, decidedBy: input.actor.principalId },
    });
    retried.push(step.id);
  }
  const status = await moveGoalRun(client, actor, goal, 'paused', 'resume', {
    due: 'now',
    audit: { pauseReason: goal.pauseReason, retriedSteps: [...new Set(input.retrySteps ?? [])] },
  });
  // S11 GO9a: the run leaves the pause its planning was for (I-P4).
  await closePlanning(client, workspaceId, goal.id, input.actor.principalId, 'run_left_pause');
  await retakeAbsenceBaselines(client, goal, input.actor.principalId);
  return { status, changed: true, retriedStepRunIds: retried };
}

/** S11 「门确认不存在」 B-c (F-b): a resume looks again at what the run's absence checks want gone,
 *  where the last look did not see it (`never_seen_present`, `unavailable`) — and takes every
 *  baseline the run's stop superseded. A plan that cannot be read is left to the advance, which
 *  pauses the run for it. */
async function retakeAbsenceBaselines(
  client: PoolClient,
  goal: GoalRunRow,
  actorPrincipalId: string,
): Promise<void> {
  if (goal.currentRevision === null) return;
  const plan = await getPlanRevision(client, goal.workspaceId, goal.id, goal.currentRevision);
  const checks = requiredAbsenceChecks(
    plan?.plan,
    await lockStepRuns(client, goal.workspaceId, goal.id),
  );
  if (!checks || checks.length === 0) return;
  await ensureAbsenceBaselines(client, goal.workspaceId, {
    goalRunId: goal.id,
    checks,
    retake: true,
    actorPrincipalId,
  });
}

/** A person's retry runs no new attempt beside a request that may still run (I-G4) or a Task of the
 *  step still running — a nested child Task outlives its caller's attempt (GO3b) — and only for a
 *  step still in the current plan, unchanged (I-G2). A step waiting on an outcome-unknown request
 *  is reconciled first, never simply retried; and one with a request found `effect_absent` needs
 *  the requester's re-execute decision first (GO3c) — a new attempt would only be replayed that
 *  request (I-G4), and might report the step done although the action never ran. */
async function assertRetryable(
  client: PoolClient,
  goal: GoalRunRow,
  step: StepRunRow,
): Promise<void> {
  if ((await listStepLiveTasks(client, goal.workspaceId, goal.id, step.id)).length > 0) {
    throw new GoalRunStateError(`step ${step.stepKey}: a Task of it still runs`);
  }
  const outcomes = await listStepActionOutcomes(client, goal.workspaceId, step.id);
  const effect = stepActionEffect(outcomes);
  if (effect.kind === 'wait') {
    throw new GoalRunStateError(
      effect.waitingReason === 'reconcile'
        ? `step ${step.stepKey}: an action of it may have run (outcome unknown); reconcile it first`
        : `step ${step.stepKey}: an action of it still awaits a decision or runs`,
    );
  }
  if (outcomes.some((outcome) => actionDisposition(outcome) === 'unconfirmed')) {
    throw new GoalRunStateError(
      `step ${step.stepKey}: an action of it was found to have no effect; decide to run it again (or revise the plan) first`,
    );
  }
  const current = goal.currentRevision;
  const introduced = await getPlanRevision(
    client,
    goal.workspaceId,
    goal.id,
    step.introducedInRevision,
  );
  const plan =
    current === null ? null : await getPlanRevision(client, goal.workspaceId, goal.id, current);
  if (
    step.supersededInRevision !== null ||
    !introduced ||
    !plan ||
    !samePlanEntry(introduced.plan, plan.plan, step.stepKey)
  ) {
    throw new GoalRunStateError(`step ${step.stepKey}: no longer in the current plan`);
  }
}

export async function cancelGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: GoalControlInput,
): Promise<
  GoalControlResult & {
    readonly cancelledStepRunIds: readonly string[];
    readonly withdrawnActionRequestIds: readonly string[];
  }
> {
  const goal = await lockControlledRun(client, workspaceId, input, 'stop');
  if (goal.status === 'cancelling' || goal.status === 'cancelled') {
    return {
      status: goal.status,
      changed: false,
      cancelledStepRunIds: [],
      withdrawnActionRequestIds: [],
    };
  }
  if (goal.status !== 'running' && goal.status !== 'paused' && goal.status !== 'verifying') {
    throw new GoalRunStateError(
      goal.status === 'proposed'
        ? `goal run ${goal.id} is proposed; an unconfirmed run is rejected, not cancelled`
        : `goal run ${goal.id} is ${goal.status}; it has ended`,
    );
  }
  const actor = personOf(input);
  const status = await moveGoalRun(client, actor, goal, goal.status, 'cancel', { due: 'now' });
  // S11 GO9a: its planning ends with it; the cancelling run terminates the planner's Task.
  await closePlanning(client, workspaceId, goal.id, input.actor.principalId, 'run_left_pause');
  const steps = await lockStepRuns(client, workspaceId, goal.id);
  const cancelled: string[] = [];
  for (const step of steps) {
    if (ENDED_STEP_STATUSES.has(step.status)) continue;
    await moveStepRun(client, actor, step, 'cancel', { audit: { reason: 'goal_cancelled' } });
    cancelled.push(step.id);
  }
  const withdrawn = await withdrawStepActions(
    client,
    workspaceId,
    steps.map((step) => step.id),
    { actorPrincipalId: input.actor.principalId, reason: GOAL_CANCELLED_WITHDRAW_REASON },
  );
  return {
    status,
    changed: true,
    cancelledStepRunIds: cancelled,
    withdrawnActionRequestIds: withdrawn,
  };
}
