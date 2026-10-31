import {
  type GoalFromProcedure,
  GoalPlanSchema,
  type GoalRunStatus,
  MAX_GOAL_STATEMENT_CHARS,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { refuseCredentialText, refuseRedactedText } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { type PlanSource, planFromProcedure, refuseProcedureParameters } from './from-procedure.js';
import { moveGoalRun } from './moves.js';
import {
  type GoalPlan,
  type PlanHint,
  type PlanReferenceSources,
  planHints,
  planShape,
  refusePlanCredentials,
  validatePlan,
} from './plan.js';
import { planAuthorityHints } from './precheck.js';
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
 *     word) and what the requester's authority would stop now (`precheck.ts`) for the
 *     confirmation card. S11 GO5c: the statement and the plan carry nothing a read masks — no
 *     suspected credential, no `[redacted]` mark copied from a read — refused before anything is
 *     written (`refusePlanCredentials`; the statement under the rule a revision's reason is); and
 *     with an idempotency key (the stored form `propose_goal` derives, goal/0008) the call returns
 *     the run that key proposed instead of a second one (`changed: false`): an explicit key's run
 *     whatever its status, a derived key's only while still `proposed`. S11 GO5d-2: the plan may
 *     instead be made from a published Procedure (`fromProcedure`, `from-procedure.ts`) — its
 *     parameters refused for what a written plan is, the plan it makes then checked exactly as a
 *     written one, and revision 1 recording the version it came from (goal/0009).
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

/** S11 GO5c: 409 `proposed_goal_limit` — the requester already has `limit` goals waiting to be
 *  confirmed or rejected, so no further one is proposed for them until one of those is. Nothing
 *  was written. */
export class ProposedGoalLimitError extends Error {
  readonly code = 'proposed_goal_limit' as const;
  readonly details: { readonly limit: number; readonly proposed: number };
  constructor(limit: number, proposed: number) {
    super(
      `the requester already has ${proposed} goals waiting to be confirmed or rejected (at most ${limit}) — confirm or reject one of them first; nothing was proposed`,
    );
    this.name = 'ProposedGoalLimitError';
    this.details = { limit, proposed };
  }
}

export interface CreateGoalRunInput {
  /** The requester — the principal the run acts for (`on_behalf_of`) and the one who confirms. */
  readonly requesterId: string;
  /** Who proposed the plan (the requester, or their entry agent's principal). */
  readonly proposedBy: string;
  readonly statement: string;
  /** The plan written out — or, exactly one of the two, {@link fromProcedure}. */
  readonly plan?: unknown;
  /** S11 GO5d-2: the published Procedure the plan is made from, with its parameters. */
  readonly fromProcedure?: GoalFromProcedure;
  readonly budget: GoalRunBudget;
  readonly originatedInTurnId?: string;
  /** S11 GO5c: the stored key (`explicit:…` or `auto:…`, goal/0008) — derived by `propose_goal`;
   *  none for a direct caller, which never dedupes. */
  readonly idempotencyKey?: string;
  /** S11 GO5c: the most goals the requester may have proposed and not yet confirmed or rejected
   *  ({@link ProposedGoalLimitError}) — `propose_goal` passes
   *  {@link maxProposedGoalsPerRequester}; none for a direct caller, which has no cap. */
  readonly maxProposed?: number;
  /** Legacy 513: the result is served to a person — its hints also say on which gates the
   *  requester has not connected their own account (`planAuthorityHints`' `checkAccounts`). */
  readonly checkAccounts?: boolean;
  /** S11 GO8a: the model catalog a step's WorkerSpec model is checked against (`validatePlan`'s
   *  sources); none: not checked. */
  readonly modelCatalog?: PlanReferenceSources['modelCatalog'];
}

export interface CreatedGoalRun {
  readonly goalRunId: string;
  readonly planRevisionId: string;
  readonly plan: GoalPlan;
  /** What the person confirming the plan should know ({@link planHints}), and what the
   *  requester's authority would stop now (`planAuthorityHints`) while the run is proposed. */
  readonly hints: readonly PlanHint[];
  /** `proposed`, or — for a call that matched a run its idempotency key proposed before — that
   *  run's status now. */
  readonly status: GoalRunStatus;
  /** `false` when the call matched a run proposed before with the same idempotency key. */
  readonly changed: boolean;
}

/** S11 GO5c: the longest statement a goal is proposed with (`@nexttime/shared`'s, which
 *  `propose_goal`'s params hold to; counted here in code points, as a revision's reason is). */
export const MAX_GOAL_STATEMENT_LENGTH = MAX_GOAL_STATEMENT_CHARS;

/** S11 GO5c: how many goals one requester may have proposed and not yet confirmed or rejected,
 *  when `GOAL_MAX_PROPOSED_PER_REQUESTER` is not set. */
export const DEFAULT_MAX_PROPOSED_GOALS_PER_REQUESTER = 5;

/** `GOAL_MAX_PROPOSED_PER_REQUESTER`'s value: a whole number of at least 1, or the default when
 *  unset. Throws on anything else — the kernel reads it once at start (`index.ts`), so a bad value
 *  stops it there rather than failing each proposal. */
export function maxProposedGoalsPerRequester(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PROPOSED_GOALS_PER_REQUESTER;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `GOAL_MAX_PROPOSED_PER_REQUESTER="${raw}" is not a whole number of at least 1 — unset it to use the default ${DEFAULT_MAX_PROPOSED_GOALS_PER_REQUESTER}`,
    );
  }
  return parsed;
}

