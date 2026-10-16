import type { GoalRunStatus, Role, StepRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { withdrawStepActions } from '../../governance/approval/index.js';
import { GOAL_CANCELLED_WITHDRAW_REASON } from './cancelling.js';
import { type GoalMoveActor, moveGoalRun, moveStepRun } from './moves.js';
import { samePlanEntry } from './plan.js';
import { getPlanRevision, lockStepRuns, readStepActionEffect } from './reads.js';
import { GoalRunNotFoundError, GoalRunStateError, lockGoalRun } from './service.js';
import type { GoalRunRow, StepRunRow } from './types.js';

/**
 * application/goal/control (S11 GO3a; plan §4.1, §4.8): a person stopping a GoalRun — pause,
 * resume, cancel. The capabilities that expose them (`pause_goal`, `resume_goal`, `cancel_goal`)
 * are GO5; like `confirmGoalRun`, these run in the caller's transaction and enforce what a
 * capability must not be able to skip. Each takes the GoalRun lock first, then its StepRuns'.
 *
 * Who may: stopping — pause, cancel — is the requester's or a workspace owner's (an owner may stop
 * anything in the workspace, the rule `cancel_task` applies, D-21). Resuming is the requester's
 * alone: it lets the run spend and act again with the requester's authority (propose → authorize
 * → execute, §4.3), which nobody decides for them.
 *
 *   - {@link pauseGoalRun}: `running | verifying → paused(requested)`. No new attempt starts and
 *     no retry runs; attempts already running finish and are recorded, their requests still
 *     decided and run (cancel is what stops those).
 *   - {@link resumeGoalRun}: `paused → running`, due at once; the advance then checks the budget
 *     and the plan again (§4.8 "恢复时复查"). `retrySteps` names failed steps a person sends back
 *     to `ready` — the "person's decision" retry of the StepRun table, past the attempt limit too —
 *     each only with no request of the step still in flight (I-G4) and still part of the current
 *     plan (I-G2).
 *   - {@link cancelGoalRun}: `running | paused | verifying → cancelling`, due at once. In the same
 *     transaction every step not yet ended is `cancelled` and every request of the run's steps that
 *     has not started is `withdrawn` (I-G9) — read under its row lock, so one the drainer started
 *     meanwhile stays `executing` and ends the R-48 way. The advance of the cancelling run
 *     (`cancelling.ts`) terminates the Tasks and waits for the executing requests.
 *
 * A call that finds the run already where it asks for (paused, cancelling or cancelled) changes
 * nothing; any other status it does not apply to is a {@link GoalRunStateError}.
 */

export interface GoalControlActor {
  readonly principalId: string;
  readonly role: Role;
}

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
    throw new GoalRunStateError(
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

export async function pauseGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: GoalControlInput,
): Promise<GoalControlResult> {
  const goal = await lockControlledRun(client, workspaceId, input, 'stop');
  if (goal.status === 'paused') return { status: goal.status, changed: false };
  if (goal.status !== 'running' && goal.status !== 'verifying') {
    throw new GoalRunStateError(`goal run ${goal.id} is ${goal.status}; only a running run pauses`);
  }
  const status = await moveGoalRun(client, personOf(input), goal, goal.status, 'pause', {
    pauseReason: 'requested',
  });
  return { status, changed: true };
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
  return { status, changed: true, retriedStepRunIds: retried };
}

/** A person's retry runs no new attempt beside a request that may still run (I-G4) and only for a
 *  step still in the current plan, unchanged (I-G2). A step waiting on an outcome-unknown request
 *  is reconciled first (GO3b), never simply retried. */
async function assertRetryable(
  client: PoolClient,
  goal: GoalRunRow,
  step: StepRunRow,
): Promise<void> {
  const effect = await readStepActionEffect(client, goal.workspaceId, step.id);
  if (effect.kind === 'wait') {
    throw new GoalRunStateError(
      effect.waitingReason === 'reconcile'
        ? `step ${step.stepKey}: an action of it may have run (outcome unknown); reconcile it first`
        : `step ${step.stepKey}: an action of it still awaits a decision or runs`,
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
