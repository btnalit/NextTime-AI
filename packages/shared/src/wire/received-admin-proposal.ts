import { z } from 'zod';
import {
  AdminProposalGateAvailabilitySchema,
  AdminProposalItemBlockerSchema,
  AdminProposalSegmentStatusSchema,
  AdminProposalWithdrawnOriginSchema,
  AdminProposalWorkerGateSourceSchema,
  ChangeItemClassificationSchema,
  ChangeItemKindSchema,
  DraftOriginSchema,
  GateInstanceDriftFieldSchema,
} from '../enums.js';
import { SkillApplicableSchema } from '../skill.js';
import {
  AdminProposalItemIntentWireSchema,
  AdminProposalPlatformItemIntentWireSchema,
  AdminProposalProposerWireSchema,
} from './admin-proposal.js';
import {
  ChangeGateRefWireSchema,
  ChangePrincipalRefWireSchema,
  ChangeVerificationWireSchema,
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

/** S11 AA3c: the platform segment of the proposal a received segment belongs to — what a platform
 *  administrator applies first (a new gate instance, `gate_instance`). The received segment depends
 *  on it: while it is not `applied`, the received segment's preview plans nothing to apply (digest
 *  `null`) and applying it is refused (409 `platform_segment_not_applied`). Its items are the
 *  platform's, as proposed; who decided it is not shown here. */
export const ReceivedAdminProposalPlatformSegmentWireSchema = z
  .object({
    id: z.string(),
    status: AdminProposalSegmentStatusSchema,
    items: z.array(AdminProposalPlatformItemIntentWireSchema),
  })
  .strict();
export type ReceivedAdminProposalPlatformSegmentWire = z.infer<
  typeof ReceivedAdminProposalPlatformSegmentWireSchema
>;

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
    /** Withdrawn: by the administrator's agent, by a platform administrator in the console, or
     *  because the proposal's platform segment was rejected or rolled back (`platform_segment`). */
    withdrawnOrigin: AdminProposalWithdrawnOriginSchema.nullable(),
    /** Rejected: the reason this workspace's owner gave. Withdrawn: the reason, when one was
     *  given. */
    reason: z.string().nullable(),
    /** Applied: the change segment that recorded it here (`get_change_segment`, 安装历史). */
    appliedSegmentId: z.string().nullable(),
    rolledBackAt: z.string().nullable(),
    /** The proposal's platform segment, which this one depends on; `null` when it has none. */
    platformSegment: ReceivedAdminProposalPlatformSegmentWireSchema.nullable(),
  })
  .strict();
export type ReceivedAdminProposalSegmentWire = z.infer<
  typeof ReceivedAdminProposalSegmentWireSchema
>;

/** `get_admin_proposal_segment_counts` (S11 AA4e): how many segments addressed to this workspace
 *  wait for its owner's decision — `proposed`, the rows `list_admin_proposal_segments` lists under
 *  that status (one per proposal here: governance 0032's unique (proposal_id,
 *  target_workspace_id)). Counted by the kernel in the owner's scope, so the console's badge and
 *  notice need no list. */
export const ReceivedAdminProposalCountsWireSchema = z
  .object({ proposed: z.number().int().nonnegative() })
  .strict();
export type ReceivedAdminProposalCountsWire = z.infer<typeof ReceivedAdminProposalCountsWireSchema>;

/** A platform gate instance this workspace may enable (`enable_gate_instance`), as a pack
 *  requirement offers it. */
export const AdminProposalGateOfferWireSchema = z
  .object({ gateId: z.string(), displayName: z.string() })
  .strict();
export type AdminProposalGateOfferWire = z.infer<typeof AdminProposalGateOfferWireSchema>;

/** An intent that does not resolve here (`ADMIN_PROPOSAL_ITEM_BLOCKER_VALUES`), by its ordinal in
 *  the segment. `gateAvailability` (S11 AA3c-2, F-c1), on `gate_not_enabled` and
 *  `worker_system_not_connected`: whether the owner can enable a gate instance here now
 *  (`can_enable`) or the platform has to offer one first (`needs_platform`) —
 *  `ADMIN_PROPOSAL_GATE_AVAILABILITY_VALUES`. On `worker_system_not_connected` (S11 AA5f) only:
 *  `connector`, the system with no connected gate here, and `offered`, the instances of it the
 *  platform offers this workspace (for `can_enable`; empty otherwise). */
export const AdminProposalItemBlockerWireSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: ChangeItemKindSchema,
    reason: AdminProposalItemBlockerSchema,
    gateAvailability: AdminProposalGateAvailabilitySchema.optional(),
    connector: z.string().optional(),
    offered: z.array(AdminProposalGateOfferWireSchema).optional(),
  })
  .strict();
export type AdminProposalItemBlockerWire = z.infer<typeof AdminProposalItemBlockerWireSchema>;

