import { z } from 'zod';
import { OperationFieldsSchema } from '../action-description.js';
import {
  AdminProposalSegmentAuthoritySchema,
  AdminProposalSegmentStatusSchema,
  AdminProposalStatusSchema,
  DraftOriginSchema,
} from '../enums.js';
import { OntologyDefinitionSchema } from '../ontology-definition.js';
import {
  PublishedSkillDescriptionSchema,
  PublishedSkillNameSchema,
  SkillApplicableSchema,
} from '../skill.js';

// ---------------------------------------------------------------------------------------------
// S11 AA3b: Admin proposals (plan §3.1–§3.3, §5.4; migration governance 0032; the kernel's
// `application/change-plan/admin-proposals.ts`). A **proposal** is what a platform administrator's admin
// agent proposes from its trial workspace; each **segment** of it is addressed to one workspace,
// whose owner decides it (AA3b-2: preview, apply, reject). What a segment proposes is a list of
// workspace-agnostic intents — a Skill or a Worker by name, an ontology family by name, an
// Operation by gate instance and name — that the target workspace's own dry run resolves (F5): the
// agent cannot see another workspace's ids, and the proposal never names one of its objects.
//
// Read by the agent that proposed it (`agent_get_admin_proposal`, its administrator's proposals in its
// trial workspace) and by platform administrators (`get_admin_proposal`). Neither sees what a target
// workspace's dry run found there, nor who decided a segment (a Principal of that workspace): a
// segment carries its status, when it was decided, and the reason given when one was — an owner's
// reason for rejecting it to platform administrators only (the agent reads that it was rejected).
// ---------------------------------------------------------------------------------------------

/** A proposal's title: what it changes, in a line. */
export const ADMIN_PROPOSAL_TITLE_MAX_LENGTH = 200;
/** A proposal's description: why, and what to look at. */
export const ADMIN_PROPOSAL_DESCRIPTION_MAX_LENGTH = 4000;
/** Segments in one proposal (one per target workspace). */
export const ADMIN_PROPOSAL_MAX_SEGMENTS = 20;
/** Items in one segment. */
export const ADMIN_PROPOSAL_SEGMENT_MAX_ITEMS = 50;
/** A reason given when a segment is rejected or withdrawn. */
export const ADMIN_PROPOSAL_REASON_MAX_LENGTH = 2000;
/** F11: proposals one platform user may make per UTC day, across every trial workspace (429
 *  `admin_proposal_quota_exceeded` past it). Withdrawn proposals count. */
export const ADMIN_PROPOSAL_DAILY_LIMIT = 20;
/** At most this many proposals in one list (newest first; `truncated` says there are more). */
export const ADMIN_PROPOSAL_LIST_LIMIT = 100;
/** A proposal's `sourceName`: the name its new Skill and Worker families are derived under in a target
 *  workspace (AA3b-2, `derivePackComponentId(sourceName, kind, name)`) — a pack's name rule, so the
 *  proposal exported as a pack keeps their ids. migrations/governance/0032's check is the same. */
export const ADMIN_PROPOSAL_SOURCE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** An ontology family's name in an `ontology_version` intent: the same rule. */
export const ADMIN_PROPOSAL_ONTOLOGY_FAMILY_PATTERN = ADMIN_PROPOSAL_SOURCE_NAME_PATTERN;
/** A gate instance's id in an `operation_version` intent (`gate_instances.gate_id`, core 0023's
 *  check; `PLATFORM_STATE_GATE_ID_PATTERN` is the same, and the test says so). */
export const ADMIN_PROPOSAL_GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** The Operation fields an `operation_version` intent may set — `OPERATION_ITEM_FIELD_VALUES`, each
 *  with the Operation's own schema; at least one. The kernel checks the revised Operation as a
 *  whole against the target's live version when the owner previews it. */
const AdminProposalOperationSetSchema = OperationFieldsSchema.pick({
  description: true,
  blast_radius: true,
  auto_approvable: true,
  await_decision: true,
  reads: true,
  writes: true,
})
  .partial()
  .strict()
  .refine((set) => Object.keys(set).length > 0, { message: 'set changes at least one field' });

/**
 * One intent of a proposed segment, by kind (`CHANGE_ITEM_KIND_VALUES`), naming its target the way
 * every workspace can resolve it:
 *  - `skill_version`: the next version of the target's Skill of this `name` — a new Skill there
 *    when it has none. The content as `propose_skill` takes it, under the published Skill rules.
 *  - `worker_definition_version`: the next version of the target's `worker` WorkerDefinition named
 *    `definition.name` — a new one when it has none. Never its `gates` or `model`: those are the
 *    target workspace's own, kept from its current version, as a pack's Worker (the kernel refuses
 *    a definition that sets either).
 *  - `ontology_version`: the next version of the ontology family named `family`, its complete new
 *    definition.
 *  - `operation_version`: a revision of how calls of the Operation `name` on the gate instance
 *    `gateId` are governed (the fields of `set`), wherever the target has that gate enabled.
 */
