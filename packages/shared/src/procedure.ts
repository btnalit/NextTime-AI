import { z } from 'zod';
import {
  MAX_PLAN_STEPS,
  MAX_STEP_ATTEMPTS,
  MAX_STEP_BINDINGS,
  StepAcceptanceCheckSchema,
  StepBindingSchema,
  StepKeySchema,
} from './goal-plan.js';
import { OUTPUT_MAX_CHARS, StepOutputSchemaSchema, isOutputJsonValue } from './output-schema.js';

/**
 * procedure: the Zod shape of a Procedure's content (design doc §5.1.4 Procedure "有序步骤引用
 * Operation / WorkerDefinition，含审批步与验证步"; §9.2 procedures row sketch; docs/development-
 * tasks.md S2.14). `procedures.name`/`.description`/`.steps` are first-class relational columns
 * (`migrations/worker/0002_skills_procedures.sql`), mirroring `skill.ts`'s own split from a single
 * opaque jsonb blob.
 *
 * Four step kinds (design doc §5.1.4 "含审批步与验证步" — approval/verify steps are procedural
 * markers with no external reference, distinct from the two step kinds that name a concrete thing
 * to invoke):
 *   - `operation` — a Gatekeeper Operation, addressed by its `{gatekeeperId, name}` identity
 *     (`governance/gatekeepers/manifest.ts`'s own `OperationIdentity` — same two fields, same
 *     names, reused rather than re-derived).
 *   - `worker` — a WorkerDefinition, addressed by its `{definitionId, version}` identity
 *     (`application/worker/definitions.ts`'s `WorkerDefinitionVersionRef`).
 *   - `approval` — a human-decision checkpoint the Procedure's own runner must honor (P5:
 *     "Workflow 引擎持久执行" territory; S2.14 only distills and validates the shape).
 *   - `verify` — a post-condition check the Procedure's own runner must honor.
 *
 * S11 GO5d-2 (plan §4.3 "Procedure 成为计划模板"): a published Procedure is also a template a goal's
 * plan is made from (`propose_goal`'s `fromProcedure`). Its `worker` steps may carry what a plan
 * step carries — `key`, `dependsOn`, `input`, `bindings`, `outputSchema`, `maxAttempts` — and a
 * binding may take its value from the parameters the goal is proposed with
 * ({@link PROCEDURE_PARAMS_SOURCE}, declared by the Procedure's `parameters` schema) instead of an
 * earlier step's output; a `verify` step may carry a structured `check` (an acceptance check the
 * platform makes). All optional: a Procedure without them makes a plan of its `worker` steps, each
 * after the one before, and its `verify` steps become checks the requester confirms. What a
 * Procedure expands to, and what it cannot (an `operation` or `approval` step is not a goal step),
 * is the kernel's `application/goal/from-procedure.ts`.
 *
 * Two validation tiers, mirroring `skill.ts`'s own split ("propose is permissive, publish is the
 * gate"): {@link ProposeProcedureContentSchema} accepts any step list (structurally valid, but
 * `operation`/`worker` references are not resolved against the graph yet); publish-time reference
 * resolution (`getPublishedOperation`/`requirePublishedWorkerDefinition`) is
 * `application/worker/procedures.ts`'s job — it needs a database round trip per step, which a pure
 * Zod schema cannot perform.
 */

