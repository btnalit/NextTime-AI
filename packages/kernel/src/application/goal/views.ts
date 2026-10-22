import {
  type GoalPlan,
  GoalPlanSchema,
  type GoalRunStatus,
  type PlanHint,
  type Role,
  STEP_RUN_STATUS_VALUES,
  type StepRunStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type ExecutingStepAction,
  type StepActionOutcome,
  listStepsActionOutcomes,
} from '../../governance/approval/index.js';
import { redactSuspectedSecrets } from '../../governance/redaction/index.js';
import { type GoalStepAttempt, listGoalRunStepAttempts, readGoalRunsUsage } from '../task/index.js';
import { type GoalAcceptanceView, readGoalAcceptance } from './acceptance.js';
import { readCancelLeftovers } from './cancelling.js';
import { planHints } from './plan.js';
import { getGoalRun, getPlanRevision, listPlanRevisions, listStepRuns } from './reads.js';
import { type UnresolvedGoalAction, listGoalRunUnresolvedActions } from './reconcile.js';
import { GoalRunNotFoundError } from './service.js';
import {
  GOAL_RUN_ROW_COLUMNS,
  type GoalRunDbRow,
  type GoalRunRow,
  type PlanRevisionRow,
  type StepRunRow,
  mapGoalRunRow,
} from './types.js';

/**
 * application/goal/views (S11 GO5a; plan §4.3, §7): what the `goal` capabilities read — a run, a
 * page of runs, one revision of a plan, the actions still needing a person — for the console's
 * goal pages (GO6) and the requester's entry agent (GO5e).
 *
 * Who sees a run ({@link goalVisibleTo}): the workspace owner and the requester (`on_behalf_of`),
 * the rule `get_task` applies (`taskVisibleTo`, D-21) — a run's statement, plan inputs and step
 * results can carry private-chat content. Anyone else gets {@link GoalRunNotFoundError}, exactly
 * like an unknown id. `list_goals` lists the owner every run and anyone else their own.
 *
 * A step's `input` is what one agent wrote for another, stored as given because it is what the
 * step's Worker runs on (its Task's input); every reader here gets it with each suspected
 * credential replaced by `[redacted]` (`redactSuspectedSecrets`, the call-argument rule `get_task`
 * applies to a Task's input, legacy 184). The plan's other parameters — reconcile and acceptance
 * observations, fact checks — passed the credential review when the plan was validated (`plan.ts`).
 *
 * A run's usage is what I-G6 counts (`readGoalRunsUsage`: tokens and step attempts) plus the
 * revisions made after the first (`revise.ts`'s budget rule); its StepRuns are counted by status.
 */

export interface GoalViewer {
  readonly principalId: string;
  readonly role: Role;
}

/** Whether `viewer` may read `goal` — see the module comment. */
export function goalVisibleTo(viewer: GoalViewer, goal: Pick<GoalRunRow, 'onBehalfOf'>): boolean {
  return viewer.role === 'owner' || goal.onBehalfOf === viewer.principalId;
}

/** A revision of a GoalRun's plan that `revision` does not name. */
export class GoalRevisionNotFoundError extends Error {
  constructor(goalRunId: string, revision: number) {
    super(`goal run ${goalRunId} has no plan revision ${revision}`);
    this.name = 'GoalRevisionNotFoundError';
  }
}

/** The GoalRun, when `viewer` may read it; {@link GoalRunNotFoundError} otherwise. */
export async function getGoalRunVisibleTo(
  client: PoolClient,
  workspaceId: string,
  viewer: GoalViewer,
  goalRunId: string,
): Promise<GoalRunRow> {
  const goal = await getGoalRun(client, workspaceId, goalRunId);
  if (!goal || !goalVisibleTo(viewer, goal)) throw new GoalRunNotFoundError(goalRunId);
  return goal;
}

export interface GoalRunUsageView {
  readonly tokens: number;
  readonly steps: number;
  readonly revisions: number;
}

/** A run with what it has spent and its StepRuns counted by status (superseded ones included). */
export interface GoalRunSummary {
  readonly goal: GoalRunRow;
  readonly usage: GoalRunUsageView;
  readonly stepCounts: Readonly<Record<StepRunStatus, number>>;
}

/** {@link GoalRunSummary} of each of `goals`, in their order — three queries, whatever their
 *  number. */
