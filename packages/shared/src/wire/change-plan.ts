import { z } from 'zod';
import { OperationFieldsSchema } from '../action-description.js';
import {
  ChangeChannelSchema,
  ChangeItemClassificationSchema,
  ChangeItemKindSchema,
  ChangeItemStateSchema,
  ChangePlanSegmentAuthoritySchema,
  ChangePlanSegmentStatusSchema,
  ChangePlanStatusSchema,
  ChangeRollbackBlockerSchema,
  ChangeSegmentStatusSchema,
  ChangeSourceKindSchema,
  ChangeVerificationTriggerSchema,
  ChangeWideningReasonCodeSchema,
  DraftOriginSchema,
  OperationItemFieldSchema,
  PackInstallStatusSchema,
  PackRequirementStateSchema,
  PrincipalKindSchema,
} from '../enums.js';
import { OntologyDefinitionSchema } from '../ontology-definition.js';
import {
  PublishedSkillDescriptionSchema,
  PublishedSkillNameSchema,
  SkillApplicableSchema,
} from '../skill.js';

/**
 * wire/change-plan: the ChangePlan core's records as the console reads them (S11 P1-B,
 * docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–§3.4, §5.4; the kernel's
 * `application/change-plan`). A **segment** is one change applied to a workspace from one source
 * (a pack — a module is a pack with one ontology component), in one transaction, by one person;
 * its **items** are what it changed — a version of an ontology family, a Skill or a `worker`
 * WorkerDefinition published, or a revision of an Operation's governance — each with its state
 * before and after. A segment can be verified, again and again: whether what it wrote is still in
 * effect and the systems its source needs are in place (S11 P1-E). Projected by
 * `application/gateway/change-segment-handlers.ts`.
 *
 * Workspace segments only (§5.4 "第一版收窄"). Their contents are read in the owning workspace and
 * nowhere else (§5.4 "工作区段的内容只在该工作区可见"): every capability here is `scope:'workspace'`.
 */

/** A principal named on a change record, resolved (`displayName` null when it has none). */
export const ChangePrincipalRefWireSchema = z
  .object({
    id: z.string(),
    kind: PrincipalKindSchema,
    displayName: z.string().nullable(),
  })
  .strict();
export type ChangePrincipalRefWire = z.infer<typeof ChangePrincipalRefWireSchema>;

/** Where a segment came from: a pack (a module) at a version, and the digest of the content its
 *  items were built from. */
export const ChangeSourceWireSchema = z
  .object({
    kind: ChangeSourceKindSchema,
    name: z.string(),
    version: z.string(),
    digest: z.string(),
  })
  .strict();
export type ChangeSourceWire = z.infer<typeof ChangeSourceWireSchema>;

/** One reason an item widens authority (I-A4): where in the item, and why. */
export const ChangeWideningReasonWireSchema = z
  .object({
    path: z.string(),
    reason: ChangeWideningReasonCodeSchema,
  })
  .strict();
export type ChangeWideningReasonWire = z.infer<typeof ChangeWideningReasonWireSchema>;

/** `list_change_segments`' item, and the head of `get_change_segment` / the result of
 *  `roll_back_change_segment`. Times are ISO 8601. `channel: 'platform'`: the platform applied it
 *  on the workspace's behalf (workspace creation's default modules) — `proposedBy` / `appliedBy`
 *  then name the workspace's first owner, who did nothing themselves. */
export const ChangeSegmentWireSchema = z
  .object({
    id: z.string(),
    planId: z.string(),
    channel: ChangeChannelSchema,
    source: ChangeSourceWireSchema,
    status: ChangeSegmentStatusSchema,
    proposedBy: ChangePrincipalRefWireSchema,
    appliedBy: ChangePrincipalRefWireSchema,
    appliedAt: z.string(),
    verifiedAt: z.string().nullable(),
    rolledBackBy: ChangePrincipalRefWireSchema.nullable(),
    rolledBackAt: z.string().nullable(),
    itemCount: z.number().int().positive(),
    /** Of `itemCount`, how many were `authority_widening` (each confirmed by `appliedBy`). */
    wideningItemCount: z.number().int().nonnegative(),
  })
  .strict();
