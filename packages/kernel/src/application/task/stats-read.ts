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
