import { z } from 'zod';
import {
  AdminProposalPlatformItemBlockerSchema,
  AdminProposalPlatformItemKindSchema,
  AdminProposalSegmentStatusSchema,
  ChangeItemClassificationSchema,
  GateInstanceDriftFieldSchema,
  GateInstanceNextStepSchema,
  PlatformChangeRollbackActionSchema,
  PlatformChangeSegmentStatusSchema,
} from '../enums.js';
import {
  AdminProposalProposerWireSchema,
  AdminProposalSegmentWireSchema,
} from './admin-proposal.js';
import { ChangeWideningReasonWireSchema } from './change-plan.js';
import { GateHostedDefinitionWireSchema } from './platform.js';
import { ReceivedAdminProposalHeadWireSchema } from './received-admin-proposal.js';

// ---------------------------------------------------------------------------------------------
// wire/platform-change (S11 AA3c; the AA3 default plan F6 / F8 / F12, aa3c-plan F-c1–F-c7;
// migration governance 0034; the kernel's `application/change-plan/platform-segments.ts`): an
// admin proposal's platform segment as a platform administrator previews, applies and rejects it on
// the platform plane, and the platform change segment its apply records — rolled back from there.
//
// The platform segment holds `gate_instance` items only (the whitelist): applying one creates a
// gate-host instance as `create_gate_instance` does, `discovered`; the administrator then enters a
// shared credential when it takes one, waits for the gate host's announce, reviews the Operations
// and enables it. Every workspace segment of the proposal depends on the platform segment: applied
// only once it is, withdrawn with it when it is rejected or rolled back, and while one of them is
// applied the platform segment is not rolled back.
// ---------------------------------------------------------------------------------------------

/** A platform user, by the name they had then. */
export const PlatformUserRefWireSchema = z
  .object({ userId: z.string(), displayName: z.string() })
  .strict();
export type PlatformUserRefWire = z.infer<typeof PlatformUserRefWireSchema>;

/** A workspace segment of the same proposal, which depends on its platform segment. */
export const PlatformSegmentDependentWireSchema = z
  .object({
    segmentId: z.string(),
    targetWorkspaceId: z.string(),
    status: AdminProposalSegmentStatusSchema,
  })
  .strict();
export type PlatformSegmentDependentWire = z.infer<typeof PlatformSegmentDependentWireSchema>;

/** An item that cannot be created as proposed now, by its ordinal in the segment. */
export const PlatformSegmentItemBlockerWireSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: AdminProposalPlatformItemKindSchema,
    reason: AdminProposalPlatformItemBlockerSchema,
  })
  .strict();
export type PlatformSegmentItemBlockerWire = z.infer<typeof PlatformSegmentItemBlockerWireSchema>;

/** The connector a `gate_instance` joins: the preset's, or the one it names — `created` when no
 *  connector has that name yet, so applying creates it (`platform_preset`). */
export const PlatformChangeConnectorWireSchema = z
  .object({ name: z.string(), created: z.boolean() })
  .strict();
export type PlatformChangeConnectorWire = z.infer<typeof PlatformChangeConnectorWireSchema>;

/**
 * One item of a platform segment's dry run: the instance applying it creates. Always
 * `authority_widening` — a new outside address, which the credential entered for it is sent to — so
 * it is confirmed by its ordinal in `apply_platform_segment` (I-A4). `nextSteps`: what the
 * administrator still does before a workspace can enable it.
 */
export const PlatformSegmentPreviewItemWireSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: z.literal('gate_instance'),
    classification: ChangeItemClassificationSchema,
    widening: z.array(ChangeWideningReasonWireSchema),
    gateId: z.string(),
    displayName: z.string(),
    connector: PlatformChangeConnectorWireSchema,
    definition: GateHostedDefinitionWireSchema,
    nextSteps: z.array(GateInstanceNextStepSchema),
  })
  .strict();
export type PlatformSegmentPreviewItemWire = z.infer<typeof PlatformSegmentPreviewItemWireSchema>;

/** `preview_platform_segment`: what applying the platform segment would create, without creating
 *  it. */
export const PlatformSegmentPreviewWireSchema = z
  .object({
    proposal: ReceivedAdminProposalHeadWireSchema,
    segment: AdminProposalSegmentWireSchema,
    /** Items that cannot be created as proposed now. While there is one, nothing is planned:
     *  `items` is empty, `digest` null, and applying is refused (409
     *  `admin_proposal_segment_blocked`). */
    blockers: z.array(PlatformSegmentItemBlockerWireSchema),
    /** I-A8: what the administrator reviews — `apply_platform_segment`'s `reviewedDigest`. */
    digest: z.string().nullable(),
    items: z.array(PlatformSegmentPreviewItemWireSchema),
    /** The proposal's workspace segments: each is applied in its workspace only once this one is. */
    dependents: z.array(PlatformSegmentDependentWireSchema),
    /** Values that look like credentials in what it writes: applying needs `credentialsReviewed:
     *  true` while above 0. */
    suspectedSecretValues: z.number().int().nonnegative(),
    /** Where, by item from 0 (`items[0].target`, at most 20): never a value. */
    suspectedSecretPaths: z.array(z.string()),
  })
  .strict();
