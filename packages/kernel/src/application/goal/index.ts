/**
 * application/goal: goal-level execution — GoalRun, PlanRevision, StepRun
 * (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3, §4; S11 W1 GO1–GO4).
 *
 * This module owns `migrations/goal/` (`goal_runs`, `plan_revisions`, `step_runs`) and exposes only
 * this interface. GO1 delivers the data model: the tables, their state machines (packages/shared
 * `GOAL_RUN_TRANSITIONS`, `PLAN_REVISION_TRANSITIONS`, `STEP_RUN_TRANSITIONS`, each also enforced
 * by a DB trigger), reads, and how a step splits on its ActionRequests' columns
 * (`disposition.ts`). The deterministic advancer (GO2) and the recovery, cancel and revise paths
 * (GO3) build on these.
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

export type { GoalRunBudget, GoalRunRow, PlanRevisionRow, StepRunRow } from './types.js';
