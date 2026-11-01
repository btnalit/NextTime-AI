import type { GoalRunStatus, PlanRevisionDecision } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { resumeGoalRun } from './control.js';
import type { PlanReferenceSources } from './plan.js';
import { readPlannerRevision } from './planner.js';
import { closePlanning } from './planning-rounds.js';
import { type RevisedGoalRun, adoptRevision, checkRevisionCandidate } from './revise.js';
import {
  GoalRunForbiddenError,
  GoalRunNotFoundError,
  GoalRunStateError,
  lockGoalRun,
} from './service.js';
import type { GoalControlActor } from './types.js';

/**
 * application/goal/decide (S11 GO9a; plan §4.3, I-P1, I-P5): the requester deciding about a
 * revision the goal planner proposed (`planner.ts`) — the `decide_plan_revision` capability, in the
 * caller's transaction, GoalRun locked first. Nobody else decides it: the planner acts for the
 * requester, so only they put what it proposes in force (the database refuses anyone else's
 * acceptance, goal/0014).
 *
 *   - **accept**: the proposal must still be based on the revision in force and the run paused;
 *     its plan is checked again exactly like a revision the requester writes, within the revision
 *     budget (`revise.ts` `checkRevisionCandidate`), then adopted like one (`adoptRevision`: steps
 *     it drops or changes superseded and their Tasks terminated, their requests withdrawn, new
 *     keys pending). Every other planning of the pause ends (`closePlanning`). With `resume`, the
 *     run is resumed in the same transaction, as `resume_goal` would (refused while a workspace
 *     owner holds it, which refuses the whole call).
 *   - **reject**: the proposal is rejected; nothing else changes. The planner is not asked again
 *     about the same failed attempt (one round per attempt, goal/0014): the requester retries,
 *     revises or cancels.
 *
 * The same decision sent again changes nothing (`changed: false`); a proposal already decided the
 * other way, superseded by another revision or proposed by a person is refused (409).
 */

export interface DecidePlanRevisionInput {
  readonly goalRunId: string;
  readonly revision: number;
  readonly decision: PlanRevisionDecision;
  readonly resume?: boolean;
  readonly actor: GoalControlActor;
  /** Legacy 513: see `CreateGoalRunInput.checkAccounts`. */
  readonly checkAccounts?: boolean;
  readonly modelCatalog?: PlanReferenceSources['modelCatalog'];
}

export interface DecidedPlanRevision extends RevisedGoalRun {
  readonly status: GoalRunStatus;
  readonly changed: boolean;
  readonly decision: PlanRevisionDecision;
  readonly resumed: boolean;
}

export async function decidePlanRevision(
  client: PoolClient,
  workspaceId: string,
  input: DecidePlanRevisionInput,
): Promise<DecidedPlanRevision> {
  if (input.resume === true && input.decision !== 'accept') {
    throw new GoalRunStateError('a run is resumed only with an accepted revision');
  }
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  if (goal.onBehalfOf !== input.actor.principalId) {
    throw new GoalRunForbiddenError(
      "only the requester decides about the goal planner's revision of their goal run",
    );
  }
  const proposal = await readPlannerRevision(client, workspaceId, goal.id, input.revision);
  if (!proposal) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: revision ${input.revision} is not a revision the goal planner proposed`,
    );
  }
  const unchanged = (): DecidedPlanRevision => ({
    status: goal.status,
    changed: false,
    decision: input.decision,
    resumed: false,
    revision: input.revision,
    planRevisionId: proposal.id,
    supersededStepRunIds: [],
    createdStepRunIds: [],
    withdrawnActionRequestIds: [],
    releasedActionRequestIds: [],
    hints: [],
  });
  const decided = input.decision === 'accept' ? 'accepted' : 'rejected';
  if (proposal.status === decided) return unchanged();
  if (proposal.status !== 'proposed') {
    throw new GoalRunStateError(
      `goal run ${goal.id}: revision ${input.revision} was already ${proposal.status}`,
    );
  }
  if (goal.status !== 'paused') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is ${goal.status}; a proposed revision is decided while the run is paused`,
    );
  }
  if (proposal.basedOnRevision !== goal.currentRevision) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: revision ${input.revision} is based on ${proposal.basedOnRevision ?? 'none'}, but the current revision is ${goal.currentRevision ?? 'none'} (I-G3)`,
    );
  }
  if (input.resume === true && goal.pausedByAuthority === 'owner') {
    throw new GoalRunStateError(
      `goal run ${goal.id}: a workspace owner holds it; it resumes once an owner lifts the hold`,
    );
  }

  if (input.decision === 'reject') {
    await client.query(
      `update plan_revisions set status = 'rejected', decided_by = $3, decided_at = now()
        where workspace_id = $1 and id = $2 and status = 'proposed'`,
      [workspaceId, proposal.id, input.actor.principalId],
    );
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: input.actor.principalId,
      action: 'plan_revision.reject',
      resourceType: 'plan_revision',
      resourceId: proposal.id,
      payload: { goalRunId: goal.id, revision: input.revision, by: 'person', proposer: 'planner' },
    });
    return { ...unchanged(), changed: true };
  }

  // Reviewed when the planner reported it, on the base in force (I-G3, checked above).
  const candidate = await checkRevisionCandidate(client, workspaceId, goal, {
    plan: proposal.plan,
    lock: true,
    reviewed: true,
    ...(input.modelCatalog ? { modelCatalog: input.modelCatalog } : {}),
  });
  await closePlanning(client, workspaceId, goal.id, input.actor.principalId, 'plan_revised', {
    keepRevision: input.revision,
  });
  const adopted = await adoptRevision(client, workspaceId, goal, candidate, {
    actorId: input.actor.principalId,
    reason: null,
    budgetChanged: false,
    checkAccounts: input.checkAccounts === true,
    proposal: { id: proposal.id, revision: input.revision },
  });
  if (input.resume !== true) {
    return { ...adopted, status: 'paused', changed: true, decision: 'accept', resumed: false };
  }
  // The run as adopted: its revision and due time changed, not its status or hold.
  const resumed = await resumeGoalRun(client, workspaceId, {
    goalRunId: goal.id,
    actor: input.actor,
  });
  return { ...adopted, status: resumed.status, changed: true, decision: 'accept', resumed: true };
}
