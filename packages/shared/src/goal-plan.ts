import { z } from 'zod';
import { FactCheckSchema, ObservationCheckSchema } from './predicate.js';

/**
 * goal-plan (S11 GO5a; plan §4.3, §4.5–§4.7): the shape of a GoalRun's plan, its budget and what a
 * revision decides about a step it removes — the structure only, shared by the kernel that
 * validates and runs plans and by the wire that shows them (`wire/goal.ts`; the console's goal
 * pages, GO6). What each field means and the checks a plan passes beyond its shape (dependencies
 * acyclic, every reference published, predicates linted, no credentials) are the kernel's
 * `application/goal/plan.ts` — its module comment is the reference. Unknown fields are refused
 * rather than ignored: a field the platform does not act on must not look like it is in force.
 */

export const STEP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_PLAN_STEPS = 50;
export const MAX_STEP_ATTEMPTS = 5;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** The serialized plan, inputs included — a plan is reviewed by a person on a confirmation card. */
export const MAX_PLAN_BYTES = 256 * 1024;
/** Reconcile declarations one step carries at most. */
export const MAX_STEP_RECONCILE_DECLARATIONS = 8;
/** Acceptance checks one plan carries at most. */
export const MAX_PLAN_ACCEPTANCE_CHECKS = 16;
/** Acceptance checks one step carries at most. */
export const MAX_STEP_ACCEPTANCE_CHECKS = 8;
/** The longest prompt a `requester_confirm` check asks with. */
export const MAX_ACCEPTANCE_PROMPT_CHARS = 2000;
/** S11 GO5b: the longest reason a revision records — a sentence or two for the revision timeline. */
export const MAX_REVISION_REASON_CHARS = 2000;
/** S11 GO5b: the longest note a person gives with a goal's outcome or a finding about an action. */
export const MAX_GOAL_NOTE_CHARS = 2000;
/** S11 GO5c: the longest statement a goal is proposed with — what the requester wants, in a few
 *  sentences; the plan carries the detail. */
export const MAX_GOAL_STATEMENT_CHARS = 2000;
/** S11 GO5c: the longest idempotency key `propose_goal` takes. */
export const MAX_GOAL_IDEMPOTENCY_KEY_CHARS = 200;

export const StepKeySchema = z.string().regex(STEP_KEY_PATTERN);

/** S11 GO3d: how the platform reconciles one action of the step. */
export const StepReconcileSchema = z
  .object({
    action: z
      .object({
        gatekeeperId: z.string().uuid(),
        operation: z.string().min(1).max(200),
        params: z.record(z.unknown()).optional(),
      })
      .strict(),
    check: ObservationCheckSchema,
  })
  .strict();

export type StepReconcile = z.infer<typeof StepReconcileSchema>;

/** An acceptance check the platform observes: the goal's and a step's (S11 GO4a, GO4b). */
const ObservePredicateCheckSchema = z
  .object({
    kind: z.literal('observe_predicate'),
    key: StepKeySchema,
    check: ObservationCheckSchema,
  })
  .strict();

/** An acceptance check the platform judges on a Fact of the graph: the goal's and a step's (S11
 *  GO4c). */
const FactPredicateCheckSchema = z
  .object({
    kind: z.literal('fact_predicate'),
    key: StepKeySchema,
    fact: FactCheckSchema,
  })
  .strict();

/** S11 GO4b: one acceptance check of a step — never one that waits on a person. */
export const StepAcceptanceCheckSchema = z.discriminatedUnion('kind', [
  ObservePredicateCheckSchema,
  FactPredicateCheckSchema,
]);

export type StepAcceptanceCheck = z.infer<typeof StepAcceptanceCheckSchema>;

export const PlanStepSchema = z
  .object({
    key: StepKeySchema,
    worker: z
      .object({
        definitionId: z.string().uuid(),
        version: z.number().int().positive(),
      })
      .strict(),
    input: z.unknown().optional(),
    dependsOn: z.array(StepKeySchema).max(MAX_PLAN_STEPS).optional(),
    nested: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(MAX_STEP_ATTEMPTS).optional(),
    reconcile: z.array(StepReconcileSchema).min(1).max(MAX_STEP_RECONCILE_DECLARATIONS).optional(),
    acceptance: z
      .array(StepAcceptanceCheckSchema)
      .min(1)
      .max(MAX_STEP_ACCEPTANCE_CHECKS)
      .optional(),
  })
  .strict();

