import {
  type GoalRunPauseReason,
  type GoalRunStatus,
  type OutputProblem,
  PLANNING_FAILURE_CATEGORY_VALUES,
  PlannerOutputSchema,
  type PlanningFailureCategory,
  type WorkerResultCapabilityParams,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  RedactedTextSubmittedError,
  TextCarriesCredentialsError,
  boundedEcho,
  redactSecrets,
  refuseCredentialText,
  refuseRedactedText,
} from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { writeProbeHoldRefusal } from '../eval-seal/index.js';
import {
  PLANNER_MAX_DURATION_SEC,
  PLANNER_MAX_TOKEN_BUDGET,
  PLANNER_MIN_TOKEN_BUDGET,
  type PlannerTemplate,
  type PreparedStepAttempt,
  countStepAttemptsWithoutResult,
  createPlanningTask,
  ensurePlannerDefinition,
  findGoalPlannerFamily,
  findGoalPlannerPrincipal,
  getOrCreateGoalPlannerPrincipal,
  loadPlannerTemplate,
  lockTaskQuotas,
  readGoalRunTokenHeadroom,
  readGoalRunUsage,
  readStepAttemptTask,
  readTaskPlanningRound,
} from '../task/index.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  GoalPlanValidationError,
  type PlanStep,
  planAsRead,
} from './plan.js';
import {
  type PlanningActor,
  type PlanningRoundRow,
  boundDetail,
  listPlanningRounds,
  readGoalPlannerMode,
  settlePlanningRound,
} from './planning-rounds.js';
import { getGoalRun, getPlanRevision } from './reads.js';
import {
  type RevisionCandidate,
  checkRevisionCandidate,
  readBasePlan,
  revisionValidation,
} from './revise.js';
import { GoalRunInputError, GoalRunStateError } from './service.js';
import type { GoalRunRow, StepRunRow } from './types.js';

/**
 * application/goal/planner (S11 GO9a; plan §4.1, §4.3, §10 F3, I-P1..I-P5): the goal planner — a
 * Worker the platform starts, for the requester and with their leave, when a step of their GoalRun
 * failed in a way only a person resolves. It reads the plan and what became of it and proposes a
 * revision, or says none would help; the requester accepts or rejects what it proposes
 * (`decide.ts`). It decides nothing itself.
 *
 * Phase P of an advance ({@link runPlanningPhase}, after every other phase, in the advance's
 * transaction — GoalRun and StepRuns locked):
 *
 *   1. **Abandon** a running round the run is no longer paused for: the run is not paused
 *      `needs_decision`, a workspace owner holds it, or its revision in force is no longer the
 *      round's base (a person's action already settles it, `planning-rounds.ts` `closePlanning`;
 *      this is the backstop). Its Task is terminated after the commit, like every Task of a round
 *      that is no longer running.
 *   2. **Settle** a running round whose Task ended: a `revise` report whose plan still passes every
 *      check of a person's revision (`revise.ts` `checkRevisionCandidate`, the run as it stands
 *      now) becomes a `proposed` plan revision by the planner Principal, and the round `proposed`;
 *      a `no_revision` report settles it `no_revision` with the planner's reason; a plan that no
 *      longer passes, a Task that failed or was cancelled, or a report that is not the planner's
 *      settles it `failed`. The report was already held to the same checks when it was made
 *      ({@link plannerReportProblems}), so a planner that wrote a plan that does not pass was told
 *      where and could fix it then.
 *   3. **Open** a round when the run is paused `needs_decision`, no owner holds it, the requester
 *      gave the leave, no round runs and no revision the planner proposed waits for a decision —
 *      for the latest live failed step of the plan in force whose failure the platform does not
 *      retry on its own ({@link plannableFailure}), at most once per failed attempt. When no planner
 *      can run for it, the round is recorded `failed` with why (no revision or token budget left, no
 *      planner definition, a requester who cannot start Workers now); the requester's concurrency
 *      quota only delays it ({@link PlanningPhaseResult.retryAt}). The planner Task is created
 *      here and started after the commit.
 *
 * Every round settles once (goal/0014), and its audit row (`goal_planning_round.open`,
 * `goal_planning_round.settle`) carries `by: 'advancer'` with the requester as actor, like every
 * other move of the advance.
 */