export const ProcedureOperationStepSchema = z
  .object({
    kind: z.literal('operation'),
    gatekeeperId: z.string().min(1),
    operationName: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();
export type ProcedureOperationStep = z.infer<typeof ProcedureOperationStepSchema>;

/** S11 GO5d-2: where a template binding takes its value from the parameters a goal is proposed
 *  with, not from an earlier step's output. A step key starts with a letter or digit, so it never
 *  reads as this. */
export const PROCEDURE_PARAMS_SOURCE = '$params';

/** S11 GO5d-2: a binding of a Procedure's `worker` step — a plan step's (`StepBindingSchema`), or
 *  one whose `from` is {@link PROCEDURE_PARAMS_SOURCE}: its `path` reads the goal's parameters, and
 *  the value is put in the step's input when the plan is made. */
export const ProcedureBindingSchema = StepBindingSchema.extend({
  from: z.union([StepKeySchema, z.literal(PROCEDURE_PARAMS_SOURCE)]),
});
export type ProcedureBinding = z.infer<typeof ProcedureBindingSchema>;

export const ProcedureWorkerStepSchema = z
  .object({
    kind: z.literal('worker'),
    definitionId: z.string().min(1),
    version: z.number().int().positive(),
    description: z.string().optional(),
    // S11 GO5d-2: as the plan step it becomes (`goal-plan.ts` `PlanStepSchema`); see the module
    // comment for what each defaults to.
    key: StepKeySchema.optional(),
    dependsOn: z.array(StepKeySchema).max(MAX_PLAN_STEPS).optional(),
    input: z.unknown().optional(),
    bindings: z.array(ProcedureBindingSchema).min(1).max(MAX_STEP_BINDINGS).optional(),
    outputSchema: StepOutputSchemaSchema.optional(),
    maxAttempts: z.number().int().min(1).max(MAX_STEP_ATTEMPTS).optional(),
  })
  .strict();
export type ProcedureWorkerStep = z.infer<typeof ProcedureWorkerStepSchema>;

export const ProcedureApprovalStepSchema = z
  .object({
    kind: z.literal('approval'),
    description: z.string().min(1),
  })
  .strict();
export type ProcedureApprovalStep = z.infer<typeof ProcedureApprovalStepSchema>;

export const ProcedureVerifyStepSchema = z
  .object({
    kind: z.literal('verify'),
    description: z.string().min(1),
    /** S11 GO5d-2: the check the platform makes for it in a goal made from the Procedure — one of
     *  the goal's acceptance checks. Without one, the goal's requester confirms `description`. */
    check: StepAcceptanceCheckSchema.optional(),
  })
  .strict();
export type ProcedureVerifyStep = z.infer<typeof ProcedureVerifyStepSchema>;

export const ProcedureStepSchema = z.discriminatedUnion('kind', [
  ProcedureOperationStepSchema,
  ProcedureWorkerStepSchema,
  ProcedureApprovalStepSchema,
  ProcedureVerifyStepSchema,
]);
export type ProcedureStep = z.infer<typeof ProcedureStepSchema>;

/** Propose-time content (permissive — see this module's doc comment). */
export const ProposeProcedureContentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    steps: z.array(ProcedureStepSchema),
    /** S11 GO5d-2: the parameters a goal made from the Procedure is proposed with — the same
     *  bounded schema subset as a step's output (`output-schema.ts`); what its `$params` bindings
     *  read. */
    parameters: StepOutputSchemaSchema.optional(),
  })
  .strict();
export type ProposeProcedureContent = z.infer<typeof ProposeProcedureContentSchema>;

const TEMPLATE_WORKER_FIELDS = [
  'key',
  'dependsOn',
  'input',
  'bindings',
  'outputSchema',
  'maxAttempts',
] as const;

/** S11 GO5d-2: whether a Procedure says anything of the goal plan it makes — parameters, a
 *  `worker` step with a plan step's field, or a `verify` step with a `check`. Publishing such a
 *  Procedure checks the plan it would make (the kernel's `publishProcedure`). */
export function usesPlanTemplateFields(content: {
  readonly steps: readonly ProcedureStep[];
  readonly parameters?: unknown;
}): boolean {
  if (content.parameters !== undefined && content.parameters !== null) return true;
  return content.steps.some((step) =>
    step.kind === 'worker'
      ? TEMPLATE_WORKER_FIELDS.some((field) => step[field] !== undefined)
      : step.kind === 'verify' && step.check !== undefined,
  );
}

/** S11 GO5d-2: `propose_goal`'s `fromProcedure` — make the goal's plan from a published Procedure
 *  (its latest published version unless `version` names one) with `parameters`, which the
 *  Procedure's `parameters` schema checks and its `$params` bindings read. A JSON object of at most
 *  {@link OUTPUT_MAX_CHARS} characters, like a step's output. */
export const GoalFromProcedureSchema = z
  .object({
    procedureId: z.string().uuid(),
    version: z.number().int().positive().optional(),
    parameters: z
      .record(z.string(), z.unknown())
      .refine((parameters) => isOutputJsonValue(parameters), { message: 'must be plain JSON' })
      .refine((parameters) => JSON.stringify(parameters).length <= OUTPUT_MAX_CHARS, {
        message: `is longer than ${OUTPUT_MAX_CHARS} characters as JSON`,
      })
      .optional(),
  })
  .strict();
export type GoalFromProcedure = z.infer<typeof GoalFromProcedureSchema>;