/** goal/0008's two indexes: a unique violation on either means another call proposed with this
 *  key first. */
const GOAL_IDEMPOTENCY_KEY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'goal_runs_idempotency_key_uidx',
  'goal_runs_derived_idempotency_key_proposed_uidx',
]);

/** The prefix of a derived key (goal/0008): it dedupes only against a run still proposed. */
export const DERIVED_GOAL_IDEMPOTENCY_KEY_PREFIX = 'auto:';

function isGoalIdempotencyKeyConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === '23505' &&
    typeof candidate.constraint === 'string' &&
    GOAL_IDEMPOTENCY_KEY_CONSTRAINTS.has(candidate.constraint)
  );
}

/** What a run proposed under a key holds now — for the call that replays it. */
async function proposedRunOfKey(
  client: PoolClient,
  workspaceId: string,
  idempotencyKey: string,
  options: { readonly afterConflict: boolean },
): Promise<{
  readonly goalRunId: string;
  readonly requesterId: string;
  readonly status: GoalRunStatus;
} | null> {
  // A derived key matches only a run still proposed — except after losing the insert race: the
  // unique violation proves the winner was proposed a moment ago, so its run is this call's even
  // if it was confirmed since (as `requestAction` does).
  const derived = idempotencyKey.startsWith(DERIVED_GOAL_IDEMPOTENCY_KEY_PREFIX);
  const result = await client.query<{ id: string; on_behalf_of: string; status: GoalRunStatus }>(
    `select id, on_behalf_of, status from goal_runs
      where workspace_id = $1 and idempotency_key = $2
        and ($3::boolean or status = 'proposed')
      order by created_at desc, id desc
      limit 1`,
    [workspaceId, idempotencyKey, !derived || options.afterConflict],
  );
  const row = result.rows[0];
  return row ? { goalRunId: row.id, requesterId: row.on_behalf_of, status: row.status } : null;
}

/** How many runs for this requester are proposed — waiting to be confirmed or rejected. */
async function proposedRunsOf(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
): Promise<number> {
  const result = await client.query<{ proposed: number }>(
    `select count(*)::int as proposed from goal_runs
      where workspace_id = $1 and on_behalf_of = $2 and status = 'proposed'`,
    [workspaceId, requesterId],
  );
  return result.rows[0]?.proposed ?? 0;
}

async function replayProposal(
  client: PoolClient,
  workspaceId: string,
  run: { readonly goalRunId: string; readonly requesterId: string; readonly status: GoalRunStatus },
  checkAccounts: boolean,
): Promise<CreatedGoalRun> {
  const revision = await client.query<{ id: string; plan: unknown }>(
    `select id, plan from plan_revisions
      where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
    [workspaceId, run.goalRunId],
  );
  const stored = revision.rows[0];
  if (!stored) throw new Error(`createGoalRun: goal run ${run.goalRunId} has no revision 1`);
  const parsed = GoalPlanSchema.safeParse(stored.plan);
  if (!parsed.success) {
    throw new Error(`createGoalRun: goal run ${run.goalRunId}'s proposal no longer parses`);
  }
  return {
    goalRunId: run.goalRunId,
    planRevisionId: stored.id,
    plan: parsed.data,
    hints: [
      ...planHints(parsed.data),
      ...(run.status === 'proposed'
        ? await planAuthorityHints(client, workspaceId, run.requesterId, parsed.data, {
            checkAccounts,
          })
        : []),
    ],
    status: run.status,
    changed: false,
  };
}

/** The statement's checks — see the module comment. */
function checkStatement(statement: string): void {
  if (!/\S/.test(statement)) throw new GoalRunInputError('a goal statement says nothing');
  if ([...statement].length > MAX_GOAL_STATEMENT_LENGTH) {
    throw new GoalRunInputError(
      `a goal statement is at most ${MAX_GOAL_STATEMENT_LENGTH} characters`,
    );
  }
  refuseRedactedText('statement', statement);
  refuseCredentialText('statement', statement);
}

