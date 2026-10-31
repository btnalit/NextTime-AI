import {
  type ActionFailureCode,
  type GoalPlan,
  GoalPlanSchema,
  type GoalRunStatus,
  type PlanHint,
  STEP_RUN_STATUS_VALUES,
  type StepRunStatus,
  failureCodeOfReason,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type ExecutingStepAction,
  type StepActionOutcome,
  listStepsActionOutcomes,
  readActionRequestFailureReasons,
} from '../../governance/approval/index.js';
import {
  type GoalStepAttempt,
  listGoalRunStepAttempts,
  readGoalRunsUsage,
  workerSpecDigest,
} from '../task/index.js';
import { getProcedure } from '../worker/index.js';
import {
  type GoalAcceptanceCheckView,
  type GoalAcceptanceView,
  readGoalAcceptance,
} from './acceptance.js';
import { readCancelLeftovers } from './cancelling.js';
import { procedureConfirmCheck } from './from-procedure.js';
import { paramsAsRead, planAsRead, planHints, procedureParametersAsRead } from './plan.js';
import { planAuthorityHints } from './precheck.js';
import { getGoalRun, getPlanRevision, listPlanRevisions, listStepRuns } from './reads.js';
import { type UnresolvedGoalAction, listGoalRunUnresolvedActions } from './reconcile.js';
import { GoalRunNotFoundError } from './service.js';
import {
  type StepTrialApprovalView,
  listStepTrialApprovals,
  readStepTrialApprovals,
  trialApprovalsFor,
} from './trial-approvals.js';
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
 * like an unknown id. `list_goals` lists the owner every run and anyone else their own. The owner's
 * view of every run is the human channel's only (the console): an agent reading on a Handle sees
 * the runs of the Handle's `obo` and no others, whatever that principal's role (coordinator
 * decision on review #493 of #680) — looking across the workspace, and holding or cancelling
 * someone else's goal, are a person's, not an agent's.
 *
 * Parameters in a plan are what one agent wrote for another, stored as given because the platform
 * acts on them: a step's `input` (its Task's input), a reconcile declaration's action params (the
 * step's request is matched by them) and every observation's params (reconcile and acceptance
 * checks; the review refuses a credential there, `reviewObserveParams`, but only flags a suspected
 * one) — in the plan, and in the check rows a verification round copies from it. Every reader
 * here gets them with each suspected credential replaced by `[redacted]`
 * (`redactSuspectedSecrets`, the call-argument rule `get_task` applies to a Task's input, legacy
 * 184). The rest of a plan cannot carry one: predicate literals, fact-check identities and the
 * `requester_confirm` prompt are refused when the plan is validated (`plan.ts`).
 *
 * A run's usage is what I-G6 counts (`readGoalRunsUsage`: tokens and step attempts) plus the
 * revisions made after the first (`revise.ts`'s budget rule); its StepRuns are counted by status.
 */

/** Who is reading: `seesEveryRun` only for the workspace owner on the human channel — see the
 *  module comment. */
export interface GoalViewer {
  readonly principalId: string;
  readonly seesEveryRun: boolean;
}

/** Whether `viewer` may read `goal` — see the module comment. */
export function goalVisibleTo(viewer: GoalViewer, goal: Pick<GoalRunRow, 'onBehalfOf'>): boolean {
  return viewer.seesEveryRun || goal.onBehalfOf === viewer.principalId;
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
  const requester = viewer.seesEveryRun ? filter.onBehalfOf : viewer.principalId;
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

/** S11 GO5d-2: the published Procedure version a plan was made from, with its name as it reads
 *  now (the version's content never changes; its name is the Procedure's). Legacy 454: the start
 *  parameters it was proposed with, as every read shows them (`null`: none given, or proposed
 *  before goal/0010), and the check its `verify` steps without a check of their own made
 *  (`procedureConfirmCheck`; `null` when there is none, or the version could not be read). */
export interface PlanSourceView {
  readonly procedureId: string;
  readonly version: number;
  readonly name: string;
  readonly parameters: Record<string, unknown> | null;
  readonly confirmCheck: {
    readonly key: string;
    readonly procedureSteps: readonly number[];
  } | null;
}

/** The Procedure `revision`'s plan was made from, or `null` for a plan written out. */
async function planSourceOf(
  client: PoolClient,
  workspaceId: string,
  revision: PlanRevisionRow,
): Promise<PlanSourceView | null> {
  const source = revision.sourceProcedure;
  if (!source) return null;
  // goal/0009's key holds the version there; a name it could not read shows the id.
  const procedure = await getProcedure(client, workspaceId, source);
  return {
    procedureId: source.procedureId,
    version: source.version,
    name: procedure?.name ?? source.procedureId,
    parameters: source.parameters ? procedureParametersAsRead(source.parameters) : null,
    confirmCheck: procedure ? procedureConfirmCheck(procedure.steps) : null,
  };
}

/** A revision of a plan as a reader gets it: the plan as every read shows it (`planAsRead`), and
 *  the hints for the person confirming it. */
export interface PlanRevisionView {
  readonly revision: PlanRevisionRow;
  readonly plan: GoalPlan;
  readonly hints: readonly PlanHint[];
  /** S11 GO5d-2: see {@link PlanSourceView}. */
  readonly source: PlanSourceView | null;
}

/** Legacy 513: what a read served to a person adds — see `planAuthorityHints`' `checkAccounts`. */
export interface GoalReadOptions {
  readonly checkAccounts?: boolean;
  /** S11 GO8a: the llm-proxy catalog the steps of a proposal and of a paused run are hinted
   *  against — see `planAuthorityHints`' `modelCatalog`. */
  readonly modelCatalog?: () => Promise<ReadonlySet<string> | null>;
}

async function planRevisionView(
  client: PoolClient,
  workspaceId: string,
  goal: GoalRunRow,
  revision: PlanRevisionRow,
  options: GoalReadOptions,
): Promise<PlanRevisionView> {
  // Every stored plan passed `parsePlan` when its revision was made (`service.ts`, `revise.ts`).
  const parsed = GoalPlanSchema.safeParse(revision.plan);
  if (!parsed.success) {
    throw new Error(
      `goal run ${revision.goalRunId} revision ${revision.revision}: the stored plan no longer parses`,
    );
  }
  const plan = parsed.data;
  // S11 GO5c: the proposal of a run still proposed is what the confirmation card shows — with what
  // the requester's authority would stop now, worked out on every read (`precheck.ts`). S11 GO8a:
  // so is the revision in force of a paused run, for the steps that have not started an attempt or
  // wait to be tried again — the pause then says which step would not start, and why (a draft
  // Skill waiting for a person, a gate the requester lost, a model no longer allowed or offered).
  const {
    steps: checked,
    retried,
    live,
  } = await stepsToCheck(client, workspaceId, goal, revision, plan);
  // S11 GO8b: a step whose trial a person approved starts with that approval — not hinted.
  const approvals =
    checked.length > 0 ? await listStepTrialApprovals(client, workspaceId, goal.id) : [];
  const trialApprovals = new Map(
    checked
      .filter((step) => !retried.has(step.key))
      .map((step) => [
        step.key,
        trialApprovalsFor(
          approvals,
          goal,
          step.key,
          live.get(step.key) ?? null,
          workerSpecDigest(step.spec ?? null),
        ),
      ]),
  );
  return {
    revision,
    plan: planAsRead(plan),
    hints: [
      ...planHints(plan),
      ...(checked.length > 0
        ? await planAuthorityHints(
            client,
            workspaceId,
            goal.onBehalfOf,
            { ...plan, steps: checked },
            {
              checkAccounts: options.checkAccounts === true,
              retried,
              trialApprovals,
              // A plan is validated against the catalog when proposed, confirmed or revised: a
              // read says what changed since — confirming would be refused (UX on #853), or the
              // next attempt would be.
              ...(options.modelCatalog ? { modelCatalog: options.modelCatalog } : {}),
            },
          )
        : []),
    ],
    source: await planSourceOf(client, workspaceId, revision),
  };
}

/** The steps of `plan` whose authority and admission a read of `revision` works out: every step of
 *  a run's proposal while it is proposed; for a paused run's revision in force, the steps whose
 *  StepRun there has not started an attempt (`pending` or `ready`) and the ones `ready` to be tried
 *  again (`retried`: checked as a later attempt is, `precheck.ts`); none otherwise. A step running,
 *  waiting or ended has no next attempt to admit. `live`: the StepRuns of a paused run's steps
 *  checked, by key (none for a proposal — its confirmation creates them). */
async function stepsToCheck(
  client: PoolClient,
  workspaceId: string,
  goal: GoalRunRow,
  revision: PlanRevisionRow,
  plan: GoalPlan,
): Promise<{
  readonly steps: GoalPlan['steps'];
  readonly retried: ReadonlySet<string>;
  readonly live: ReadonlyMap<string, StepRunRow>;
}> {
  const retried = new Set<string>();
  const live = new Map<string, StepRunRow>();
  if (goal.status === 'proposed') {
    return { steps: revision.revision === 1 ? plan.steps : [], retried, live };
  }
  if (goal.status !== 'paused' || revision.revision !== goal.currentRevision) {
    return { steps: [], retried, live };
  }
  for (const step of await listStepRuns(client, workspaceId, goal.id)) {
    if (step.attemptCount === 0 && (step.status === 'pending' || step.status === 'ready')) {
      live.set(step.stepKey, step);
    } else if (step.attemptCount > 0 && step.status === 'ready') {
      live.set(step.stepKey, step);
      retried.add(step.stepKey);
    }
  }
  return { steps: plan.steps.filter((step) => live.has(step.key)), retried, live };
}

/** `params` with each suspected credential replaced — see the module comment. */
function withRedactedParams<T extends { readonly params?: Record<string, unknown> }>(value: T): T {
  return value.params === undefined
    ? value
    : { ...value, params: paramsAsRead(value.params).value };
}

/** A run's acceptance with every observation's params redacted: a round's check rows copy the
 *  plan's checks as written (`goal_acceptance_checks`, `step_acceptance_checks`), so they carry
 *  what the plan does — review #493 on #680. */
function redactedAcceptance(view: GoalAcceptanceView): GoalAcceptanceView {
  const redactRound = <R extends { readonly checks: readonly GoalAcceptanceCheckView[] }>(
    round: R,
  ): R => ({
    ...round,
    checks: round.checks.map((row) =>
      row.check === null ? row : { ...row, check: withRedactedParams(row.check) },
    ),
  });
  return {
    ...view,
    rounds: view.rounds.map(redactRound),
    steps: view.steps.map((step) => ({ ...step, rounds: step.rounds.map(redactRound) })),
  };
}

/** `get_goal_revision`: one revision of a run `viewer` may read. */
export async function readPlanRevisionVisibleTo(
  client: PoolClient,
  workspaceId: string,
  viewer: GoalViewer,
  goalRunId: string,
  revision: number,
  options: GoalReadOptions = {},
): Promise<PlanRevisionView> {
  const goal = await getGoalRunVisibleTo(client, workspaceId, viewer, goalRunId);
  const row = await getPlanRevision(client, workspaceId, goalRunId, revision);
  if (!row) throw new GoalRevisionNotFoundError(goalRunId, revision);
  return planRevisionView(client, workspaceId, goal, row, options);
}

/** A request a step raised, as the goal page shows it — legacy 513: with the whitelisted code of
 *  why one that was refused or not delivered failed (`failureCodeOfReason`), never the text. */
export interface GoalStepActionView extends StepActionOutcome {
  readonly failureCode: ActionFailureCode | null;
}

/** One StepRun with its attempts (the Tasks) and the requests it raised, oldest first. */
export interface GoalRunStepView {
  readonly step: StepRunRow;
  readonly attempts: readonly GoalStepAttempt[];
  readonly actions: readonly GoalStepActionView[];
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
  /** S11 GO5d-2: the Procedure revision 1's plan was made from — the one revision that may have
   *  one (goal/0009); `null` for a plan written out. */
  readonly planSource: PlanSourceView | null;
  /** In plan order ({@link inPlanOrder}); the acceptance view's steps follow it too. */
  readonly steps: readonly GoalRunStepView[];
  readonly acceptance: GoalAcceptanceView;
  /** Only while `cancelling`, or cancelled with `cleanupPending`. */
  readonly leftovers: GoalRunLeftoversView | null;
  /** S11 GO8b: every approval of a trial of a step's draft Skills, with where it stands, oldest
   *  first (`readStepTrialApprovals`). */
  readonly trialApprovals: readonly StepTrialApprovalView[];
}

/** `get_goal`: everything the goal page shows of a run `viewer` may read. */
export async function readGoalRunDetail(
  client: PoolClient,
  workspaceId: string,
  viewer: GoalViewer,
  goalRunId: string,
  options: GoalReadOptions = {},
): Promise<GoalRunDetail> {
  const goal = await getGoalRunVisibleTo(client, workspaceId, viewer, goalRunId);
  const [summary] = await summarizeGoalRuns(client, workspaceId, [goal]);
  const revisions = await listPlanRevisions(client, workspaceId, goalRunId);
  const inForce = revisions.find((row) => row.revision === (goal.currentRevision ?? 1));
  const acceptance = await readGoalAcceptance(client, workspaceId, goalRunId);
  if (!summary || !inForce || !acceptance) {
    throw new Error(`goal run ${goalRunId}: its revision in force or its acceptance did not read`);
  }
  const planView = await planRevisionView(client, workspaceId, goal, inForce, options);
  const stepRuns = inPlanOrder(await listStepRuns(client, workspaceId, goalRunId), planView.plan);
  const attempts = await listGoalRunStepAttempts(client, workspaceId, goalRunId);
  const actions = await listStepsActionOutcomes(
    client,
    workspaceId,
    stepRuns.map((step) => step.id),
  );
  const failureReasons = await readActionRequestFailureReasons(
    client,
    workspaceId,
    actions.filter(
      (action) => action.failureKind === 'refused' || action.failureKind === 'not_delivered',
    ),
  );
  const leftovers =
    goal.status === 'cancelling' || goal.cleanupPending
      ? await readCancelLeftovers(client, goal)
      : null;
  const position = new Map(stepRuns.map((step, index) => [step.id, index]));
  const first = revisions.find((row) => row.revision === 1);
  return {
    ...summary,
    planRevision: planView,
    revisions,
    planSource:
      first === inForce
        ? planView.source
        : first
          ? await planSourceOf(client, workspaceId, first)
          : null,
    steps: stepRuns.map((step) => ({
      step,
      attempts: attempts.filter((attempt) => attempt.stepRunId === step.id),
      actions: actions
        .filter((action) => action.stepRunId === step.id)
        .map(({ stepRunId: _stepRunId, ...action }) => ({
          ...action,
          failureCode: failureCodeOfReason(failureReasons.get(action.id)?.text),
        })),
    })),
    acceptance: redactedAcceptance({
      ...acceptance,
      steps: [...acceptance.steps].sort(
        (a, b) => (position.get(a.stepRunId) ?? 0) - (position.get(b.stepRunId) ?? 0),
      ),
    }),
    leftovers: leftovers
      ? { liveTaskIds: leftovers.liveTaskIds, executingActions: leftovers.executingActions }
      : null,
    trialApprovals: await readStepTrialApprovals(
      client,
      workspaceId,
      goal,
      inForce.plan,
      stepRuns,
      attempts,
    ),
  };
}

/** A run's StepRuns in the order a person reads a plan: by when they were created (a revision's
 *  steps after the ones before it), and — within one confirmation or revision, which creates its
 *  steps together — by the step's place in the plan in force; a step that plan no longer holds
 *  comes after, by key. Creation order alone ties there, and an id breaks the tie at random. */
function inPlanOrder(steps: readonly StepRunRow[], plan: GoalPlan): readonly StepRunRow[] {
  const place = new Map(plan.steps.map((step, index) => [step.key, index]));
  const rank = (step: StepRunRow) => place.get(step.stepKey) ?? Number.MAX_SAFE_INTEGER;
  return [...steps].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      rank(a) - rank(b) ||
      a.stepKey.localeCompare(b.stepKey) ||
      a.id.localeCompare(b.id),
  );
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