/** S11 AA5f: a connected gate of a system a proposed Worker names, which this apply may bind it to
 *  — with whether the person previewing holds it (`held`: a `connect_gatekeeper` Grant of theirs
 *  covers it). Binding is what the Worker may act on; holding is whether this person can hand the
 *  gate to it when they run it (`invoke_worker` narrows a Worker to the gates its caller holds), so
 *  a gate not held is shown, never granted by applying (the 系统访问 card does that). */
export const AdminProposalWorkerGateCandidateWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    connector: z.string(),
    held: z.boolean(),
  })
  .strict();
export type AdminProposalWorkerGateCandidateWire = z.infer<
  typeof AdminProposalWorkerGateCandidateWireSchema
>;

/** S11 AA5f: how applying sets a proposed Worker's gates here (`ADMIN_PROPOSAL_WORKER_GATE_SOURCE_
 *  VALUES`). `systems`: what the proposal names (empty: none). `candidates`: for `apply`, the
 *  connected gates of those systems, in the systems' order (the item's `gates` are the ones kept —
 *  every candidate unless `workerGates` kept fewer); empty for `workspace` and `none`. */
export const AdminProposalWorkerGateBindingWireSchema = z
  .object({
    systems: z.array(z.string()),
    source: AdminProposalWorkerGateSourceSchema,
    candidates: z.array(AdminProposalWorkerGateCandidateWireSchema),
  })
  .strict();
export type AdminProposalWorkerGateBindingWire = z.infer<
  typeof AdminProposalWorkerGateBindingWireSchema
>;

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
 * and `model` from its head; one with no gates here yet that names its systems is bound to the
 * connected gates of those systems the owner keeps (`gateBinding`, S11 AA5f). `operation_version`:
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
      /** The definition it publishes, with the head's `gates` and `model` kept, or the gates this
       *  apply binds it to. */
      definition: z.record(z.string(), z.unknown()),
      /** The gates it publishes: kept from the head, or bound by this apply (`gateBinding.source`);
       *  empty: none. */
      gates: z.array(ChangeGateRefWireSchema),
      gateBinding: AdminProposalWorkerGateBindingWireSchema,
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

/** S11 AA3c-2 (F-c4): a gate instance the proposal's applied platform segment created that is not
 *  as it created it any more — `gone` (deleted since), or `drift`, the fields changed since
 *  (`GATE_INSTANCE_DRIFT_FIELD_VALUES`, the comparison its rollback makes). The owner reviewed the
 *  proposal against what the platform segment created; while one has changed, the segment is not
 *  applied (409 `platform_segment_changed`). */
export const AdminProposalPlatformInstanceChangeWireSchema = z
  .object({
    gateId: z.string(),
    gone: z.boolean(),
    drift: z.array(GateInstanceDriftFieldSchema),
  })
  .strict();
export type AdminProposalPlatformInstanceChangeWire = z.infer<
  typeof AdminProposalPlatformInstanceChangeWireSchema
>;

/** `preview_admin_proposal_segment`: what applying the segment here would do, without doing it. */
export const AdminProposalSegmentPreviewWireSchema = z
  .object({
    segment: ReceivedAdminProposalSegmentWireSchema,
    /** Intents that do not resolve here. While there is one, nothing is planned: `items` is empty
     *  and `digest` null, and applying is refused (409 `admin_proposal_segment_blocked`). While the
     *  proposal's platform segment (`segment.platformSegment`) is not applied, `items` show what
     *  applying would do and `digest` is null (409 `platform_segment_not_applied`); the same while
     *  an instance it created has changed since (`platformChanges`, 409
     *  `platform_segment_changed`). */
    blockers: z.array(AdminProposalItemBlockerWireSchema),
    /** S11 AA3c-2: the instances the applied platform segment created that changed since (see
     *  `AdminProposalPlatformInstanceChangeWire`); empty when none did, or when the proposal has no
     *  platform segment or it is not applied. */
    platformChanges: z.array(AdminProposalPlatformInstanceChangeWireSchema),
    /** S11 AA4c (governance 0036): whether this workspace is still among the targets the proposal's
     *  administrator lets their admin agent propose to. A proposal keeps the targets it was made
     *  with; when the administrator has dropped this workspace since, `digest` is null and applying
     *  is refused (409 `admin_proposal_target_no_longer_chosen`) — reject it, or ask for it to be
     *  proposed again. */
    targetChosen: z.boolean(),
    /** I-A8: what the owner reviews — `apply_admin_proposal_segment`'s `reviewedDigest`. It covers
     *  what each intent resolved to, so a resolution that changes before the apply is refused too
     *  (409 `change_plan_changed`), and — with a platform segment — that segment and the record its
     *  apply wrote (S11 AA3c-2, F8). */
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
    /** S11 AA5f: the change segment's first verification, run once the apply committed (as the
     *  owner, `trigger: system`), as `install_pack`'s is; `null` when that run could not be made —
     *  the apply stands, and the owner verifies it from 安装历史. */
    verification: ChangeVerificationWireSchema.nullable(),
  })
  .strict();
export type AdminProposalSegmentApplyResultWire = z.infer<
  typeof AdminProposalSegmentApplyResultWireSchema
>;
