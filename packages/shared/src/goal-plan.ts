import { z } from 'zod';
import { StepOutputSchemaSchema } from './output-schema.js';
import {
  FactCheckSchema,
  ObservationAbsenceCheckSchema,
  ObservationCheckSchema,
  PREDICATE_PATH_MAX,
} from './predicate.js';

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

/** S11 GO5d-1: input bindings one step carries at most. */
export const MAX_STEP_BINDINGS = 16;
/** S11 GO5d-1: where a binding puts its value in the step's input — field names separated by
 *  dots, at most 8 deep (`host`, `target.hosts`). Fields only, no array positions: a binding fills
 *  a field, it does not splice a list. */
export const BINDING_TARGET_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,7}$/;
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export const StepKeySchema = z.string().regex(STEP_KEY_PATTERN);

/** S11 GO3d: how the platform reconciles one action of the step. Its check is an observation and
 *  a predicate over the result, or — S11 「门确认不存在」, for an action that removes something — an
 *  absence call with no predicate: the gate confirming the thing is not there shows the removal
 *  took effect. */
export const StepReconcileSchema = z
  .object({
    action: z
      .object({
        gatekeeperId: z.guid(),
        operation: z.string().min(1).max(200),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    check: z.union([ObservationCheckSchema, ObservationAbsenceCheckSchema]),
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

/** An acceptance check the platform observes to confirm something is not there: the goal's and a
 *  step's (S11 「门确认不存在」 B). */
const ObserveAbsentCheckSchema = z
  .object({
    kind: z.literal('observe_absent'),
    key: StepKeySchema,
    check: ObservationAbsenceCheckSchema,
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
  ObserveAbsentCheckSchema,
  FactPredicateCheckSchema,
]);

export type StepAcceptanceCheck = z.infer<typeof StepAcceptanceCheckSchema>;

/**
 * S11 GO5d-1 (plan §4.5): one input binding of a step — the value its attempt's input gets at `to`
 * comes from step `from`'s output, read with the JMESPath `path` (the expressions predicates use).
 * The advancer assembles the input when an attempt starts, from the output of `from`'s attempt that
 * succeeded; what the kernel checks of a binding is `application/goal/plan.ts`'s.
 */
export const StepBindingSchema = z
  .object({
    to: z
      .string()
      .regex(BINDING_TARGET_PATTERN, 'must be field names separated by dots, e.g. target.host')
      .refine((to) => !to.split('.').some((field) => RESERVED_FIELD_NAMES.has(field)), {
        message: 'goes through __proto__, constructor or prototype',
      }),
    from: StepKeySchema,
    path: z.string().trim().min(1).max(PREDICATE_PATH_MAX),
  })
  .strict();

export type StepBinding = z.infer<typeof StepBindingSchema>;

/** S11 GO8a: the longest responsibility statement a WorkerSpec adds to its base's prompt. */
export const MAX_WORKER_SPEC_INSTRUCTIONS_CHARS = 8000;
/** S11 GO8a: entries one WorkerSpec list (Skills, gates, capabilities, observation scope) holds at
 *  most. */
export const MAX_WORKER_SPEC_LIST = 64;
/** S11 GO8a: the most tokens a WorkerSpec may cap one attempt of its step at. */
export const MAX_WORKER_SPEC_TOKEN_BUDGET = 10_000_000;

const WorkerSpecRefSchema = z.string().trim().min(1).max(200);

/**
 * S11 GO8a (plan §3.1, §4.4, I-G8): the Worker one step wants this time — its plan entry's
 * `worker` (a published WorkerDefinition) as the base, with what this step sets differently. Each
 * field present replaces the base's: `instructions` is added after the base's system prompt (it
 * never replaces it); `skills` (published names or ids, as a WorkerDefinition names them),
 * `gates`, `capabilities` and `model` replace the base's lists and model; `observeScope` is the
 * gates the step's Task may observe (S11 GO11, `tasks.observe_scope`); `tokenBudget` caps each
 * attempt of the step below what is left of the goal's budget.
 *
 * A WorkerSpec is never published and never reused: GO16 proposes a combination that kept working
 * as a WorkerDefinition. Whether a step with one may start is the kernel's admission
 * (`application/task/step-attempt.ts`): what it runs with never goes beyond the Worker ceiling and
 * what the requester holds, whatever the WorkerSpec says.
 */
export const WorkerSpecSchema = z
  .object({
    instructions: z
      .string()
      .max(MAX_WORKER_SPEC_INSTRUCTIONS_CHARS)
      .regex(/\S/, 'says nothing')
      .optional(),
    skills: z.array(WorkerSpecRefSchema).max(MAX_WORKER_SPEC_LIST).optional(),
    gates: z.array(z.guid()).max(MAX_WORKER_SPEC_LIST).optional(),
    capabilities: z.array(WorkerSpecRefSchema).max(MAX_WORKER_SPEC_LIST).optional(),
    model: WorkerSpecRefSchema.optional(),
    observeScope: z.array(z.guid()).max(MAX_WORKER_SPEC_LIST).optional(),
    tokenBudget: z.number().int().positive().max(MAX_WORKER_SPEC_TOKEN_BUDGET).optional(),
  })
  .strict()
  .refine((spec) => Object.values(spec).some((value) => value !== undefined), {
    message: 'sets nothing — leave the spec out to run the Worker as it is',
  });

export type WorkerSpec = z.infer<typeof WorkerSpecSchema>;

export const PlanStepSchema = z
  .object({
    key: StepKeySchema,
    worker: z
      .object({
        definitionId: z.guid(),
        version: z.number().int().positive(),
      })
      .strict(),
    /** S11 GO8a: what this step's Worker sets differently from `worker`. */
    spec: WorkerSpecSchema.optional(),
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
    /** S11 GO5d-1: the structured output the step's Worker reports (`output-schema.ts`). */
    outputSchema: StepOutputSchemaSchema.optional(),
    /** S11 GO5d-1: inputs the step takes from earlier steps' outputs. */
    bindings: z.array(StepBindingSchema).min(1).max(MAX_STEP_BINDINGS).optional(),
  })
  .strict();

export type PlanStep = z.infer<typeof PlanStepSchema>;

/** S11 GO4a: one acceptance check of the plan. */
export const AcceptanceCheckSchema = z.discriminatedUnion('kind', [
  ObservePredicateCheckSchema,
  ObserveAbsentCheckSchema,
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
 * S11 GO8b (I-G8): one draft Skill version a trial of a step mounts — what a person approves
 * (`approve_step_trial`), named by id and version and bound to its content by `draftDigest`
 * (`SkillSummaryWire.draftDigest`: a discarded draft's version is taken again by the next
 * proposal, so the version alone does not name what was read).
 */
export const StepTrialDraftSchema = z
  .object({
    skillId: z.guid(),
    version: z.number().int().positive(),
    draftDigest: z.string().min(1),
  })
  .strict();
export type StepTrialDraft = z.infer<typeof StepTrialDraftSchema>;

/** S11 GO8b: a draft a trial would mount, as a hint names it — with its name and who proposed it
 *  (whoever may publish it may approve its trial: its proposer when a builder, or the workspace
 *  owner). */
export const StepTrialDraftInfoSchema = z
  .object({
    skillId: z.string(),
    version: z.number().int().positive(),
    name: z.string(),
    draftDigest: z.string(),
    proposedBy: z.string(),
  })
  .strict();
export type StepTrialDraftInfo = z.infer<typeof StepTrialDraftInfoSchema>;

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
 *       - `step_definition_excluded` — the requester's AgentProfile excludes the WorkerDefinition;
 *       - legacy 513, `step_account_not_connected` — the step's WorkerDefinition declares gates
 *         that run in `connected_account` mode on which the requester has not connected their own
 *         account (`gatekeeperIds`): the gate would refuse the step's calls
 *         (`credential_unavailable`). Asked of the gate, and only in a read served to a person —
 *         never in a result an agent or a Handle receives;
 *   - S11 GO8a, what the admission of a step's WorkerSpec says (I-G8): `step_gate_not_held` and
 *     `step_capability_not_held` above cover the gates and capabilities its WorkerSpec sets, and
 *     besides:
 *       - `step_skill_draft` — it names Skills that are only drafts (`skillRefs`): the step waits
 *         for approval and does not start. S11 GO8b: `trial` names what a person approves for
 *         one trial of the step (`approve_step_trial`) — the digest of its WorkerSpec and each
 *         draft version — when every draft Skill it names is exactly one draft; a step whose
 *         trial is approved, and still matches, has no such hint;
 *       - `step_skill_deprecated` — it names Skills whose published versions were all deprecated
 *         (`skillRefs`): refused until the plan names others;
 *       - `step_model_not_offered` — the model it sets is not in the llm-proxy catalog any more
 *         (`model`; the plan was validated against it): refused until the catalog offers it again
 *         or the plan names another;
 *       - `step_model_not_allowed` — the model it sets is not one the workspace allows (`model`):
 *         refused until the plan names another.
 *   - legacy 544, what keeps a step from starting (or being tried again) as the plan pins it:
 *       - `step_worker_unavailable` — the WorkerDefinition version the step names is no longer
 *         published (deprecated, or not there): refused until the plan names another;
 *       - `step_skill_version_unavailable` — a step waiting to be tried again: a Skill version its
 *         previous attempt mounted, which a later attempt mounts again, can no longer be (a
 *         published version deprecated since; a draft whose trial was approved changed, discarded
 *         or deprecated since) — `skillRefs` names each as 「name v<version>」: refused until the
 *         plan is revised (the step then starts afresh, admitted as a first attempt).
 *     Worked out on every read like the others: authority and Skills change, and the attempt's own
 *     admission when the step starts decides (`application/task/step-attempt.ts`).
 *   Where they appear: every hint but `requester_confirm_only` is on the proposal of a run still
 *   proposed and — S11 GO8a — on the current revision of a paused run, for its steps that have not
 *   started an attempt, so a pause can say which step would not start and why.
 */
export const PLAN_HINT_CODE_VALUES = [
  'requester_confirm_only',
  'requester_cannot_start_workers',
  'step_gate_not_held',
  'step_capability_not_held',
  'step_definition_excluded',
  'step_account_not_connected',
  'step_skill_draft',
  'step_skill_deprecated',
  'step_model_not_offered',
  'step_model_not_allowed',
  'step_worker_unavailable',
  'step_skill_version_unavailable',
] as const;
export type PlanHintCode = (typeof PLAN_HINT_CODE_VALUES)[number];
export const PlanHintCodeSchema = z.enum(PLAN_HINT_CODE_VALUES);

export const PlanHintSchema = z
  .object({
    code: PlanHintCodeSchema,
    message: z.string(),
    /** The step the hint is about (the `step_*` codes). */
    stepKey: StepKeySchema.optional(),
    /** The gates a `step_gate_not_held` step declares and the requester cannot act on; for
     *  `step_account_not_connected`, those on which the requester has not connected an account. */
    gatekeeperIds: z.array(z.guid()).optional(),
    /** The execute-class capabilities a `step_capability_not_held` step declares and the
     *  requester does not hold. */
    capabilityNames: z.array(z.string()).optional(),
    /** S11 GO8a: the Skills a `step_skill_draft` / `step_skill_deprecated` step's WorkerSpec names,
     *  as it names them; legacy 544, on `step_skill_version_unavailable`, the Skill versions a
     *  retry would mount and cannot, each 「name v<version>」. */
    skillRefs: z.array(z.string()).optional(),
    /** S11 GO8a: the model a `step_model_not_offered` / `step_model_not_allowed` step's WorkerSpec
     *  sets. */
    model: z.string().optional(),
    /** S11 GO8b: on `step_skill_draft`, what one trial of the step would run and a person approves
     *  — the step's WorkerSpec digest and the draft versions it would mount. */
    trial: z
      .object({
        specDigest: z.string(),
        drafts: z.array(StepTrialDraftInfoSchema).min(1),
      })
      .strict()
      .optional(),
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
    release: z.array(z.guid()).min(1).max(100).optional(),
  })
  .strict();

export type StepRemoval = z.infer<typeof StepRemovalSchema>;

/** A revision's removals, keyed by the removed step's key. A removed step not listed was
 *  terminated. */
export const StepRemovalsSchema = z.record(z.string(), StepRemovalSchema);