export async function createGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: CreateGoalRunInput,
): Promise<CreatedGoalRun> {
  // What the call carries is checked before anything else, a replay included: a call refused for
  // its content never returns a run.
  checkStatement(input.statement);
  if ((input.plan === undefined) === (input.fromProcedure === undefined)) {
    throw new GoalRunInputError('a goal is proposed with exactly one of plan and fromProcedure');
  }
  if (input.fromProcedure !== undefined) refuseProcedureParameters(input.fromProcedure.parameters);
  else refusePlanCredentials(planShape(input.plan));
  // The cap's count and this call's insert are one step per requester: two proposals at once
  // cannot both take the last place. A replay proposes nothing, so it is answered at the cap too.
  if (input.maxProposed !== undefined) {
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
      `goal-proposals:${workspaceId}:${input.requesterId}`,
    ]);
  }
  if (input.idempotencyKey !== undefined) {
    const existing = await proposedRunOfKey(client, workspaceId, input.idempotencyKey, {
      afterConflict: false,
    });
    if (existing)
      return replayProposal(client, workspaceId, existing, input.checkAccounts === true);
  }
  if (input.maxProposed !== undefined) {
    const proposed = await proposedRunsOf(client, workspaceId, input.requesterId);
    if (proposed >= input.maxProposed)
      throw new ProposedGoalLimitError(input.maxProposed, proposed);
  }
  let written = input.plan;
  let source: PlanSource | null = null;
  if (input.fromProcedure !== undefined) {
    // The Procedure's content is held to what a written plan is: coming from a template skips
    // nothing.
    const made = await planFromProcedure(client, workspaceId, input.fromProcedure);
    refusePlanCredentials(planShape(made.plan));
    written = made.plan;
    source = made.source;
  }
  const plan = await validatePlan(client, workspaceId, written, input.requesterId, {
    ...(input.modelCatalog ? { modelCatalog: input.modelCatalog } : {}),
  });
  const hints = planHints(plan);
  if (input.idempotencyKey !== undefined) {
    await client.query('SAVEPOINT create_goal_run_insert');
    try {
      const created = await insertGoalRun(client, workspaceId, input, plan, hints, source);
      await client.query('RELEASE SAVEPOINT create_goal_run_insert');
      return created;
    } catch (err) {
      if (!isGoalIdempotencyKeyConflict(err)) throw err;
      await client.query('ROLLBACK TO SAVEPOINT create_goal_run_insert');
      const existing = await proposedRunOfKey(client, workspaceId, input.idempotencyKey, {
        afterConflict: true,
      });
      // The violation means a committed run holds the key; not finding it would contradict that.
      if (!existing) throw err;
      return replayProposal(client, workspaceId, existing, input.checkAccounts === true);
    }
  }
  return insertGoalRun(client, workspaceId, input, plan, hints, source);
}

async function insertGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: CreateGoalRunInput,
  plan: GoalPlan,
  hints: readonly PlanHint[],
  source: PlanSource | null,
): Promise<CreatedGoalRun> {
  const goal = await client.query<{ id: string }>(
    `insert into goal_runs (
       workspace_id, on_behalf_of, originated_in_turn_id, statement, budget_max_tokens,
       budget_max_steps, budget_max_revisions, budget_max_wall_clock_seconds, idempotency_key
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      input.idempotencyKey ?? null,
    ],
  );
  const goalRunId = goal.rows[0]?.id;
  if (!goalRunId) throw new Error('createGoalRun: goal_runs INSERT ... RETURNING produced no row');
  const revision = await client.query<{ id: string }>(
    `insert into plan_revisions (
       workspace_id, goal_run_id, revision, plan, proposed_by, validation, source_procedure_id,
       source_procedure_version, source_procedure_parameters
     ) values ($1, $2, 1, $3::jsonb, $4, $5::jsonb, $6, $7, $8::jsonb)
     returning id`,
    [
      workspaceId,
      goalRunId,
      JSON.stringify(plan),
      input.proposedBy,
      JSON.stringify({ valid: true, steps: plan.steps.length, hints }),
      source?.procedureId ?? null,
      source?.version ?? null,
      source?.parameters ? JSON.stringify(source.parameters) : null,
    ],
  );
  const planRevisionId = revision.rows[0]?.id;
  if (!planRevisionId) {
    throw new Error('createGoalRun: plan_revisions INSERT ... RETURNING produced no row');
  }
  await recordGoalRunTransition(client, workspaceId, {
    actorPrincipalId: input.proposedBy,
    change: 'propose',
    goalRunId,
    resultingStatus: 'proposed',
    extraAuditPayload: {
      requesterId: input.requesterId,
      steps: plan.steps.length,
      // Which version only: the parameters are on the revision, read masked, not in the audit.
      ...(source !== null
        ? { fromProcedure: { procedureId: source.procedureId, version: source.version } }
        : {}),
    },
  });
  return {
    goalRunId,
    planRevisionId,
    plan,
    hints: [
      ...hints,
      ...(await planAuthorityHints(client, workspaceId, input.requesterId, plan, {
        checkAccounts: input.checkAccounts === true,
      })),
    ],
    status: 'proposed',
    changed: true,
  };
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
  /** S11 GO8a: see `CreateGoalRunInput.modelCatalog`. */
  readonly modelCatalog?: PlanReferenceSources['modelCatalog'];
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
  const plan = await validatePlan(client, workspaceId, stored.plan, goal.onBehalfOf, {
    ...(input.modelCatalog ? { modelCatalog: input.modelCatalog } : {}),
  });

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
    change: 'confirm',
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
