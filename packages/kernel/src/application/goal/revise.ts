import {
  GoalBudgetSchema,
  GoalPlanSchema,
  MAX_REVISION_REASON_CHARS,
  StepRemovalsSchema,
  type StepRunStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  lockWithdrawableStepActions,
  withdrawStepActions,
} from '../../governance/approval/index.js';
import { refuseCredentialText, refuseRedactedText } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { moveStepRun } from './moves.js';
import {
  type GoalPlan,
  type PlanHint,
  planHints,
  planShape,
  reviewRevisedPlan,
  samePlanEntry,
  validatePlan,
} from './plan.js';
import { planAuthorityHints } from './precheck.js';
import { getPlanRevision, lockStepRuns } from './reads.js';
import {
  GoalRunForbiddenError,
  GoalRunInputError,
  GoalRunNotFoundError,
  GoalRunStateError,
  lockGoalRun,
} from './service.js';
import { recordGoalRunTransition, recordStepRunTransition } from './transition-log.js';
import type { GoalControlActor, GoalRunBudget, StepRemoval, StepRunRow } from './types.js';

/**
 * application/goal/revise (S11 GO3b; plan §4.3, §4.8, I-G2, I-G3, I-G9; scenario S8): the requester
 * revising the plan of a paused GoalRun. Like the other writers here it runs in the caller's
 * transaction (the `revise_goal` capability, S11 GO5b, takes the actor from the authenticated
 * caller) and enforces what a capability must not be able to skip.
 *
 * Who and when: the requester alone — a revision is a plan the run then carries out with their
 * authority (propose → authorize → execute, §4.3) — and only while the run is `paused`, the pause
 * point where nothing new starts. The revision must be based on the run's current one (I-G3: a
 * stale page cannot overwrite a revision accepted since) and stays within the revision budget —
 * the budget the revision itself brings, when it brings one (I-G6: the budget changes with the
 * revision that takes effect).
 *
 * In one transaction, GoalRun locked first, then its StepRuns:
 *
 *   1. the new plan is validated (`plan.ts`), and the revision is inserted, accepted (the person
 *      revising is the one deciding) and adopted as the run's current revision — accept before
 *      adopt, the order the guards check;
 *   2. every live step whose definition the new plan drops or changes is `superseded` by it —
 *      unless it already ended (`succeeded`, `skipped`, `cancelled`): a dropped one stays as
 *      history, a changed one is refused (its key is taken; a changed definition needs a new
 *      key). A step the new plan holds unchanged keeps its StepRun, attempts and all;
 *   3. every key the new plan adds or changes gets a new `pending` StepRun under the revision;
 *   4. every request of the superseded steps that has not started is `withdrawn` — except those
 *      the person released (below). One that is `executing` cannot be taken back: it ends the
 *      R-48 way, and the run does not verify until it has (`advance.ts`).
 *
 * What happens to a superseded step's work is the person's choice per step (`removals`, recorded
 * on the revision, goal/0004): `terminate` (the default) — the next advance terminates its Tasks,
 * nested child Tasks included, after its commit; or `let_finish` — its Tasks run to their end and
 * their results are recorded on the Tasks, but the step moves no more (I-G2) and no Worker of it
 * raises anything new (the I-G9 entry check refuses a superseded step). Only with `let_finish`, the
 * person may release requests of the step that are awaiting a decision or approved and queued
 * (`release`): they keep their status and are decided and run as usual. Releasing is not a status
 * of its own; each released request gets an audit row. The run stays `paused`, due at once (so the
 * advance terminates what it should), for the requester to resume.
 */

export interface ReviseGoalRunInput {
  readonly goalRunId: string;
  readonly actor: GoalControlActor;
  /** The revision the new plan was made from — the run's current one (I-G3). */
  readonly basedOnRevision: number;
  readonly plan: unknown;
  /** Why — shown on the revision timeline as written; refused when it carries a suspected
   *  credential (`TextCarriesCredentialsError`, S11 GO5b). */
  readonly reason?: string;
  /** A new budget that takes effect with the revision; the current one when absent. */
  readonly budget?: GoalRunBudget;
  /** Per removed step: what happens to its work (see the module doc comment). */
  readonly removals?: unknown;
}

