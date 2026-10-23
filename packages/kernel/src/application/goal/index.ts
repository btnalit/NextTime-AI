/**
 * application/goal: goal-level execution — GoalRun, PlanRevision, StepRun
 * (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3, §4; S11 W1 GO1–GO4).
 *
 * This module owns `migrations/goal/` (`goal_runs`, `plan_revisions`, `step_runs`) and exposes only
 * this interface. GO1 delivers the data model: the tables, their state machines (packages/shared
 * `GOAL_RUN_TRANSITIONS`, `PLAN_REVISION_TRANSITIONS`, `STEP_RUN_TRANSITIONS`, each also enforced
 * by a DB trigger), reads, and how a step splits on its ActionRequests' columns
 * (`disposition.ts`). GO2 adds the plan's shape and checks (`plan.ts`), proposing and confirming a
 * run (`service.ts`), the deterministic advancer (`advance.ts`: one advance of one run;
 * `advancer.ts`: due claims, the outbox wake consumer and the reconcile scan) and its transition
 * log (`transition-log.ts`). GO3a adds a person stopping a run (`control.ts`: pause, resume,
 * cancel), the advance of a cancelling run (`cancelling.ts`) and the transition helpers both writers
 * share (`moves.ts`). GO3b adds an owner's hold (`control.ts`), revising a paused run's plan
 * (`revise.ts`) and pausing a run whose advances keep failing (`advancer.ts`, legacy 356). GO3c adds
 * a person settling an action whose outcome is unknown (`reconcile.ts`: a finding, a re-execute)
 * and the step-scoped identity of a step's requests (I-G4, in `governance/approval`). GO3d adds the
 * platform's own check of such an action, declared by its step (`plan.ts` `reconcile`; the
 * observation and its predicate run by `reconcile-check.ts`, the predicate judged in
 * `substrate/epistemic`). GO4a adds the goal's acceptance (`plan.ts` `acceptance`): verification
 * rounds (`acceptance-checks.ts`, goal/0005) the advance opens and judges (`advance.ts` phase V),
 * the platform's observations (`acceptance-check.ts`, sharing `platform-observation.ts` with the
 * reconcile check) and the requester's word on the outcome (`acceptance.ts`). GO4b adds a step's
 * own acceptance (`plan.ts` step `acceptance`): rounds per attempt (`step_acceptance_checks`,
 * goal/0006) the advance opens and judges when an attempt's work succeeded (`advance.ts` phase A),
 * observed by the same executor. GO4c adds checks judged on a Fact of the graph, the goal's and a
 * step's (`plan.ts` `fact_predicate`; the Fact read and judged by `fact-check.ts`, under the same
 * executor; what may serve as evidence held by the database, goal/0007). GO5a adds what the `goal`
 * reads return and who may read a run (`views.ts`). GO5b adds rejecting a proposal and binding a
 * confirmation to the revision read (`service.ts`), and sorts every refusal into not allowed for
 * this caller (`GoalRunForbiddenError`), not now (`GoalRunStateError`) and malformed
 * (`GoalRunInputError`) — the `goal` capabilities' 403, 409 and 400.
 *
 * Boundaries: it lives in `application` because the advancer creates Tasks (`application/task`) and
 * withdraws ActionRequests (`governance/approval`) in the transaction that moves a StepRun.
 * `governance/approval` never reads `step_runs` — its execution side keeps judging a request by
 * the request's own row (plan I-G9). `chat` and `host-bridge` must not import this module
 * (`.dependency-cruiser.cjs`); they will consume its events.
 */

export {
  type ActionDisposition,
  type ActionOutcomeColumns,
  type StepActionEffect,
  actionDisposition,
  stepActionEffect,
} from './disposition.js';

export {
  getGoalRun,
  getPlanRevision,
  listStepRuns,
  lockStepRuns,
  readStepActionEffect,
} from './reads.js';

export {
  type AcceptanceCheck,
  AcceptanceCheckSchema,
  DEFAULT_MAX_ATTEMPTS,
  GoalPlanSchema,
  GoalPlanValidationError,
  IMPLICIT_CONFIRM_KEY,
  MAX_ACCEPTANCE_PROMPT_CHARS,
  MAX_PLAN_ACCEPTANCE_CHECKS,
  MAX_PLAN_STEPS,
  MAX_STEP_ACCEPTANCE_CHECKS,
  MAX_STEP_ATTEMPTS,
  type GoalPlan,
  type PlanHint,
  type PlanStep,
  parsePlan,
  planHints,
  factSelectorProblems,
  isPlatformAcceptanceCheck,
  roundAcceptance,
  type StepAcceptanceCheck,
  StepAcceptanceCheckSchema,
  validatePlan,
} from './plan.js';

export {
  type FactCheckRefusal,
  type FactEvidence,
  judgeFact,
  prepareFactCheck,
  readFactEvidence,
} from './fact-check.js';

export {
  type ConfirmGoalRunInput,
  type ConfirmedGoalRun,
  type CreateGoalRunInput,
  type CreatedGoalRun,
  GoalRunForbiddenError,
  GoalRunInputError,
  GoalRunNotFoundError,
  GoalRunStateError,
  DEFAULT_MAX_PROPOSED_GOALS_PER_REQUESTER,
  ProposedGoalLimitError,
  type RejectGoalRunInput,
  confirmGoalRun,
  createGoalRun,
  maxProposedGoalsPerRequester,
  rejectGoalRun,
} from './service.js';