export type ChangeSegmentWire = z.infer<typeof ChangeSegmentWireSchema>;

/** An `ontology_version` item's target: the ontology family's stable name and its
 *  `ontology_versions.id`. */
export const OntologyVersionChangeTargetWireSchema = z
  .object({
    family: z.string(),
    ontologyId: z.string(),
  })
  .strict();
export type OntologyVersionChangeTargetWire = z.infer<typeof OntologyVersionChangeTargetWireSchema>;

/** One version of an ontology family, by number and the digest of its definition. */
export const OntologyVersionRefWireSchema = z
  .object({
    version: z.number().int().positive(),
    definitionDigest: z.string(),
  })
  .strict();
export type OntologyVersionRefWire = z.infer<typeof OntologyVersionRefWireSchema>;

/** A `skill_version` item's target: the Skill family (`skills.id`) and the name it is mounted
 *  under (a Skill name belongs to one family, `skill_name_conflict`). */
export const SkillVersionChangeTargetWireSchema = z
  .object({
    skillId: z.string(),
    name: z.string(),
  })
  .strict();
export type SkillVersionChangeTargetWire = z.infer<typeof SkillVersionChangeTargetWireSchema>;

/** A `worker_definition_version` item's target: the WorkerDefinition family
 *  (`worker_definitions.id`, kind `worker`) and its `name`. */
export const WorkerDefinitionVersionChangeTargetWireSchema = z
  .object({
    definitionId: z.string(),
    name: z.string(),
  })
  .strict();
export type WorkerDefinitionVersionChangeTargetWire = z.infer<
  typeof WorkerDefinitionVersionChangeTargetWireSchema
>;

/** One version of a Skill or WorkerDefinition family, by number and the digest of its content
 *  (a Skill's name, description, body and `applicable`; a WorkerDefinition's `definition`). */
export const ContentVersionRefWireSchema = z
  .object({
    version: z.number().int().positive(),
    contentDigest: z.string(),
  })
  .strict();
export type ContentVersionRefWire = z.infer<typeof ContentVersionRefWireSchema>;

/** An `operation_version` item's target: one Operation of one Gatekeeper of the workspace —
 *  `gatekeeperName` as it was named when the item was applied. */
export const OperationVersionChangeTargetWireSchema = z
  .object({
    gatekeeperId: z.string(),
    gatekeeperName: z.string(),
    name: z.string(),
  })
  .strict();
export type OperationVersionChangeTargetWire = z.infer<
  typeof OperationVersionChangeTargetWireSchema
>;

/** A governance field's value on an Operation version (`blast_radius`, `auto_approvable`,
 *  `await_decision`, `reads`, `writes`, `description`); `null` when the version has none. */
export const OperationFieldValueWireSchema = z
  .union([z.string(), z.boolean(), z.array(z.string())])
  .nullable();
export type OperationFieldValueWire = z.infer<typeof OperationFieldValueWireSchema>;

/** One field an Operation revision changes, before and after. */
export const OperationFieldChangeWireSchema = z
  .object({
    field: OperationItemFieldSchema,
    before: OperationFieldValueWireSchema,
    after: OperationFieldValueWireSchema,
  })
  .strict();
export type OperationFieldChangeWire = z.infer<typeof OperationFieldChangeWireSchema>;

/** A Gatekeeper of the workspace, by id and the name people know it by (its id for one no longer
 *  there). */
export const ChangeGateRefWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();
export type ChangeGateRefWire = z.infer<typeof ChangeGateRefWireSchema>;