export async function summarizeGoalRuns(
  client: PoolClient,
  workspaceId: string,
  goals: readonly GoalRunRow[],
): Promise<readonly GoalRunSummary[]> {
  if (goals.length === 0) return [];
  const ids = goals.map((goal) => goal.id);
  const usage = await readGoalRunsUsage(client, workspaceId, ids);
  const revisions = await client.query<{ goal_run_id: string; accepted: number }>(
    `select goal_run_id, count(*) filter (where status = 'accepted')::int as accepted
       from plan_revisions
      where workspace_id = $1 and goal_run_id = any($2::uuid[])
      group by goal_run_id`,
    [workspaceId, ids],
  );
  const accepted = new Map(revisions.rows.map((row) => [row.goal_run_id, row.accepted]));
  const steps = await client.query<{ goal_run_id: string; status: StepRunStatus; count: number }>(
    `select goal_run_id, status, count(*)::int as count
       from step_runs
      where workspace_id = $1 and goal_run_id = any($2::uuid[])
      group by goal_run_id, status`,
    [workspaceId, ids],
  );
  const counts = new Map<string, Record<StepRunStatus, number>>();
  for (const row of steps.rows) {
    const own = counts.get(row.goal_run_id) ?? emptyStepCounts();
    own[row.status] = row.count;
    counts.set(row.goal_run_id, own);
  }
  return goals.map((goal) => ({
    goal,
    usage: {
      tokens: usage.get(goal.id)?.tokens ?? 0,
      steps: usage.get(goal.id)?.steps ?? 0,
      // Revision 1 is the confirmed plan; each accepted one after it counts (`revise.ts`).
      revisions: Math.max((accepted.get(goal.id) ?? 0) - 1, 0),
    },
    stepCounts: counts.get(goal.id) ?? emptyStepCounts(),
  }));
}

function emptyStepCounts(): Record<StepRunStatus, number> {
  return Object.fromEntries(STEP_RUN_STATUS_VALUES.map((status) => [status, 0])) as Record<
    StepRunStatus,
    number
  >;
}

// -------------------------------------------------------------------------------------------
// `list_goals` keyset cursor — the `(date_trunc('milliseconds', created_at), id)` shape, `desc`,
// that `list_tasks` uses (application/task/service.ts), a private copy like the others. A cursor
// that does not parse reads as "no cursor" (the first page), never a 500 — the same convention.
// -------------------------------------------------------------------------------------------

const GOAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeListGoalsCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeListGoalsCursor(
  cursor: string | undefined,
): { readonly createdAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sepIndex = decoded.lastIndexOf('|');
    if (sepIndex < 0) return null;
    const createdAt = decoded.slice(0, sepIndex);
    const id = decoded.slice(sepIndex + 1);
    if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !GOAL_UUID_PATTERN.test(id)) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface ListGoalRunsFilter {
  readonly status?: readonly GoalRunStatus[];
  /** Only the runs of this requester. For a viewer who is not the owner, any other requester lists
   *  nothing — a filter narrows what the viewer may see, never widens it. */
  readonly onBehalfOf?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListGoalRunsOptions {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

export interface GoalRunsPage {
  readonly items: readonly GoalRunSummary[];
  readonly nextCursor?: string;
  readonly truncated?: true;
}

/** `list_goals`: the runs `viewer` may read, newest first — see the module comment. `truncated`
 *  when the requested `limit` was above `maxLimit`. */
export async function listGoalRunsVisibleTo(
  client: PoolClient,
  workspaceId: string,
  viewer: GoalViewer,
  filter: ListGoalRunsFilter,
  options: ListGoalRunsOptions,
): Promise<GoalRunsPage> {
  const requestedLimit = filter.limit ?? options.defaultLimit;
  const limit = Math.min(Math.max(requestedLimit, 1), options.maxLimit);
  const truncated = requestedLimit > options.maxLimit ? (true as const) : undefined;
  const requester = viewer.role === 'owner' ? filter.onBehalfOf : viewer.principalId;
  if (
    requester !== undefined &&
    filter.onBehalfOf !== undefined &&
    filter.onBehalfOf !== requester
  ) {
    return { items: [], ...(truncated !== undefined ? { truncated } : {}) };
  }
  const cursor = decodeListGoalsCursor(filter.cursor);
  const result = await client.query<GoalRunDbRow>(
    `select ${GOAL_RUN_ROW_COLUMNS} from goal_runs
     where workspace_id = $1
       and ($2::uuid is null or on_behalf_of = $2::uuid)
       and ($3::text[] is null or status = any($3::text[]))
       and (
         $4::timestamptz is null
         or (date_trunc('milliseconds', created_at), id) < ($4::timestamptz, $5::uuid)
       )
     order by date_trunc('milliseconds', created_at) desc, id desc
     limit $6`,
    [
      workspaceId,
      requester ?? null,
      filter.status === undefined ? null : [...filter.status],
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const rows = result.rows.map(mapGoalRunRow);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeListGoalsCursor(last.createdAt, last.id) : undefined;
  return {
    items: await summarizeGoalRuns(client, workspaceId, page),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

/** A revision of a plan as a reader gets it: the plan typed, its steps' inputs redacted, and the
 *  hints for the person confirming it. */
export interface PlanRevisionView {
  readonly revision: PlanRevisionRow;
  readonly plan: GoalPlan;
  readonly hints: readonly PlanHint[];
}

function planRevisionView(revision: PlanRevisionRow): PlanRevisionView {
  // Every stored plan passed `parsePlan` when its revision was made (`service.ts`, `revise.ts`).
  const parsed = GoalPlanSchema.safeParse(revision.plan);
  if (!parsed.success) {
    throw new Error(
      `goal run ${revision.goalRunId} revision ${revision.revision}: the stored plan no longer parses`,
    );
  }
  return {
    revision,
    plan: {
      ...parsed.data,
      steps: parsed.data.steps.map((step) =>
        step.input === undefined
          ? step
          : { ...step, input: redactSuspectedSecrets(step.input, { secretFields: true }).value },
      ),
    },
    hints: planHints(parsed.data),
  };
}

/** `get_goal_revision`: one revision of a run `viewer` may read. */
export async function readPlanRevisionVisibleTo(
  client: PoolClient,
  workspaceId: string,
  viewer: GoalViewer,
  goalRunId: string,
  revision: number,
): Promise<PlanRevisionView> {
  await getGoalRunVisibleTo(client, workspaceId, viewer, goalRunId);
  const row = await getPlanRevision(client, workspaceId, goalRunId, revision);
  if (!row) throw new GoalRevisionNotFoundError(goalRunId, revision);
  return planRevisionView(row);
}

/** One StepRun with its attempts (the Tasks) and the requests it raised, oldest first. */
export interface GoalRunStepView {
  readonly step: StepRunRow;
  readonly attempts: readonly GoalStepAttempt[];
  readonly actions: readonly StepActionOutcome[];
}

/** What a cancel still waits for, or left behind (`cancelling.ts`). */
export interface GoalRunLeftoversView {
  readonly liveTaskIds: readonly string[];
  readonly executingActions: readonly ExecutingStepAction[];
}

export interface GoalRunDetail extends GoalRunSummary {
  /** The revision in force — revision 1 until the run is confirmed (and on one cancelled before). */
  readonly planRevision: PlanRevisionView;
  readonly revisions: readonly PlanRevisionRow[];
  readonly steps: readonly GoalRunStepView[];
  readonly acceptance: GoalAcceptanceView;
  /** Only while `cancelling`, or cancelled with `cleanupPending`. */
  readonly leftovers: GoalRunLeftoversView | null;
}

/** `get_goal`: everything the goal page shows of a run `viewer` may read. */
export async function readGoalRunDetail(
  client: PoolClient,
  workspaceId: string,
  viewer: GoalViewer,
  goalRunId: string,
): Promise<GoalRunDetail> {
  const goal = await getGoalRunVisibleTo(client, workspaceId, viewer, goalRunId);
  const [summary] = await summarizeGoalRuns(client, workspaceId, [goal]);
  const revisions = await listPlanRevisions(client, workspaceId, goalRunId);
  const inForce = revisions.find((row) => row.revision === (goal.currentRevision ?? 1));
  const acceptance = await readGoalAcceptance(client, workspaceId, goalRunId);
  if (!summary || !inForce || !acceptance) {
    throw new Error(`goal run ${goalRunId}: its revision in force or its acceptance did not read`);
  }
  const stepRuns = await listStepRuns(client, workspaceId, goalRunId);
  const attempts = await listGoalRunStepAttempts(client, workspaceId, goalRunId);
  const actions = await listStepsActionOutcomes(
    client,
    workspaceId,
    stepRuns.map((step) => step.id),
  );
  const leftovers =
    goal.status === 'cancelling' || goal.cleanupPending
      ? await readCancelLeftovers(client, goal)
      : null;
  return {
    ...summary,
    planRevision: planRevisionView(inForce),
    revisions,
    steps: stepRuns.map((step) => ({
      step,
      attempts: attempts.filter((attempt) => attempt.stepRunId === step.id),
      actions: actions
        .filter((action) => action.stepRunId === step.id)
        .map(({ stepRunId: _stepRunId, ...action }) => action),
    })),
    acceptance,
    leftovers: leftovers
      ? { liveTaskIds: leftovers.liveTaskIds, executingActions: leftovers.executingActions }
      : null,
  };
}

/** `list_goal_unresolved_actions`: the actions of a run `viewer` may read that still need a person
 *  (`reconcile.ts`). */
export async function listGoalRunUnresolvedActionsVisibleTo(
  client: PoolClient,
  workspaceId: string,
  viewer: GoalViewer,
  goalRunId: string,
): Promise<readonly UnresolvedGoalAction[]> {
  await getGoalRunVisibleTo(client, workspaceId, viewer, goalRunId);
  return listGoalRunUnresolvedActions(client, workspaceId, goalRunId);
}
