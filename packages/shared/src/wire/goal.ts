import { z } from 'zod';
import {
  ActionRequestFailureKindSchema,
  ActionRequestReconcileCheckStatusSchema,
  ActionRequestReconciliationSchema,
  ActionRequestStatusSchema,
  GoalAcceptanceCheckKindSchema,
  GoalAcceptanceCheckStatusSchema,
  GoalOutcomeBasisSchema,
  GoalRunPauseAuthoritySchema,
  GoalRunPauseReasonSchema,
  GoalRunStatusSchema,
  ObjectiveOutcomeSchema,
  PlanRevisionStatusSchema,
  STEP_RUN_STATUS_VALUES,
  StepRunFailureCategorySchema,
  StepRunStatusSchema,
  StepRunWaitingReasonSchema,
  TaskStatusSchema,
} from '../enums.js';
import {
  GoalBudgetSchema,
  GoalPlanSchema,
  PlanHintSchema,
  StepRemovalsSchema,
} from '../goal-plan.js';
import { FactCheckSchema, ObservationCheckSchema } from '../predicate.js';

/**
 * wire/goal (S11 GO5a; docs/wire-contract-conventions.md §5): the GoalRun as the `goal` capability
 * group returns it — mirrors `application/gateway/goal-handlers.ts`'s projections of the kernel's
 * `application/goal` reads. One shape per resource, reused by `get_goal`, `list_goals`,
 * `get_goal_revision` and `list_goal_unresolved_actions`, and by the console's goal pages (GO6).
 *
 * A run's plan is typed (`GoalPlanSchema`, `goal-plan.ts`): every stored revision passed it when it
 * was created. Its parameters — a step's `input`, a reconcile declaration's action params, every
 * observation's params — are what one agent wrote for another, so — like a Task's input on
 * `get_task` — every reader gets them with suspected credentials replaced by `[redacted]`.
 */

/** What the run has spent of its budget (I-G6): tokens of all its Tasks (nested child Tasks
 *  included), step attempts started, revisions made after the first. Wall clock runs from
 *  `confirmedAt`. */
export const GoalUsageWireSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    revisions: z.number().int().nonnegative(),
  })
  .strict();
export type GoalUsageWire = z.infer<typeof GoalUsageWireSchema>;

/** The run's StepRuns counted by status — superseded ones included, under `superseded`. */
export const GoalStepCountsWireSchema = z
  .object(
    Object.fromEntries(
      STEP_RUN_STATUS_VALUES.map((status) => [status, z.number().int().nonnegative()]),
    ) as Record<(typeof STEP_RUN_STATUS_VALUES)[number], z.ZodNumber>,
  )
  .strict();
export type GoalStepCountsWire = z.infer<typeof GoalStepCountsWireSchema>;

/** A GoalRun — `list_goals`' item and the head of `get_goal`'s result. Sub-states are set exactly
 *  while their status holds: `pauseReason` (and, for a person's pause, `pausedBy` with the
 *  authority it carries — `owner` holds someone else's run) while paused, `outcome` with its basis
 *  once completed, `outcomeDecisionId` when the outcome rests on the requester's word.
 *  `cleanupPending`: cancelled while Tasks or executing actions were still left (`get_goal`'s
 *  `leftovers`). `currentRevision` is `null` until confirmed. */
export const GoalRunWireSchema = z
  .object({
    id: z.string(),
    status: GoalRunStatusSchema,
    pauseReason: GoalRunPauseReasonSchema.nullable(),
    pausedBy: z.string().nullable(),
    pausedByAuthority: GoalRunPauseAuthoritySchema.nullable(),
    cleanupPending: z.boolean(),
    outcome: ObjectiveOutcomeSchema.nullable(),
    outcomeBasis: GoalOutcomeBasisSchema.nullable(),
    outcomeDecisionId: z.string().nullable(),
    onBehalfOf: z.string(),
    /** The Turn the goal was proposed in — `null` for one proposed outside a conversation. */
    turnId: z.string().nullable(),
    statement: z.string(),
    currentRevision: z.number().int().positive().nullable(),
    budget: GoalBudgetSchema,
    usage: GoalUsageWireSchema,
    stepCounts: GoalStepCountsWireSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    confirmedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  })
  .strict();
export type GoalRunWire = z.infer<typeof GoalRunWireSchema>;

/** One revision of a run's plan (`get_goal_revision`, and `get_goal`'s `planRevision`): revision 1
 *  is the proposal the requester confirmed (or has yet to); a later one is a revision the
 *  requester made of a paused run, accepted as made. `removals`: what it decided about each step
 *  it removed (a removed step not listed was terminated). `hints`: what the person confirming
 *  should know that does not stop the plan. */
