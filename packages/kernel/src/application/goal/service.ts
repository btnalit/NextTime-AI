import type { GoalRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { moveGoalRun } from './moves.js';
import { type GoalPlan, type PlanHint, planHints, validatePlan } from './plan.js';
import { getGoalRun } from './reads.js';
import { recordGoalRunTransition, recordStepRunTransition } from './transition-log.js';
import type { GoalControlActor, GoalRunBudget, GoalRunRow } from './types.js';

/**
 * application/goal/service (S11 GO2; plan §4.3, I-G3): proposing, confirming and rejecting a
 * GoalRun — the writes before the advancer takes over. The capabilities that expose them are
 * `propose_goal` (handle channel, GO5c) and `confirm_goal` / `reject_goal` (human channel, S11
 * GO5b, `application/gateway/goal-handlers.ts`); these functions run in the caller's transaction
 * and enforce what a capability must not be able to skip.
 *
 *   - {@link createGoalRun}: a `proposed` GoalRun and its revision 1 (`proposed`), the plan
 *     validated (`plan.ts`) and the validation recorded on the revision, with the plan's hints
 *     (`planHints`: a plan the platform checks nothing of is achieved only on the requester's
 *     word) for the confirmation card.
 *   - {@link confirmGoalRun}: only the requester confirms (propose → authorize → execute: a
 *     GoalRun spends and acts while nobody watches, §4.3), and only the revision they read — the
 *     proposal, revision 1 (S11 GO5b: what is confirmed is what was shown). In one transaction,
 *     GoalRun locked first (the guards' lock order): the plan is validated again (a
 *     WorkerDefinition may have been deprecated since), revision 1 is accepted, then adopted
 *     (`current_revision`, I-G3 — accept first, the guard adopts accepted revisions only), the run
 *     moves to `running` and is due at once (`next_tick_at`), and every step of the plan gets its
 *     StepRun, `pending`, under that revision with no attempts (I-G1, I-G2). A confirmation sent
 *     again once that revision is accepted changes nothing (`changed: false`, scenario S3): the
 *     state is the idempotency key — revision 1 is decided once, by the requester.
 *   - {@link rejectGoalRun}: the requester, or a workspace owner (who may stop anything in the
 *     workspace, `control.ts`), turns the proposal down: revision 1 `rejected`, the run
 *     `cancelled` — the way out of `proposed` (a proposed run is never cancelled, it never ran).
 *     Sent again, it changes nothing.
 *
 * Errors: {@link GoalRunNotFoundError} (404), {@link GoalRunForbiddenError} — the caller may not
 * make this call on this run (403), {@link GoalRunStateError} — the run's state does not allow it
 * now (409), {@link GoalRunInputError} — the request is malformed whatever the state (400).
 */

export class GoalRunNotFoundError extends Error {
  constructor(goalRunId: string) {
    super(`goal run ${goalRunId} not found`);
    this.name = 'GoalRunNotFoundError';
  }
}

/** The run is not in a state the operation applies to (409: the console reads it as "the state
 *  changed — reload"). */
export class GoalRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalRunStateError';
  }
}

/** S11 GO5b: the caller may not perform the operation on this run — not the requester, not a
 *  workspace owner where an owner may (403). Thrown only for a run the caller can see; one they
 *  cannot is not found (`goal-handlers.ts`, `views.ts`'s `goalVisibleTo`). */
export class GoalRunForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalRunForbiddenError';
  }
}

/** S11 GO5b: a request the operation cannot take whatever the run's state — a note too long, a
 *  budget or removals of the wrong shape (400 invalid_params). */
export class GoalRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalRunInputError';
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
  /** What the person confirming the plan should know ({@link planHints}). */
  readonly hints: readonly PlanHint[];
}

