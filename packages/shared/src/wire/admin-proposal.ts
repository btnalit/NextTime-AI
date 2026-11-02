import { z } from 'zod';
import { OperationFieldsSchema } from '../action-description.js';
import {
  AdminProposalSegmentAuthoritySchema,
  AdminProposalSegmentStatusSchema,
  AdminProposalStatusSchema,
  AdminProposalWithdrawnOriginSchema,
  DraftOriginSchema,
} from '../enums.js';
import { OntologyDefinitionSchema } from '../ontology-definition.js';
import {
  PublishedSkillDescriptionSchema,
  PublishedSkillNameSchema,
  SkillApplicableSchema,
} from '../skill.js';
import {
  gateInstanceCreateFields,
  isGenericConnector,
  refineGateInstanceCreate,
} from './gate-instance-fields.js';

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

/** Items in a platform segment. */
export const ADMIN_PROPOSAL_PLATFORM_MAX_ITEMS = 10;

/**
 * S11 AA3c (F6, F-c1–F-c3): what a platform segment proposes — `gate_instance`, a new gate-host
 * instance, with exactly what `create_gate_instance` takes (`gateInstanceCreateFields`: a preset and
 * an address, or a transport kind, an address, a credential mode and the OpenAPI document an http
 * instance imports from). Never a credential, and never the generic connector: without a preset it
 * names the connector of the system it serves (`connector`), so a workspace can enable the instance
 * from the catalog once a platform administrator has. Applying it creates the instance
 * `discovered`; the administrator then enters a shared credential when it takes one, waits for the
 * gate host to announce its Operations, reviews them and enables it.
 */
export const AdminProposalGateInstanceIntentWireSchema = z
  .object({ kind: z.literal('gate_instance'), ...gateInstanceCreateFields })
  .strict()
  .superRefine((value, ctx) => {
    refineGateInstanceCreate(value, ctx);
    if (value.preset !== undefined) return;
    if (value.connector === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['connector'],
        message:
          'name the connector of the system it serves: without a preset, a proposed instance never joins a generic connector',
      });
    } else if (isGenericConnector(value.connector)) {
      ctx.addIssue({
        code: 'custom',
        path: ['connector'],
        message: `"${value.connector}" is a generic connector, whose mode governs every workspace connecting that kind itself: name the system's own`,
      });
    }
  });
export type AdminProposalGateInstanceIntentWire = z.infer<
  typeof AdminProposalGateInstanceIntentWireSchema
>;

/** One intent of a platform segment ({@link ADMIN_PROPOSAL_PLATFORM_ITEM_KIND_VALUES}). */
export const AdminProposalPlatformItemIntentWireSchema = z.discriminatedUnion('kind', [
  AdminProposalGateInstanceIntentWireSchema,
]);
export type AdminProposalPlatformItemIntentWire = z.infer<
  typeof AdminProposalPlatformItemIntentWireSchema
>;

/** An intent of either kind of segment, as a proposal reads back: a workspace segment's
 *  ({@link AdminProposalItemIntentWireSchema}) or a platform segment's. */
export const AdminProposalAnyItemIntentWireSchema = z.union([
  AdminProposalItemIntentWireSchema,
  AdminProposalPlatformItemIntentWireSchema,
]);
export type AdminProposalAnyItemIntentWire = z.infer<typeof AdminProposalAnyItemIntentWireSchema>;

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

/** S11 AA3c: the platform segment as proposed — what a platform administrator applies on the
 *  platform plane. At most one per proposal; each workspace segment of the proposal then depends on
 *  it (applied only once it is). */
export const AdminProposalPlatformSegmentInputWireSchema = z
  .object({
    items: z
      .array(AdminProposalPlatformItemIntentWireSchema)
      .min(1)
      .max(ADMIN_PROPOSAL_PLATFORM_MAX_ITEMS),
  })
  .strict();
