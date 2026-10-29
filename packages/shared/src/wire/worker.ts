import { z } from 'zod';
import { DraftKindSchema, PublishableStatusSchema, WorkerDefinitionKindSchema } from '../enums.js';
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

/** Legacy 145: the entry content fields the platform's entry template decides (the kernel's
 *  `application/worker/entry-template.ts`); the rest of the entry content is the workspace's. */
export const ENTRY_TEMPLATE_FIELD_VALUES = ['systemPrompt', 'capabilities'] as const;
export const EntryTemplateFieldSchema = z.enum(ENTRY_TEMPLATE_FIELD_VALUES);
export type EntryTemplateField = z.infer<typeof EntryTemplateFieldSchema>;

const EntryVersionRefWireSchema = z
  .object({ definitionId: z.string(), version: z.number().int().positive() })
  .strict();

/** `get_entry_template_status` (legacy 145): the entry template this kernel ships, and the entry
 *  definition the entry agent runs with now against it. `digest` is `sha256:<hex>` over the
 *  template fields (capabilities as a set); `current` is `null` when no entry definition is
 *  published; `differs` lists the template fields `current` has otherwise (both when `current` is
 *  `null`, none when it is up to date). */
export const EntryTemplateStatusWireSchema = z
  .object({
    template: z
      .object({
        digest: z.string(),
        systemPrompt: z.string(),
        capabilities: z.array(z.string()),
      })
      .strict(),
    current: EntryVersionRefWireSchema.extend({ digest: z.string() }).strict().nullable(),
    differs: z.array(EntryTemplateFieldSchema),
  })
  .strict();
export type EntryTemplateStatusWire = z.infer<typeof EntryTemplateStatusWireSchema>;

/** `propose_entry_template_upgrade` (legacy 145): the caller's private draft — the next version of
 *  the entry family `basedOn` names (a new family when it is `null`), with the template's fields
 *  over that version's own; `created: false` when the caller already had this very draft. */
export const EntryTemplateUpgradeWireSchema = z
  .object({
    draft: WorkerDefinitionWireSchema,
    templateDigest: z.string(),
    basedOn: EntryVersionRefWireSchema.nullable(),
    differs: z.array(EntryTemplateFieldSchema),
    created: z.boolean(),
  })
  .strict();
export type EntryTemplateUpgradeWire = z.infer<typeof EntryTemplateUpgradeWireSchema>;

/** `list_skills` item shape (skill-procedure-handlers.ts's `listSkillsHandler` — a hand-picked
 *  subset of `SkillRow`: no `markdown`/`createdAt`/`publishedAt`/`publishedBy`). `proposedBy` (the
 *  proposer's principal id) lets the owner and builders, who see every draft (D-26 rule,
 *  application/worker/draft-visibility.ts), tell whose draft they are reviewing. */
const SkillSummaryBaseWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    name: z.string(),
    description: z.string(),
    applicable: SkillApplicableSchema,
    proposedBy: z.string(),
    /** Review #493 on #764 (F1): on a `draft` only — the digest of everything this version says
     *  and who proposed it. A discarded draft is deleted and the family's next proposal takes its
     *  version again, so the version alone does not name what the reader looked at:
     *  `publish_skill` requires this back and refuses 409 `draft_changed` when the draft is no
     *  longer the one shown. Opaque to the console. */
    draftDigest: z.string().optional(),
  })
  .strict();

/** UX acceptance of #764 (P2-1): a `list_skills` row is the latest version the reader sees, so to
 *  the owner and builders a family with a pending draft lists as that draft. `inUse` is then the
 *  family's latest published version — the one Workers mount until the draft is published; absent
 *  when the row is itself published, or nothing earlier is. */
export const SkillSummaryWireSchema = SkillSummaryBaseWireSchema.extend({
  inUse: SkillSummaryBaseWireSchema.optional(),
}).strict();
export type SkillSummaryWire = z.infer<typeof SkillSummaryWireSchema>;

/** `get_skill`'s result (S8 W1-C, leftover 48 "无 get_skill" — Skill "编辑" needs the full body to
 *  prefill): the summary plus `markdown` and the lifecycle/authorship fields `list_skills` leaves
 *  out (`SkillRow`'s own shape, `application/worker/skills.ts`). */
export const SkillDetailWireSchema = SkillSummaryWireSchema.extend({
  markdown: z.string(),
  publishedBy: z.string().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type SkillDetailWire = z.infer<typeof SkillDetailWireSchema>;

/** `propose_skill`'s result — with the new draft's `draftDigest`, for publishing it as proposed. */
export const SkillProposeResultWireSchema = SkillSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
  name: true,
}).extend({ draftDigest: z.string() });

/** `publish_skill`/`deprecate_skill`'s result. */
export const SkillPublishResultWireSchema = SkillSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
});

/** `list_procedures` item shape (skill-procedure-handlers.ts's `listProceduresHandler`).
 *  `proposedBy`: as on `SkillSummaryWireSchema`. */
const ProcedureSummaryBaseWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    name: z.string(),
    description: z.string(),
    steps: z.array(ProcedureStepSchema),
    /** S11 GO5d-2: the parameters schema a goal made from it is proposed with; `null` = none. */
    parameters: z.record(z.string(), z.unknown()).nullable(),
    proposedBy: z.string(),
    /** Review #493 on #764 (F1): as `SkillSummaryWire.draftDigest`, for `publish_procedure`. */
    draftDigest: z.string().optional(),
  })
  .strict();

/** As `SkillSummaryWire.inUse`: on a draft row, the family's latest published version — the one a
 *  goal made from this Procedure uses until the draft is published. */
export const ProcedureSummaryWireSchema = ProcedureSummaryBaseWireSchema.extend({
  inUse: ProcedureSummaryBaseWireSchema.optional(),
}).strict();
export type ProcedureSummaryWire = z.infer<typeof ProcedureSummaryWireSchema>;

export const ProcedureProposeResultWireSchema = ProcedureSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
  name: true,
}).extend({ draftDigest: z.string() });

export const ProcedurePublishResultWireSchema = ProcedureSummaryWireSchema.pick({
  id: true,
  version: true,
  status: true,
});

/** `discard_draft`'s result (S8 W3 K2, leftover 82): echoes back what was deleted — never a
 *  `status` field (the row no longer exists; there is no fourth `PublishableStatus` value for
 *  this). */
export const DiscardDraftResultWireSchema = z
  .object({
    kind: DraftKindSchema,
    id: z.string(),
    version: z.number().int().positive(),
  })
  .strict();
export type DiscardDraftResultWire = z.infer<typeof DiscardDraftResultWireSchema>;