export async function createGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: CreateGoalRunInput,
): Promise<CreatedGoalRun> {
  const plan = await validatePlan(client, workspaceId, input.plan);
  const hints = planHints(plan);
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
      JSON.stringify({ valid: true, steps: plan.steps.length, hints }),
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
  return { goalRunId, planRevisionId, plan, hints };
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

export interface ConfirmGoalRunInput {
  readonly goalRunId: string;
  /** The revision the requester read on the confirmation card: the proposal, revision 1. */
  readonly revision: number;
  readonly confirmedBy: string;
}

export interface ConfirmedGoalRun {
  readonly status: GoalRunStatus;
  /** `false` when the requester had already confirmed this revision — a confirmation sent again. */
  readonly changed: boolean;
  readonly createdStepRunIds: readonly string[];
}

/** The proposal a confirmation or a rejection decides: a run is proposed with revision 1 only. */
function assertProposalRevision(goal: GoalRunRow, revision: number): void {
  if (revision !== 1) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: revision ${revision} is not its proposal; a goal run's proposal is revision 1`,
    );
  }
}

async function readProposalStatus(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<{ readonly id: string; readonly status: string; readonly plan: unknown } | null> {
  const revision = await client.query<{ id: string; status: string; plan: unknown }>(
    `select id, status, plan from plan_revisions
      where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
    [workspaceId, goalRunId],
  );
  return revision.rows[0] ?? null;
}

export async function confirmGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: ConfirmGoalRunInput,
): Promise<ConfirmedGoalRun> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  if (goal.onBehalfOf !== input.confirmedBy) {
    throw new GoalRunForbiddenError('only the requester confirms a goal run');
  }
  assertProposalRevision(goal, input.revision);
  const stored = await readProposalStatus(client, workspaceId, goal.id);
  // Accepted only by the confirmation (`confirmed_at` is written with it, once).
  if (stored?.status === 'accepted' && goal.confirmedAt !== null) {
    return { status: goal.status, changed: false, createdStepRunIds: [] };
  }
  if (goal.status !== 'proposed') {
    throw new GoalRunStateError(`goal run ${goal.id} is ${goal.status}, not proposed`);
  }
  if (stored?.status !== 'proposed') {
    throw new GoalRunStateError(`goal run ${goal.id} has no proposed revision 1`);
  }
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
  const created: string[] = [];
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
    created.push(stepRunId);
  }
  return { status: 'running', changed: true, createdStepRunIds: created };
}

export interface RejectGoalRunInput {
  readonly goalRunId: string;
  /** The revision the person read: the proposal, revision 1. */
  readonly revision: number;
  readonly actor: GoalControlActor;
}

/** The requester or a workspace owner rejects a proposed run — see the module comment. */
export async function rejectGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: RejectGoalRunInput,
): Promise<{ readonly status: GoalRunStatus; readonly changed: boolean }> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  const requester = goal.onBehalfOf === input.actor.principalId;
  if (!requester && input.actor.role !== 'owner') {
    throw new GoalRunForbiddenError(
      'only the requester or a workspace owner rejects a proposed goal run',
    );
  }
  assertProposalRevision(goal, input.revision);
  const stored = await readProposalStatus(client, workspaceId, goal.id);
  if (stored?.status === 'rejected') return { status: goal.status, changed: false };
  if (goal.status !== 'proposed' || stored?.status !== 'proposed') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is ${goal.status}; only a proposed run is rejected (a confirmed one is cancelled)`,
    );
  }
  await client.query(
    `update plan_revisions set status = 'rejected', decided_by = $3, decided_at = now()
      where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
    [workspaceId, goal.id, input.actor.principalId],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actor.principalId,
    action: 'plan_revision.reject',
    resourceType: 'plan_revision',
    resourceId: stored.id,
    payload: { goalRunId: goal.id, revision: 1 },
  });
  const status = await moveGoalRun(
    client,
    { principalId: input.actor.principalId, by: 'person' },
    goal,
    'proposed',
    'reject',
    { audit: { revision: 1, authority: requester ? 'requester' : 'owner' } },
  );
  return { status, changed: true };
}
