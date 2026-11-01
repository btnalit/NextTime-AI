import type {
  GoalPlannerMode,
  PlanningFailureCategory,
  PlanningRoundOutcomeReason,
  PlanningRoundStatus,
  TaskStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { findGoalPlannerPrincipal } from '../task/index.js';

/**
 * application/goal/planning-rounds (S11 GO9a; plan §4.1, §4.3, I-P1, I-P4; migrations/goal/0014):
 * the rows of a GoalRun's planning — the requester's leave (`goal_planner_delegations`), its rounds
 * (`goal_planning_rounds`) and the revisions the planner proposed — and the one rule every person's
 * action on a paused run applies to them: {@link closePlanning}. What opens and settles a round is
 * the advancer's (`planner.ts`, phase P of `advance.ts`).
 *
 * A round belongs to one pause (I-P4): once the run leaves it — resumed, cancelled, held by a
 * workspace owner — or its plan is revised, a round still running is `abandoned` (its Task is
 * terminated by the next advance, or by the cancelling run's), and a revision the planner proposed
 * that nobody decided is `rejected` on the person's behalf: it was made for a plan and a pause that
 * are no more. Accepting the planner's revision is such an action too, for every other round.
 */

/** A round as the advancer and the reads use it, with its Task when it has one. */
export interface PlanningRoundRow {
  readonly id: string;
  readonly goalRunId: string;
  readonly basedOnRevision: number;
  readonly stepRunId: string;
  readonly stepKey: string;
  readonly stepAttempt: number;
  readonly failureCategory: PlanningFailureCategory;
  readonly status: PlanningRoundStatus;
  readonly revision: number | null;
  readonly outcomeReason: PlanningRoundOutcomeReason | null;
  readonly detail: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
  readonly task: {
    readonly id: string;
    readonly status: TaskStatus;
    readonly failureReason: string | null;
    readonly result: unknown;
  } | null;
}

interface PlanningRoundDbRow {
  id: string;
  goal_run_id: string;
  based_on_revision: number;
  step_run_id: string;
  step_key: string;
  step_attempt: number;
  failure_category: PlanningFailureCategory;
  status: PlanningRoundStatus;
  revision: number | null;
  outcome_reason: PlanningRoundOutcomeReason | null;
  detail: string | null;
  created_at: Date;
  settled_at: Date | null;
  task_id: string | null;
  task_status: TaskStatus | null;
  task_failure_reason: string | null;
  task_result: unknown;
}

const ROUND_SELECT = `select pr.id, pr.goal_run_id, pr.based_on_revision, pr.step_run_id, s.step_key,
       pr.step_attempt, pr.failure_category, pr.status, pr.revision, pr.outcome_reason, pr.detail,
       pr.created_at, pr.settled_at, t.id as task_id, t.status as task_status,
       t.failure_reason as task_failure_reason, t.result as task_result
  from goal_planning_rounds pr
  join step_runs s on s.workspace_id = pr.workspace_id and s.id = pr.step_run_id
  left join tasks t on t.workspace_id = pr.workspace_id and t.planning_round_id = pr.id`;

function mapRound(row: PlanningRoundDbRow): PlanningRoundRow {
  return {
    id: row.id,
    goalRunId: row.goal_run_id,
    basedOnRevision: row.based_on_revision,
    stepRunId: row.step_run_id,
    stepKey: row.step_key,
    stepAttempt: row.step_attempt,
    failureCategory: row.failure_category,
    status: row.status,
    revision: row.revision,
    outcomeReason: row.outcome_reason,
    detail: row.detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    task:
      row.task_id !== null && row.task_status !== null
        ? {
            id: row.task_id,
            status: row.task_status,
            failureReason: row.task_failure_reason,
            result: row.task_result,
          }
        : null,
  };
}

/** Every round of a GoalRun, oldest first. */
export async function listPlanningRounds(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<readonly PlanningRoundRow[]> {
  const result = await client.query<PlanningRoundDbRow>(
    `${ROUND_SELECT}
      where pr.workspace_id = $1 and pr.goal_run_id = $2
      order by pr.created_at, pr.id`,
    [workspaceId, goalRunId],
  );
  return result.rows.map(mapRound);
}

/** The leave the requester gave the planner when they confirmed the run, or `null`. */
export async function readGoalPlannerMode(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
): Promise<GoalPlannerMode | null> {
  const result = await client.query<{ mode: GoalPlannerMode }>(
    'select mode from goal_planner_delegations where workspace_id = $1 and goal_run_id = $2',
    [workspaceId, goalRunId],
  );
  return result.rows[0]?.mode ?? null;
}

/** The planner leave of several runs (a page of `list_goals`): the runs that have one. */
export async function readGoalPlannerModes(
  client: PoolClient,
  workspaceId: string,
  goalRunIds: readonly string[],
): Promise<ReadonlyMap<string, GoalPlannerMode>> {
  if (goalRunIds.length === 0) return new Map();
  const result = await client.query<{ goal_run_id: string; mode: GoalPlannerMode }>(
    `select goal_run_id, mode from goal_planner_delegations
      where workspace_id = $1 and goal_run_id = any($2::uuid[])`,
    [workspaceId, [...goalRunIds]],
  );
  return new Map(result.rows.map((row) => [row.goal_run_id, row.mode]));
}

/**
 * `confirm_goal`'s `planner`: the requester lets the planner propose revisions of this run when one
 * of its steps fails for them. Written in the confirming transaction, before the run leaves
 * `proposed` (the table's guard), once.
 */
export async function grantGoalPlanner(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  requesterId: string,
  mode: GoalPlannerMode,
): Promise<void> {
  await client.query(
    `insert into goal_planner_delegations (workspace_id, goal_run_id, mode, granted_by)
     values ($1, $2, $4, $3)
     on conflict (workspace_id, goal_run_id) do nothing`,
    [workspaceId, goalRunId, requesterId, mode],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: requesterId,
    action: 'goal_run.planner_granted',
    resourceType: 'goal_run',
    resourceId: goalRunId,
    payload: { mode },
  });
}

/** Who settled a round, for its audit row: a person's action or the advancer. */
export interface PlanningActor {
  readonly principalId: string;
  readonly by: 'person' | 'advancer';
}

/** Settles a running round (the database refuses settling one that is not), with its audit row. */
export async function settlePlanningRound(
  client: PoolClient,
  workspaceId: string,
  actor: PlanningActor,
  round: Pick<PlanningRoundRow, 'id' | 'goalRunId'>,
  outcome:
    | { readonly status: 'proposed'; readonly revision: number }
    | { readonly status: 'no_revision'; readonly detail: string }
    | {
        readonly status: 'failed' | 'abandoned';
        readonly reason: PlanningRoundOutcomeReason;
        readonly detail?: string;
      },
): Promise<void> {
  const reason = 'reason' in outcome ? outcome.reason : null;
  const detail = 'detail' in outcome && outcome.detail !== undefined ? outcome.detail : null;
  await client.query(
    `update goal_planning_rounds
        set status = $3, revision = $4, outcome_reason = $5, detail = $6, settled_at = now()
      where workspace_id = $1 and id = $2 and status = 'running'`,
    [
      workspaceId,
      round.id,
      outcome.status,
      outcome.status === 'proposed' ? outcome.revision : null,
      reason,
      detail === null ? null : boundDetail(detail),
    ],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: actor.principalId,
    action: 'goal_planning_round.settle',
    resourceType: 'goal_run',
    resourceId: round.goalRunId,
    payload: {
      by: actor.by,
      planningRoundId: round.id,
      status: outcome.status,
      ...(outcome.status === 'proposed' ? { revision: outcome.revision } : {}),
      ...(reason !== null ? { reason } : {}),
    },
  });
}