export type PlanStep = z.infer<typeof PlanStepSchema>;

/** S11 GO4a: one acceptance check of the plan. */
export const AcceptanceCheckSchema = z.discriminatedUnion('kind', [
  ObservePredicateCheckSchema,
  FactPredicateCheckSchema,
  z
    .object({
      kind: z.literal('requester_confirm'),
      key: StepKeySchema,
      prompt: z.string().max(MAX_ACCEPTANCE_PROMPT_CHARS).regex(/\S/, 'says nothing to confirm'),
    })
    .strict(),
]);

export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export const GoalPlanSchema = z
  .object({
    steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS),
    acceptance: z.array(AcceptanceCheckSchema).max(MAX_PLAN_ACCEPTANCE_CHECKS).optional(),
  })
  .strict();

export type GoalPlan = z.infer<typeof GoalPlanSchema>;

/**
 * What a person confirming a plan should know that does not stop it:
 *   - `requester_confirm_only` (the kernel's `planHints`) — no check the platform makes, so the
 *     goal is achieved only on the requester's word;
 *   - S11 GO5c, the confirmation card's check of the requester's authority (the kernel's
 *     `planAuthorityHints`, worked out when it is read, for a proposed run — authority changes):
 *     what would stop a step's first attempt from starting, the goal then pausing for a person
 *     (`authority_lost`, or the step's WorkerDefinition unavailable to them):
 *       - `requester_cannot_start_workers` — the requester (their role, or they are disabled) cannot
 *         start Workers at all; no `stepKey`;
 *       - `step_gate_not_held` — the step's WorkerDefinition declares gates the requester cannot act
 *         on (`gatekeeperIds`);
 *       - `step_capability_not_held` — it declares an execute-class capability the requester's own
 *         scope does not hold (`capabilityNames`);
 *       - `step_definition_excluded` — the requester's AgentProfile excludes the WorkerDefinition.
 */
export const PLAN_HINT_CODE_VALUES = [
  'requester_confirm_only',
  'requester_cannot_start_workers',
  'step_gate_not_held',
  'step_capability_not_held',
  'step_definition_excluded',
] as const;
export type PlanHintCode = (typeof PLAN_HINT_CODE_VALUES)[number];
export const PlanHintCodeSchema = z.enum(PLAN_HINT_CODE_VALUES);

export const PlanHintSchema = z
  .object({
    code: PlanHintCodeSchema,
    message: z.string(),
    /** The step the hint is about (the `step_*` codes). */
    stepKey: StepKeySchema.optional(),
    /** The gates a `step_gate_not_held` step declares and the requester cannot act on. */
    gatekeeperIds: z.array(z.string().uuid()).optional(),
    /** The execute-class capabilities a `step_capability_not_held` step declares and the
     *  requester does not hold. */
    capabilityNames: z.array(z.string()).optional(),
  })
  .strict();
export type PlanHint = z.infer<typeof PlanHintSchema>;

/** A GoalRun's budget (I-G6; goal/0001's `budget_*` columns and their CHECKs): tokens and step
 *  attempts spent, revisions made after the first, wall-clock seconds from confirmation. */
export const GoalBudgetSchema = z
  .object({
    maxTokens: z.number().int().positive(),
    maxSteps: z.number().int().positive(),
    maxRevisions: z.number().int().nonnegative(),
    maxWallClockSeconds: z.number().int().positive(),
  })
  .strict();

export type GoalBudget = z.infer<typeof GoalBudgetSchema>;

/** What a revision decides about one step it removes (goal/0004 `plan_revisions.removals`): its
 *  Task terminated (the default) or let to finish, and — only when let to finish — the requests
 *  awaiting a decision or queued that a person released (they are decided and run as usual). */
export const StepRemovalSchema = z
  .object({
    mode: z.enum(['terminate', 'let_finish']),
    release: z.array(z.string().uuid()).min(1).max(100).optional(),
  })
  .strict();

export type StepRemoval = z.infer<typeof StepRemovalSchema>;

/** A revision's removals, keyed by the removed step's key. A removed step not listed was
 *  terminated. */
export const StepRemovalsSchema = z.record(z.string(), StepRemovalSchema);
