import { z } from 'zod';
import { ACTION_FAILURE_CODE_VALUES } from '../action-failure-reason.js';
import {
  ActionRequestFailureKindSchema,
  ActionRequestReconcileCheckStatusSchema,
  ActionRequestReconciliationSchema,
  ActionRequestStatusSchema,
  GoalAbsenceBaselineStatusSchema,
  GoalAcceptanceCheckKindSchema,
  GoalAcceptanceCheckStatusSchema,
  GoalOutcomeBasisSchema,
  GoalPlannerModeSchema,
  GoalRunPauseAuthoritySchema,
  GoalRunPauseReasonSchema,
  GoalRunStatusSchema,
  ObjectiveOutcomeSchema,
  PlanRevisionAcceptorSchema,
  PlanRevisionProposerSchema,
  PlanRevisionStatusSchema,
  PlannerRevisionClassSchema,
  PlannerRevisionMajorReasonSchema,
  PlanningFailureCategorySchema,
  PlanningRoundKindSchema,
  PlanningRoundOutcomeReasonSchema,
  PlanningRoundStatusSchema,
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
  StepTrialDraftInfoSchema,
} from '../goal-plan.js';
import { PlanRevisionDecisionSchema } from '../goal-planner.js';
import { OutputProblemSchema } from '../output-schema.js';
import {
  FactCheckSchema,
  ObservationAbsenceCheckSchema,
  ObservationCheckSchema,
} from '../predicate.js';

/**
 * wire/goal (S11 GO5a; docs/wire-contract-conventions.md §5): the GoalRun as the `goal` capability
 * group returns it — mirrors `application/gateway/goal-handlers.ts`'s projections of the kernel's
 * `application/goal` reads. One shape per resource, reused by `get_goal`, `list_goals`,
 * `get_goal_revision` and `list_goal_unresolved_actions`, and by the console's goal pages (GO6).
 *
 * A run's plan is typed (`GoalPlanSchema`, `goal-plan.ts`): every stored revision passed it when it
 * was created. Its parameters — a step's `input`, a reconcile declaration's action params, every
 * observation's params — are what one agent wrote for another, so — like a Task's input on
 * `get_task` — every reader gets them with suspected credentials replaced by `[redacted]`. Free
 * text a person writes — a revision's reason (S11 GO5b) — is refused when it carries one, and so
 * is read back as written.
 *
 * S11 GO5b adds what each of a person's operations on a run returns (the end of this file).
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

/** S11 GO5d-2: the published Procedure a plan was made from (`propose_goal`'s `fromProcedure`) —
 *  revision 1 of a goal made from one; `name` as it reads now. Legacy 454: `parameters`, the start
 *  parameters it was proposed with, masked like a step's input (`null`: none given, or proposed
 *  before the platform kept them); `confirmCheck`, the acceptance check of the plan the
 *  Procedure's `verify` steps without a check of their own became — its key in the plan and those
 *  steps' numbers in the Procedure (1-based) — so a reader names it without reading its key
 *  (`null`: every `verify` step carries its own check). */
