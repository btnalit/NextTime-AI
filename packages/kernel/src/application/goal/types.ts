import type {
  GoalBudget,
  GoalOutcomeBasis,
  GoalRunPauseAuthority,
  GoalRunPauseReason,
  GoalRunStatus,
  ObjectiveOutcome,
  PlanRevisionStatus,
  Role,
  StepRemoval as SharedStepRemoval,
  StepRunFailureCategory,
  StepRunStatus,
  StepRunWaitingReason,
} from '@nexttime/shared';

/**
 * application/goal/types: the row shapes of migrations/goal/0001_goal_runs.sql. Each sub-state
 * column is set exactly while its status holds (DB CHECKs): `pauseReason` while paused,
 * `outcome` + `outcomeBasis` once completed, `waitingReason` while waiting, `failureCategory` while
 * failed.
 */

/** A person deciding about a GoalRun (`control.ts`, `revise.ts`, `acceptance.ts`, `service.ts`'s
 *  reject). The `goal` capabilities (S11 GO5b) take both from the authenticated caller, never from
 *  params (legacy 389): the database's guards do not know the role. */
export interface GoalControlActor {
  readonly principalId: string;
  readonly role: Role;
}

/** goal/0001's `budget_*` columns — the shape is `@nexttime/shared`'s `GoalBudget` (GO5a). */
export type GoalRunBudget = Readonly<GoalBudget>;

export interface GoalRunRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly status: GoalRunStatus;
  readonly pauseReason: GoalRunPauseReason | null;
  /** The person whose pause this is, and the authority it carries (goal/0004) — set only while
   *  paused by a person; `null` when the advancer paused the run. `owner`: a workspace owner holds
   *  someone else's run, and the requester cannot resume it until an owner lifts the hold. */
  readonly pausedBy: string | null;
  readonly pausedByAuthority: GoalRunPauseAuthority | null;
  readonly cleanupPending: boolean;
  readonly outcome: ObjectiveOutcome | null;
  readonly outcomeBasis: GoalOutcomeBasis | null;
  /** S11 GO4a (goal/0005): the requester's Decision an outcome on their word rests on — set only
   *  with `outcomeBasis = 'requester'`. */
  readonly outcomeDecisionId: string | null;
  readonly onBehalfOf: string;
  readonly originatedInTurnId: string | null;
  readonly statement: string;
  /** The plan revision in force — the fencing number (I-G2); `null` until confirmed. */
  readonly currentRevision: number | null;
  readonly budget: GoalRunBudget;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly confirmedAt: Date | null;
  readonly endedAt: Date | null;
  /** When the advancer next looks at this run (goal/0002): due once it has passed; `null` while
   *  only an event can move it, and always on a final run. */
  readonly nextTickAt: Date | null;
  /** Advances of this run that failed in a row (goal/0004, legacy 356); reset by one that commits. */
  readonly advanceFailures: number;
}

/** What a revision decided about one step it removes (goal/0004 `plan_revisions.removals`) — the
 *  shape is `@nexttime/shared`'s `StepRemoval` (GO5a). */
export type StepRemoval = Readonly<SharedStepRemoval>;

export interface PlanRevisionRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly goalRunId: string;
  readonly revision: number;
  readonly status: PlanRevisionStatus;
  readonly basedOnRevision: number | null;
  /** `{ steps: [{ key, … }, …] }` — the rest of a step's shape belongs to the code that proposes
   *  plans (GO2, GO5). */
  readonly plan: Record<string, unknown>;
  readonly proposedBy: string;
  readonly reason: string | null;
  readonly validation: unknown;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
  /** What the person decided about steps this revision removed, keyed by step key (goal/0004);
   *  `{}` on revision 1. A removed step not listed was terminated. */
  readonly removals: Readonly<Record<string, StepRemoval>>;
  /** S11 GO5d-2: the published Procedure version the plan was made from (goal/0009) — revision 1
   *  of a goal proposed `fromProcedure`; `null` for a plan written out. */
  readonly sourceProcedure: { readonly procedureId: string; readonly version: number } | null;
}

export interface StepRunRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly goalRunId: string;
  readonly stepKey: string;
  readonly introducedInRevision: number;
  readonly supersededInRevision: number | null;
  readonly status: StepRunStatus;
  readonly waitingReason: StepRunWaitingReason | null;
  readonly failureCategory: StepRunFailureCategory | null;
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly endedAt: Date | null;
}