export const PlanRevisionWireSchema = z
  .object({
    id: z.string(),
    goalRunId: z.string(),
    revision: z.number().int().positive(),
    status: PlanRevisionStatusSchema,
    basedOnRevision: z.number().int().positive().nullable(),
    plan: GoalPlanSchema,
    proposedBy: z.string(),
    reason: z.string().nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
    createdAt: z.string(),
    removals: StepRemovalsSchema,
    hints: z.array(PlanHintSchema),
  })
  .strict();
export type PlanRevisionWire = z.infer<typeof PlanRevisionWireSchema>;

/** A revision in `get_goal`'s history — without its plan (`get_goal_revision` reads one). */
export const PlanRevisionSummaryWireSchema = PlanRevisionWireSchema.omit({
  plan: true,
  hints: true,
});
export type PlanRevisionSummaryWire = z.infer<typeof PlanRevisionSummaryWireSchema>;

/** One attempt of a step: the Task that ran it (`get_task` reads it). */
export const StepAttemptWireSchema = z
  .object({
    attempt: z.number().int().positive(),
    taskId: z.string(),
    status: TaskStatusSchema,
    createdAt: z.string(),
  })
  .strict();
export type StepAttemptWire = z.infer<typeof StepAttemptWireSchema>;

/** An action a step raised (its ActionRequest — `list_action_requests` / the approval queue read
 *  it), oldest first. A request its requester chose to run again is left out once its new run
 *  exists. `reconciliation`: what was found about one whose outcome was unknown. */
export const StepActionWireSchema = z
  .object({
    actionRequestId: z.string(),
    status: ActionRequestStatusSchema,
    failureKind: ActionRequestFailureKindSchema.nullable(),
    reconciliation: ActionRequestReconciliationSchema.nullable(),
  })
  .strict();
export type StepActionWire = z.infer<typeof StepActionWireSchema>;

/** A StepRun — one step of the plan under the revision that introduced it. `supersededInRevision`:
 *  the revision that removed or redefined it. `waitingReason` is set exactly while waiting,
 *  `failureCategory` while failed. */
export const StepRunWireSchema = z
  .object({
    id: z.string(),
    stepKey: z.string(),
    introducedInRevision: z.number().int().positive(),
    supersededInRevision: z.number().int().positive().nullable(),
    status: StepRunStatusSchema,
    waitingReason: StepRunWaitingReasonSchema.nullable(),
    failureCategory: StepRunFailureCategorySchema.nullable(),
    attemptCount: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
    endedAt: z.string().nullable(),
    attempts: z.array(StepAttemptWireSchema),
    actions: z.array(StepActionWireSchema),
  })
  .strict();
export type StepRunWire = z.infer<typeof StepRunWireSchema>;

/** One acceptance check of a verification round. The evidence: `observationId` (an observation's
 *  latest Observation), `factId` (the Fact a fact check saw), `decisionId` (the requester's
 *  confirmation). `nextAttemptAt` only while a check the platform makes is pending. `overridden`:
 *  the requester declared the goal achieved over this check, which had not passed. */
export const GoalAcceptanceCheckWireSchema = z
  .object({
    checkKey: z.string(),
    kind: GoalAcceptanceCheckKindSchema,
    status: GoalAcceptanceCheckStatusSchema,
    check: ObservationCheckSchema.nullable(),
    fact: FactCheckSchema.nullable(),
    prompt: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    observationId: z.string().nullable(),
    factId: z.string().nullable(),
    decisionId: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
    settledAt: z.string().nullable(),
    overridden: z.boolean(),
  })
  .strict();
export type GoalAcceptanceCheckWire = z.infer<typeof GoalAcceptanceCheckWireSchema>;

export const GoalAcceptanceRoundWireSchema = z
  .object({
    round: z.number().int().positive(),
    planRevision: z.number().int().positive(),
    openedAt: z.string(),
    checks: z.array(GoalAcceptanceCheckWireSchema),
  })
  .strict();
export type GoalAcceptanceRoundWire = z.infer<typeof GoalAcceptanceRoundWireSchema>;

/**
 * Where a step's own acceptance stands (S11 GO4b): `verifying` (its checks are being observed),
 * `unavailable` (a check could not be made — the run waits on a person; resuming verifies the step
 * again without redoing its work), `failed` (a check was made and did not pass — only a person
 * retries it, which redoes the work), `passed`. `null`: none of these now.
 */
