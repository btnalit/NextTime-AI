import {
  type GoalOutcomeBasis,
  type GoalRunStatus,
  type ObjectiveOutcome,
  type ProcedureClaimsWire,
  type ProcedureFailureGroupWire,
  type ProcedureFailurePlace,
  type ProcedureOutcomeHintWire,
  type ProcedureStatsSegmentWire,
  type ProcedureStatsWire,
  type ProcedureUsageWire,
  type ProcedureVersionStatsWire,
  type PublishableStatus,
  REVIEW_STREAK,
  STEP_RUN_FAILURE_CATEGORY_VALUES,
  type StepRunFailureCategory,
  outcomeBasisTier,
  suggestsReview,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type SubjectOutcome, outcomeTallyWire, readJudgedStepTasks } from './stats-read.js';

/**
 * application/task/procedure-stats (S11 W1a E2-2; S10 §5.4, docs/global-roadmap-2026-10-16.md W1a
 * E2): `get_procedure_stats` — how each version of a Procedure family has done — and the outcome
 * hint `find_procedures` carries, read when asked. No table of its own: every number is counted
 * from the records the work already left, under the rules `packages/shared`
 * `wire/procedure-stats.ts` states.
 *
 * The records, and what each one is:
 *   - `plan_revisions` (goal/0009): revision 1 of a goal made from a Procedure version records the
 *     version — written by the kernel as it made the plan, so authoritative.
 *   - `goal_runs` (goal/0001): the goal's status, its outcome and what the outcome rests on.
 *   - `tasks`, `worker_runs` (task/0007, task/0009): the goal's Tasks and the environment each
 *     run ran in.
 *   - `step_runs` (goal/0001) and the steps' transition records (`audit_records`, `step_run.*`):
 *     which step failed and how; `goal_acceptance_checks` (goal/0005): the acceptance rounds.
 *   - `turn_procedure_claims` (worker/0004): a Turn whose entry agent said it followed a version —
 *     the agent's claim — and `turn_outcomes` (task/0006): the requester's outcome of that Turn.
 *
 * A read-only projection across modules (goal, worker and audit tables beside this module's own),
 * as `skill-stats.ts` is: it writes nothing. Every table read here is workspace-isolated only, so
 * the counts cover the whole workspace; numbers only — no goal, Turn, Task or step id and no free
 * text leaves this module, and a step's key only when the Procedure itself named the step.
 */

interface GoalRow {
  readonly id: string;
  readonly procedure_id: string;
  readonly version: number;
  readonly status: GoalRunStatus;
  readonly outcome: ObjectiveOutcome | null;
  readonly outcome_basis: GoalOutcomeBasis | null;
  readonly created_at: Date;
  readonly confirmed_at: Date | null;
  readonly ended_at: Date | null;
}

const IN_PROGRESS: ReadonlySet<GoalRunStatus> = new Set([
  'running',
  'paused',
  'verifying',
  'cancelling',
]);

/** Procedure family `procedureId`'s statistics, or `null` when the workspace has no such
 *  Procedure. */
export async function readProcedureStats(
  client: PoolClient,
  workspaceId: string,
  procedureId: string,
): Promise<ProcedureStatsWire | null> {
  const versions = await client.query<{ version: number; status: PublishableStatus; name: string }>(
    `select version, status, name from procedures
      where workspace_id = $1 and id = $2
      order by version desc`,
    [workspaceId, procedureId],
  );
  const latest = versions.rows[0];
  if (!latest) return null;

  const goals = await readGoalsMadeFrom(client, workspaceId, [procedureId]);
  const environments = await readGoalEnvironments(
    client,
    workspaceId,
    goals.map((goal) => goal.id),
  );
  const claims = await readClaims(client, workspaceId, procedureId);

  const versionStats: ProcedureVersionStatsWire[] = versions.rows.map((row) => {
    const versionGoals = goals.filter((goal) => goal.version === row.version);
    const bySegment = new Map<string, { digests: string[] | null; goals: GoalRow[] }>();
    for (const goal of versionGoals) {
      const digests = environments.get(goal.id);
      // A goal no Worker has run for yet is in no segment.
      if (digests === undefined) continue;
      const key = digests === null ? '' : digests.join(',');
      const segment = bySegment.get(key) ?? {
        digests: digests === null ? null : [...digests],
        goals: [],
      };
      segment.goals.push(goal);
      bySegment.set(key, segment);
    }
    const segments = [...bySegment.values()]
      .map(
        (segment): ProcedureStatsSegmentWire => ({
          environmentDigests: segment.digests,
          usage: usageOf(segment.goals),
          outcomes: outcomeTallyWire(outcomesOf(segment.goals)),
          reviewSuggested: suggestsReview(
            outcomesOf(segment.goals)
              .filter((subject) => outcomeBasisTier(subject.basis) === 'primary')
              .sort((a, b) => b.at.getTime() - a.at.getTime())
              .map((subject) => subject.outcome),
          ),
        }),
      )
      .sort(byLastUsedDesc);
    return {
      version: row.version,
      status: row.status,
      usage: usageOf(versionGoals),
      outcomes: outcomeTallyWire(outcomesOf(versionGoals)),
      claims: claims.get(row.version) ?? {
        turns: 0,
        achieved: 0,
        notAchieved: 0,
        lastClaimedAt: null,
      },
      reviewSuggested: segments.some((segment) => segment.reviewSuggested),
      segments,
    };
  });

  return {
    procedureId,
    name: latest.name,
    reviewStreak: REVIEW_STREAK,
    versions: versionStats,
    failureGroups: await readFailureGroups(client, workspaceId, goals),
  };
}