export const GOAL_RUN_ROW_COLUMNS =
  'workspace_id, id, status, pause_reason, paused_by, paused_by_authority, cleanup_pending, ' +
  'outcome, outcome_basis, outcome_decision_id, on_behalf_of, originated_in_turn_id, statement, ' +
  'current_revision, ' +
  'budget_max_tokens, budget_max_steps, budget_max_revisions, budget_max_wall_clock_seconds, ' +
  'created_at, updated_at, confirmed_at, ended_at, next_tick_at, advance_failures';

export interface GoalRunDbRow {
  workspace_id: string;
  id: string;
  status: GoalRunStatus;
  pause_reason: GoalRunPauseReason | null;
  paused_by: string | null;
  paused_by_authority: GoalRunPauseAuthority | null;
  cleanup_pending: boolean;
  outcome: ObjectiveOutcome | null;
  outcome_basis: GoalOutcomeBasis | null;
  outcome_decision_id: string | null;
  on_behalf_of: string;
  originated_in_turn_id: string | null;
  statement: string;
  current_revision: number | null;
  budget_max_tokens: string;
  budget_max_steps: number;
  budget_max_revisions: number;
  budget_max_wall_clock_seconds: number;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  ended_at: Date | null;
  next_tick_at: Date | null;
  advance_failures: number;
}

export function mapGoalRunRow(row: GoalRunDbRow): GoalRunRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    status: row.status,
    pauseReason: row.pause_reason,
    pausedBy: row.paused_by,
    pausedByAuthority: row.paused_by_authority,
    cleanupPending: row.cleanup_pending,
    outcome: row.outcome,
    outcomeBasis: row.outcome_basis,
    outcomeDecisionId: row.outcome_decision_id,
    onBehalfOf: row.on_behalf_of,
    originatedInTurnId: row.originated_in_turn_id,
    statement: row.statement,
    currentRevision: row.current_revision,
    budget: {
      // `bigint` arrives as a string from `pg`.
      maxTokens: Number(row.budget_max_tokens),
      maxSteps: row.budget_max_steps,
      maxRevisions: row.budget_max_revisions,
      maxWallClockSeconds: row.budget_max_wall_clock_seconds,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    endedAt: row.ended_at,
    nextTickAt: row.next_tick_at,
    advanceFailures: row.advance_failures,
  };
}

export const PLAN_REVISION_ROW_COLUMNS =
  'workspace_id, id, goal_run_id, revision, status, based_on_revision, plan, proposed_by, ' +
  'reason, validation, decided_by, decided_at, created_at, removals, source_procedure_id, ' +
  'source_procedure_version';

export interface PlanRevisionDbRow {
  workspace_id: string;
  id: string;
  goal_run_id: string;
  revision: number;
  status: PlanRevisionStatus;
  based_on_revision: number | null;
  plan: Record<string, unknown>;
  proposed_by: string;
  reason: string | null;
  validation: unknown;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  removals: Record<string, StepRemoval>;
  source_procedure_id: string | null;
  source_procedure_version: number | null;
}

export function mapPlanRevisionRow(row: PlanRevisionDbRow): PlanRevisionRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    goalRunId: row.goal_run_id,
    revision: row.revision,
    status: row.status,
    basedOnRevision: row.based_on_revision,
    plan: row.plan,
    proposedBy: row.proposed_by,
    reason: row.reason,
    validation: row.validation,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    removals: row.removals,
    sourceProcedure:
      row.source_procedure_id !== null && row.source_procedure_version !== null
        ? { procedureId: row.source_procedure_id, version: row.source_procedure_version }
        : null,
  };
}

export const STEP_RUN_ROW_COLUMNS =
  'workspace_id, id, goal_run_id, step_key, introduced_in_revision, superseded_in_revision, ' +
  'status, waiting_reason, failure_category, attempt_count, created_at, updated_at, ended_at';

export interface StepRunDbRow {
  workspace_id: string;
  id: string;
  goal_run_id: string;
  step_key: string;
  introduced_in_revision: number;
  superseded_in_revision: number | null;
  status: StepRunStatus;
  waiting_reason: StepRunWaitingReason | null;
  failure_category: StepRunFailureCategory | null;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
}

export function mapStepRunRow(row: StepRunDbRow): StepRunRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    goalRunId: row.goal_run_id,
    stepKey: row.step_key,
    introducedInRevision: row.introduced_in_revision,
    supersededInRevision: row.superseded_in_revision,
    status: row.status,
    waitingReason: row.waiting_reason,
    failureCategory: row.failure_category,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}