export type AdminProposalPlatformSegmentInputWire = z.infer<
  typeof AdminProposalPlatformSegmentInputWireSchema
>;

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
    /** The workspace a `workspace` segment is for; `null` for the `platform` segment. */
    targetWorkspaceId: z.string().nullable(),
    /** A workspace segment's intents, or the platform segment's (`gate_instance`). */
    items: z.array(AdminProposalAnyItemIntentWireSchema),
    /** `sha256:` of what the segment proposes (its target and items). */
    contentDigest: z.string(),
    status: AdminProposalSegmentStatusSchema,
    /** When it was applied, rejected or withdrawn. */
    decidedAt: z.string().nullable(),
    /** Withdrawn: through the administrator's agent, by a platform administrator in the console,
     *  or because the proposal's platform segment was rejected or rolled back (`platform_segment`). */
    withdrawnOrigin: AdminProposalWithdrawnOriginSchema.nullable(),
    /** Rejected: the reason its owner — or, for the platform segment, a platform administrator —
     *  gave, for platform administrators (`get_admin_proposal`); `null` to the agent, which reads
     *  that the segment was rejected, not why. Withdrawn: the reason, when one was given, to both. */
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
  /** Legacy 619: its platform segment's status — `proposed` is a platform administrator's to
   *  decide, before any of its workspace segments can be applied (F8); `null` when it has none.
   *  `segmentCounts` counts it too. */
  platformSegmentStatus: AdminProposalSegmentStatusSchema.nullable(),
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

// ---------------------------------------------------------------------------------------------
// S11 AA4-0 (coordinator 2026-11-02, on #929): what the agent reads back. A platform segment's
// `gate_instance` items reach the target workspace's owner and platform administrators as proposed
// — their `target` and `manifestSource` passed F9's rule when proposed (no user, password, query or
// fragment) — but never the agent, even the addresses it typed itself: a later session of the same
// administrator's agent, or a proposal another session made, would otherwise read an address the
// platform never shows the agent anywhere else (`platform_state_*` lists no address). The agent's
// reads (`propose_admin_proposal`'s result, `agent_get_admin_proposal`,
// `agent_withdraw_admin_proposal`) carry each such item without the two, marked `addressWithheld`.
// ---------------------------------------------------------------------------------------------

/** A platform segment's `gate_instance` item as the agent reads it: everything but its addresses. */
export const AdminProposalWithheldGateInstanceWireSchema = z
  .object({
    kind: z.literal('gate_instance'),
    gateId: gateInstanceCreateFields.gateId,
    displayName: gateInstanceCreateFields.displayName,
    preset: gateInstanceCreateFields.preset,
    transportKind: gateInstanceCreateFields.transportKind,
    credentialMode: gateInstanceCreateFields.credentialMode,
    connector: gateInstanceCreateFields.connector,
    /** Always `true`: `target` and `manifestSource` are not read back to the agent. */
    addressWithheld: z.literal(true),
  })
  .strict();
export type AdminProposalWithheldGateInstanceWire = z.infer<
  typeof AdminProposalWithheldGateInstanceWireSchema
>;

/** A segment of a proposal as the agent that proposed it reads it. */
export const AgentAdminProposalSegmentWireSchema = AdminProposalSegmentWireSchema.extend({
  /** A workspace segment's intents as proposed, or the platform segment's without addresses. */
  items: z.array(
    z.union([AdminProposalItemIntentWireSchema, AdminProposalWithheldGateInstanceWireSchema]),
  ),
}).strict();
export type AgentAdminProposalSegmentWire = z.infer<typeof AgentAdminProposalSegmentWireSchema>;

/** A proposal with its segments, as the agent that proposed it reads it. */
export const AgentAdminProposalWireSchema = AdminProposalWireSchema.extend({
  segments: z.array(AgentAdminProposalSegmentWireSchema),
}).strict();
export type AgentAdminProposalWire = z.infer<typeof AgentAdminProposalWireSchema>;