/**
 * `find_procedures`' hint per result (E2-2 fork 4 = a): the primary outcomes — the requester's and
 * a platform check's — of the goals made from each `procedureId@version`, the same count
 * `get_procedure_stats` gives as the version's `outcomes.primary`. Keyed `procedureId@version`;
 * a version no goal was made from, or none ended, is `{achieved: 0, total: 0}`.
 */
export async function readProcedureOutcomeHints(
  client: PoolClient,
  workspaceId: string,
  wanted: readonly { readonly procedureId: string; readonly version: number }[],
): Promise<Map<string, ProcedureOutcomeHintWire>> {
  const hints = new Map<string, ProcedureOutcomeHintWire>();
  for (const { procedureId, version } of wanted) {
    hints.set(`${procedureId}@${version}`, { achieved: 0, total: 0 });
  }
  if (wanted.length === 0) return hints;
  const goals = await readGoalsMadeFrom(client, workspaceId, [
    ...new Set(wanted.map((item) => item.procedureId)),
  ]);
  for (const goal of goals) {
    const hint = hints.get(`${goal.procedure_id}@${goal.version}`);
    if (!hint || !goal.outcome || !goal.outcome_basis) continue;
    if (outcomeBasisTier(goal.outcome_basis) !== 'primary') continue;
    hints.set(`${goal.procedure_id}@${goal.version}`, {
      achieved: hint.achieved + (goal.outcome === 'achieved' ? 1 : 0),
      total: hint.total + 1,
    });
  }
  return hints;
}

/** Every goal made from a version of the given families: revision 1 records the version. */
async function readGoalsMadeFrom(
  client: PoolClient,
  workspaceId: string,
  procedureIds: readonly string[],
): Promise<GoalRow[]> {
  const result = await client.query<GoalRow>(
    `select g.id, r.source_procedure_id as procedure_id, r.source_procedure_version as version,
            g.status, g.outcome, g.outcome_basis, g.created_at, g.confirmed_at, g.ended_at
       from plan_revisions r
       join goal_runs g on g.workspace_id = r.workspace_id and g.id = r.goal_run_id
      where r.workspace_id = $1 and r.revision = 1
        and r.source_procedure_id = any($2::uuid[])`,
    [workspaceId, procedureIds],
  );
  return result.rows;
}

/**
 * Per goal, the set of environments its runs ran in, sorted: the last run of each Task a step's or
 * the goal's verdict judged (each step's current attempt and its nested Tasks — never a replaced
 * attempt or a superseded step), as E2-1 counts a Task. `null` when one of those runs' environment
 * is unknown; absent when none of those Tasks has run yet.
 */
async function readGoalEnvironments(
  client: PoolClient,
  workspaceId: string,
  goalIds: readonly string[],
): Promise<Map<string, readonly string[] | null>> {
  const environments = new Map<string, readonly string[] | null>();
  if (goalIds.length === 0) return environments;
  const tasks = await client.query<{ id: string; goal_run_id: string }>(
    `select id, goal_run_id from tasks
      where workspace_id = $1 and goal_run_id = any($2::uuid[])`,
    [workspaceId, goalIds],
  );
  const judged = await readJudgedStepTasks(
    client,
    workspaceId,
    tasks.rows.map((task) => task.id),
  );
  const goalOf = new Map(tasks.rows.map((task) => [task.id, task.goal_run_id]));
  const lastRuns = await client.query<{ task_id: string; environment_digest: string | null }>(
    `select distinct on (task_id) task_id, environment_digest
       from worker_runs
      where workspace_id = $1 and task_id = any($2::uuid[])
      order by task_id, started_at desc, attempt desc, id desc`,
    [workspaceId, [...judged]],
  );
  const sets = new Map<string, Set<string> | null>();
  for (const run of lastRuns.rows) {
    const goal = goalOf.get(run.task_id);
    if (!goal) continue;
    // `undefined`: nothing seen yet; `null`: a run's environment is unknown, which stays so.
    const seen = sets.get(goal);
    if (seen === null) continue;
    if (run.environment_digest === null) {
      sets.set(goal, null);
      continue;
    }
    const set = seen ?? new Set<string>();
    set.add(run.environment_digest);
    sets.set(goal, set);
  }
  for (const [goal, set] of sets) environments.set(goal, set === null ? null : [...set].sort());
  return environments;
}