export interface RevisedGoalRun {
  readonly revision: number;
  readonly planRevisionId: string;
  readonly supersededStepRunIds: readonly string[];
  readonly createdStepRunIds: readonly string[];
  readonly withdrawnActionRequestIds: readonly string[];
  readonly releasedActionRequestIds: readonly string[];
  /** What the requester should know about the revised plan ({@link planHints}), and what their
   *  authority would stop now (`planAuthorityHints`, S11 GO5c). */
  readonly hints: readonly PlanHint[];
}

/** The longest reason a revision records — a sentence or two for the revision timeline
 *  (`@nexttime/shared`'s, which `revise_goal`'s params hold to). */
export const MAX_REVISION_REASON_LENGTH = MAX_REVISION_REASON_CHARS;

/** Why a superseded step's requests were withdrawn — in each withdrawal's audit payload. */
export const GOAL_REVISED_WITHDRAW_REASON = 'its step was revised away';

/** A step that ended keeps its row whatever later revisions say: it cannot be superseded. */
const ENDED_STEP_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  'succeeded',
  'skipped',
  'cancelled',
]);

export async function reviseGoalRun(
  client: PoolClient,
  workspaceId: string,
  input: ReviseGoalRunInput,
): Promise<RevisedGoalRun> {
  const goal = await lockGoalRun(client, workspaceId, input.goalRunId);
  if (!goal) throw new GoalRunNotFoundError(input.goalRunId);
  if (goal.onBehalfOf !== input.actor.principalId) {
    throw new GoalRunForbiddenError('only the requester revises a goal run');
  }
  if (goal.status !== 'paused') {
    throw new GoalRunStateError(
      `goal run ${goal.id} is ${goal.status}; a plan is revised while the run is paused`,
    );
  }
  const current = goal.currentRevision;
  if (current === null || input.basedOnRevision !== current) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: the revision is based on ${input.basedOnRevision}, but the current revision is ${current ?? 'none'} (I-G3)`,
    );
  }
  if (input.reason !== undefined && [...input.reason].length > MAX_REVISION_REASON_LENGTH) {
    throw new GoalRunInputError(
      `a revision reason is at most ${MAX_REVISION_REASON_LENGTH} characters`,
    );
  }
  // S11 GO5b (review #493 on #680): the reason is kept and read back as written. S11 GO5c: so is
  // the plan — neither may carry what a read masks, nor the mark a read left in a copy of it (an
  // editor opened on a masked read, GO6). An entry of the plan left as the read showed it is not a
  // copy but the entry itself: it keeps what is stored, and only the entries changed are checked
  // (`reviewRevisedPlan`).
  refuseRedactedText('reason', input.reason);
  refuseCredentialText('reason', input.reason);
  const currentRow = await getPlanRevision(client, workspaceId, goal.id, current);
  if (!currentRow) throw new Error(`reviseGoalRun: current revision ${current} is unreadable`);
  const stored = GoalPlanSchema.safeParse(currentRow.plan);
  if (!stored.success) {
    throw new Error(`reviseGoalRun: the plan of current revision ${current} no longer parses`);
  }
  const submitted = reviewRevisedPlan(planShape(input.plan), stored.data);
  const budget = parseBudget(input.budget) ?? goal.budget;
  const accepted = await client.query<{ accepted: number; next: number }>(
    `select count(*) filter (where status = 'accepted')::int as accepted,
            coalesce(max(revision), 0)::int + 1 as next
       from plan_revisions where workspace_id = $1 and goal_run_id = $2`,
    [workspaceId, goal.id],
  );
  const counts = accepted.rows[0];
  if (!counts) throw new Error('reviseGoalRun: counting the revisions returned no row');
  // Revision 1 is the confirmed plan; each accepted one after it counts against the budget.
  if (counts.accepted > budget.maxRevisions) {
    throw new GoalRunStateError(
      `goal run ${goal.id}: ${counts.accepted - 1} of ${budget.maxRevisions} revisions already made`,
    );
  }
  const revision = counts.next;
  const plan = await validatePlan(client, workspaceId, submitted);

  const steps = await lockStepRuns(client, workspaceId, goal.id);
  const { superseded, kept } = await splitSteps(client, workspaceId, goal.id, steps, plan);
  const endedKeys = new Set(
    steps
      .filter((step) => kept.has(step.stepKey) && ENDED_STEP_STATUSES.has(step.status))
      .map((step) => step.stepKey),
  );
  const removals = parseRemovals(input.removals, superseded);
  const releases = await lockReleases(client, workspaceId, superseded, removals);

  const inserted = await client.query<{ id: string }>(
    `insert into plan_revisions (
       workspace_id, goal_run_id, revision, based_on_revision, plan, proposed_by, reason,
       validation, removals
     ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb)
     returning id`,
    [
      workspaceId,
      goal.id,
      revision,
      current,
      JSON.stringify(plan),
      input.actor.principalId,
      input.reason ?? null,
      JSON.stringify({
        valid: true,
        steps: plan.steps.length,
        superseded: superseded.map((step) => step.stepKey),
        hints: planHints(plan),
      }),
      JSON.stringify(removals),
    ],
  );
  const planRevisionId = inserted.rows[0]?.id;
  if (!planRevisionId) {
    throw new Error('reviseGoalRun: plan_revisions INSERT ... RETURNING produced no row');
  }
  await client.query(
    `update plan_revisions set status = 'accepted', decided_by = $3, decided_at = now()
      where workspace_id = $1 and id = $2`,
    [workspaceId, planRevisionId, input.actor.principalId],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.actor.principalId,
    action: 'plan_revision.accept',
    resourceType: 'plan_revision',
    resourceId: planRevisionId,
    payload: { goalRunId: goal.id, revision, basedOnRevision: current },
  });
  // A revision is a change of the run (`updated_at`), not a transition: it stays paused. Like a
  // resume, a person's revision starts the count of failed advances again (legacy 356): past the
  // limit the reconcile scan skips the run, and with it the terminating of the Tasks this revision
  // stops (review #493 on #633).
  await client.query(
    `update goal_runs
        set current_revision = $3, budget_max_tokens = $4, budget_max_steps = $5,
            budget_max_revisions = $6, budget_max_wall_clock_seconds = $7, updated_at = now(),
            next_tick_at = now(), advance_failures = 0
      where workspace_id = $1 and id = $2 and status = 'paused'`,
    [
      workspaceId,
      goal.id,
      revision,
      budget.maxTokens,
      budget.maxSteps,
      budget.maxRevisions,
      budget.maxWallClockSeconds,
    ],
  );

  const actor = { principalId: input.actor.principalId, by: 'person' } as const;
  for (const step of superseded) {
    await moveStepRun(client, actor, step, 'supersede', {
      supersededInRevision: revision,
      audit: { mode: removals[step.stepKey]?.mode ?? 'terminate' },
    });
  }
  const created: string[] = [];
  for (const entry of plan.steps) {
    if (kept.has(entry.key)) continue;
    const row = await client.query<{ id: string }>(
      `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision)
       values ($1, $2, $3, $4)
       returning id`,
      [workspaceId, goal.id, entry.key, revision],
    );
    const stepRunId = row.rows[0]?.id;
    if (!stepRunId)
      throw new Error('reviseGoalRun: step_runs INSERT ... RETURNING produced no row');
    await recordStepRunTransition(client, workspaceId, {
      actorPrincipalId: input.actor.principalId,
      action: 'step_run.create',
      goalRunId: goal.id,
      stepRunId,
      resultingStatus: 'pending',
      extraAuditPayload: { by: 'person', stepKey: entry.key, revision },
    });
    created.push(stepRunId);
  }
  const released = releases.map((release) => release.id);
  const withdrawn = await withdrawStepActions(
    client,
    workspaceId,
    superseded.map((step) => step.id),
    {
      actorPrincipalId: input.actor.principalId,
      reason: GOAL_REVISED_WITHDRAW_REASON,
      keep: released,
    },
  );
  for (const release of releases) {
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: input.actor.principalId,
      action: 'action_request.release',
      resourceType: 'action_request',
      resourceId: release.id,
      payload: {
        goalRunId: goal.id,
        stepRunId: release.stepRunId,
        revision,
        status: release.status,
      },
    });
  }
  await recordGoalRunTransition(client, workspaceId, {
    actorPrincipalId: input.actor.principalId,
    action: 'goal_run.revise',
    goalRunId: goal.id,
    resultingStatus: 'paused',
    extraAuditPayload: {
      by: 'person',
      revision,
      basedOnRevision: current,
      superseded: superseded.map((step) => step.stepKey),
      created: plan.steps.filter((entry) => !kept.has(entry.key)).map((entry) => entry.key),
      letFinish: Object.keys(removals).filter((key) => removals[key]?.mode === 'let_finish'),
      withdrawn: withdrawn.length,
      released: released.length,
      ...(input.budget ? { budget } : {}),
    },
  });
  return {
    revision,
    planRevisionId,
    supersededStepRunIds: superseded.map((step) => step.id),
    createdStepRunIds: created,
    withdrawnActionRequestIds: withdrawn,
    releasedActionRequestIds: released,
    // S11 GO5c: and what the requester's authority would stop now — a step still to start that
    // would not pauses the run when it gets there (`precheck.ts`); a kept step that ended never
    // starts again.
    hints: [
      ...planHints(plan),
      ...(await planAuthorityHints(client, workspaceId, goal.onBehalfOf, {
        ...plan,
        steps: plan.steps.filter((entry) => !endedKeys.has(entry.key)),
      })),
    ],
  };
}

function parseBudget(budget: GoalRunBudget | undefined): GoalRunBudget | null {
  if (budget === undefined) return null;
  const parsed = GoalBudgetSchema.safeParse(budget);
  if (!parsed.success) {
    throw new GoalRunInputError(
      `budget: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

