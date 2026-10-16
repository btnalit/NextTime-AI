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
 * log (`transition-log.ts`). The recovery, cancel and revise paths (GO3) build on these.
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

export { getGoalRun, getPlanRevision, listStepRuns, readStepActionEffect } from './reads.js';

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
  ADVANCED_GOAL_RUN_STATUSES,
  DEFAULT_GOAL_ADVANCE_BATCH,
  DEFAULT_GOAL_ADVANCE_LEASE_MS,
  DEFAULT_GOAL_ADVANCER_INTERVAL_MS,
  DEFAULT_GOAL_RECONCILE_INTERVAL_MS,
  type GoalAdvancerTickOptions,
  type GoalWakeEventSource,
  claimDueGoalRuns,
  markReconcileDue,
  registerGoalWakeConsumer,
  runGoalAdvancerTick,
} from './advancer.js';

export type { GoalRunBudget, GoalRunRow, PlanRevisionRow, StepRunRow } from './types.js';