/** What the planner Task's input says it is. */
export const PLANNER_INPUT_KIND = 'goal_planning';

/** Each succeeded step's output is cut to this many characters of JSON in the planner's input. */
export const PLANNER_OUTPUT_PREVIEW_CHARS = 4000;
/** At most this many Worker versions are offered to the planner. */
export const PLANNER_MAX_WORKERS = 50;

/** What the platform refuses in a revision, as the planner's input states it. */
const PLANNER_RULES: readonly string[] = [
  'plan is the whole plan from now on: a live step it leaves out is removed and its Worker stopped',
  'a step that succeeded, was skipped or cancelled cannot change under its key: keep it exactly as it is, or give new work a new key',
  'a value shown as [redacted] is kept only when the whole call it is in (a step worker with its input, a reconcile action or check, an acceptance check) is left exactly as read; anywhere else it is refused',
  'name only Worker versions listed in workers',
  'never write a credential: a gate authenticates with the credentials configured on it',
  'the budget does not change with a revision',
];

export interface PlanningPhaseContext {
  readonly client: PoolClient;
  /** The run as read under its lock when the advance began. */
  readonly goal: GoalRunRow;
  /** The run's status and pause reason after the advance's other phases. */
  readonly status: GoalRunStatus;
  readonly pauseReason: GoalRunPauseReason | null;
  /** The run's StepRuns, locked, as the advance's other phases left them. */
  readonly steps: readonly StepRunRow[];
  readonly now: Date;
  readonly quotaRetryMs: number;
  /** A step's definition (its entry in the revision that introduced it) and whether the plan in
   *  force still holds it unchanged (I-G2) — the advance's own reads. */
  readonly entry: (step: StepRunRow) => Promise<PlanStep | null>;
  readonly inCurrentPlan: (step: StepRunRow) => Promise<boolean>;
  /** The planner template; default `ontology/goal-planner.yaml`. */
  readonly plannerTemplate?: () => Promise<PlannerTemplate>;
}

export interface PlanningPhaseResult {
  /** Tasks of rounds no longer running, terminated after the commit. */
  readonly terminate: readonly string[];
  /** The planner Task of the round this advance opened, started after the commit. */
  readonly start: PreparedStepAttempt | null;
  /** When the requester's concurrency quota may let the planner start (epoch ms). */
  readonly retryAt: number | null;
}

const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Phase P — see the module comment. */
export async function runPlanningPhase(ctx: PlanningPhaseContext): Promise<PlanningPhaseResult> {
  const { client, goal } = ctx;
  const ws = goal.workspaceId;
  const actor: PlanningActor = { principalId: goal.onBehalfOf, by: 'advancer' };
  const inPause =
    ctx.status === 'paused' &&
    ctx.pauseReason === 'needs_decision' &&
    goal.pausedByAuthority !== 'owner';
  const terminate: string[] = [];
  let rounds = await listPlanningRounds(client, ws, goal.id);
  for (const round of rounds) {
    const live = round.task !== null && !FINISHED.has(round.task.status);
    if (round.status !== 'running') {
      if (live && round.task) terminate.push(round.task.id);
      continue;
    }
    if (!inPause || round.basedOnRevision !== goal.currentRevision) {
      await settlePlanningRound(client, ws, actor, round, {
        status: 'abandoned',
        reason: round.basedOnRevision !== goal.currentRevision ? 'plan_revised' : 'run_left_pause',
      });
      if (live && round.task) terminate.push(round.task.id);
      continue;
    }
    if (round.task === null) {
      await settlePlanningRound(client, ws, actor, round, {
        status: 'failed',
        reason: 'task_failed',
        detail: 'the round has no planner Task',
      });
      continue;
    }
    if (live) continue;
    await settleFinishedRound(client, goal, actor, round);
  }
  if (!inPause) return { terminate, start: null, retryAt: null };
  rounds = await listPlanningRounds(client, ws, goal.id);
  if (rounds.some((round) => round.status === 'running')) {
    return { terminate, start: null, retryAt: null };
  }
  const opened = await openRound(ctx, rounds);
  return { terminate, ...opened };
}

// ----- settle -------------------------------------------------------------------------------

