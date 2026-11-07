import {
  type EntryGoalPrecedentWire,
  GOAL_PRECEDENT_WINDOW_DAYS,
  type GoalOutcomeBasis,
  type GoalPlan,
  GoalPlanSchema,
  type GoalPrecedentMatch,
  type GoalPrecedentWire,
  type ObjectiveOutcome,
  goalPrecedentPolarity,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { shownFreeText } from '../../governance/redaction/index.js';
import { listAcceptanceChecks } from './acceptance-checks.js';
import { readOverriddenChecks } from './acceptance.js';
import { planAsRead } from './plan.js';
import { getGoalRun, getPlanRevision, listStepRuns } from './reads.js';

/**
 * application/goal/precedents (S11 GO17; `@nexttime/shared` `goal-precedents.ts` has the rules):
 * a requester's earlier goals of the same kind, read for whoever writes the next plan — the
 * entry agent (`find_goal_precedents`, and the entry context's references) and the goal planner
 * (its input). Read, never stored; nothing here authorizes anything.
 *
 * Whose goals: only `on_behalf_of = requester` — never `goalVisibleTo`'s owner view: an owner's
 * agent does not get other people's plans (F2 A). A reader is told the requester; this module
 * never widens it. Text is shown as every goal read shows it (`shownFreeText`, `planAsRead`).
 */

export interface PrecedentFilter {
  /** Goals whose revision 1 was made from this Procedure (any version). */
  readonly procedureId?: string;
  /** Goals whose plan in force at their end has a step run by a Worker of one of these families. */
  readonly workerDefinitionIds?: readonly string[];
  /** The goal being planned — never its own precedent. */
  readonly excludeGoalRunId?: string;
}

interface CandidateRow {
  id: string;
  rank: number;
}

/** The ids of the requester's precedents under `filter`, best first — see the shared module. */
async function precedentCandidates(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  filter: PrecedentFilter,
  limit: number,
  now: Date,
): Promise<readonly { readonly id: string; readonly match: GoalPrecedentMatch }[]> {
  const procedureId = filter.procedureId ?? null;
  const workers =
    filter.workerDefinitionIds && filter.workerDefinitionIds.length > 0
      ? [...new Set(filter.workerDefinitionIds.map((id) => id.toLowerCase()))]
      : null;
  const since = new Date(now.getTime() - GOAL_PRECEDENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // rank 0: made from the Procedure; 1: a step of the plan at the end ran one of the Workers;
  // 2: neither — listed only when nothing was asked for (`recent`).
  const result = await client.query<CandidateRow>(
    `select id, rank from (
       select g.id, g.ended_at,
              case
                when $3::uuid is not null and first.source_procedure_id = $3::uuid then 0
                when $4::text[] is not null and exists (
                       select 1 from jsonb_array_elements(last.plan -> 'steps') step
                        where lower(step -> 'worker' ->> 'definitionId') = any($4::text[])) then 1
                else 2
              end as rank
         from goal_runs g
         join plan_revisions first
           on first.workspace_id = g.workspace_id and first.goal_run_id = g.id
          and first.revision = 1
         join plan_revisions last
           on last.workspace_id = g.workspace_id and last.goal_run_id = g.id
          and last.revision = coalesce(g.current_revision, 1)
        where g.workspace_id = $1 and g.on_behalf_of = $2
          and g.status = 'completed' and g.outcome is not null and g.outcome_basis is not null
          and g.ended_at is not null and g.ended_at >= $5
          and ($6::uuid is null or g.id <> $6::uuid)
     ) c
     where $7::boolean or rank < 2
     order by rank, ended_at desc, id
     limit $8`,
    [
      workspaceId,
      requesterId,
      procedureId,
      workers,
      since,
      filter.excludeGoalRunId ?? null,
      procedureId === null && workers === null,
      limit,
    ],
  );
  return result.rows.map((row) => ({
    id: row.id,
    match: row.rank === 0 ? 'procedure' : row.rank === 1 ? 'worker' : 'recent',
  }));
}

/** The requester's precedents under `filter`, as records — at most `limit`, best first. */
export async function findGoalPrecedents(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  filter: PrecedentFilter,
  limit: number,
  now: Date = new Date(),
): Promise<readonly GoalPrecedentWire[]> {
  const candidates = await precedentCandidates(
    client,
    workspaceId,
    requesterId,
    filter,
    limit,
    now,
  );
  const records: GoalPrecedentWire[] = [];
  for (const candidate of candidates) {
    const record = await precedentRecord(client, workspaceId, candidate.id, candidate.match);
    if (record) records.push(record);
  }
  return records;
}

/** One precedent's record — `null` when the goal is gone or did not end with an outcome. */
async function precedentRecord(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  match: GoalPrecedentMatch,
): Promise<GoalPrecedentWire | null> {
  const goal = await getGoalRun(client, workspaceId, goalRunId);
  if (!goal?.outcome || !goal.outcomeBasis || !goal.endedAt) return null;
  const revision = goal.currentRevision ?? 1;
  const inForce = await getPlanRevision(client, workspaceId, goal.id, revision);
  const first = revision === 1 ? inForce : await getPlanRevision(client, workspaceId, goal.id, 1);
  if (!inForce || !first) return null;
  // Stored only after these same checks; a row that no longer parses is not shown as a precedent.
  const plan = GoalPlanSchema.safeParse(inForce.plan);
  if (!plan.success) return null;
  const accepted = await client.query<{ accepted: number }>(
    `select count(*) filter (where status = 'accepted')::int as accepted
       from plan_revisions where workspace_id = $1 and goal_run_id = $2`,
    [workspaceId, goal.id],
  );
  const steps = (await listStepRuns(client, workspaceId, goal.id)).filter(
    (step) => step.status !== 'superseded',
  );
  const checks = await listAcceptanceChecks(client, workspaceId, goal.id);
  const lastRound = checks.reduce((max, check) => Math.max(max, check.round), 0);
  const overriddenChecks = await readOverriddenChecks(client, workspaceId, goal);
  const source = first.sourceProcedure;
  return {
    goalRunId: goal.id,
    match,
    polarity: goalPrecedentPolarity(goal.outcome, goal.outcomeBasis, overriddenChecks.length),
    statement: shownFreeText(goal.statement),
    outcome: goal.outcome,
    outcomeBasis: goal.outcomeBasis,
    endedAt: goal.endedAt.toISOString(),
    fromProcedure: source ? { procedureId: source.procedureId, version: source.version } : null,
    revision,
    // Revision 1 is the confirmed plan; each accepted one after it counts (`views.ts`).
    revisions: Math.max((accepted.rows[0]?.accepted ?? 0) - 1, 0),
    plan: planAsRead(plan.data),
    steps: steps.map((step) => ({
      key: step.stepKey,
      status: step.status,
      attempts: step.attemptCount,
      failureCategory: step.failureCategory,
    })),
    acceptance:
      lastRound === 0
        ? null
        : {
            round: lastRound,
            checks: checks
              .filter((check) => check.round === lastRound)
              .map((check) => ({
                checkKey: check.checkKey,
                kind: check.kind,
                status: check.status,
                observationId: check.observationId,
                factId: check.factId,
                lastError: check.lastError,
              })),
          },
    overriddenChecks: overriddenChecks.map((check) => ({ ...check })),
  };
}

interface RecentRow {
  id: string;
  statement: string;
  outcome: ObjectiveOutcome;
  outcome_basis: GoalOutcomeBasis;
  ended_at: Date;
  source_procedure_id: string | null;
  source_procedure_version: number | null;
  overridden: number;
}

/**
 * The requester's most recently ended goals as the entry context lists them — one query, since
 * the entry runtime reads its context before every model call. References only: the record is
 * {@link findGoalPrecedents}'.
 */
export async function readRecentGoalPrecedents(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  limit: number,
  now: Date = new Date(),
): Promise<readonly EntryGoalPrecedentWire[]> {
  const since = new Date(now.getTime() - GOAL_PRECEDENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const result = await client.query<RecentRow>(
    `select g.id, g.statement, g.outcome, g.outcome_basis, g.ended_at,
            first.source_procedure_id, first.source_procedure_version,
            case when jsonb_typeof(d.rationale -> 'overriddenChecks') = 'array'
                 then jsonb_array_length(d.rationale -> 'overriddenChecks') else 0 end as overridden
       from goal_runs g
       join plan_revisions first
         on first.workspace_id = g.workspace_id and first.goal_run_id = g.id and first.revision = 1
       left join decisions d
         on g.outcome = 'achieved' and d.workspace_id = g.workspace_id and d.id = g.outcome_decision_id
      where g.workspace_id = $1 and g.on_behalf_of = $2
        and g.status = 'completed' and g.outcome is not null and g.outcome_basis is not null
        and g.ended_at is not null and g.ended_at >= $3
      order by g.ended_at desc, g.id
      limit $4`,
    [workspaceId, requesterId, since, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    statement: shownFreeText(row.statement),
    outcome: row.outcome,
    outcomeBasis: row.outcome_basis,
    polarity: goalPrecedentPolarity(row.outcome, row.outcome_basis, row.overridden),
    endedAt: row.ended_at.toISOString(),
    fromProcedure:
      row.source_procedure_id !== null && row.source_procedure_version !== null
        ? { procedureId: row.source_procedure_id, version: row.source_procedure_version }
        : null,
  }));
}

/**
 * The precedents of a goal being planned (the goal planner's input): the requester's goals made
 * from the same Procedure as this one's revision 1, then those sharing a Worker family with
 * `plan` — never the goal itself.
 */
export async function precedentsOfGoal(
  client: PoolClient,
  workspaceId: string,
  goal: { readonly id: string; readonly onBehalfOf: string },
  plan: GoalPlan,
  limit: number,
  now: Date = new Date(),
): Promise<readonly GoalPrecedentWire[]> {
  const first = await getPlanRevision(client, workspaceId, goal.id, 1);
  return findGoalPrecedents(
    client,
    workspaceId,
    goal.onBehalfOf,
    {
      ...(first?.sourceProcedure ? { procedureId: first.sourceProcedure.procedureId } : {}),
      workerDefinitionIds: plan.steps.map((step) => step.worker.definitionId),
      excludeGoalRunId: goal.id,
    },
    limit,
    now,
  );
}
