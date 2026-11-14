import {
  type GoalOutcomeBasis,
  type GoalPrecedentPolarity,
  type ObjectiveOutcome,
  goalPrecedentPolarity,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { shownFreeText } from '../../governance/redaction/index.js';

/**
 * application/goal/cited-precedents (S11 GO17b, F4 A; `@nexttime/shared` `goal-precedents.ts`):
 * the precedents a revision's plan was written from — named by its writer (`propose_goal`'s
 * `precedents`, a goal planner's report), checked here before the write
 * ({@link citedPrecedentProblems}), stored on the revision (`plan_revisions.cited_precedents`,
 * migration goal/0018, which holds the same rule) and read back with every read of a revision
 * ({@link readCitedPrecedents}). A citation authorizes nothing: the plan is checked like any other.
 *
 * Apart from `precedents.ts` (which reads whole records and imports `acceptance.ts`): the write
 * path of `service.ts` uses this, and `acceptance.ts` imports `service.ts`.
 */

/** Where the precedents a plan cites are given, and what the round of a goal planner offered. */
export interface CitedPrecedentsCheck {
  /** The place the ids were given at — `precedents` (`propose_goal`), `output.precedents` (a
   *  planner's report); each problem names `<at>.<i>`. */
  readonly at: string;
  /** The goal citing them, once it exists (a planner's) — never one of them. */
  readonly goalRunId?: string;
  /** A goal planner's round: the precedents its input gave it — the only ones it may cite. */
  readonly offered?: ReadonlySet<string>;
}

/** One cited id that does not pass, at `<at>.<i>`. */
export interface CitedPrecedentProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * What is wrong with `ids` as the precedents a plan of `requesterId`'s goal cites, one problem per
 * id at `<at>.<i>` — none when each is a completed goal of theirs, cited once (and, for a planner,
 * one its input gave it). Migration goal/0018 holds the same at the insert
 * (`plan_revisions_cited_precedents`); this answers first, with the place, nothing written. A goal
 * someone else requested reads exactly like an unknown id.
 */
export async function citedPrecedentProblems(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  ids: readonly string[],
  check: CitedPrecedentsCheck,
): Promise<readonly CitedPrecedentProblem[]> {
  if (ids.length === 0) return [];
  const own = await client.query<{ id: string }>(
    `select id from goal_runs
      where workspace_id = $1 and id = any($2::uuid[]) and on_behalf_of = $3
        and status = 'completed'`,
    [workspaceId, [...new Set(ids)], requesterId],
  );
  const completed = new Set(own.rows.map((row) => row.id));
  const seen = new Set<string>();
  const problems: CitedPrecedentProblem[] = [];
  ids.forEach((id, index) => {
    const path = `${check.at}.${index}`;
    const refuse = (message: string) => problems.push({ path, message });
    if (seen.has(id)) refuse(`${id} is cited a second time — cite each goal once`);
    else if (id === check.goalRunId) refuse('a goal is never its own precedent');
    else if (check.offered && !check.offered.has(id)) {
      refuse(`${id} is not one of the precedents your input gives`);
    } else if (!completed.has(id)) {
      refuse(`${id} is not a completed goal of the requester — find_goal_precedents lists theirs`);
    }
    seen.add(id);
  });
  return problems;
}

/** A precedent a revision cites, as a read of the revision shows it — see `CitedGoalPrecedentWire`. */
export interface CitedPrecedentView {
  readonly goalRunId: string;
  readonly statement: string;
  readonly outcome: ObjectiveOutcome;
  readonly outcomeBasis: GoalOutcomeBasis;
  readonly polarity: GoalPrecedentPolarity;
}

interface CitedRow {
  id: string;
  statement: string;
  outcome: ObjectiveOutcome;
  outcome_basis: GoalOutcomeBasis;
  overridden: number;
  platform_checks_passed: boolean;
}

/**
 * S11 GO18 (independent review N2; `goalPrecedentPolarity`'s `platformChecksPassed`): whether the
 * last verification round of GoalRun `g` (a `goal_runs` alias) passed whole with at least one
 * check the platform makes in it — whatever a review or the requester's confirmation added on top.
 */
export function platformChecksPassedSql(g: string): string {
  return `coalesce((select bool_and(c.status = 'passed')
                           and bool_or(c.kind in ('observe_predicate', 'observe_absent',
                                                  'fact_predicate'))
                      from goal_acceptance_checks c
                     where c.workspace_id = ${g}.workspace_id and c.goal_run_id = ${g}.id
                       and c.round = (select max(r.round) from goal_acceptance_checks r
                                       where r.workspace_id = ${g}.workspace_id
                                         and r.goal_run_id = ${g}.id)), false)`;
}

/**
 * The goals `ids` name, as a revision citing them shows them — one query for every revision a read
 * holds. Each was a completed goal of the citing goal's requester when cited (goal/0018), and
 * `completed` is final: a missing one breaks that, and the read says so rather than show less.
 */
export async function readCitedPrecedents(
  client: PoolClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, CitedPrecedentView>> {
  if (ids.length === 0) return new Map();
  const wanted = [...new Set(ids)];
  const result = await client.query<CitedRow>(
    `select g.id, g.statement, g.outcome, g.outcome_basis,
            case when jsonb_typeof(d.rationale -> 'overriddenChecks') = 'array'
                 then jsonb_array_length(d.rationale -> 'overriddenChecks') else 0 end as overridden,
            ${platformChecksPassedSql('g')} as platform_checks_passed
       from goal_runs g
       left join decisions d
         on g.outcome = 'achieved' and d.workspace_id = g.workspace_id and d.id = g.outcome_decision_id
      where g.workspace_id = $1 and g.id = any($2::uuid[])
        and g.status = 'completed' and g.outcome is not null and g.outcome_basis is not null`,
    [workspaceId, wanted],
  );
  const views = new Map(
    result.rows.map((row) => [
      row.id,
      {
        goalRunId: row.id,
        statement: shownFreeText(row.statement),
        outcome: row.outcome,
        outcomeBasis: row.outcome_basis,
        polarity: goalPrecedentPolarity(
          row.outcome,
          row.outcome_basis,
          row.overridden,
          row.platform_checks_passed,
        ),
      } satisfies CitedPrecedentView,
    ]),
  );
  const missing = wanted.find((id) => !views.has(id));
  if (missing !== undefined) {
    throw new Error(`cited precedent ${missing} is not a completed goal (goal/0018 held it was)`);
  }
  return views;
}