/** Per version: the Turns whose entry agent said it followed it, and the requester's outcomes of
 *  those Turns. */
async function readClaims(
  client: PoolClient,
  workspaceId: string,
  procedureId: string,
): Promise<Map<number, ProcedureClaimsWire>> {
  const result = await client.query<{
    version: number;
    turns: number;
    achieved: number;
    not_achieved: number;
    last_claimed_at: Date | null;
  }>(
    `select c.procedure_version as version, count(*)::int as turns,
            (count(*) filter (where o.outcome = 'achieved'))::int as achieved,
            (count(*) filter (where o.outcome = 'not_achieved'))::int as not_achieved,
            max(c.claimed_at) as last_claimed_at
       from turn_procedure_claims c
       left join turn_outcomes o on o.workspace_id = c.workspace_id and o.turn_id = c.turn_id
      where c.workspace_id = $1 and c.procedure_id = $2
      group by c.procedure_version`,
    [workspaceId, procedureId],
  );
  return new Map(
    result.rows.map((row) => [
      row.version,
      {
        turns: row.turns,
        achieved: row.achieved,
        notAchieved: row.not_achieved,
        lastClaimedAt: row.last_claimed_at?.toISOString() ?? null,
      },
    ]),
  );
}

function usageOf(goals: readonly GoalRow[]): ProcedureUsageWire {
  const count = (test: (goal: GoalRow) => boolean) => goals.filter(test).length;
  let lastUsedAt: Date | null = null;
  for (const goal of goals) {
    if (!lastUsedAt || goal.created_at > lastUsedAt) lastUsedAt = goal.created_at;
  }
  return {
    goals: goals.length,
    byStatus: {
      proposed: count((goal) => goal.status === 'proposed'),
      inProgress: count((goal) => IN_PROGRESS.has(goal.status)),
      completed: count((goal) => goal.status === 'completed'),
      cancelled: count((goal) => goal.status === 'cancelled'),
      failed: count((goal) => goal.status === 'failed'),
    },
    lastUsedAt: lastUsedAt?.toISOString() ?? null,
  };
}

/** Each goal's outcome, once: what it rests on and when the goal ended. */
function outcomesOf(goals: readonly GoalRow[]): SubjectOutcome[] {
  const outcomes: SubjectOutcome[] = [];
  for (const goal of goals) {
    if (!goal.outcome || !goal.outcome_basis || !goal.ended_at) continue;
    outcomes.push({ basis: goal.outcome_basis, outcome: goal.outcome, at: goal.ended_at });
  }
  return outcomes;
}

/** Most recently used first. */
function byLastUsedDesc(a: ProcedureStatsSegmentWire, b: ProcedureStatsSegmentWire): number {
  const at = (segment: ProcedureStatsSegmentWire) =>
    segment.usage.lastUsedAt === null ? 0 : Date.parse(segment.usage.lastUsedAt);
  return at(b) - at(a);
}

/** A goal that ended without being achieved: the requester ended it not achieved, cancelled it
 *  after confirming it, or it failed. */
function endedUnachieved(goal: GoalRow): boolean {
  return (
    (goal.status === 'completed' && goal.outcome === 'not_achieved') ||
    (goal.status === 'cancelled' && goal.confirmed_at !== null) ||
    goal.status === 'failed'
  );
}

const isStepFailureCategory = (value: string | null): value is StepRunFailureCategory =>
  value !== null && (STEP_RUN_FAILURE_CATEGORY_VALUES as readonly string[]).includes(value);

/**
 * The goals that ended without being achieved, by version × where they went wrong × the step × its
 * failure category (S10 §5.4 "确定性失败分组"; E2-2 fork 3 = a), largest groups first:
 *   - every step that failed: one still `failed` (its row says how), or one cancelled with its goal
 *     while failed — a cancel clears the row's category, so it is read from the step's transition
 *     records: retry is the only way out of `failed` and a step fails only while running, so a
 *     step with one more `step_run.fail` than `step_run.retry` was failed when cancelled, by its
 *     latest failure's category. A step the Procedure made (revision 1's) is named by its key; a
 *     step a later revision added is not (its key is the requester's text);
 *   - no failed step: the goal's latest acceptance round had a check that failed or could not be
 *     evaluated — `acceptance_check`;
 *   - nothing failed: `requester`.
 * A goal with several failed steps is counted in each of their groups, once per group.
 */