const ChangeItemCommonShape = {
  id: z.string(),
  /** 1-based position in its segment; items apply in this order and roll back in reverse. */
  ordinal: z.number().int().positive(),
  classification: ChangeItemClassificationSchema,
  /** Empty exactly for a `not_widening` item. */
  widening: z.array(ChangeWideningReasonWireSchema),
  /** Who confirmed this `authority_widening` item (the segment's applier); null otherwise. */
  confirmedBy: ChangePrincipalRefWireSchema.nullable(),
  /** The item's target now, read when this was called. */
  state: ChangeItemStateSchema,
  /** For `state: 'replaced'`: the segment whose item wrote what is there now; null when that was
   *  written outside the ChangePlan core (`publish_ontology_version`, `seed-domain-pack`), and
   *  for every other state. */
  replacedBy: z.object({ segmentId: z.string() }).strict().nullable(),
};

/** One item of `get_change_segment`, by kind. Each published `after` as its family's next
 *  version; `before` was the family's head then (null: not installed). `ontology_version`: an
 *  ontology family; `skill_version`: a Skill; `worker_definition_version`: a `worker`
 *  WorkerDefinition, `gates` the gates of each side's version (S11 P1-E2: what the Worker could act
 *  on before and after; read from the versions now, `null` for a side not there or no longer
 *  holding what the item recorded); `operation_version`: a revision of a published Operation
 *  (`before` the version it replaced, never null), `fields` the governance fields it changed (read
 *  from the two versions now; empty when either no longer holds what the item recorded). */
export const ChangeItemWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...ChangeItemCommonShape,
      kind: z.literal('ontology_version'),
      target: OntologyVersionChangeTargetWireSchema,
      before: OntologyVersionRefWireSchema.nullable(),
      after: OntologyVersionRefWireSchema,
    })
    .strict(),
  z
    .object({
      ...ChangeItemCommonShape,
      kind: z.literal('skill_version'),
      target: SkillVersionChangeTargetWireSchema,
      before: ContentVersionRefWireSchema.nullable(),
      after: ContentVersionRefWireSchema,
    })
    .strict(),
  z
    .object({
      ...ChangeItemCommonShape,
      kind: z.literal('worker_definition_version'),
      target: WorkerDefinitionVersionChangeTargetWireSchema,
      before: ContentVersionRefWireSchema.nullable(),
      after: ContentVersionRefWireSchema,
      gates: z
        .object({
          before: z.array(ChangeGateRefWireSchema).nullable(),
          after: z.array(ChangeGateRefWireSchema).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ChangeItemCommonShape,
      kind: z.literal('operation_version'),
      target: OperationVersionChangeTargetWireSchema,
      before: ContentVersionRefWireSchema,
      after: ContentVersionRefWireSchema,
      fields: z.array(OperationFieldChangeWireSchema),
    })
    .strict(),
]);
export type ChangeItemWire = z.infer<typeof ChangeItemWireSchema>;

/** A Gatekeeper of the workspace as a verification saw it: its live health, through the gate's own
 *  health endpoint (the probe `get_gatekeeper` makes). */
export const ChangeRequirementGateWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    health: z.enum(['ok', 'unreachable', 'unauthorized']),
  })
  .strict();
export type ChangeRequirementGateWire = z.infer<typeof ChangeRequirementGateWireSchema>;

/** One system the segment's source needs (a connector its pack version `requires`), as a
 *  verification found it: where it stands in the workspace and, when `connected`, the health of
 *  each of its gates there. Met when `connected` with at least one gate `ok`. */
export const ChangeRequirementCheckWireSchema = z
  .object({
    connector: z.string(),
    state: PackRequirementStateSchema,
    gates: z.array(ChangeRequirementGateWireSchema),
    met: z.boolean(),
  })
  .strict();
export type ChangeRequirementCheckWire = z.infer<typeof ChangeRequirementCheckWireSchema>;

/** S11 P1-F: one pack the segment's source builds on (its pack version's `requires.packs`), as a
 *  verification found it: how the workspace has it (that pack's own status and installed version).
 *  Met when installed at `minVersion` or later. */
export const ChangeDependencyCheckWireSchema = z
  .object({
    name: z.string(),
    minVersion: z.number().int().positive(),
    status: PackInstallStatusSchema,
    installedVersion: z.number().int().positive().nullable(),
    met: z.boolean(),
  })
  .strict();
export type ChangeDependencyCheckWire = z.infer<typeof ChangeDependencyCheckWireSchema>;

