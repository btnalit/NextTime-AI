import { z } from 'zod';

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

export const ProcedureWorkerStepSchema = z
  .object({
    kind: z.literal('worker'),
    definitionId: z.string().min(1),
    version: z.number().int().positive(),
    description: z.string().optional(),
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
  })
  .strict();
export type ProposeProcedureContent = z.infer<typeof ProposeProcedureContentSchema>;
