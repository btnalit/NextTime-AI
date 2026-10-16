import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { type GoalPlan, validatePlan } from './plan.js';
import { getGoalRun } from './reads.js';
import { recordGoalRunTransition, recordStepRunTransition } from './transition-log.js';
import type { GoalRunBudget, GoalRunRow } from './types.js';

/**
 * application/goal/service (S11 GO2; plan §4.3, I-G3): proposing and confirming a GoalRun — the
 * two writes before the advancer takes over. The capabilities that expose them (`propose_goal`
 * on the handle channel, `confirm_goal` for the requester, both with idempotency keys) are GO5;
 * these functions run in the caller's transaction and enforce what a capability must not be able
 * to skip.
 *
 *   - {@link createGoalRun}: a `proposed` GoalRun and its revision 1 (`proposed`), the plan
 *     validated (`plan.ts`) and the validation recorded on the revision.
 *   - {@link confirmGoalRun}: only the requester confirms (propose → authorize → execute: a
 *     GoalRun spends and acts while nobody watches, §4.3). In one transaction, GoalRun locked
 *     first (the guards' lock order): the plan is validated again (a WorkerDefinition may have been
 *     deprecated since), revision 1 is accepted, then adopted (`current_revision`, I-G3 — accept
 *     first, the guard adopts accepted revisions only), the run moves to `running` and is due at
 *     once (`next_tick_at`), and every step of the plan gets its StepRun, `pending`, under that
 *     revision with no attempts (I-G1, I-G2).
 */

export class GoalRunNotFoundError extends Error {
  constructor(goalRunId: string) {
    super(`goal run ${goalRunId} not found`);
    this.name = 'GoalRunNotFoundError';
  }
}

/** The run is not in a state the operation applies to, or the caller may not perform it. */
export class GoalRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalRunStateError';
  }
}

export interface CreateGoalRunInput {
  /** The requester — the principal the run acts for (`on_behalf_of`) and the one who confirms. */
  readonly requesterId: string;
  /** Who proposed the plan (the requester, or their entry agent's principal). */
  readonly proposedBy: string;
  readonly statement: string;
  readonly plan: unknown;
  readonly budget: GoalRunBudget;
  readonly originatedInTurnId?: string;
}

export interface CreatedGoalRun {
  readonly goalRunId: string;
  readonly planRevisionId: string;
  readonly plan: GoalPlan;
}

export async function createGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: CreateGoalRunInput,
): Promise<CreatedGoalRun> {
  const plan = await validatePlan(client, workspaceId, input.plan);
  const goal = await client.query<{ id: string }>(
    `insert into goal_runs (
       workspace_id, on_behalf_of, originated_in_turn_id, statement, budget_max_tokens,
       budget_max_steps, budget_max_revisions, budget_max_wall_clock_seconds
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      workspaceId,
      input.requesterId,
      input.originatedInTurnId ?? null,
      input.statement,
      input.budget.maxTokens,
      input.budget.maxSteps,
      input.budget.maxRevisions,
      input.budget.maxWallClockSeconds,
    ],
  );
  const goalRunId = goal.rows[0]?.id;
  if (!goalRunId) throw new Error('createGoalRun: goal_runs INSERT ... RETURNING produced no row');
  const revision = await client.query<{ id: string }>(
    `insert into plan_revisions (workspace_id, goal_run_id, revision, plan, proposed_by, validation)
     values ($1, $2, 1, $3::jsonb, $4, $5::jsonb)
     returning id`,
    [
      workspaceId,
      goalRunId,
      JSON.stringify(plan),
      input.proposedBy,
      JSON.stringify({ valid: true, steps: plan.steps.length }),
    ],
  );
  const planRevisionId = revision.rows[0]?.id;
  if (!planRevisionId) {
    throw new Error('createGoalRun: plan_revisions INSERT ... RETURNING produced no row');
  }
  await recordGoalRunTransition(client, workspaceId, {
    actorPrincipalId: input.proposedBy,
    action: 'goal_run.propose',
    goalRunId,
    resultingStatus: 'proposed',
    extraAuditPayload: { requesterId: input.requesterId, steps: plan.steps.length },
  });
  return { goalRunId, planRevisionId, plan };
}

/** Locks the GoalRun row (`for no key update`, the lock every writer under a GoalRun takes first)
 *  and returns it. */
export async function lockGoalRun(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<GoalRunRow | null> {
  await client.query(
    'select 1 from goal_runs where workspace_id = $1 and id = $2 for no key update',
    [workspaceId, goalRunId],
  );
  return getGoalRun(client, workspaceId, goalRunId);
}

export async function confirmGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: { readonly goalRunId: string; readonly confirmedBy: string },
): Promise<void> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  if (goal.onBehalfOf !== input.confirmedBy) {
    throw new GoalRunStateError('only the requester confirms a goal run');
  }
  if (goal.status !== 'proposed') {
    throw new GoalRunStateError(`goal run ${goal.id} is ${goal.status}, not proposed`);
  }
  const revision = await client.query<{ id: string; plan: unknown }>(
    `select id, plan from plan_revisions
     where workspace_id = $1 and goal_run_id = $2 and revision = 1 and status = 'proposed'`,
    [workspaceId, goal.id],
  );
  const stored = revision.rows[0];
  if (!stored) throw new GoalRunStateError(`goal run ${goal.id} has no proposed revision 1`);
  const plan = await validatePlan(client, workspaceId, stored.plan);

  await client.query(
    `update plan_revisions set status = 'accepted', decided_by = $3, decided_at = now()
     where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
    [workspaceId, goal.id, input.confirmedBy],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.confirmedBy,
    action: 'plan_revision.accept',
    resourceType: 'plan_revision',
    resourceId: stored.id,
    payload: { goalRunId: goal.id, revision: 1 },
  });
  await client.query(
    `update goal_runs
        set status = 'running', current_revision = 1, confirmed_at = now(), updated_at = now(),
            next_tick_at = now()
      where workspace_id = $1 and id = $2`,
    [workspaceId, goal.id],
  );
  await recordGoalRunTransition(client, workspaceId, {
    actorPrincipalId: input.confirmedBy,
    action: 'goal_run.confirm',
    goalRunId: goal.id,
    resultingStatus: 'running',
    extraAuditPayload: { revision: 1 },
  });
  for (const step of plan.steps) {
    const inserted = await client.query<{ id: string }>(
      `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision)
       values ($1, $2, $3, 1)
       returning id`,
      [workspaceId, goal.id, step.key],
    );
    const stepRunId = inserted.rows[0]?.id;
    if (!stepRunId)
      throw new Error('confirmGoalRun: step_runs INSERT ... RETURNING produced no row');
    await recordStepRunTransition(client, workspaceId, {
      actorPrincipalId: input.confirmedBy,
      action: 'step_run.create',
      goalRunId: goal.id,
      stepRunId,
      resultingStatus: 'pending',
      extraAuditPayload: { stepKey: step.key, revision: 1 },
    });
  }
}
