import {
  GOAL_PLANNER_NO_PROGRESS_LIMIT,
  type GoalRunPauseReason,
  type GoalRunStatus,
  type OutputProblem,
  PLANNING_FAILURE_CATEGORY_VALUES,
  PlannerOutputSchema,
  type PlannerRevisionClassReasonWire,
  type PlanningFailureCategory,
  type PlanningRoundKind,
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
  leftReason,
  listPlanningRounds,
  readGoalPlannerMode,
  settlePlanningRound,
} from './planning-rounds.js';
import { getGoalRun, getPlanRevision } from './reads.js';
import {
  type RevisionCandidate,
  adoptRevision,
  checkRevisionCandidate,
  readBasePlan,
  revisionValidation,
} from './revise.js';
import { classifyPlannerRevision, plannerRevisionFacts } from './revision-class.js';
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
 *      retry on its own ({@link plannableFailure}), at most once per failed attempt (or, S11 GO10b
 *      below, for the verification round the goal did not pass). When no planner
 *      can run for it, the round is recorded `failed` with why (no revision or token budget left, no
 *      planner definition, a requester who cannot start Workers now); the requester's concurrency
 *      quota only delays it ({@link PlanningPhaseResult.retryAt}). The planner Task is created
 *      here and started after the commit.
 *
 * S11 GO9b (plan §4.3; `s11-w2/go9-default-plan.md` §7): under the requester's `apply_minor`
 * leave the same failure need not pause the run. The advance leaves it to the planner instead
 * (`advance.ts` asks {@link autonomousPlanning} where it would pause) and starts no new attempt
 * while that is pending; phase P then runs an `autonomous` round while the run keeps running:
 *
 *   - **Abandoned** once the run stops running (`run_not_running`: any pause, a hold, a cancel) or
 *     its plan is revised (`plan_revised`); a person's pause or hold settles it at once.
 *   - **Opened** for the latest live failed step of the plan in force whose failed attempt has no
 *     round yet and whose failure is plannable — unless a planner revision waits for a decision.
 *     A step whose work the platform already applied {@link AUTONOMY_MAX_APPLIED_PER_STEP}
 *     revisions for ({@link platformAppliedLineage}: by where the step came from, so a new key
 *     does not start over) is not planned again (`step_keeps_failing`); like a planner that cannot
 *     run, that records the round `failed` and pauses the run `needs_decision` for the requester.
 *   - **Settled**: the revision is classed (`revision-class.ts`, the platform's rule, never the
 *     planner's say). A `minor` one the platform accepts for the requester and adopts in the same
 *     transaction (`adoptRevision` with `autonomy`), the round `applied`, the run due at once; a
 *     `major` one is left `proposed` and the run pauses for the requester to decide (GO9a's card).
 *     A `no_revision` or failed round pauses the run too, with what the planner said.
 *
 * A proposal round's revision is classed as well, for the requester to read; who decides does not
 * change.
 *
 * S11 GO10 (`s11-w2/go10-default-plan.md` §3): two limits on top.
 *
 *   - **No progress**: an autonomous round is not opened once {@link GOAL_PLANNER_NO_PROGRESS_LIMIT}
 *     have run with no step succeeding and no person acting since ({@link roundsWithoutProgress});
 *     the run pauses `no_progress` instead, with no round row, for a person to retry, revise or
 *     end it. It is the goal-wide counterpart of the per-step limit above: that one stops one
 *     step's work being redone over and over, this one stops failures moving from step to step.
 *   - **Planner rounds**: a round of either kind is not opened once `maxRevisions` planner rounds
 *     (rounds that started a planning Task, whatever they came to) have run
 *     (`revision_budget_exhausted`). `maxRevisions` caps them and the revisions made each — two
 *     counts, one limit; `usage.plannerRounds` reads the first.
 *
 * S11 GO10b (`s11-w2/go10b-default-plan.md`; goal/0016): a second judgment point. When every step
 * succeeded and the goal's own acceptance did not pass, the run is paused `needs_decision` as
 * before; with no failed step to plan for, phase P opens a `proposal` round for that verification
 * round instead ({@link failedAcceptanceRound}): the run's latest, on the revision in force, with
 * a check the platform made that `failed` (a round of only `unavailable` checks is no judgment
 * point — the platform could not look), at most once per verification round, and not one the
 * requester already resumed the run from. It is always a proposal round, `apply_minor` leave or
 * not (I-P6, the DB holds it): the run is paused for it already, and the platform never changes a
 * plan on its own after the goal did not pass. The planner reads which checks did not pass — key,
 * kind, status, the code of why — never what they observed (I-P7). The limits above hold for it
 * like any round: it counts as a planner round, and only autonomous rounds count towards no
 * progress.
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
/** S11 GO9b: past this many revisions the platform applied on its own for one step's work
 *  ({@link platformAppliedLineage}), a further failure of it is the requester's
 *  (`step_keeps_failing`). */
export const AUTONOMY_MAX_APPLIED_PER_STEP = 2;

/**
 * S11 GO9b (review #493 P2-1 on #866): how many revisions the platform applied on its own on the
 * way to `step` — counted by where the step came from, not by its key. A step is the platform's
 * when the revision that introduced it as it stands was one an `autonomous` round applied; that
 * round was for another step's failure (or an earlier run of this key), whose own count goes on.
 * So a planner that drops the failing step and adds the same work back under a new key, or
 * redefines it under its key, keeps the count; a step a person introduced or redefined
 * (`revise_goal`, accepting a proposal) starts it again. A step the platform's revision added
 * beside the one it replaced counts too — sooner back to the requester, never later.
 */
export function platformAppliedLineage(
  step: StepRunRow,
  steps: readonly StepRunRow[],
  rounds: readonly Pick<PlanningRoundRow, 'status' | 'revision' | 'stepRunId'>[],
): number {
  let count = 0;
  const seen = new Set<string>();
  let current: StepRunRow | undefined = step;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const introducedIn: number = current.introducedInRevision;
    const round = rounds.find(
      (candidate) => candidate.status === 'applied' && candidate.revision === introducedIn,
    );
    if (!round) break;
    count += 1;
    current = steps.find((candidate) => candidate.id === round.stepRunId);
  }
  return count;
}

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

/** S11 GO9b / GO10: why a running run pauses now. `needs_decision`: an autonomous round's outcome
 *  the platform does not apply, or a planner that cannot run. `no_progress` (GO10): the planner
 *  took {@link GOAL_PLANNER_NO_PROGRESS_LIMIT} failures in a row with no step succeeding and no
 *  person acting in between ({@link roundsWithoutProgress}). */
export interface PlanningPause {
  readonly reason: Extract<GoalRunPauseReason, 'needs_decision' | 'no_progress'>;
  readonly detail: string;
}

export interface PlanningPhaseResult {
  /** Tasks of rounds no longer running, terminated after the commit. */
  readonly terminate: readonly string[];
  /** The planner Task of the round this advance opened, started after the commit. */
  readonly start: PreparedStepAttempt | null;
  /** When the requester's concurrency quota may let the planner start (epoch ms). */
  readonly retryAt: number | null;
  /** S11 GO9b: why a running run pauses now, or `null`. */
  readonly pause: PlanningPause | null;
  /** S11 GO9b: the platform adopted a revision for the requester: the run is due at once. */
  readonly due: boolean;
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
  const running = ctx.status === 'running';
  const terminate: string[] = [];
  let pause: string | null = null;
  let due = false;
  let rounds = await listPlanningRounds(client, ws, goal.id);
  for (const round of rounds) {
    const live = round.task !== null && !FINISHED.has(round.task.status);
    if (round.status !== 'running') {
      if (live && round.task) terminate.push(round.task.id);
      continue;
    }
    const stays = round.kind === 'autonomous' ? running : inPause;
    if (!stays || round.basedOnRevision !== goal.currentRevision) {
      await settlePlanningRound(client, ws, actor, round, {
        status: 'abandoned',
        reason:
          round.basedOnRevision !== goal.currentRevision ? 'plan_revised' : leftReason(round.kind),
      });
      if (live && round.task) terminate.push(round.task.id);
      continue;
    }
    if (round.task === null) {
      const detail = 'the round has no planner Task';
      await settlePlanningRound(client, ws, actor, round, {
        status: 'failed',
        reason: 'task_failed',
        detail,
      });
      if (round.kind === 'autonomous')
        pause ??= roundPause(ctx, round, `its round failed (${detail})`);
      continue;
    }
    if (live) continue;
    const settled = await settleFinishedRound(ctx, actor, round);
    if (settled.pause !== null) pause ??= settled.pause;
    if (settled.due) due = true;
  }
  const idle = {
    terminate,
    start: null,
    retryAt: null,
    pause: pause === null ? null : { reason: 'needs_decision' as const, detail: pause },
    due,
  };
  // A revision adopted, or a pause to make: the next advance works on what is now in force.
  if (due || pause !== null) return idle;
  const autonomy = running && (await readGoalPlannerMode(client, ws, goal.id)) === 'apply_minor';
  if (!inPause && !autonomy) return idle;
  rounds = await listPlanningRounds(client, ws, goal.id);
  if (rounds.some((round) => round.status === 'running')) return idle;
  const opened = await openRound(ctx, rounds, inPause ? 'proposal' : 'autonomous');
  return { terminate, due: false, ...opened };
}

/** The pause an autonomous round's outcome makes, naming the step it was for. */
function roundPause(ctx: PlanningPhaseContext, round: PlanningRoundRow, outcome: string): string {
  const key = ctx.steps.find((step) => step.id === round.stepRunId)?.stepKey ?? round.stepRunId;
  return `step ${key}: attempt ${round.stepAttempt} failed (${round.failureCategory}); the goal planner ${outcome} — retry the step, revise the plan or cancel`;
}

// ----- settle -------------------------------------------------------------------------------

interface SettledRound {
  readonly pause: string | null;
  readonly due: boolean;
}

async function settleFinishedRound(
  ctx: PlanningPhaseContext,
  actor: PlanningActor,
  round: PlanningRoundRow,
): Promise<SettledRound> {
  const { client, goal } = ctx;
  const ws = goal.workspaceId;
  const task = round.task;
  const autonomous = round.kind === 'autonomous';
  const settled = (outcome: string): SettledRound => ({
    pause: autonomous ? roundPause(ctx, round, outcome) : null,
    due: false,
  });
  if (!task) return { pause: null, due: false };
  if (task.status !== 'completed') {
    const detail = `the planner's Task ${task.status}${task.failureReason ? ` (${task.failureReason})` : ''}`;
    await settlePlanningRound(client, ws, actor, round, {
      status: 'failed',
      reason: 'task_failed',
      detail,
    });
    return settled(`round failed (${detail})`);
  }
  const output = PlannerOutputSchema.safeParse(
    task.result !== null && typeof task.result === 'object'
      ? (task.result as { output?: unknown }).output
      : undefined,
  );
  if (!output.success) {
    const detail = "the planner's report is not a planner's proposal";
    await settlePlanningRound(client, ws, actor, round, {
      status: 'failed',
      reason: 'task_failed',
      detail,
    });
    return settled(`round failed (${detail})`);
  }
  if (output.data.decision === 'no_revision') {
    await settlePlanningRound(client, ws, actor, round, {
      status: 'no_revision',
      detail: output.data.reason,
    });
    return settled(`proposed no revision (${boundDetail(output.data.reason)})`);
  }
  let candidate: RevisionCandidate;
  try {
    refuseRedactedText('reason', output.data.reason);
    refuseCredentialText('reason', output.data.reason);
    // An autonomous round's revision may be adopted in this transaction: checked as its writer.
    candidate = await checkRevisionCandidate(client, ws, goal, {
      plan: output.data.plan,
      lock: autonomous,
    });
  } catch (err) {
    const problems = revisionProblems(err);
    if (!problems) throw err;
    const detail = problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
    await settlePlanningRound(client, ws, actor, round, {
      status: 'failed',
      reason: 'invalid_revision',
      detail,
    });
    return settled(`proposed a revision that no longer passes (${boundDetail(detail)})`);
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
  const base = await readBasePlan(client, ws, goal);
  const classification = classifyPlannerRevision({
    base,
    candidate: candidate.plan,
    ...(await plannerRevisionFacts(client, ws, goal, base, candidate.plan)),
  });
  const classed = {
    revisionClass: classification.revisionClass,
    classReasons: classification.reasons,
  };
  if (autonomous && classification.revisionClass === 'minor') {
    await adoptRevision(client, ws, goal, candidate, {
      actorId: goal.onBehalfOf,
      reason: null,
      budgetChanged: false,
      checkAccounts: false,
      proposal: { id: planRevisionId, revision: candidate.nextRevision },
      autonomy: { planningRoundId: round.id },
    });
    await settlePlanningRound(client, ws, actor, round, {
      status: 'applied',
      revision: candidate.nextRevision,
      ...classed,
    });
    return { pause: null, due: true };
  }
  await settlePlanningRound(client, ws, actor, round, {
    status: 'proposed',
    revision: candidate.nextRevision,
    ...classed,
  });
  if (!autonomous) return { pause: null, due: false };
  const key = ctx.steps.find((step) => step.id === round.stepRunId)?.stepKey ?? round.stepRunId;
  return {
    pause: `step ${key}: the goal planner proposed revision ${candidate.nextRevision}, which needs your decision (${majorReasons(classification.reasons)}) — accept or reject it, or revise the plan or cancel`,
    due: false,
  };
}

function majorReasons(reasons: readonly PlannerRevisionClassReasonWire[]): string {
  return reasons
    .map((reason) => (reason.stepKey ? `${reason.code} at step ${reason.stepKey}` : reason.code))
    .join(', ');
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

/**
 * S11 GO9b: what the planning of an `apply_minor` run does about `step`'s failure, read now — the
 * advance asks where it would pause for a person (`advance.ts`), and before it starts attempts.
 * `'open'`: the platform does not move the step on its own ({@link plannableFailure}), no round
 * was opened for its failed attempt and no planner revision waits for a decision — phase P opens an
 * autonomous round for it; `'running'`: the autonomous round for that attempt runs; `null`: the
 * planner has nothing to do with it now (the run pauses for a person as it would without the
 * leave). The caller checks the leave, that the run runs and that `step` is in the plan in force.
 */
export async function autonomousPlanning(
  client: PoolClient,
  workspaceId: string,
  step: StepRunRow,
  entry: PlanStep,
): Promise<'open' | 'running' | null> {
  if (!(await plannableFailure(client, workspaceId, step, entry))) return null;
  const round = await client.query<{ status: string; kind: PlanningRoundKind }>(
    `select status, kind from goal_planning_rounds
      where workspace_id = $1 and goal_run_id = $2 and step_run_id = $3 and step_attempt = $4`,
    [workspaceId, step.goalRunId, step.id, step.attemptCount],
  );
  const existing = round.rows[0];
  if (existing) {
    return existing.status === 'running' && existing.kind === 'autonomous' ? 'running' : null;
  }
  return (await plannerRevisionWaits(client, workspaceId, step.goalRunId)) ? null : 'open';
}

/** Whether a revision the planner proposed for the run waits for the requester's decision. */
async function plannerRevisionWaits(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<boolean> {
  const plannerId = await findGoalPlannerPrincipal(client, workspaceId);
  if (plannerId === null) return false;
  const waiting = await client.query(
    `select 1 from plan_revisions
      where workspace_id = $1 and goal_run_id = $2 and proposed_by = $3 and status = 'proposed'
      limit 1`,
    [workspaceId, goalRunId, plannerId],
  );
  return (waiting.rowCount ?? 0) > 0;
}

/**
 * S11 GO10 (`s11-w2/go10-default-plan.md` §3.1): the autonomous rounds that ran a planner since
 * the run last made progress or saw a person — since the later of its confirmation, its latest
 * resume and its latest step that succeeded. Every way back to `running` after a pause is a
 * person's (`confirm`, `resume`: the platform never resumes on its own) and a person changes the
 * plan only while it is paused (`revise.ts`), so the latest resume covers every decision of
 * theirs. The resume is read from the run's transition log (`goal_run.resume`,
 * `transition-log.ts`), written in the transaction that moved it. Derived, never counted in a
 * column: it rebuilds from the rows and answers why the run paused.
 */
export async function roundsWithoutProgress(
  ctx: Pick<PlanningPhaseContext, 'client' | 'goal' | 'steps'>,
  rounds: readonly PlanningRoundRow[],
): Promise<readonly PlanningRoundRow[]> {
  const { client, goal } = ctx;
  const resumed = await client.query<{ at: Date | null }>(
    `select max(created_at) as at from audit_records
      where workspace_id = $1 and resource_id = $2 and action = 'goal_run.resume'`,
    [goal.workspaceId, goal.id],
  );
  const marks = [
    goal.confirmedAt,
    resumed.rows[0]?.at ?? null,
    ...ctx.steps.map((step) => (step.status === 'succeeded' ? step.endedAt : null)),
  ].filter((at): at is Date => at !== null);
  const since = marks.reduce((latest, at) => Math.max(latest, at.getTime()), 0);
  return rounds
    .filter(
      (round) =>
        round.kind === 'autonomous' && round.task !== null && round.createdAt.getTime() >= since,
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Whether an autonomous round of the run is running. */
export async function autonomousRoundRuns(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<boolean> {
  const running = await client.query(
    `select 1 from goal_planning_rounds
      where workspace_id = $1 and goal_run_id = $2 and status = 'running' and kind = 'autonomous'
      limit 1`,
    [workspaceId, goalRunId],
  );
  return (running.rowCount ?? 0) > 0;
}

async function openRound(
  ctx: PlanningPhaseContext,
  rounds: readonly PlanningRoundRow[],
  kind: PlanningRoundKind,
): Promise<Omit<PlanningPhaseResult, 'terminate' | 'due'>> {
  const none = { start: null, retryAt: null, pause: null } as const;
  const { client, goal } = ctx;
  const ws = goal.workspaceId;
  const base = goal.currentRevision;
  if (base === null) return none;
  if ((await readGoalPlannerMode(client, ws, goal.id)) === null) return none;
  if (await plannerRevisionWaits(client, ws, goal.id)) return none;
  const rounded = (step: StepRunRow) =>
    rounds.some((round) => round.stepRunId === step.id && round.stepAttempt === step.attemptCount);
  // A pause gets one round, for its latest failure; a running run's planning takes the latest
  // failure that has none yet (an earlier one's round may have been abandoned by a pause).
  let target: { step: StepRunRow; category: PlanningFailureCategory } | null = null;
  const failed = ctx.steps
    .filter((step) => step.status === 'failed' && step.supersededInRevision === null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  for (const step of failed) {
    if (kind === 'autonomous' && rounded(step)) continue;
    const entry = await ctx.entry(step);
    if (!entry || !(await ctx.inCurrentPlan(step))) continue;
    const category = await plannableFailure(client, ws, step, entry);
    if (category) {
      target = { step, category };
      break;
    }
  }
  if (!target) {
    // S11 GO10b: no failed step to plan for — under a pause, the goal's own acceptance may be what
    // did not pass (a proposal round only, I-P6).
    if (kind !== 'proposal') return none;
    const acceptance = await failedAcceptanceRound(ctx, rounds);
    if (!acceptance) return none;
    return openPlannerRound(ctx, rounds, kind, {
      goalRunId: goal.id,
      basedOnRevision: base,
      point: 'goal_acceptance',
      stepRunId: null,
      stepAttempt: null,
      failureCategory: null,
      acceptanceRound: acceptance.round,
      kind,
      failed: acceptance,
    });
  }
  const { step, category } = target;
  if (rounded(step)) return none;
  return openPlannerRound(ctx, rounds, kind, {
    goalRunId: goal.id,
    basedOnRevision: base,
    point: 'step_failure',
    stepRunId: step.id,
    stepAttempt: step.attemptCount,
    failureCategory: category,
    acceptanceRound: null,
    kind,
    failed: { step, category },
  });
}

/** What a round is opened for, as `insertRound` writes it, with what the planner is told failed. */
type RoundOpening = {
  readonly goalRunId: string;
  readonly basedOnRevision: number;
  readonly kind: PlanningRoundKind;
} & (
  | {
      readonly point: 'step_failure';
      readonly stepRunId: string;
      readonly stepAttempt: number;
      readonly failureCategory: PlanningFailureCategory;
      readonly acceptanceRound: null;
      readonly failed: { readonly step: StepRunRow; readonly category: PlanningFailureCategory };
    }
  | {
      readonly point: 'goal_acceptance';
      readonly stepRunId: null;
      readonly stepAttempt: null;
      readonly failureCategory: null;
      readonly acceptanceRound: number;
      readonly failed: FailedAcceptanceRound;
    }
);

/** S11 GO10b: a verification round of the goal the planner may be asked about. */
interface FailedAcceptanceRound {
  readonly round: number;
  /** Its checks that did not pass — the platform's, `failed` or `unavailable` — key, kind, status
   *  and why (`lastError`): never what an observation saw (I-P7). */
  readonly unmet: readonly {
    readonly key: string;
    readonly kind: string;
    readonly status: string;
    readonly lastError: string | null;
  }[];
}

/**
 * S11 GO10b (goal/0016): the verification round the run is paused for, when a check of it the
 * platform made `failed` — `null` otherwise. It is the run's latest round, on the revision in
 * force, with no planning round yet (one per verification round), and the run has not been resumed
 * since it was opened: a resume verifies again in a new round, so an older round is no longer what
 * the run waits on — not even while another pause holds it before it verifies again (I-P4). A round
 * of only `unavailable` checks is none: the platform could not look, and a revision would not help.
 */
async function failedAcceptanceRound(
  ctx: PlanningPhaseContext,
  rounds: readonly PlanningRoundRow[],
): Promise<FailedAcceptanceRound | null> {
  const { client, goal } = ctx;
  const ws = goal.workspaceId;
  const latest = await client.query<{
    round: number;
    check_key: string;
    kind: string;
    status: string;
    last_error: string | null;
    plan_revision: number;
    opened_at: Date;
  }>(
    `select c.round, c.check_key, c.kind, c.status, c.last_error, c.plan_revision,
            min(c.created_at) over () as opened_at
       from goal_acceptance_checks c
      where c.workspace_id = $1 and c.goal_run_id = $2
        and c.round = (select max(round) from goal_acceptance_checks
                        where workspace_id = $1 and goal_run_id = $2)
      order by c.check_key`,
    [ws, goal.id],
  );
  const checks = latest.rows;
  const first = checks[0];
  if (!first) return null;
  if (checks.some((check) => check.plan_revision !== goal.currentRevision)) return null;
  if (!checks.some((check) => check.status === 'failed')) return null;
  if (rounds.some((round) => round.acceptanceRound === first.round)) return null;
  const resumed = await client.query<{ at: Date | null }>(
    `select max(created_at) as at from audit_records
      where workspace_id = $1 and resource_id = $2 and action = 'goal_run.resume'`,
    [ws, goal.id],
  );
  // A resume in the transaction that opened the round (one `now()`) came before it.
  const resumedAt = resumed.rows[0]?.at ?? null;
  if (resumedAt !== null && resumedAt.getTime() > first.opened_at.getTime()) return null;
  return {
    round: first.round,
    unmet: checks
      .filter((check) => check.status === 'failed' || check.status === 'unavailable')
      .map((check) => ({
        key: check.check_key,
        kind: check.kind,
        status: check.status,
        lastError: check.last_error,
      })),
  };
}

/** Opens a round for `opening` — or records it failed when no planner can run for it, pausing an
 *  autonomous run's step for a person. */
async function openPlannerRound(
  ctx: PlanningPhaseContext,
  rounds: readonly PlanningRoundRow[],
  kind: PlanningRoundKind,
  opening: RoundOpening,
): Promise<Omit<PlanningPhaseResult, 'terminate' | 'due'>> {
  const none = { start: null, retryAt: null, pause: null } as const;
  const { client, goal } = ctx;
  const ws = goal.workspaceId;
  const base = opening.basedOnRevision;
  const failRound = async (
    reason:
      | 'revision_budget_exhausted'
      | 'token_budget_exhausted'
      | 'planner_unavailable'
      | 'requester_cannot_start'
      | 'step_keeps_failing',
    detail: string,
  ) => {
    await insertRound(client, ws, goal.onBehalfOf, opening, { reason, detail });
    return {
      ...none,
      pause:
        opening.point === 'step_failure' && kind === 'autonomous'
          ? {
              reason: 'needs_decision' as const,
              detail: `step ${opening.failed.step.stepKey}: attempt ${opening.failed.step.attemptCount} failed (${opening.failed.category}); the platform does not plan it on its own now (${reason}: ${boundDetail(detail)}) — retry the step, revise the plan or cancel`,
            }
          : null,
    };
  };

  if (opening.point === 'step_failure' && kind === 'autonomous') {
    const { step, category } = opening.failed;
    // S11 GO10: the breaker — no round, and no round row: the run waits for a person, who may
    // retry, revise or end it (it never ends on its own).
    const stalled = await roundsWithoutProgress(ctx, rounds);
    if (stalled.length >= GOAL_PLANNER_NO_PROGRESS_LIMIT) {
      const keys = [...new Set(stalled.map((round) => round.stepKey))].join(', ');
      return {
        ...none,
        pause: {
          reason: 'no_progress',
          detail: `step ${step.stepKey}: attempt ${step.attemptCount} failed (${category}); the goal planner's last ${stalled.length} rounds (for steps ${keys}) made no step succeed, so the platform does not plan on its own again — retry the step, revise the plan or cancel`,
        },
      };
    }
    const applied = platformAppliedLineage(step, ctx.steps, rounds);
    if (applied >= AUTONOMY_MAX_APPLIED_PER_STEP) {
      return failRound(
        'step_keeps_failing',
        `the platform already applied ${applied} planner revisions on its own for the work of step ${step.stepKey}`,
      );
    }
  }
  // S11 GO10: the planner rounds — every round that started a planning Task, whatever it came to
  // (rejected, no revision, failed), since it spent the goal's tokens all the same — are capped by
  // `maxRevisions`, counted apart from the revisions made (two counts, one limit).
  const planned = rounds.filter((round) => round.task !== null).length;
  if (planned >= goal.budget.maxRevisions) {
    return failRound(
      'revision_budget_exhausted',
      `${planned} of ${goal.budget.maxRevisions} planner rounds already run`,
    );
  }
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
  const input = await plannerInput(ctx, opening, rounds, base);
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
    return { ...none, start: created.prepared };
  }
  await client.query('rollback to savepoint goal_planning_round');
  const { refusal } = created;
  if (refusal.kind === 'quota' && refusal.code === 'concurrency_exceeded') {
    return { ...none, retryAt: ctx.now.getTime() + ctx.quotaRetryMs };
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
  opening: RoundOpening,
  failed: { readonly reason: string; readonly detail: string } | null,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into goal_planning_rounds (
       workspace_id, goal_run_id, based_on_revision, step_run_id, step_attempt, failure_category,
       acceptance_round, status, outcome_reason, detail, settled_at, kind
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               case when $8 = 'running' then null else now() end, $11)
     returning id`,
    [
      workspaceId,
      opening.goalRunId,
      opening.basedOnRevision,
      opening.stepRunId,
      opening.stepAttempt,
      opening.failureCategory,
      opening.acceptanceRound,
      failed ? 'failed' : 'running',
      failed?.reason ?? null,
      failed ? boundDetail(failed.detail) : null,
      opening.kind,
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
      point: opening.point,
      stepRunId: opening.stepRunId,
      stepAttempt: opening.stepAttempt,
      failureCategory: opening.failureCategory,
      acceptanceRound: opening.acceptanceRound,
      kind: opening.kind,
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
  opening: RoundOpening,
  rounds: readonly PlanningRoundRow[],
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
      ...(opening.point === 'step_failure'
        ? {
            failedStep: await failedStepFacts(
              client,
              ws,
              opening.failed.step,
              opening.failed.category,
            ),
          }
        : {
            // S11 GO10b: every step succeeded, the goal's acceptance did not pass — the checks
            // that did not (their definitions are in the plan), never what was observed (I-P7).
            failedAcceptance: {
              round: opening.failed.round,
              checks: opening.failed.unmet.map((check) => ({ ...check })),
            },
          }),
      outputs,
      budget: {
        tokensLeft: Math.max(0, goal.budget.maxTokens - usage.tokens),
        stepAttemptsLeft: Math.max(0, goal.budget.maxSteps - usage.steps),
        revisionsLeft: Math.max(
          0,
          goal.budget.maxRevisions - ((accepted.rows[0]?.accepted ?? 1) - 1),
        ),
        // S11 GO10b: the other count `maxRevisions` caps (GO10) — this round is one of them.
        plannerRoundsLeft: Math.max(
          0,
          goal.budget.maxRevisions - rounds.filter((round) => round.task !== null).length - 1,
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
 *  workspace, the planner's own family left out (every version of it, a workspace owner's too —
 *  as `find_workers` does). */
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
  const round = await client.query<{
    status: string;
    based_on_revision: number;
    kind: PlanningRoundKind;
  }>(
    `select status, based_on_revision, kind from goal_planning_rounds
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
    // A run that left the round's pause (GO9b: stopped running, for an autonomous round), or whose
    // plan changed, abandons the round at its next advance: the report moves nothing then, and is
    // not held to a plan it no longer revises.
    const stays = row.kind === 'autonomous' ? 'running' : 'paused';
    if (goal?.status !== stays || goal.currentRevision !== row.based_on_revision) {
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