/** Which live steps the new plan supersedes, and the keys it keeps on their existing StepRun. */
async function splitSteps(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  steps: readonly StepRunRow[],
  plan: GoalPlan,
): Promise<{ readonly superseded: readonly StepRunRow[]; readonly kept: ReadonlySet<string> }> {
  const planned = new Set(plan.steps.map((entry) => entry.key));
  const introducedPlans = new Map<number, unknown>();
  const superseded: StepRunRow[] = [];
  const kept = new Set<string>();
  for (const step of steps) {
    if (step.status === 'superseded') continue;
    let introduced = introducedPlans.get(step.introducedInRevision);
    if (introduced === undefined) {
      introduced =
        (await getPlanRevision(client, workspaceId, goalRunId, step.introducedInRevision))?.plan ??
        null;
      introducedPlans.set(step.introducedInRevision, introduced);
    }
    if (samePlanEntry(introduced, plan, step.stepKey)) {
      kept.add(step.stepKey);
      continue;
    }
    if (ENDED_STEP_STATUSES.has(step.status)) {
      if (planned.has(step.stepKey)) {
        throw new GoalRunStateError(
          `step ${step.stepKey} is ${step.status}; its definition cannot change — add a step with a new key instead`,
        );
      }
      // Dropped after it ended: it stays as history (the StepRun table has no edge out of it).
      continue;
    }
    superseded.push(step);
  }
  return { superseded, kept };
}