/** One item as a verification found it: whether what it wrote is still in effect. */
export const ChangeItemCheckWireSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: ChangeItemKindSchema,
    state: ChangeItemStateSchema,
  })
  .strict();
export type ChangeItemCheckWire = z.infer<typeof ChangeItemCheckWireSchema>;

/** A segment's latest verification run (S11 P1-E, `verify_change_segment`): who ran it and how
 *  (`system`: right after the install, as the person who installed), when, each item's state and
 *  each needed system's and pack's. `passed` — every item `in_effect`, every requirement and
 *  dependency met, and the source
 *  version still in this deployment (`sourceFound`: without it the systems it needs are not
 *  known, so the run cannot pass). The segment's status follows: `verified` or
 *  `verification_failed`. */
export const ChangeVerificationWireSchema = z
  .object({
    trigger: ChangeVerificationTriggerSchema,
    verifiedBy: ChangePrincipalRefWireSchema,
    verifiedAt: z.string(),
    passed: z.boolean(),
    sourceFound: z.boolean(),
    items: z.array(ChangeItemCheckWireSchema),
    requirements: z.array(ChangeRequirementCheckWireSchema),
    /** S11 P1-F: empty for a run recorded before, and for a source that builds on no pack. */
    dependencies: z.array(ChangeDependencyCheckWireSchema),
  })
  .strict();
export type ChangeVerificationWire = z.infer<typeof ChangeVerificationWireSchema>;

/** `get_change_segment`: a segment with its items, in order, and its latest verification (null:
 *  never verified). */
export const ChangeSegmentDetailWireSchema = z
  .object({
    segment: ChangeSegmentWireSchema,
    items: z.array(ChangeItemWireSchema),
    verification: ChangeVerificationWireSchema.nullable(),
  })
  .strict();
export type ChangeSegmentDetailWire = z.infer<typeof ChangeSegmentDetailWireSchema>;

/** `verify_change_segment`: the segment after the run, and the run. */
export const ChangeVerificationResultWireSchema = z
  .object({
    segment: ChangeSegmentWireSchema,
    verification: ChangeVerificationWireSchema,
  })
  .strict();
export type ChangeVerificationResultWire = z.infer<typeof ChangeVerificationResultWireSchema>;

/** How long a segment's verification is not run again (`verify_change_segment` refuses 429
 *  `change_verification_cooldown` within it): each run probes the gates its source needs. */
export const CHANGE_VERIFICATION_COOLDOWN_SECONDS = 60;

/** Type names of an ontology definition, per section (a rollback's `removes`: declared by the
 *  version it rolls back from and not by the one it returns to). */
export const OntologyTypeNamesWireSchema = z
  .object({
    objectTypes: z.array(z.string()),
    linkTypes: z.array(z.string()),
    actionTypes: z.array(z.string()),
  })
  .strict();
export type OntologyTypeNamesWire = z.infer<typeof OntologyTypeNamesWireSchema>;

const RollbackBlockedByShape = {
  /** Why this item cannot be rolled back now; null when it can. */
  blocker: ChangeRollbackBlockerSchema.nullable(),
  /** For `blocker: 'replaced'`: the segment whose change came after this one — roll that one back
   *  first; null when the later change was made outside the ChangePlan core, and for every other
   *  blocker. */
  blockedBy: z.object({ segmentId: z.string() }).strict().nullable(),
};

/** One item of a rollback dry run, by kind. The family goes back from `from` (the version the item
 *  published) to `to` (the version before it; null — the family is no longer installed: a Skill
 *  no Worker mounts any more, a WorkerDefinition nobody can invoke). Its classification is the
 *  rollback's own, by the same whitelist as applying (I-A4): an `authority_widening` item is
 *  confirmed by its ordinal in `roll_back_change_segment`. Only an `ontology_version` item can be
 *  blocked by `namespace_conflict`; a Skill or WorkerDefinition rollback only retires a version, so
 *  it never gives a name a second owner. */
