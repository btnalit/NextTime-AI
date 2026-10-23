import { z } from 'zod';
import {
  ChangeChannelSchema,
  ChangeItemClassificationSchema,
  ChangeItemKindSchema,
  ChangeItemStateSchema,
  ChangeRollbackBlockerSchema,
  ChangeSegmentStatusSchema,
  ChangeSourceKindSchema,
  ChangeVerificationTriggerSchema,
  ChangeWideningReasonCodeSchema,
  OperationItemFieldSchema,
  PackRequirementStateSchema,
  PrincipalKindSchema,
} from '../enums.js';

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
 *  WorkerDefinition; `operation_version`: a revision of a published Operation (`before` the
 *  version it replaced, never null), `fields` the governance fields it changed (read from the two
 *  versions now; empty when either no longer holds what the item recorded). */
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
 *  each needed system's. `passed` — every item `in_effect`, every requirement met, and the source
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