async function readFailureGroups(
  client: PoolClient,
  workspaceId: string,
  goals: readonly GoalRow[],
): Promise<ProcedureFailureGroupWire[]> {
  const ended = goals.filter(endedUnachieved);
  if (ended.length === 0) return [];
  const goalIds = ended.map((goal) => goal.id);

  const steps = await client.query<{
    id: string;
    goal_run_id: string;
    step_key: string;
    introduced_in_revision: number;
    status: 'failed' | 'cancelled';
    failure_category: string | null;
  }>(
    `select id, goal_run_id, step_key, introduced_in_revision, status, failure_category
       from step_runs
      where workspace_id = $1 and goal_run_id = any($2::uuid[])
        and status in ('failed', 'cancelled')`,
    [workspaceId, goalIds],
  );
  const cancelled = steps.rows.filter((step) => step.status === 'cancelled').map((step) => step.id);
  const failedWhenCancelled = new Map<string, string | null>();
  if (cancelled.length > 0) {
    const records = await client.query<{
      step_run_id: string;
      fails: number;
      retries: number;
      failure_category: string | null;
    }>(
      `select resource_id as step_run_id,
              (count(*) filter (where action = 'step_run.fail'))::int as fails,
              (count(*) filter (where action = 'step_run.retry'))::int as retries,
              (array_agg(payload ->> 'failureCategory' order by created_at desc)
                 filter (where action = 'step_run.fail'))[1] as failure_category
         from audit_records
        where workspace_id = $1 and resource_id = any($2::uuid[]) and resource_type = 'step_run'
          and action in ('step_run.fail', 'step_run.retry')
        group by resource_id`,
      [workspaceId, cancelled],
    );
    for (const row of records.rows) {
      if (row.fails > row.retries) failedWhenCancelled.set(row.step_run_id, row.failure_category);
    }
  }

  const failedSteps = new Map<
    string,
    { readonly key: string | null; readonly category: StepRunFailureCategory }[]
  >();
  for (const step of steps.rows) {
    const category =
      step.status === 'failed' ? step.failure_category : failedWhenCancelled.get(step.id);
    if (category === undefined || !isStepFailureCategory(category)) continue;
    const list = failedSteps.get(step.goal_run_id) ?? [];
    list.push({ key: step.introduced_in_revision === 1 ? step.step_key : null, category });
    failedSteps.set(step.goal_run_id, list);
  }

  const acceptance = await client.query<{ goal_run_id: string }>(
    `select distinct c.goal_run_id
       from goal_acceptance_checks c
      where c.workspace_id = $1 and c.goal_run_id = any($2::uuid[])
        and c.status in ('failed', 'unavailable')
        and c.round = (select max(m.round) from goal_acceptance_checks m
                        where m.workspace_id = c.workspace_id and m.goal_run_id = c.goal_run_id)`,
    [workspaceId, goalIds],
  );
  const acceptanceUnmet = new Set(acceptance.rows.map((row) => row.goal_run_id));

  const groups = new Map<string, { group: ProcedureFailureGroupWire; goals: Set<string> }>();
  const add = (
    goal: GoalRow,
    place: ProcedureFailurePlace,
    stepKey: string | null,
    category: StepRunFailureCategory | null,
  ) => {
    const key = JSON.stringify([goal.version, place, stepKey, category]);
    const endedAt = goal.ended_at?.toISOString() ?? null;
    const entry = groups.get(key) ?? {
      group: {
        procedureVersion: goal.version,
        place,
        stepKey,
        category,
        goals: 0,
        lastEndedAt: null,
      },
      goals: new Set<string>(),
    };
    if (entry.goals.has(goal.id)) return;
    entry.goals.add(goal.id);
    const last = entry.group.lastEndedAt;
    entry.group = {
      ...entry.group,
      goals: entry.goals.size,
      lastEndedAt: endedAt !== null && (last === null || endedAt > last) ? endedAt : last,
    };
    groups.set(key, entry);
  };
  for (const goal of ended) {
    const failed = failedSteps.get(goal.id) ?? [];
    for (const step of failed) {
      add(goal, step.key === null ? 'revised_step' : 'procedure_step', step.key, step.category);
    }
    if (failed.length > 0) continue;
    add(goal, acceptanceUnmet.has(goal.id) ? 'acceptance_check' : 'requester', null, null);
  }
  return [...groups.values()]
    .map((entry) => entry.group)
    .sort(
      (a, b) =>
        b.goals - a.goals ||
        (b.lastEndedAt === null ? 0 : Date.parse(b.lastEndedAt)) -
          (a.lastEndedAt === null ? 0 : Date.parse(a.lastEndedAt)),
    );
}
