import { z } from 'zod';
import { PublishableStatusSchema, WorkerDefinitionKindSchema } from '../enums.js';
import { ProcedureStepSchema } from '../procedure.js';
import { SkillApplicableSchema } from '../skill.js';

/**
 * wire/worker: WorkerDefinition / Skill / Procedure wire shapes (docs/wire-contract-conventions.md
 * §5, S3.7) — mirror `application/gateway/handlers.ts`'s `toWireWorkerDefinition` and
 * `application/gateway/skill-procedure-handlers.ts`'s own inline projections (all already
 * ISO-string clean, no wire fix needed).
 */

export const WorkerDefinitionWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    kind: WorkerDefinitionKindSchema,
    status: PublishableStatusSchema,
    definition: z.record(z.string(), z.unknown()),
    proposedBy: z.string(),
    publishedBy: z.string().nullable(),
    createdAt: z.string(),
    publishedAt: z.string().nullable(),
  })
  .strict();
export type WorkerDefinitionWire = z.infer<typeof WorkerDefinitionWireSchema>;

/** `list_skills` item shape (skill-procedure-handlers.ts's `listSkillsHandler` — a hand-picked
 *  subset of `SkillRow`: no `markdown`/`createdAt`/`publishedAt`/`proposedBy`/`publishedBy`). */
export const SkillSummaryWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    name: z.string(),
    description: z.string(),
    applicable: SkillApplicableSchema,
  })
  .strict();
export type SkillSummaryWire = z.infer<typeof SkillSummaryWireSchema>;

/** `propose_skill`'s result. */
export const SkillProposeResultWireSchema = SkillSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
  name: true,
});

/** `publish_skill`/`deprecate_skill`'s result. */
export const SkillPublishResultWireSchema = SkillSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
});

/** `list_procedures` item shape (skill-procedure-handlers.ts's `listProceduresHandler`). */
export const ProcedureSummaryWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    name: z.string(),
    description: z.string(),
    steps: z.array(ProcedureStepSchema),
  })
  .strict();
export type ProcedureSummaryWire = z.infer<typeof ProcedureSummaryWireSchema>;

export const ProcedureProposeResultWireSchema = ProcedureSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
  name: true,
});

export const ProcedurePublishResultWireSchema = ProcedureSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
});
