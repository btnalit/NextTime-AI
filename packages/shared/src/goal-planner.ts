import { z } from 'zod';
import { MAX_REVISION_REASON_CHARS } from './goal-plan.js';
import type { OutputSchema } from './output-schema.js';

/**
 * goal-planner (S11 GO9a; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.1, §4.3):
 * what the goal planner reports and what the requester decides about it — shared by the kernel
 * that runs planning rounds (`application/goal/planner.ts`), the wire that shows them
 * (`wire/goal.ts`) and the console.
 *
 * A planner is a Worker the kernel starts for a GoalRun paused on a failed step, when the
 * requester let it when they confirmed the goal (`confirm_goal`'s `planner`). It acts for the
 * requester, observes nothing and can do nothing but report (I-P1): it proposes a new plan
 * (`revise`) or says it found none that helps (`no_revision`). What it proposes is checked exactly
 * like a revision the requester writes (`revise_goal`) and has no effect until the requester
 * accepts it (`decide_plan_revision`). It carries no budget: a planner never changes what the goal
 * may spend (I-P3).
 */

export const PLANNER_DECISION_VALUES = ['revise', 'no_revision'] as const;
export type PlannerDecision = (typeof PLANNER_DECISION_VALUES)[number];

/** The planner Task's output contract (`tasks.output_schema`, held by `report_task_result`). Its
 *  `plan` is held to the full plan checks only after the contract: the platform answers a plan
 *  that does not pass them with the places it fails (`output.plan.…`), like a contract problem. */
export const PLANNER_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  description:
    'Your proposal for the goal: decision revise with the whole new plan, or no_revision when no change of plan would help. reason says why, for the requester to read.',
  properties: {
    decision: { type: 'string', enum: [...PLANNER_DECISION_VALUES] },
    plan: {
      type: 'object',
      description:
        'decision revise only: the whole plan as it should be from now on — every step, the ones kept unchanged included, and the acceptance checks. A step left out is removed and its Worker stopped.',
    },
    reason: { type: 'string', minLength: 1, maxLength: MAX_REVISION_REASON_CHARS },
  },
  required: ['decision', 'reason'],
  additionalProperties: false,
};

/** A planner's report, as its output contract and the platform's own rule (a plan exactly with
 *  `revise`) read it; the plan itself is checked by the kernel's plan validation. */
export const PlannerOutputSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('revise'),
      plan: z.record(z.string(), z.unknown()),
      reason: z.string().min(1).max(MAX_REVISION_REASON_CHARS),
    })
    .strict(),
  z
    .object({
      decision: z.literal('no_revision'),
      reason: z.string().min(1).max(MAX_REVISION_REASON_CHARS),
    })
    .strict(),
]);
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/** What the requester decides about a revision the planner proposed (`decide_plan_revision`). */
export const PLAN_REVISION_DECISION_VALUES = ['accept', 'reject'] as const;
export type PlanRevisionDecision = (typeof PLAN_REVISION_DECISION_VALUES)[number];
export const PlanRevisionDecisionSchema = z.enum(PLAN_REVISION_DECISION_VALUES);
