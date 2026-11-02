import { z } from 'zod';
import {
  AdminProposalItemBlockerSchema,
  AdminProposalSegmentStatusSchema,
  ChangeItemClassificationSchema,
  ChangeItemKindSchema,
  DraftOriginSchema,
} from '../enums.js';
import { SkillApplicableSchema } from '../skill.js';
import {
  AdminProposalItemIntentWireSchema,
  AdminProposalProposerWireSchema,
} from './admin-proposal.js';
import {
  ChangeGateRefWireSchema,
  ChangePrincipalRefWireSchema,
  ChangeWideningReasonWireSchema,
  ContentVersionRefWireSchema,
  OntologyVersionChangeTargetWireSchema,
  OntologyVersionRefWireSchema,
  OperationFieldChangeWireSchema,
  OperationVersionChangeTargetWireSchema,
  SkillVersionChangeTargetWireSchema,
  WorkerDefinitionVersionChangeTargetWireSchema,
} from './change-plan.js';
import { OntologyTypeChangesWireSchema } from './packs.js';

/**
 * wire/received-admin-proposal (S11 AA3b-2; plan §3.1–§3.3, §5.4; migrations governance 0032 /
 * 0033; the kernel's `application/change-plan/admin-proposal-segments.ts`): an admin proposal's
 * segment as the owner of the workspace it is addressed to reads, previews, applies and rejects it
 * — the `modules` group's `*_admin_proposal_segment(s)` capabilities, human channel, owner only.
 *
 * The owner sees what the proposal says about itself (its title, description, source name, the
 * platform user whose admin agent proposed it) and their own segment, never the proposal's other
 * segments (F4). The preview resolves each workspace-agnostic intent to this workspace's objects
 * (F5) and dry-runs the result exactly as a pack's install does; what it finds stays here — the
 * agent and the platform read only the segment's status (and the platform an owner's reason for
 * rejecting it).
 */

/** The admin proposal a received segment belongs to, as its target's owner reads it. */
export const ReceivedAdminProposalHeadWireSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    /** What new Skill and Worker families are named under here (`derivePackComponentId`). */
    sourceName: z.string(),
    /** I-A7: who wrote it — an admin agent, always. */
    origin: DraftOriginSchema,
    proposedBy: AdminProposalProposerWireSchema,
    proposedAt: z.string(),
  })
  .strict();
export type ReceivedAdminProposalHeadWire = z.infer<typeof ReceivedAdminProposalHeadWireSchema>;

/** One segment addressed to this workspace. */
export const ReceivedAdminProposalSegmentWireSchema = z
  .object({
    id: z.string(),
    proposal: ReceivedAdminProposalHeadWireSchema,
    ordinal: z.number().int().positive(),
    /** As proposed: workspace-agnostic intents (`AdminProposalItemIntentWire`). */
    items: z.array(AdminProposalItemIntentWireSchema),
    /** `sha256:` of what the segment proposes. */
    contentDigest: z.string(),
    status: AdminProposalSegmentStatusSchema,
    /** When it was applied, rejected or withdrawn. */
    decidedAt: z.string().nullable(),
    /** The person of this workspace who applied or rejected it. */
    decidedBy: ChangePrincipalRefWireSchema.nullable(),
    /** Withdrawn: by the administrator's agent, or by a platform administrator in the console. */
    withdrawnOrigin: DraftOriginSchema.exclude(['platform']).nullable(),
    /** Rejected: the reason this workspace's owner gave. Withdrawn: the reason, when one was
     *  given. */
    reason: z.string().nullable(),
    /** Applied: the change segment that recorded it here (`get_change_segment`, 安装历史). */
    appliedSegmentId: z.string().nullable(),
    rolledBackAt: z.string().nullable(),
  })
  .strict();
export type ReceivedAdminProposalSegmentWire = z.infer<
  typeof ReceivedAdminProposalSegmentWireSchema
>;

/** An intent that does not resolve here (`ADMIN_PROPOSAL_ITEM_BLOCKER_VALUES`), by its ordinal in
 *  the segment. */
export const AdminProposalItemBlockerWireSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: ChangeItemKindSchema,
    reason: AdminProposalItemBlockerSchema,
  })
  .strict();
export type AdminProposalItemBlockerWire = z.infer<typeof AdminProposalItemBlockerWireSchema>;

const AdminProposalPreviewItemCommonShape = {
  ordinal: z.number().int().positive(),
  /** Already as proposed here: not applied, not recorded. */
  unchanged: z.boolean(),
  classification: ChangeItemClassificationSchema,
  widening: z.array(ChangeWideningReasonWireSchema),
};