export {
  type AttemptVerdict,
  DEFAULT_BLOCKED_RETRY_RECHECK_MS,
  DEFAULT_QUOTA_RETRY_MS,
  type GoalAdvanceDeps,
  type GoalAdvanceOutcome,
  type GoalAdvanceTarget,
  type GoalAdvancerOptions,
  advanceGoalRun,
  defaultRetryBackoffMs,
  judgeFinishedAttempt,
  refusalPause,
} from './advance.js';

export {
  type CancelLeftovers,
  type CancellingOptions,
  DEFAULT_CANCEL_DEADLINE_MS,
  DEFAULT_CANCEL_RECHECK_MS,
  GOAL_CANCELLED_WITHDRAW_REASON,
  readCancelLeftovers,
} from './cancelling.js';

export {
  type GoalControlActor,
  type GoalControlInput,
  type GoalControlResult,
  cancelGoalRun,
  pauseGoalRun,
  releaseGoalRunHold,
  resumeGoalRun,
} from './control.js';

export {
  GOAL_REVISED_WITHDRAW_REASON,
  MAX_REVISION_REASON_LENGTH,
  type ReviseGoalRunInput,
  type RevisedGoalRun,
  reviseGoalRun,
} from './revise.js';

export {
  type ReconcileGoalActionInput,
  type ReconciledGoalAction,
  type UnresolvedGoalAction,
  listGoalRunUnresolvedActions,
  reconcileGoalAction,
} from './reconcile.js';

export {
  DEFAULT_RECONCILE_CHECK_BATCH,
  DEFAULT_RECONCILE_CHECK_INTERVAL_MS,
  DEFAULT_RECONCILE_CHECK_LEASE_MS,
  DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS,
  DEFAULT_RECONCILE_CHECK_MAX_DURATION_MS,
  type DueReconcileCheck,
  RECONCILE_CHECK_MAX_BACKOFF_MS,
  RECONCILE_RESULT_MAX_CHARS,
  type ReconcileCheckDeps,
  type ReconcileCheckOptions,
  type ReconcileCheckOutcome,
  type ReconcileCheckTickOptions,
  defaultReconcileCheckBackoffMs,
  listDueReconcileChecks,
  reconcileRetryDelayMs,
  runReconcileCheck,
  runReconcileCheckTick,
} from './reconcile-check.js';

export {
  type AcceptanceCheckRow,
  FACT_NOT_OBSERVED,
  listAcceptanceChecks,
  listStepAcceptanceChecks,
  readCurrentAcceptanceRound,
  readCurrentStepAcceptanceRound,
} from './acceptance-checks.js';

export {
  type AcceptanceCheckDeps,
  type AcceptanceCheckOptions,
  type AcceptanceCheckOutcome,
  type AcceptanceCheckTickOptions,
  DEFAULT_ACCEPTANCE_CHECK_BATCH,
  DEFAULT_ACCEPTANCE_CHECK_INTERVAL_MS,
  DEFAULT_ACCEPTANCE_CHECK_LEASE_MS,
  DEFAULT_ACCEPTANCE_CHECK_MAX_ATTEMPTS,
  DEFAULT_ACCEPTANCE_CHECK_MAX_DURATION_MS,
  type DueAcceptanceCheck,
  acceptanceRetryDelayMs,
  listDueAcceptanceChecks,
  runAcceptanceCheck,
  runAcceptanceCheckTick,
} from './acceptance-check.js';

export {
  type ConfirmGoalAcceptanceInput,
  type ConfirmGoalAcceptanceResult,
  type EndGoalRunInput,
  type EndGoalRunResult,
  GOAL_OUTCOME_NOTE_MAX,
  type GoalAcceptanceCheckView,
  type GoalAcceptanceRoundView,
  type GoalAcceptanceView,
  type OverriddenAcceptanceCheck,
  type StepAcceptanceRoundView,
  type StepAcceptanceState,
  type StepAcceptanceView,
  confirmGoalAcceptance,
  endGoalRun,
  readGoalAcceptance,
} from './acceptance.js';

export {
  ADVANCED_GOAL_RUN_STATUSES,
  DEFAULT_GOAL_ADVANCE_BATCH,
  DEFAULT_GOAL_CLEANUP_BATCH,
  DEFAULT_GOAL_ADVANCE_LEASE_MS,
  DEFAULT_GOAL_ADVANCER_INTERVAL_MS,
  DEFAULT_GOAL_RECONCILE_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_ADVANCE_FAILURES,
  type GoalAdvancerTickOptions,
  type GoalCleanupCursor,
  type GoalWakeEventSource,
  claimDueGoalRuns,
  markReconcileDue,
  recordAdvanceFailure,
  registerGoalWakeConsumer,
  runGoalAdvancerTick,
  sweepGoalCancelCleanup,
} from './advancer.js';

export {
  type GoalRunDetail,
  type GoalRunLeftoversView,
  type GoalRunStepView,
  type GoalRunSummary,
  type GoalRunUsageView,
  type GoalRunsPage,
  type GoalViewer,
  GoalRevisionNotFoundError,
  type ListGoalRunsFilter,
  type ListGoalRunsOptions,
  type PlanRevisionView,
  getGoalRunVisibleTo,
  goalVisibleTo,
  listGoalRunUnresolvedActionsVisibleTo,
  listGoalRunsVisibleTo,
  readGoalRunDetail,
  readPlanRevisionVisibleTo,
  summarizeGoalRuns,
} from './views.js';

export type {
  GoalRunBudget,
  GoalRunRow,
  PlanRevisionRow,
  StepRemoval,
  StepRunRow,
} from './types.js';