export type PlatformSegmentPreviewWire = z.infer<typeof PlatformSegmentPreviewWireSchema>;

/** One item a platform change segment recorded: the instance it created, as created. */
export const PlatformChangeItemWireSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: z.literal('gate_instance'),
    classification: ChangeItemClassificationSchema,
    gateId: z.string(),
    displayName: z.string(),
    connector: PlatformChangeConnectorWireSchema,
    definition: GateHostedDefinitionWireSchema,
    /** The administrator who confirmed it (I-A4) — the one who applied it. */
    confirmedBy: PlatformUserRefWireSchema,
  })
  .strict();
export type PlatformChangeItemWire = z.infer<typeof PlatformChangeItemWireSchema>;

/** What a platform segment's apply recorded on the platform (`list_platform_change_segments`,
 *  `get_platform_change_segment`). Kept when the proposal's trial workspace is purged. */
export const PlatformChangeSegmentWireSchema = z
  .object({
    id: z.string(),
    source: z
      .object({
        kind: z.literal('admin_proposal'),
        /** The proposal's source name. */
        name: z.string(),
        proposalId: z.string(),
        proposalSegmentId: z.string(),
        /** The platform segment's content digest. */
        digest: z.string(),
      })
      .strict(),
    /** I-A7: the platform user whose admin agent drafted it. */
    proposedBy: AdminProposalProposerWireSchema,
    /** The dry run the administrator reviewed. */
    reviewedDigest: z.string(),
    status: PlatformChangeSegmentStatusSchema,
    appliedBy: PlatformUserRefWireSchema,
    appliedAt: z.string(),
    rolledBackBy: PlatformUserRefWireSchema.nullable(),
    rolledBackAt: z.string().nullable(),
    items: z.array(PlatformChangeItemWireSchema),
  })
  .strict();
export type PlatformChangeSegmentWire = z.infer<typeof PlatformChangeSegmentWireSchema>;

/** `apply_platform_segment`: the platform segment, applied, and what recorded it. */
export const PlatformSegmentApplyResultWireSchema = z
  .object({
    segment: AdminProposalSegmentWireSchema,
    changeSegment: PlatformChangeSegmentWireSchema,
    /** Per item, what the administrator does next (in order). */
    nextSteps: z.array(
      z.object({ gateId: z.string(), steps: z.array(GateInstanceNextStepSchema) }).strict(),
    ),
  })
  .strict();
export type PlatformSegmentApplyResultWire = z.infer<typeof PlatformSegmentApplyResultWireSchema>;

/** One item of a rollback: what it does to the instance its item created. `drift`: the fields
 *  changed since it was created (F-c3) — while there is one, nothing is rolled back (409
 *  `platform_change_drifted`). `linkedWorkspaceCount`: workspaces that enabled the instance — a
 *  disabled instance takes no new workspace, and those keep calling it (cutting calls off is
 *  `set_connector_mode`'s `disabledOperations`). */
export const PlatformChangeRollbackItemWireSchema = z
  .object({
    ordinal: z.number().int().positive(),
    gateId: z.string(),
    action: PlatformChangeRollbackActionSchema,
    drift: z.array(GateInstanceDriftFieldSchema),
    linkedWorkspaceCount: z.number().int().nonnegative(),
  })
  .strict();
export type PlatformChangeRollbackItemWire = z.infer<typeof PlatformChangeRollbackItemWireSchema>;

/** `preview_roll_back_platform_change_segment`: what rolling it back would do, writing nothing. */
export const PlatformChangeRollbackPreviewWireSchema = z
  .object({
    changeSegment: PlatformChangeSegmentWireSchema,
    items: z.array(PlatformChangeRollbackItemWireSchema),
    /** The proposal's workspace segments applied now: roll each back in its workspace first (409
     *  `dependent_segments_applied`). Read from the change segments their applies recorded in each
     *  workspace (S11 AA3c-2), which outlive the proposal: still listed once its trial workspace is
     *  purged. */
    dependentsApplied: z.array(PlatformSegmentDependentWireSchema),
    /** Nothing is drifted, no dependent is applied, and it is not rolled back already. */
    canRollBack: z.boolean(),
  })
  .strict();
export type PlatformChangeRollbackPreviewWire = z.infer<
  typeof PlatformChangeRollbackPreviewWireSchema
>;

/** `roll_back_platform_change_segment`: the change segment, rolled back, what each item did, and how
 *  many of the proposal's workspace segments still proposed it withdrew (`platform_segment`). */
export const PlatformChangeRollbackResultWireSchema = z
  .object({
    changeSegment: PlatformChangeSegmentWireSchema,
    items: z.array(PlatformChangeRollbackItemWireSchema),
    withdrawnSegments: z.number().int().nonnegative(),
  })
  .strict();
export type PlatformChangeRollbackResultWire = z.infer<
  typeof PlatformChangeRollbackResultWireSchema
>;