/**
 * One item of the dry run, by kind — what the intent resolved to here (`target`), its family's head
 * now (`before`, null: none here yet) and what applying it writes (`after`), as the pack install's
 * preview shows them. `skill_version` / `worker_definition_version`: `newFamily` — no family here
 * goes by that name, so it starts one (under the id `derivePackComponentId(sourceName, …)` gives);
 * `changedFields` the fields that differ from the head. A Worker keeps this workspace's own `gates`
 * and `model` from its head (none for a new one: bind it here afterwards). `operation_version`:
 * `fields` the governance fields it changes. An `authority_widening` item is confirmed by its
 * ordinal in `apply_admin_proposal_segment` (I-A4).
 */
export const AdminProposalPreviewItemWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...AdminProposalPreviewItemCommonShape,
      kind: z.literal('ontology_version'),
      target: OntologyVersionChangeTargetWireSchema,
      before: OntologyVersionRefWireSchema.nullable(),
      after: z.object({ definitionDigest: z.string() }).strict(),
      types: OntologyTypeChangesWireSchema,
    })
    .strict(),
  z
    .object({
      ...AdminProposalPreviewItemCommonShape,
      kind: z.literal('skill_version'),
      target: SkillVersionChangeTargetWireSchema,
      newFamily: z.boolean(),
      before: ContentVersionRefWireSchema.nullable(),
      after: z.object({ contentDigest: z.string() }).strict(),
      skill: z
        .object({
          name: z.string(),
          description: z.string(),
          markdown: z.string(),
          applicable: SkillApplicableSchema,
        })
        .strict(),
      changedFields: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...AdminProposalPreviewItemCommonShape,
      kind: z.literal('worker_definition_version'),
      target: WorkerDefinitionVersionChangeTargetWireSchema,
      newFamily: z.boolean(),
      before: ContentVersionRefWireSchema.nullable(),
      after: z.object({ contentDigest: z.string() }).strict(),
      /** The definition it publishes, with the head's `gates` and `model` kept. */
      definition: z.record(z.string(), z.unknown()),
      /** The gates it keeps from the head (empty: none — a new Worker, or a head with none). */
      gates: z.array(ChangeGateRefWireSchema),
      changedFields: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...AdminProposalPreviewItemCommonShape,
      kind: z.literal('operation_version'),
      target: OperationVersionChangeTargetWireSchema,
      before: ContentVersionRefWireSchema,
      after: z.object({ contentDigest: z.string() }).strict(),
      fields: z.array(OperationFieldChangeWireSchema),
    })
    .strict(),
]);
export type AdminProposalPreviewItemWire = z.infer<typeof AdminProposalPreviewItemWireSchema>;

/** `preview_admin_proposal_segment`: what applying the segment here would do, without doing it. */
export const AdminProposalSegmentPreviewWireSchema = z
  .object({
    segment: ReceivedAdminProposalSegmentWireSchema,
    /** Intents that do not resolve here. While there is one, nothing is planned: `items` is empty
     *  and `digest` null, and applying is refused (409 `admin_proposal_segment_blocked`). */
    blockers: z.array(AdminProposalItemBlockerWireSchema),
    /** I-A8: what the owner reviews — `apply_admin_proposal_segment`'s `reviewedDigest`. It covers
     *  what each intent resolved to, so a resolution that changes before the apply is refused too
     *  (409 `change_plan_changed`). */
    digest: z.string().nullable(),
    /** Every item is `unchanged`: there is nothing to apply (409 `admin_proposal_segment_unchanged`;
     *  reject it instead). */
    unchanged: z.boolean(),
    items: z.array(AdminProposalPreviewItemWireSchema),
    /** Values in what the segment writes that look like credentials (the count `publish_*` makes,
     *  #526): applying needs `credentialsReviewed: true` while it is above 0. */
    suspectedSecretValues: z.number().int().nonnegative(),
    /** Where, by intent from 0 (`items[0].skill.markdown`, at most 20): never a value. */
    suspectedSecretPaths: z.array(z.string()),
  })
  .strict();
export type AdminProposalSegmentPreviewWire = z.infer<typeof AdminProposalSegmentPreviewWireSchema>;

/** `apply_admin_proposal_segment`: the segment, applied, and the change segment that recorded it
 *  here — roll it back from there (`roll_back_change_segment`). */
export const AdminProposalSegmentApplyResultWireSchema = z
  .object({
    segment: ReceivedAdminProposalSegmentWireSchema,
    changeSegmentId: z.string(),
  })
  .strict();
export type AdminProposalSegmentApplyResultWire = z.infer<
  typeof AdminProposalSegmentApplyResultWireSchema
>;