export const ChangeRollbackItemWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ordinal: z.number().int().positive(),
      kind: z.literal('ontology_version'),
      target: OntologyVersionChangeTargetWireSchema,
      from: OntologyVersionRefWireSchema,
      to: OntologyVersionRefWireSchema.nullable(),
      classification: ChangeItemClassificationSchema,
      widening: z.array(ChangeWideningReasonWireSchema),
      removes: OntologyTypeNamesWireSchema,
      ...RollbackBlockedByShape,
      /** For `blocker: 'namespace_conflict'`: the type names (`object` / `action`) another family
       *  declares now (I-P1). Empty otherwise. */
      conflicts: z.array(
        z
          .object({
            kind: z.enum(['object', 'action']),
            name: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ordinal: z.number().int().positive(),
      kind: z.literal('skill_version'),
      target: SkillVersionChangeTargetWireSchema,
      from: ContentVersionRefWireSchema,
      to: ContentVersionRefWireSchema.nullable(),
      classification: ChangeItemClassificationSchema,
      widening: z.array(ChangeWideningReasonWireSchema),
      ...RollbackBlockedByShape,
    })
    .strict(),
  z
    .object({
      ordinal: z.number().int().positive(),
      kind: z.literal('worker_definition_version'),
      target: WorkerDefinitionVersionChangeTargetWireSchema,
      from: ContentVersionRefWireSchema,
      to: ContentVersionRefWireSchema.nullable(),
      classification: ChangeItemClassificationSchema,
      widening: z.array(ChangeWideningReasonWireSchema),
      ...RollbackBlockedByShape,
    })
    .strict(),
  // An Operation has one published version at a time and a retired one is never published again
  // (I12): rolling a revision back publishes a further version carrying `to`'s content — `to`
  // names the version whose content comes back, not the row that will be live.
  z
    .object({
      ordinal: z.number().int().positive(),
      kind: z.literal('operation_version'),
      target: OperationVersionChangeTargetWireSchema,
      from: ContentVersionRefWireSchema,
      to: ContentVersionRefWireSchema,
      classification: ChangeItemClassificationSchema,
      widening: z.array(ChangeWideningReasonWireSchema),
      ...RollbackBlockedByShape,
    })
    .strict(),
]);
export type ChangeRollbackItemWire = z.infer<typeof ChangeRollbackItemWireSchema>;

/** Most graph rows `preview_roll_back_change_segment` / `preview_pack_install` count per kind
 *  before they stop. */
export const CHANGE_ROLLBACK_IN_USE_CAP = 1000;

/** Objects and active Facts of a type a change takes out of the workspace's ontology. They stay
 *  (S10 I-P4: data already written is never removed); new writes are checked against the ontology
 *  without those types. Each count stops at `CHANGE_ROLLBACK_IN_USE_CAP`; `capped` says one did. */
export const ChangeInUseWireSchema = z
  .object({
    objects: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
    capped: z.boolean(),
  })
  .strict();
export type ChangeInUseWire = z.infer<typeof ChangeInUseWireSchema>;

/** `preview_roll_back_change_segment`: what rolling a segment back would do, without doing it. */
export const ChangeRollbackPreviewWireSchema = z
  .object({
    segment: ChangeSegmentWireSchema,
    /** The segment is not rolled back and no item has a blocker. */
    possible: z.boolean(),
    /** In the order they would be rolled back: the segment's items in reverse. */
    items: z.array(ChangeRollbackItemWireSchema),
    /** Of the types the rollback takes out (every item's `removes`, minus a LinkType name another
     *  family still declares). */
    inUse: ChangeInUseWireSchema,
  })
  .strict();
export type ChangeRollbackPreviewWire = z.infer<typeof ChangeRollbackPreviewWireSchema>;

/** Which ChangeItem put a family's installed version there — an ontology family's
 *  (`list_workspace_modules`' `provenance`), or a pack component's (`list_packs`). `recorded`:
 *  `segmentId`'s item — applied by `appliedBy` at `appliedAt`, or, for `channel: 'platform'`, by the
 *  platform on the workspace's behalf. `provenance_unknown`: installed before the ChangePlan core
 *  recorded changes, or published outside it — nothing to roll back from here. `not_installed`: no
 *  published version. */
