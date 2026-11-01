import {
  OUTCOME_BASIS_VALUES,
  type ObjectiveOutcome,
  type OutcomeBasis,
  type OutcomeTallyWire,
  tallyOutcomesByBasis,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * application/task/stats-read (S11 W1a E2-1, E2-2): what `get_skill_stats` (`skill-stats.ts`) and
 * `get_procedure_stats` (`procedure-stats.ts`) read the same way — an outcome subject's record, the
 * tally as sent, and which goal step Tasks a step's or goal's verdict judged.
 */

/** One outcome subject's record: whose judgement (`basis`), what, and when it was given. */
export interface SubjectOutcome {
  readonly basis: OutcomeBasis;
  readonly outcome: ObjectiveOutcome;
  readonly at: Date;
}

/** `tallyOutcomesByBasis`, as sent: `byBasis` an array in `OUTCOME_BASIS_VALUES` order. */
export function outcomeTallyWire(subjects: Iterable<SubjectOutcome>): OutcomeTallyWire {
  const tally = tallyOutcomesByBasis(subjects);
  return {
    primary: tally.primary,
    proxy: tally.proxy,
    byBasis: OUTCOME_BASIS_VALUES.map((basis) => ({ basis, ...tally.byBasis[basis] })),
  };
}

/**
 * Of `stepTaskIds` (goal step Tasks), those a step's or goal's verdict judged: the Tasks of the
 * step's current attempt (`step_attempt = attempt_count`, the goal module's own test for it), the
 * attempt's nested Tasks included — a nested Task carries the step's `step_run_id` but no
 * `step_attempt`, so its attempt is its ancestor's, found up the WorkerRun tree — and not of a
 * superseded step (review #493 on #781, N1).
 */
export async function readJudgedStepTasks(
  client: PoolClient,
  workspaceId: string,
  stepTaskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (stepTaskIds.length === 0) return new Set();
  const result = await client.query<{ task_id: string }>(
    `with recursive up as (
       select t.id as task_id, t.id as at_task, t.step_attempt, 0 as depth
         from tasks t
        where t.workspace_id = $1 and t.id = any($2::uuid[])
       union
       select up.task_id, p.task_id, pt.step_attempt, up.depth + 1
         from up
         join worker_runs r on r.workspace_id = $1 and r.task_id = up.at_task
         join worker_runs p on p.workspace_id = $1 and p.id = r.parent_worker_run_id
         join tasks pt on pt.workspace_id = $1 and pt.id = p.task_id
        where up.step_attempt is null and up.depth < 4
     )
     select distinct up.task_id
       from up
       join tasks t on t.workspace_id = $1 and t.id = up.task_id
       join step_runs s on s.workspace_id = $1 and s.id = t.step_run_id
      where up.step_attempt = s.attempt_count and s.status <> 'superseded'`,
    [workspaceId, stepTaskIds],
  );
  return new Set(result.rows.map((row) => row.task_id));
}

export function unique(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** What {@link readSubjectOutcomes} reads of a Task: its id and where its outcomes are. */
export interface SubjectTaskRow {
  readonly id: string;
  readonly created_by_activity_id: string | null;
  readonly goal_run_id: string | null;
  readonly step_run_id: string | null;
  readonly objective_outcome: ObjectiveOutcome | null;
  readonly outcome_given_at: Date | null;
}

/**
 * Per Task, the outcome subjects that cover it and have an outcome on record:
 *   - its Turn (`created_by_activity_id`, nested Tasks inherit it): the requester's mark;
 *   - the Task itself: the delegating agent's report;
 *   - a goal step's Task (`step_run_id`, the attempt's and its nested Tasks): the step's
 *     acceptance when the step declares checks — succeeded is achieved, failed
 *     `verification_failed` not achieved, by `verified_by_check` — otherwise the GoalRun's outcome.
 *     Only the step's current attempt is judged by either (review #493 on #781, N1): an earlier
 *     attempt's Tasks, and a superseded step's, were replaced before the verdict, so a Skill version
 *     that failed one attempt does not take the credit of the version that passed the next.
 * An outcome not on record is unknown and counts nowhere.
 */
export async function readSubjectOutcomes(
  client: PoolClient,
  workspaceId: string,
  tasks: readonly SubjectTaskRow[],
): Promise<Map<string, Map<string, SubjectOutcome>>> {
  const judged = await readJudgedStepTasks(
    client,
    workspaceId,
    tasks.filter((task) => task.step_run_id !== null).map((task) => task.id),
  );
  const turnIds = unique(tasks.map((task) => task.created_by_activity_id));
  const stepIds = unique(tasks.map((task) => task.step_run_id));
  const goalIds = unique(tasks.map((task) => task.goal_run_id));

  const turns = new Map<string, SubjectOutcome>();
  if (turnIds.length > 0) {
    const result = await client.query<{
      turn_id: string;
      outcome: ObjectiveOutcome;
      given_at: Date;
    }>(
      `select turn_id, outcome, given_at from turn_outcomes
        where workspace_id = $1 and turn_id = any($2::uuid[])`,
      [workspaceId, turnIds],
    );
    for (const row of result.rows) {
      turns.set(row.turn_id, { basis: 'requester', outcome: row.outcome, at: row.given_at });
    }
  }

  // A step that declares acceptance checks: its own outcome, or none yet (`null`). A step that
  // declares none is absent, and its Tasks take the goal's.
  const steps = new Map<string, SubjectOutcome | null>();
  if (stepIds.length > 0) {
    const result = await client.query<{
      id: string;
      status: string;
      failure_category: string | null;
      ended_at: Date | null;
      updated_at: Date;
    }>(
      `select s.id, s.status, s.failure_category, s.ended_at, s.updated_at
         from step_runs s
        where s.workspace_id = $1 and s.id = any($2::uuid[])
          and step_declared_acceptance(s.workspace_id, s.goal_run_id,
                                       s.introduced_in_revision, s.step_key) is not null`,
      [workspaceId, stepIds],
    );
    for (const row of result.rows) {
      if (row.status === 'succeeded') {
        steps.set(row.id, {
          basis: 'verified_by_check',
          outcome: 'achieved',
          at: row.ended_at ?? row.updated_at,
        });
      } else if (row.status === 'failed' && row.failure_category === 'verification_failed') {
        steps.set(row.id, {
          basis: 'verified_by_check',
          outcome: 'not_achieved',
          at: row.updated_at,
        });
      } else {
        steps.set(row.id, null);
      }
    }
  }

  const goals = new Map<string, SubjectOutcome>();
  if (goalIds.length > 0) {
    const result = await client.query<{
      id: string;
      outcome: ObjectiveOutcome;
      outcome_basis: OutcomeBasis;
      ended_at: Date;
    }>(
      `select id, outcome, outcome_basis, ended_at from goal_runs
        where workspace_id = $1 and id = any($2::uuid[]) and outcome is not null`,
      [workspaceId, goalIds],
    );
    for (const row of result.rows) {
      goals.set(row.id, { basis: row.outcome_basis, outcome: row.outcome, at: row.ended_at });
    }
  }

  const byTask = new Map<string, Map<string, SubjectOutcome>>();
  for (const task of tasks) {
    const subjects = new Map<string, SubjectOutcome>();
    const turn = task.created_by_activity_id ? turns.get(task.created_by_activity_id) : undefined;
    if (turn) subjects.set(`turn:${task.created_by_activity_id}`, turn);
    if (task.objective_outcome && task.outcome_given_at) {
      subjects.set(`task:${task.id}`, {
        basis: 'agent_reported',
        outcome: task.objective_outcome,
        at: task.outcome_given_at,
      });
    }
    if (task.step_run_id && judged.has(task.id)) {
      if (steps.has(task.step_run_id)) {
        const step = steps.get(task.step_run_id);
        if (step) subjects.set(`step:${task.step_run_id}`, step);
      } else if (task.goal_run_id) {
        const goal = goals.get(task.goal_run_id);
        if (goal) subjects.set(`goal:${task.goal_run_id}`, goal);
      }
    }
    byTask.set(task.id, subjects);
  }
  return byTask;
}