export const PlanSourceProcedureWireSchema = z
  .object({
    procedureId: z.string(),
    version: z.number().int().positive(),
    name: z.string(),
    parameters: z.record(z.string(), z.unknown()).nullable(),
    confirmCheck: z
      .object({
        key: z.string(),
        procedureSteps: z.array(z.number().int().positive()).min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PlanSourceProcedureWire = z.infer<typeof PlanSourceProcedureWireSchema>;

/** One revision of a run's plan (`get_goal_revision`, and `get_goal`'s `planRevision`): revision 1
 *  is the proposal the requester confirmed (or has yet to); a later one is a revision the
 *  requester made of a paused run, accepted as made, or — S11 GO9a — one the goal planner
 *  proposed (`proposer: 'planner'`), `proposed` until the requester accepts or rejects it
 *  (`decide_plan_revision`). `removals`: what it decided about each step it removed (a removed
 *  step not listed was terminated). `hints`: what the person confirming should know that does not
 *  stop the plan. */
export const PlanRevisionWireSchema = z
  .object({
    id: z.string(),
    goalRunId: z.string(),
    revision: z.number().int().positive(),
    status: PlanRevisionStatusSchema,
    basedOnRevision: z.number().int().positive().nullable(),
    plan: GoalPlanSchema,
    proposedBy: z.string(),
    /** S11 GO9a: who `proposedBy` is — a person, or the workspace's goal planner. */
    proposer: PlanRevisionProposerSchema,
    /** S11 GO9b: who accepted it (`null` while not accepted) — a person, or the platform for the
     *  requester under their `apply_minor` leave (`decidedBy` is then the requester). */
    acceptedBy: PlanRevisionAcceptorSchema.nullable(),
    reason: z.string().nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
    createdAt: z.string(),
    removals: StepRemovalsSchema,
    hints: z.array(PlanHintSchema),
    /** S11 GO5d-2: the Procedure the plan was made from; `null` for a plan written as it is. */
    fromProcedure: PlanSourceProcedureWireSchema.nullable(),
  })
  .strict();
export type PlanRevisionWire = z.infer<typeof PlanRevisionWireSchema>;

/** A revision in `get_goal`'s history — without its plan (`get_goal_revision` reads one). */
export const PlanRevisionSummaryWireSchema = PlanRevisionWireSchema.omit({
  plan: true,
  hints: true,
});
export type PlanRevisionSummaryWire = z.infer<typeof PlanRevisionSummaryWireSchema>;

/** One attempt of a step: the Task that ran it (`get_task` reads it). S11 GO5d-1: why it failed,
 *  whether it redoes an earlier attempt that ended without an accepted result (`rework`), and —
 *  when its output contract refused a report — where the last one did not match
 *  (`outputProblems`, at most `MAX_OUTPUT_PROBLEMS`, `outputProblemCount` exact; the output itself
 *  is on the Task). */
export const StepAttemptWireSchema = z
  .object({
    attempt: z.number().int().positive(),
    taskId: z.string(),
    status: TaskStatusSchema,
    createdAt: z.string(),
    failureReason: z.string().nullable(),
    rework: z.boolean(),
    outputProblems: z.array(OutputProblemSchema).nullable(),
    outputProblemCount: z.number().int().nonnegative(),
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
    /** Legacy 513: on a request that failed `refused` or `not_delivered`, the code its reason
     *  starts with when it is one of the whitelisted codes (`ACTION_FAILURE_CODE_VALUES`) — e.g.
     *  `credential_unavailable`. Never the reason text. */
    failureCode: z.enum(ACTION_FAILURE_CODE_VALUES).nullable(),
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
    /** S11 GO5d-1: the output the step's current attempt reported with its accepted result —
     *  what the steps bound to it read once it has succeeded. `null` = none (no accepted result
     *  yet, or none reported). */
    output: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type StepRunWire = z.infer<typeof StepRunWireSchema>;

/** One acceptance check of a verification round. `check`: the observation an `observe_predicate`
 *  (with its predicate) or an `observe_absent` (without one, S11 「门确认不存在」 B) makes. The
 *  evidence: `observationId` (an observation's latest Observation), `factId` (the Fact a fact check
 *  saw), `decisionId` (the requester's confirmation). `nextAttemptAt` only while a check the
 *  platform makes is pending. `overridden`: the requester declared the goal achieved over this
 *  check, which had not passed. */
export const GoalAcceptanceCheckWireSchema = z
  .object({
    checkKey: z.string(),
    kind: GoalAcceptanceCheckKindSchema,
    status: GoalAcceptanceCheckStatusSchema,
    check: z.union([ObservationCheckSchema, ObservationAbsenceCheckSchema]).nullable(),
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

/** S11 「门确认不存在」 B-c (goal/0012): the baseline an absence check (`observe_absent`) goes by —
 *  the platform's look, with the check's call, before the goal's work started (for a check a
 *  revision added or re-called once steps had started, before the run went on — a look whose
 *  `createdAt` is after an attempt's came after the work began). The goal's own check
 *  has `stepKey` `null`. Only a baseline of the call the plan in force makes is listed (its latest
 *  take); a check with none listed has not been looked at since the run last started running or its
 *  call changed. `take` counts the check's takes (as the audit does); `look` is which look with this
 *  call it is — the earlier looks with the same call, ones superseded before they settled not
 *  counted, plus one — so the first look after the call changed is look 1 (#786 UX P3).
 *  `lastError`: why it is `unavailable`, or why it was tried again. */
export const GoalAbsenceBaselineWireSchema = z
  .object({
    stepKey: z.string().nullable(),
    checkKey: z.string(),
    take: z.number().int().positive(),
    look: z.number().int().positive(),
    status: GoalAbsenceBaselineStatusSchema,
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    observationId: z.string().nullable(),
    createdAt: z.string(),
    settledAt: z.string().nullable(),
  })
  .strict();
export type GoalAbsenceBaselineWire = z.infer<typeof GoalAbsenceBaselineWireSchema>;

/** The run's verification: its rounds (the goal's acceptance checks), the steps that verify their
 *  own work, the baselines its absence checks go by, and — on an `achieved` resting on the
 *  requester's word — the checks it overrode. */
export const GoalAcceptanceWireSchema = z
  .object({
    rounds: z.array(GoalAcceptanceRoundWireSchema),
    steps: z.array(StepAcceptanceWireSchema),
    absenceBaselines: z.array(GoalAbsenceBaselineWireSchema),
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

/**
 * S11 GO8b (goal/0013): a person's approval of one trial of a step whose WorkerSpec names draft
 * Skills — the step's WorkerSpec (`specDigest`) and the draft versions it mounts (`drafts`, each
 * bound to its content by `draftDigest`, named as it was approved), approved by someone who could
 * publish every one of them then. One trial is one StepRun — its first attempt and the retries of
 * that attempt: approved on a paused run, for the StepRun of its key that has not started
 * (`stepRunId`); on a proposal, for the StepRun its confirmation creates (`stepRunId` `null` until
 * its first attempt runs with it). `state`: `pending` (the step's first attempt has not started;
 * it starts with this approval while it matches), `used` (that attempt ran with it —
 * `usedByTaskId`) or `lapsed`, never used: `lapsedBecause` `draft_changed` (a draft it names was
 * changed, discarded or published since — approve again), `step_changed` (the step's WorkerSpec
 * or its StepRun is another one now, or the step started without it) or `run_ended`.
 */
export const STEP_TRIAL_APPROVAL_STATE_VALUES = ['pending', 'used', 'lapsed'] as const;
export type StepTrialApprovalState = (typeof STEP_TRIAL_APPROVAL_STATE_VALUES)[number];
export const STEP_TRIAL_APPROVAL_LAPSE_VALUES = [
  'draft_changed',
  'step_changed',
  'run_ended',
] as const;
export type StepTrialApprovalLapse = (typeof STEP_TRIAL_APPROVAL_LAPSE_VALUES)[number];

export const StepTrialApprovalWireSchema = z
  .object({
    id: z.string(),
    stepKey: z.string(),
    stepRunId: z.string().nullable(),
    planRevision: z.number().int().positive(),
    specDigest: z.string(),
    drafts: z.array(StepTrialDraftInfoSchema).min(1),
    approvedBy: z.string(),
    approvedAt: z.string(),
    state: z.enum(STEP_TRIAL_APPROVAL_STATE_VALUES),
    lapsedBecause: z.enum(STEP_TRIAL_APPROVAL_LAPSE_VALUES).nullable(),
    usedByTaskId: z.string().nullable(),
  })
  .strict();
export type StepTrialApprovalWire = z.infer<typeof StepTrialApprovalWireSchema>;

/** S11 GO9b: one reason a planner revision is `major` — the step it is about, when it is about
 *  one (`stepKey`; none for `goal_acceptance_changed`). */
export const PlannerRevisionClassReasonWireSchema = z
  .object({
    code: PlannerRevisionMajorReasonSchema,
    stepKey: z.string().nullable(),
  })
  .strict();
export type PlannerRevisionClassReasonWire = z.infer<typeof PlannerRevisionClassReasonWireSchema>;

/** S11 GO9a: one planning round of the run — the goal planner asked once about one failed attempt
 *  of a step (`stepKey`, `stepAttempt`, why it failed), on the revision then in force
 *  (`basedOnRevision`). `taskId`: the planner's Task (`get_task` reads it), `null` for a round that
 *  never started one. `revision`: what it proposed, once `proposed` (or `applied`). `outcomeReason`:
 *  why it `failed` or was `abandoned`. `detail`: for `no_revision`, the planner's reason as it
 *  wrote it; for `failed`, what the platform found. S11 GO9b: `kind` — opened under a pause (the
 *  requester decides) or while the run kept running (`autonomous`: a minor revision is `applied`
 *  for them); `revisionClass` and `classReasons` — how the platform classed what it proposed, and
 *  why a `major` one needs the requester (`null` / empty for a round that proposed nothing, or one
 *  settled before the platform classed revisions). */
export const PlanningRoundWireSchema = z
  .object({
    id: z.string(),
    status: PlanningRoundStatusSchema,
    kind: PlanningRoundKindSchema,
    basedOnRevision: z.number().int().positive(),
    stepRunId: z.string(),
    stepKey: z.string(),
    stepAttempt: z.number().int().positive(),
    failureCategory: PlanningFailureCategorySchema,
    taskId: z.string().nullable(),
    revision: z.number().int().positive().nullable(),
    revisionClass: PlannerRevisionClassSchema.nullable(),
    classReasons: z.array(PlannerRevisionClassReasonWireSchema),
    outcomeReason: PlanningRoundOutcomeReasonSchema.nullable(),
    detail: z.string().nullable(),
    createdAt: z.string(),
    settledAt: z.string().nullable(),
  })
  .strict();
export type PlanningRoundWire = z.infer<typeof PlanningRoundWireSchema>;

/** `get_goal`'s result: the run, the revision in force (revision 1 until confirmed, and on a run
 *  cancelled before it was), its revision history oldest first, every StepRun (superseded ones
 *  included) in plan order — by when it was created, then by its place in the plan in force — its
 *  verification (steps in the same order), and — while cancelling or `cleanupPending` — what is
 *  left. S11 GO8b: `trialApprovals`, every approval of a step's trial of draft Skills, oldest
 *  first. S11 GO9a: `planner` — how far the requester let the goal planner go when they confirmed
 *  the run (`null`: not at all); `planningRounds`, every round of it, oldest first. */
export const GoalDetailWireSchema = GoalRunWireSchema.extend({
  planRevision: PlanRevisionWireSchema,
  revisions: z.array(PlanRevisionSummaryWireSchema),
  steps: z.array(StepRunWireSchema),
  acceptance: GoalAcceptanceWireSchema,
  leftovers: GoalLeftoversWireSchema.nullable(),
  trialApprovals: z.array(StepTrialApprovalWireSchema),
  planner: GoalPlannerModeSchema.nullable(),
  planningRounds: z.array(PlanningRoundWireSchema),
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

// ---------------------------------------------------------------------------------------------
// S11 GO5b — what a person's operation on a GoalRun returns (`confirm_goal`, `reject_goal`,
// `pause_goal`, `resume_goal`, `cancel_goal`, `release_goal_hold`, `revise_goal`,
// `confirm_goal_acceptance`, `end_goal`, `reconcile_goal_action`). The console reloads the run
// (`get_goal`) to show where it stands; these say what the call itself did.
// ---------------------------------------------------------------------------------------------

/** The run's status after the call, and whether the call changed anything — `false` when the run
 *  already was where the call asked for (a call sent again changes nothing). */
export const GoalOperationResultWireSchema = z
  .object({
    goalRunId: z.string(),
    status: GoalRunStatusSchema,
    changed: z.boolean(),
  })
  .strict();
export type GoalOperationResultWire = z.infer<typeof GoalOperationResultWireSchema>;

/** S11 GO5c `propose_goal`: the run proposed — `proposed`, with its revision 1 — and what the
 *  person confirming it should know (`hints`: the plan's, and what the requester's authority would
 *  stop now). `changed: false` when the call matched a run proposed before with the same
 *  idempotency key (an explicit key: whatever its status since; a derived one: still proposed). */
export const ProposeGoalResultWireSchema = GoalOperationResultWireSchema.extend({
  planRevisionId: z.string(),
  hints: z.array(PlanHintSchema),
}).strict();
export type ProposeGoalResultWire = z.infer<typeof ProposeGoalResultWireSchema>;

/** `confirm_goal`: the StepRuns the confirmation created, every step of the plan `pending` (none
 *  when it was sent again). */
export const ConfirmGoalResultWireSchema = GoalOperationResultWireSchema.extend({
  createdStepRunIds: z.array(z.string()),
}).strict();
export type ConfirmGoalResultWire = z.infer<typeof ConfirmGoalResultWireSchema>;

/** `resume_goal`: the failed steps it sent back to `ready`. */
export const ResumeGoalResultWireSchema = GoalOperationResultWireSchema.extend({
  retriedStepRunIds: z.array(z.string()),
}).strict();
export type ResumeGoalResultWire = z.infer<typeof ResumeGoalResultWireSchema>;

/** `cancel_goal`: the steps it cancelled and the requests it withdrew (those not yet started); an
 *  executing one ends on its own, the run `cancelling` until it has. */
export const CancelGoalResultWireSchema = GoalOperationResultWireSchema.extend({
  cancelledStepRunIds: z.array(z.string()),
  withdrawnActionRequestIds: z.array(z.string()),
}).strict();
export type CancelGoalResultWire = z.infer<typeof CancelGoalResultWireSchema>;

/** `revise_goal`: the revision made (accepted and in force; the run stays paused), the steps it
 *  superseded and created, the requests it withdrew or the person released, and what the requester
 *  should know about the revised plan (`hints`). */
export const ReviseGoalResultWireSchema = GoalOperationResultWireSchema.extend({
  revision: z.number().int().positive(),
  planRevisionId: z.string(),
  supersededStepRunIds: z.array(z.string()),
  createdStepRunIds: z.array(z.string()),
  withdrawnActionRequestIds: z.array(z.string()),
  releasedActionRequestIds: z.array(z.string()),
  hints: z.array(PlanHintSchema),
}).strict();
export type ReviseGoalResultWire = z.infer<typeof ReviseGoalResultWireSchema>;

/** `confirm_goal_acceptance`: the requester's Decision the confirmation rests on. */
export const ConfirmGoalAcceptanceResultWireSchema = GoalOperationResultWireSchema.extend({
  decisionId: z.string().nullable(),
}).strict();
export type ConfirmGoalAcceptanceResultWire = z.infer<typeof ConfirmGoalAcceptanceResultWireSchema>;

/** `end_goal`: the requester's Decision the outcome rests on, every check an `achieved` overrode
 *  (with its evidence; empty otherwise) and the steps not started that it skipped. */
export const EndGoalResultWireSchema = GoalOperationResultWireSchema.extend({
  decisionId: z.string().nullable(),
  overriddenChecks: z.array(OverriddenAcceptanceCheckWireSchema),
  skippedStepRunIds: z.array(z.string()),
}).strict();
export type EndGoalResultWire = z.infer<typeof EndGoalResultWireSchema>;

/** `reconcile_goal_action`: the action as it now stands — what was found (`reconciliation`, its
 *  Decision) and whether the requester decided to run it again (its Decision). The run's status
 *  does not change: it was set due, and stays paused until the requester resumes it. */
export const ReconcileGoalActionResultWireSchema = GoalOperationResultWireSchema.extend({
  // Only an action whose outcome was unknown is reconciled, so it has no refusal code.
  action: StepActionWireSchema.omit({ failureCode: true })
    .extend({
      reconciliationDecisionId: z.string().nullable(),
      reexecuteDecisionId: z.string().nullable(),
    })
    .strict(),
}).strict();
export type ReconcileGoalActionResultWire = z.infer<typeof ReconcileGoalActionResultWireSchema>;

/** S11 GO8b `approve_step_trial`: the approval — the one made, or (`changed: false`) the pending
 *  one that already approves the same trial. The run's status does not change: a paused run stays
 *  paused for its requester to resume. */
export const ApproveStepTrialResultWireSchema = GoalOperationResultWireSchema.extend({
  approvalId: z.string(),
}).strict();
export type ApproveStepTrialResultWire = z.infer<typeof ApproveStepTrialResultWireSchema>;

/** S11 GO9a `decide_plan_revision`: the planner's revision as decided. Accepted, it is in force
 *  like a revision the requester made (`revise_goal`'s fields), and `resumed` says whether the run
 *  was resumed with it; rejected, nothing else changed. */
export const DecidePlanRevisionResultWireSchema = ReviseGoalResultWireSchema.extend({
  decision: PlanRevisionDecisionSchema,
  resumed: z.boolean(),
}).strict();
export type DecidePlanRevisionResultWire = z.infer<typeof DecidePlanRevisionResultWireSchema>;