/** The longest `detail` a round keeps (goal/0014's CHECK). */
export const MAX_PLANNING_DETAIL_CHARS = 2000;

/** `detail` cut to {@link MAX_PLANNING_DETAIL_CHARS} characters, an ellipsis marking the cut. */
export function boundDetail(detail: string): string {
  const chars = [...detail];
  return chars.length <= MAX_PLANNING_DETAIL_CHARS
    ? detail
    : `${chars.slice(0, MAX_PLANNING_DETAIL_CHARS - 1).join('')}…`;
}

export type ClosePlanningReason = Extract<
  PlanningRoundOutcomeReason,
  'run_left_pause' | 'plan_revised'
>;

export interface ClosedPlanning {
  readonly abandonedRoundIds: readonly string[];
  readonly rejectedRevisions: readonly number[];
}

/**
 * A person's action on the run ends its planning — see the module comment. In the caller's
 * transaction, after its GoalRun lock. `keepRevision`: the planner's revision the action accepts
 * (`decide_plan_revision`), which is left to the caller; `rejectProposals: false` (an owner's
 * hold) leaves undecided proposals to the requester, who may still decide them while held.
 */
export async function closePlanning(
  client: PoolClient,
  workspaceId: string,
  goalRunId: string,
  actorId: string,
  reason: ClosePlanningReason,
  options: { readonly keepRevision?: number; readonly rejectProposals?: boolean } = {},
): Promise<ClosedPlanning> {
  const actor: PlanningActor = { principalId: actorId, by: 'person' };
  const running = await client.query<{ id: string }>(
    `select id from goal_planning_rounds
      where workspace_id = $1 and goal_run_id = $2 and status = 'running'`,
    [workspaceId, goalRunId],
  );
  for (const row of running.rows) {
    await settlePlanningRound(
      client,
      workspaceId,
      actor,
      { id: row.id, goalRunId },
      {
        status: 'abandoned',
        reason,
      },
    );
  }
  const rejected: number[] = [];
  if (options.rejectProposals !== false) {
    const plannerId = await findGoalPlannerPrincipal(client, workspaceId);
    if (plannerId !== null) {
      const proposals = await client.query<{ id: string; revision: number }>(
        `update plan_revisions set status = 'rejected', decided_by = $4, decided_at = now()
          where workspace_id = $1 and goal_run_id = $2 and proposed_by = $3
            and status = 'proposed' and revision is distinct from $5
          returning id, revision`,
        [workspaceId, goalRunId, plannerId, actorId, options.keepRevision ?? null],
      );
      for (const proposal of proposals.rows) {
        await writeAudit(client, {
          workspaceId,
          actorPrincipalId: actorId,
          action: 'plan_revision.reject',
          resourceType: 'plan_revision',
          resourceId: proposal.id,
          payload: { goalRunId, revision: proposal.revision, by: 'person', reason },
        });
        rejected.push(proposal.revision);
      }
    }
  }
  return { abandonedRoundIds: running.rows.map((row) => row.id), rejectedRevisions: rejected };
}