export const ChangeProvenanceWireSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('recorded'),
      segmentId: z.string(),
      segmentStatus: ChangeSegmentStatusSchema,
      channel: ChangeChannelSchema,
      appliedBy: ChangePrincipalRefWireSchema,
      appliedAt: z.string(),
    })
    .strict(),
  z.object({ status: z.literal('provenance_unknown') }).strict(),
  z.object({ status: z.literal('not_installed') }).strict(),
]);
export type ChangeProvenanceWire = z.infer<typeof ChangeProvenanceWireSchema>;

// ---------------------------------------------------------------------------------------------
// S11 AA3b: ChangePlan proposals (plan §3.1–§3.3, §5.4; migration governance 0032; the kernel's
// `application/change-plan/proposals.ts`). A **plan** is what a platform administrator's admin
// agent proposes from its trial workspace; each **segment** of it is addressed to one workspace,
// whose owner decides it (AA3b-2: preview, apply, reject). What a segment proposes is a list of
// workspace-agnostic intents — a Skill or a Worker by name, an ontology family by name, an
// Operation by gate instance and name — that the target workspace's own dry run resolves (F5): the
// agent cannot see another workspace's ids, and the plan never names one of its objects.
//
// Read by the agent that proposed it (`agent_get_change_plan`, its administrator's plans in its
// trial workspace) and by platform administrators (`get_change_plan`). Neither sees what a target
// workspace's dry run found there, nor who decided a segment (a Principal of that workspace): a
// segment carries its status, when it was decided, and the reason given when one was.
// ---------------------------------------------------------------------------------------------

/** A plan's title: what it changes, in a line. */
export const CHANGE_PLAN_TITLE_MAX_LENGTH = 200;
/** A plan's description: why, and what to look at. */
export const CHANGE_PLAN_DESCRIPTION_MAX_LENGTH = 4000;
/** Segments in one plan (one per target workspace). */
export const CHANGE_PLAN_MAX_SEGMENTS = 20;
/** Items in one segment. */
export const CHANGE_PLAN_SEGMENT_MAX_ITEMS = 50;
/** A reason given when a segment is rejected or withdrawn. */
export const CHANGE_PLAN_REASON_MAX_LENGTH = 2000;
/** F11: plans one platform user may propose per UTC day, across every trial workspace (429
 *  `change_plan_quota_exceeded` past it). Withdrawn plans count. */
export const CHANGE_PLAN_DAILY_LIMIT = 20;
/** At most this many plans in one list (newest first; `truncated` says there are more). */
export const CHANGE_PLAN_LIST_LIMIT = 100;
/** A plan's `sourceName`: the name its new Skill and Worker families are derived under in a target
 *  workspace (AA3b-2, `derivePackComponentId(sourceName, kind, name)`) — a pack's name rule, so the
 *  plan exported as a pack keeps their ids. migrations/governance/0032's check is the same. */
export const CHANGE_PLAN_SOURCE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** An ontology family's name in an `ontology_version` intent: the same rule. */
export const CHANGE_PLAN_ONTOLOGY_FAMILY_PATTERN = CHANGE_PLAN_SOURCE_NAME_PATTERN;
/** A gate instance's id in an `operation_version` intent (`gate_instances.gate_id`, core 0023's
 *  check; `PLATFORM_STATE_GATE_ID_PATTERN` is the same, and the test says so). */
export const CHANGE_PLAN_GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** The Operation fields an `operation_version` intent may set — `OPERATION_ITEM_FIELD_VALUES`, each
 *  with the Operation's own schema; at least one. The kernel checks the revised Operation as a
 *  whole against the target's live version when the owner previews it. */
