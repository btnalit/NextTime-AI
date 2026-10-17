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
 * and the step-scoped identity of a step's requests (I-G4, in `governance/approval`).
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
  DEFAULT_MAX_ATTEMPTS,
  GoalPlanSchema,
  GoalPlanValidationError,
  MAX_PLAN_STEPS,
  MAX_STEP_ATTEMPTS,
  type GoalPlan,
  type PlanStep,
  parsePlan,
  validatePlan,
} from './plan.js';

export {
  type CreateGoalRunInput,
  type CreatedGoalRun,
  GoalRunNotFoundError,
  GoalRunStateError,
  confirmGoalRun,
  createGoalRun,
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

export type {
  GoalRunBudget,
  GoalRunRow,
  PlanRevisionRow,
  StepRemoval,
  StepRunRow,
} from './types.js';