export const AdminProposalItemIntentWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('skill_version'),
      skill: z
        .object({
          name: PublishedSkillNameSchema,
          description: PublishedSkillDescriptionSchema,
          markdown: z.string().min(1),
          applicable: SkillApplicableSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('worker_definition_version'),
      definition: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ontology_version'),
      family: z.string().max(64).regex(ADMIN_PROPOSAL_ONTOLOGY_FAMILY_PATTERN),
      definition: OntologyDefinitionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation_version'),
      gateId: z.string().regex(ADMIN_PROPOSAL_GATE_ID_PATTERN),
      name: z.string().min(1).max(200),
      set: AdminProposalOperationSetSchema,
    })
    .strict(),
]);
export type AdminProposalItemIntentWire = z.infer<typeof AdminProposalItemIntentWireSchema>;

/** One segment as proposed: the workspace it is for, and what it changes there. */
export const AdminProposalSegmentInputWireSchema = z
  .object({
    /** A workspace the administrator named (the agent sees no other workspace's id). An unknown,
     *  disabled or trial workspace is refused, all three alike (400 admin_proposal_target_unavailable,
     *  F10 / §3.2): the refusal says nothing about which. */
    targetWorkspaceId: z.guid(),
    items: z.array(AdminProposalItemIntentWireSchema).min(1).max(ADMIN_PROPOSAL_SEGMENT_MAX_ITEMS),
  })
  .strict();
export type AdminProposalSegmentInputWire = z.infer<typeof AdminProposalSegmentInputWireSchema>;

/** Who made a proposal: the platform user whose admin agent did, by the name they had then. */
export const AdminProposalProposerWireSchema = z
  .object({ userId: z.string(), displayName: z.string() })
  .strict();
export type AdminProposalProposerWire = z.infer<typeof AdminProposalProposerWireSchema>;

/** A segment of a proposal, as its proposer and the platform read it. */
export const AdminProposalSegmentWireSchema = z
  .object({
    id: z.string(),
    ordinal: z.number().int().positive(),
    authority: AdminProposalSegmentAuthoritySchema,
    /** The workspace a `workspace` segment is for. */
    targetWorkspaceId: z.string().nullable(),
    items: z.array(AdminProposalItemIntentWireSchema),
    /** `sha256:` of what the segment proposes (its target and items). */
    contentDigest: z.string(),
    status: AdminProposalSegmentStatusSchema,
    /** When it was applied, rejected or withdrawn. */
    decidedAt: z.string().nullable(),
    /** Withdrawn: through the administrator's agent, or by a platform administrator in the
     *  console. */
    withdrawnOrigin: DraftOriginSchema.exclude(['platform']).nullable(),
    /** Rejected: the owner's reason — for platform administrators (`get_admin_proposal`); `null` to
     *  the agent, which reads that the segment was rejected, not why. Withdrawn: the reason, when
     *  one was given, to both. */
    reason: z.string().nullable(),
    rolledBackAt: z.string().nullable(),
  })
  .strict();
export type AdminProposalSegmentWire = z.infer<typeof AdminProposalSegmentWireSchema>;

/** How many of a proposal's segments are in each status. */
export const AdminProposalSegmentCountsWireSchema = z
  .object({
    proposed: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    withdrawn: z.number().int().nonnegative(),
    rolledBack: z.number().int().nonnegative(),
  })
  .strict();
export type AdminProposalSegmentCountsWire = z.infer<typeof AdminProposalSegmentCountsWireSchema>;

const adminProposalHeadShape = {
  id: z.string(),
  title: z.string(),
  sourceName: z.string(),
  /** I-A7: who drafted it — an admin agent, always. */
  origin: DraftOriginSchema,
  proposedBy: AdminProposalProposerWireSchema,
  proposedAt: z.string(),
  /** Derived from its segments' (`adminProposalStatusOf`). */
  status: AdminProposalStatusSchema,
  segmentCounts: AdminProposalSegmentCountsWireSchema,
};

/** A proposal in a list. */
export const AdminProposalSummaryWireSchema = z.object(adminProposalHeadShape).strict();
export type AdminProposalSummaryWire = z.infer<typeof AdminProposalSummaryWireSchema>;

/** A proposal with its segments, in order. */
export const AdminProposalWireSchema = z
  .object({
    ...adminProposalHeadShape,
    description: z.string(),
    /** `sha256:` of what the proposal holds: its title, description, source name and each
     *  segment's digest, in order. */
    contentDigest: z.string(),
    segments: z.array(AdminProposalSegmentWireSchema),
  })
  .strict();
export type AdminProposalWire = z.infer<typeof AdminProposalWireSchema>;