function parseRemovals(
  removals: unknown,
  superseded: readonly StepRunRow[],
): Record<string, StepRemoval> {
  if (removals === undefined) return {};
  const parsed = StepRemovalsSchema.safeParse(removals);
  if (!parsed.success) {
    throw new GoalRunInputError(
      `removals: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'removals'}: ${issue.message}`).join('; ')}`,
    );
  }
  const removed = new Set(superseded.map((step) => step.stepKey));
  const result: Record<string, StepRemoval> = {};
  for (const [key, removal] of Object.entries(parsed.data)) {
    if (!removed.has(key)) {
      throw new GoalRunStateError(
        `removals: step ${key} is not a step this revision removes or changes while it runs`,
      );
    }
    if (removal.release && removal.mode !== 'let_finish') {
      throw new GoalRunInputError(
        `removals: step ${key}: requests are released only from a step let to finish`,
      );
    }
    if (removal.release && new Set(removal.release).size !== removal.release.length) {
      throw new GoalRunInputError(`removals: step ${key}: a request is released once`);
    }
    result[key] = removal;
  }
  return result;
}

/** The released requests, each one of its step's requests awaiting a decision or approved and
 *  queued — read under their row locks, so none starts executing before the revision commits. */
async function lockReleases(
  client: PoolClient,
  workspaceId: string,
  superseded: readonly StepRunRow[],
  removals: Readonly<Record<string, StepRemoval>>,
): Promise<readonly { id: string; stepRunId: string; status: string }[]> {
  const releasing = superseded.filter((step) => (removals[step.stepKey]?.release ?? []).length > 0);
  if (releasing.length === 0) return [];
  const withdrawable = await lockWithdrawableStepActions(
    client,
    workspaceId,
    releasing.map((step) => step.id),
  );
  const releases: { id: string; stepRunId: string; status: string }[] = [];
  for (const step of releasing) {
    for (const id of removals[step.stepKey]?.release ?? []) {
      const row = withdrawable.find((action) => action.id === id && action.stepRunId === step.id);
      if (!row) {
        throw new GoalRunStateError(
          `removals: step ${step.stepKey}: request ${id} is not one of its requests awaiting a decision or approved and queued`,
        );
      }
      releases.push(row);
    }
  }
  return releases;
}