async function settleFinishedRound(
  client: PoolClient,
  goal: GoalRunRow,
  actor: PlanningActor,
  round: PlanningRoundRow,
): Promise<void> {
  const ws = goal.workspaceId;
  const task = round.task;
  if (!task) return;
  if (task.status !== 'completed') {
    await settlePlanningRound(client, ws, actor, round, {
      status: 'failed',
      reason: 'task_failed',
      detail: `the planner's Task ${task.status}${task.failureReason ? ` (${task.failureReason})` : ''}`,
    });
    return;
  }
  const output = PlannerOutputSchema.safeParse(
    task.result !== null && typeof task.result === 'object'
      ? (task.result as { output?: unknown }).output
      : undefined,
  );
  if (!output.success) {
    await settlePlanningRound(client, ws, actor, round, {
      status: 'failed',
      reason: 'task_failed',
      detail: "the planner's report is not a planner's proposal",
    });
    return;
  }
  if (output.data.decision === 'no_revision') {
    await settlePlanningRound(client, ws, actor, round, {
      status: 'no_revision',
      detail: output.data.reason,
    });
    return;
  }
  let candidate: RevisionCandidate;
  try {
    refuseRedactedText('reason', output.data.reason);
    refuseCredentialText('reason', output.data.reason);
    candidate = await checkRevisionCandidate(client, ws, goal, {
      plan: output.data.plan,
      lock: false,
    });
  } catch (err) {
    const problems = revisionProblems(err);
    if (!problems) throw err;
    await settlePlanningRound(client, ws, actor, round, {
      status: 'failed',
      reason: 'invalid_revision',
      detail: problems.map((problem) => `${problem.path}: ${problem.message}`).join('; '),
    });
    return;
  }
  const plannerId = await getOrCreateGoalPlannerPrincipal(client, ws);
  const inserted = await client.query<{ id: string }>(
    `insert into plan_revisions (
       workspace_id, goal_run_id, revision, based_on_revision, plan, proposed_by, reason,
       validation, removals
     ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, '{}'::jsonb)
     returning id`,
    [
      ws,
      goal.id,
      candidate.nextRevision,
      round.basedOnRevision,
      JSON.stringify(candidate.plan),
      plannerId,
      output.data.reason,
      JSON.stringify(revisionValidation(candidate)),
    ],
  );
  const planRevisionId = inserted.rows[0]?.id;
  if (!planRevisionId) {
    throw new Error('planner: plan_revisions INSERT ... RETURNING produced no row');
  }
  await writeAudit(client, {
    workspaceId: ws,
    actorPrincipalId: plannerId,
    action: 'plan_revision.propose',
    resourceType: 'plan_revision',
    resourceId: planRevisionId,
    payload: {
      goalRunId: goal.id,
      revision: candidate.nextRevision,
      basedOnRevision: round.basedOnRevision,
      proposer: 'planner',
      planningRoundId: round.id,
      taskId: task.id,
      onBehalfOf: goal.onBehalfOf,
    },
  });
  await settlePlanningRound(client, ws, actor, round, {
    status: 'proposed',
    revision: candidate.nextRevision,
  });
}

/** The places a revision fails at, from the error a revision check throws — `null` for an error
 *  that is not a refusal of the revision (a broken row, a lost connection). Paths are spelled from
 *  the planner's report (`output.…`). */
export function revisionProblems(err: unknown): readonly OutputProblem[] | null {
  if (err instanceof GoalPlanValidationError) {
    return err.problems.map((problem) => ({ path: 'output.plan', message: problem }));
  }
  if (err instanceof RedactedTextSubmittedError || err instanceof TextCarriesCredentialsError) {
    const paths =
      err instanceof RedactedTextSubmittedError
        ? (err.details.paths ?? [err.details.field])
        : (err.details.suspectedSecretPaths ?? [err.details.field]);
    return paths.map((place) => ({ path: `output.${place}`, message: err.message }));
  }
  if (err instanceof GoalRunStateError || err instanceof GoalRunInputError) {
    return [{ path: 'output.plan', message: err.message }];
  }
  return null;
}

// ----- open ---------------------------------------------------------------------------------

/** The failure of `step` the planner is asked about, or `null` when the platform still moves the
 *  step on its own (a rework due, a transient failure under its attempt limit) or no plan change
 *  can be what it waits for (an outcome to reconcile, lost authority). */