export const STEP_ACCEPTANCE_STATE_VALUES = [
  'verifying',
  'unavailable',
  'failed',
  'passed',
] as const;
export type StepAcceptanceState = (typeof STEP_ACCEPTANCE_STATE_VALUES)[number];
export const StepAcceptanceStateSchema = z.enum(STEP_ACCEPTANCE_STATE_VALUES);

export const StepAcceptanceWireSchema = z
  .object({
    stepRunId: z.string(),
    stepKey: z.string(),
    attempt: z.number().int().nonnegative(),
    state: StepAcceptanceStateSchema.nullable(),
    rounds: z.array(
      GoalAcceptanceRoundWireSchema.extend({
        stepAttempt: z.number().int().nonnegative(),
      }).strict(),
    ),
  })
  .strict();
export type StepAcceptanceWire = z.infer<typeof StepAcceptanceWireSchema>;

/** One check an `achieved` on the requester's word overrode, with its evidence: `round` is `null`
 *  when no round ran on the current plan; `status` what became of it (`superseded`: the round
 *  ended first; `not_run`: no round on the current plan). */
export const OverriddenAcceptanceCheckWireSchema = z
  .object({
    checkKey: z.string(),
    kind: GoalAcceptanceCheckKindSchema,
    round: z.number().int().positive().nullable(),
    status: z.enum(['failed', 'unavailable', 'superseded', 'not_run']),
    observationId: z.string().nullable(),
    factId: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type OverriddenAcceptanceCheckWire = z.infer<typeof OverriddenAcceptanceCheckWireSchema>;

/** The run's verification: its rounds (the goal's acceptance checks), the steps that verify their
 *  own work, and — on an `achieved` resting on the requester's word — the checks it overrode. */
export const GoalAcceptanceWireSchema = z
  .object({
    rounds: z.array(GoalAcceptanceRoundWireSchema),
    steps: z.array(StepAcceptanceWireSchema),
    overriddenChecks: z.array(OverriddenAcceptanceCheckWireSchema),
  })
  .strict();
export type GoalAcceptanceWire = z.infer<typeof GoalAcceptanceWireSchema>;

/** What a cancel still waits for, or left behind (`cleanupPending`): live Tasks (nested child
 *  Tasks included) and actions still executing — they cannot be taken back and end on their own. */
export const GoalLeftoversWireSchema = z
  .object({
    liveTaskIds: z.array(z.string()),
    executingActions: z.array(
      z
        .object({
          actionRequestId: z.string(),
          stepRunId: z.string(),
          gatekeeperId: z.string(),
          actionKindTag: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type GoalLeftoversWire = z.infer<typeof GoalLeftoversWireSchema>;

/** `get_goal`'s result: the run, the revision in force (revision 1 until confirmed, and on a run
 *  cancelled before it was), its revision history oldest first, every StepRun (superseded ones
 *  included) in plan order — by when it was created, then by its place in the plan in force — its
 *  verification (steps in the same order), and — while cancelling or `cleanupPending` — what is
 *  left. */
export const GoalDetailWireSchema = GoalRunWireSchema.extend({
  planRevision: PlanRevisionWireSchema,
  revisions: z.array(PlanRevisionSummaryWireSchema),
  steps: z.array(StepRunWireSchema),
  acceptance: GoalAcceptanceWireSchema,
  leftovers: GoalLeftoversWireSchema.nullable(),
}).strict();
export type GoalDetailWire = z.infer<typeof GoalDetailWireSchema>;

/** An action of the run whose outcome is unknown and that still needs a person
 *  (`list_goal_unresolved_actions`): `finding` — nobody has recorded what they found; `decision` —
 *  found not to have taken effect, run it again or change the plan (only while the run can still
 *  run and its step is in the plan). `platformCheck`: the platform's own check of it, when its
 *  step declared one — a `pending` one may still settle the finding itself. */
export const UnresolvedGoalActionWireSchema = z
  .object({
    actionRequestId: z.string(),
    stepRunId: z.string(),
    stepKey: z.string(),
    gatekeeperId: z.string(),
    actionKindTag: z.string(),
    failedAt: z.string().nullable(),
    needs: z.enum(['finding', 'decision']),
    platformCheck: z
      .object({
        status: ActionRequestReconcileCheckStatusSchema,
        attempts: z.number().int().nonnegative(),
        lastError: z.string().nullable(),
        observationId: z.string().nullable(),
        nextAttemptAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type UnresolvedGoalActionWire = z.infer<typeof UnresolvedGoalActionWireSchema>;