const ChangePlanOperationSetSchema = OperationFieldsSchema.pick({
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
export const ChangePlanItemIntentWireSchema = z.discriminatedUnion('kind', [
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
      family: z.string().max(64).regex(CHANGE_PLAN_ONTOLOGY_FAMILY_PATTERN),
      definition: OntologyDefinitionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation_version'),
      gateId: z.string().regex(CHANGE_PLAN_GATE_ID_PATTERN),
      name: z.string().min(1).max(200),
      set: ChangePlanOperationSetSchema,
    })
    .strict(),
]);
export type ChangePlanItemIntentWire = z.infer<typeof ChangePlanItemIntentWireSchema>;

/** One segment as proposed: the workspace it is for, and what it changes there. */
export const ChangePlanSegmentProposalWireSchema = z
  .object({
    /** A workspace the administrator named (the agent sees no other workspace's id). An unknown,
     *  disabled or trial workspace is refused, all three alike (400 change_plan_target_unavailable,
     *  F10 / §3.2): the refusal says nothing about which. */
    targetWorkspaceId: z.guid(),
    items: z.array(ChangePlanItemIntentWireSchema).min(1).max(CHANGE_PLAN_SEGMENT_MAX_ITEMS),
  })
  .strict();
export type ChangePlanSegmentProposalWire = z.infer<typeof ChangePlanSegmentProposalWireSchema>;

/** Who proposed a plan: the platform user whose admin agent did, by the name they had then. */
export const ChangePlanProposerWireSchema = z
  .object({ userId: z.string(), displayName: z.string() })
  .strict();
export type ChangePlanProposerWire = z.infer<typeof ChangePlanProposerWireSchema>;

/** A segment of a plan, as its proposer and the platform read it. */
export const ChangePlanSegmentWireSchema = z
  .object({
    id: z.string(),
    ordinal: z.number().int().positive(),
    authority: ChangePlanSegmentAuthoritySchema,
    /** The workspace a `workspace` segment is for. */
    targetWorkspaceId: z.string().nullable(),
    items: z.array(ChangePlanItemIntentWireSchema),
    /** `sha256:` of what the segment proposes (its target and items). */
    contentDigest: z.string(),
    status: ChangePlanSegmentStatusSchema,
    /** When it was applied, rejected or withdrawn. */
    decidedAt: z.string().nullable(),
    /** Withdrawn: through the administrator's agent, or by a platform administrator in the
     *  console. */
    withdrawnOrigin: DraftOriginSchema.exclude(['platform']).nullable(),
    /** Rejected: the owner's reason. Withdrawn: the reason, when one was given. */
    reason: z.string().nullable(),
    rolledBackAt: z.string().nullable(),
  })
  .strict();
export type ChangePlanSegmentWire = z.infer<typeof ChangePlanSegmentWireSchema>;

/** How many of a plan's segments are in each status. */
export const ChangePlanSegmentCountsWireSchema = z
  .object({
    proposed: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    withdrawn: z.number().int().nonnegative(),
    rolledBack: z.number().int().nonnegative(),
  })
  .strict();
export type ChangePlanSegmentCountsWire = z.infer<typeof ChangePlanSegmentCountsWireSchema>;

const changePlanHeadShape = {
  id: z.string(),
  title: z.string(),
  sourceName: z.string(),
  /** I-A7: who drafted it — an admin agent, always. */
  origin: DraftOriginSchema,
  proposedBy: ChangePlanProposerWireSchema,
  proposedAt: z.string(),
  /** Derived from its segments' (`changePlanStatusOf`). */
  status: ChangePlanStatusSchema,
  segmentCounts: ChangePlanSegmentCountsWireSchema,
};

/** A plan in a list. */
export const ChangePlanSummaryWireSchema = z.object(changePlanHeadShape).strict();
export type ChangePlanSummaryWire = z.infer<typeof ChangePlanSummaryWireSchema>;

/** A plan with its segments, in order. */
export const ChangePlanWireSchema = z
  .object({
    ...changePlanHeadShape,
    description: z.string(),
    /** `sha256:` of what the plan proposes: its title, description, source name and each
     *  segment's digest, in order. */
    contentDigest: z.string(),
    segments: z.array(ChangePlanSegmentWireSchema),
  })
  .strict();
export type ChangePlanWire = z.infer<typeof ChangePlanWireSchema>;