export async function plannableFailure(
  client: PoolClient,
  workspaceId: string,
  step: StepRunRow,
  entry: PlanStep,
): Promise<PlanningFailureCategory | null> {
  const category = step.failureCategory;
  if (step.status !== 'failed' || category === null) return null;
  if (!(PLANNING_FAILURE_CATEGORY_VALUES as readonly string[]).includes(category)) return null;
  const plannable = category as PlanningFailureCategory;
  if (plannable === 'contract_violation') {
    return (await countStepAttemptsWithoutResult(client, workspaceId, step.id)) >= 2
      ? plannable
      : null;
  }
  if (plannable === 'transient') {
    return step.attemptCount >= (entry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) ? plannable : null;
  }
  return plannable;
}

async function openRound(
  ctx: PlanningPhaseContext,
  rounds: readonly PlanningRoundRow[],
): Promise<Omit<PlanningPhaseResult, 'terminate'>> {
  const none = { start: null, retryAt: null };
  const { client, goal } = ctx;
  const ws = goal.workspaceId;
  const base = goal.currentRevision;
  if (base === null) return none;
  if ((await readGoalPlannerMode(client, ws, goal.id)) === null) return none;
  const plannerId = await findGoalPlannerPrincipal(client, ws);
  if (plannerId !== null) {
    const waiting = await client.query(
      `select 1 from plan_revisions
        where workspace_id = $1 and goal_run_id = $2 and proposed_by = $3 and status = 'proposed'
        limit 1`,
      [ws, goal.id, plannerId],
    );
    if ((waiting.rowCount ?? 0) > 0) return none;
  }
  let target: { step: StepRunRow; category: PlanningFailureCategory } | null = null;
  const failed = ctx.steps
    .filter((step) => step.status === 'failed' && step.supersededInRevision === null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  for (const step of failed) {
    const entry = await ctx.entry(step);
    if (!entry || !(await ctx.inCurrentPlan(step))) continue;
    const category = await plannableFailure(client, ws, step, entry);
    if (category) {
      target = { step, category };
      break;
    }
  }
  if (!target) return none;
  const { step, category } = target;
  if (
    rounds.some((round) => round.stepRunId === step.id && round.stepAttempt === step.attemptCount)
  ) {
    return none;
  }
  const opening = {
    goalRunId: goal.id,
    basedOnRevision: base,
    stepRunId: step.id,
    stepAttempt: step.attemptCount,
    failureCategory: category,
  };
  const failRound = async (
    reason:
      | 'revision_budget_exhausted'
      | 'token_budget_exhausted'
      | 'planner_unavailable'
      | 'requester_cannot_start',
    detail: string,
  ) => {
    await insertRound(client, ws, goal.onBehalfOf, opening, { reason, detail });
    return none;
  };

  const revisions = await client.query<{ accepted: number }>(
    `select count(*) filter (where status = 'accepted')::int as accepted
       from plan_revisions where workspace_id = $1 and goal_run_id = $2`,
    [ws, goal.id],
  );
  const accepted = revisions.rows[0]?.accepted ?? 0;
  if (accepted > goal.budget.maxRevisions) {
    return failRound(
      'revision_budget_exhausted',
      `${accepted - 1} of ${goal.budget.maxRevisions} revisions already made`,
    );
  }
  const definition = await ensurePlannerDefinition(
    client,
    ws,
    await (ctx.plannerTemplate ?? (() => loadPlannerTemplate()))(),
  );
  if (!definition) {
    return failRound(
      'planner_unavailable',
      "the workspace's goal planner has no published version (a workspace owner deprecated it)",
    );
  }
  await lockTaskQuotas(client, ws, goal.onBehalfOf);
  const headroom = await readGoalRunTokenHeadroom(client, ws, goal.id);
  const tokenCap = Math.min(PLANNER_MAX_TOKEN_BUDGET, headroom);
  if (tokenCap < PLANNER_MIN_TOKEN_BUDGET) {
    return failRound(
      'token_budget_exhausted',
      `${headroom} tokens left of the goal's ${goal.budget.maxTokens}; a planner needs at least ${PLANNER_MIN_TOKEN_BUDGET}`,
    );
  }

  await client.query('savepoint goal_planning_round');
  const roundId = await insertRound(client, ws, goal.onBehalfOf, opening, null);
  const input = await plannerInput(ctx, step, category, base);
  const created = await createPlanningTask(client, ws, {
    definition,
    requesterId: goal.onBehalfOf,
    goalRunId: goal.id,
    planRevision: base,
    planningRoundId: roundId,
    input,
    tokenCap,
    durationCapSec: PLANNER_MAX_DURATION_SEC,
  });
  if (created.kind === 'created') {
    await client.query('release savepoint goal_planning_round');
    return { start: created.prepared, retryAt: null };
  }
  await client.query('rollback to savepoint goal_planning_round');
  const { refusal } = created;
  if (refusal.kind === 'quota' && refusal.code === 'concurrency_exceeded') {
    return { start: null, retryAt: ctx.now.getTime() + ctx.quotaRetryMs };
  }
  if (refusal.kind === 'paused') {
    await writeProbeHoldRefusal(client, {
      workspaceId: ws,
      principalId: goal.onBehalfOf,
      path: 'worker_start',
    });
  }
  return failRound(
    refusal.kind === 'quota' &&
      (refusal.code === 'daily_cost_exceeded' || refusal.code === 'goal_budget_exhausted')
      ? 'token_budget_exhausted'
      : 'requester_cannot_start',
    refusal.detail,
  );
}

/** Inserts a round — `running`, or (`failed` given) recorded failed at once — with its audit row;
 *  returns its id. */
async function insertRound(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  opening: {
    readonly goalRunId: string;
    readonly basedOnRevision: number;
    readonly stepRunId: string;
    readonly stepAttempt: number;
    readonly failureCategory: PlanningFailureCategory;
  },
  failed: { readonly reason: string; readonly detail: string } | null,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into goal_planning_rounds (
       workspace_id, goal_run_id, based_on_revision, step_run_id, step_attempt, failure_category,
       status, outcome_reason, detail, settled_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $7 = 'running' then null else now() end)
     returning id`,
    [
      workspaceId,
      opening.goalRunId,
      opening.basedOnRevision,
      opening.stepRunId,
      opening.stepAttempt,
      opening.failureCategory,
      failed ? 'failed' : 'running',
      failed?.reason ?? null,
      failed ? boundDetail(failed.detail) : null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('planner: goal_planning_rounds INSERT ... RETURNING produced no row');
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: requesterId,
    action: 'goal_planning_round.open',
    resourceType: 'goal_run',
    resourceId: opening.goalRunId,
    payload: {
      by: 'advancer',
      planningRoundId: id,
      basedOnRevision: opening.basedOnRevision,
      stepRunId: opening.stepRunId,
      stepAttempt: opening.stepAttempt,
      failureCategory: opening.failureCategory,
      status: failed ? 'failed' : 'running',
      ...(failed ? { reason: failed.reason } : {}),
    },
  });
  return id;
}

// ----- the planner's input ------------------------------------------------------------------

/** What the planner reads (`get_task`'s input) — see `ontology/goal-planner.yaml`. The plan is as
 *  every read shows it (`planAsRead`: a credential masked, the one definition `reviewRevisedPlan`
 *  compares a call with); everything else is scrubbed like a report (`redactSecrets`). Step
 *  outputs and failure texts are what Workers wrote: data for the planner, not instructions. */
async function plannerInput(
  ctx: PlanningPhaseContext,
  failedStep: StepRunRow,
  category: PlanningFailureCategory,
  base: number,
): Promise<Record<string, unknown>> {
  const { client, goal } = ctx;
  const ws = goal.workspaceId;
  const plan = planAsRead(await readBasePlan(client, ws, goal));
  const live = ctx.steps.filter((step) => step.status !== 'superseded');
  const usage = await readGoalRunUsage(client, ws, goal.id);
  const accepted = await client.query<{ accepted: number }>(
    `select count(*) filter (where status = 'accepted')::int as accepted
       from plan_revisions where workspace_id = $1 and goal_run_id = $2`,
    [ws, goal.id],
  );
  const confirmed = goal.confirmedAt ?? goal.createdAt;
  const wallClockLeft = Math.max(
    0,
    Math.floor(
      (confirmed.getTime() + goal.budget.maxWallClockSeconds * 1000 - ctx.now.getTime()) / 1000,
    ),
  );
  const outputs: Record<string, unknown> = {};
  for (const step of live) {
    if (step.status !== 'succeeded' || step.attemptCount < 1) continue;
    const output = await readStepOutput(client, ws, step);
    if (output !== undefined) outputs[step.stepKey] = previewOf(output);
  }
  const rest = redactSecrets(
    {
      goal: { statement: goal.statement, pauseReason: ctx.pauseReason },
      steps: live.map((step) => ({
        key: step.stepKey,
        status: step.status,
        attempts: step.attemptCount,
        failureCategory: step.failureCategory,
        waitingReason: step.waitingReason,
      })),
      failedStep: await failedStepFacts(client, ws, failedStep, category),
      outputs,
      budget: {
        tokensLeft: Math.max(0, goal.budget.maxTokens - usage.tokens),
        stepAttemptsLeft: Math.max(0, goal.budget.maxSteps - usage.steps),
        revisionsLeft: Math.max(
          0,
          goal.budget.maxRevisions - ((accepted.rows[0]?.accepted ?? 1) - 1),
        ),
        wallClockSecondsLeft: wallClockLeft,
      },
      workers: await plannerWorkers(client, ws),
      rules: PLANNER_RULES,
    },
    { maxNodes: Number.POSITIVE_INFINITY },
  ).value as Record<string, unknown>;
  return { kind: PLANNER_INPUT_KIND, basedOnRevision: base, plan, ...rest };
}

async function readStepOutput(
  client: PoolClient,
  workspaceId: string,
  step: StepRunRow,
): Promise<unknown> {
  const result = await client.query<{ output: unknown }>(
    `select result -> 'output' as output from tasks
      where workspace_id = $1 and step_run_id = $2 and step_attempt = $3`,
    [workspaceId, step.id, step.attemptCount],
  );
  const output = result.rows[0]?.output;
  return output === null ? undefined : output;
}

function previewOf(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= PLANNER_OUTPUT_PREVIEW_CHARS) return value;
  return { cutShort: true, json: `${json.slice(0, PLANNER_OUTPUT_PREVIEW_CHARS)}…` };
}

async function failedStepFacts(
  client: PoolClient,
  workspaceId: string,
  step: StepRunRow,
  category: PlanningFailureCategory,
): Promise<Record<string, unknown>> {
  const task = await readStepAttemptTask(client, workspaceId, step.id, step.attemptCount);
  const requests = await client.query<{
    gatekeeper_id: string;
    action_kind: string;
    status: string;
    failure_kind: string | null;
  }>(
    `select gatekeeper_id, action_kind, status, failure_kind from action_requests
      where workspace_id = $1 and step_run_id = $2
      order by requested_at, id
      limit 20`,
    [workspaceId, step.id],
  );
  const checks =
    category === 'verification_failed'
      ? await client.query<{ check_key: string; status: string; last_error: string | null }>(
          `select check_key, status, last_error from step_acceptance_checks
            where workspace_id = $1 and step_run_id = $2
              and round = (select max(round) from step_acceptance_checks
                            where workspace_id = $1 and step_run_id = $2)
            order by check_key`,
          [workspaceId, step.id],
        )
      : null;
  return {
    key: step.stepKey,
    attempt: step.attemptCount,
    failureCategory: category,
    taskFailureReason: task?.failureReason ?? null,
    requests: requests.rows.map((row) => ({
      gatekeeperId: row.gatekeeper_id,
      operation: row.action_kind,
      status: row.status,
      failureKind: row.failure_kind,
    })),
    ...(task?.rejectedOutput
      ? {
          outputProblems: task.rejectedOutput.problems.map((problem) => ({
            path: boundedEcho(problem.path, 200),
            message: problem.message,
          })),
        }
      : {}),
    ...(checks
      ? {
          acceptance: checks.rows.map((row) => ({
            key: row.check_key,
            status: row.status,
            lastError: row.last_error,
          })),
        }
      : {}),
  };
}

/** The Worker versions a step may name: the latest published version of each family of the
 *  workspace, the planner's own left out. */
async function plannerWorkers(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly Record<string, unknown>[]> {
  // Not the planner's own family, whoever published a version of it (as `find_workers`).
  const plannerFamily = await findGoalPlannerFamily(client, workspaceId);
  const result = await client.query<{
    id: string;
    version: number;
    name: unknown;
    description: unknown;
  }>(
    `select distinct on (id) id, version, definition -> 'name' as name,
            definition -> 'description' as description
       from worker_definitions
      where workspace_id = $1 and kind = 'worker' and status = 'published'
        and id is distinct from $2
      order by id, version desc
      limit $3`,
    [workspaceId, plannerFamily, PLANNER_MAX_WORKERS],
  );
  return result.rows.map((row) => ({
    definitionId: row.id,
    version: row.version,
    name: typeof row.name === 'string' ? row.name : null,
    description: typeof row.description === 'string' ? row.description : null,
  }));
}

// ----- the planner's report -----------------------------------------------------------------

/** What a planner may not put in its report: it writes nothing but its proposal (I-P1). */
const PLANNER_REPORT_FORBIDDEN = [
  'factsToAssert',
  'evidence',
  'artifacts',
  'proposedSkill',
  'proposedOperations',
] as const;

/**
 * S11 GO9a: a planning Task's report, after its output contract passed (`report_task_result`,
 * `worker-result-handler.ts`): it holds nothing but the proposal, and a `revise` plan passes every
 * check a person's revision does on the run as it stands — refused otherwise, each place named,
 * so the planner fixes it in its session (the contract's way). Nothing is checked once the round
 * stopped running: the report is kept on the Task and moves nothing. `contract` is the report as
 * it would be stored (scrubbed). Returns the problems; empty when it passes or is no planner's.
 */
export async function plannerReportProblems(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  contract: WorkerResultCapabilityParams,
): Promise<readonly OutputProblem[]> {
  const planning = await readTaskPlanningRound(client, workspaceId, taskId);
  if (!planning) return [];
  const round = await client.query<{ status: string; based_on_revision: number }>(
    `select status, based_on_revision from goal_planning_rounds
      where workspace_id = $1 and id = $2`,
    [workspaceId, planning.planningRoundId],
  );
  const row = round.rows[0];
  if (row?.status !== 'running') return [];
  const problems: OutputProblem[] = [];
  for (const field of PLANNER_REPORT_FORBIDDEN) {
    const value = contract[field];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    problems.push({
      path: field,
      message:
        'a planner reports its proposal in output only; it writes no Facts, evidence, artifacts or proposals',
    });
  }
  const output = PlannerOutputSchema.safeParse(contract.output);
  if (!output.success) {
    for (const issue of output.error.issues) {
      problems.push({
        path: ['output', ...issue.path.map(String)].join('.'),
        message:
          issue.path[0] === 'plan'
            ? 'plan is given with decision revise, and only then'
            : issue.message,
      });
    }
    return problems;
  }
  try {
    refuseRedactedText('output.reason', output.data.reason);
    refuseCredentialText('output.reason', output.data.reason);
  } catch (err) {
    if (
      !(err instanceof RedactedTextSubmittedError || err instanceof TextCarriesCredentialsError)
    ) {
      throw err;
    }
    problems.push({ path: 'output.reason', message: err.message });
  }
  if (output.data.decision === 'revise') {
    const goal = await getGoalRun(client, workspaceId, planning.goalRunId);
    // A run that left the round's pause, or whose plan changed, abandons the round at its next
    // advance: the report moves nothing then, and is not held to a plan it no longer revises.
    if (goal?.status !== 'paused' || goal.currentRevision !== row.based_on_revision) {
      return problems;
    }
    try {
      await checkRevisionCandidate(client, workspaceId, goal, {
        plan: output.data.plan,
        lock: false,
      });
    } catch (err) {
      const found = revisionProblems(err);
      if (!found) throw err;
      problems.push(...found);
    }
  }
  return problems;
}

/** The planner revision `revision` of the run, when the planner proposed it: its row. */
export async function readPlannerRevision(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  revision: number,
): Promise<{
  readonly id: string;
  readonly status: string;
  readonly basedOnRevision: number | null;
  readonly plan: unknown;
} | null> {
  const plannerId = await findGoalPlannerPrincipal(client, workspaceId);
  if (plannerId === null) return null;
  const row = await getPlanRevision(client, workspaceId, goalRunId, revision);
  if (!row || row.proposedBy !== plannerId) return null;
  return { id: row.id, status: row.status, basedOnRevision: row.basedOnRevision, plan: row.plan };
}
