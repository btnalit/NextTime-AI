import { z } from 'zod';
import {
  ChangeChannelSchema,
  ChangeItemClassificationSchema,
  ChangeItemStateSchema,
  ChangeRollbackBlockerSchema,
  ChangeSegmentStatusSchema,
  ChangeSourceKindSchema,
  ChangeWideningReasonCodeSchema,
  PrincipalKindSchema,
} from '../enums.js';

/**
 * wire/change-plan: the ChangePlan core's records as the console reads them (S11 P1-B,
 * docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–§3.4, §5.4; the kernel's
 * `application/change-plan`). A **segment** is one change applied to a workspace from one source
 * (a pack — a module is a pack with one ontology component), in one transaction, by one person;
 * its **items** are what it changed, each with its state before and after. Projected by
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

/** One item of `get_change_segment`, by kind. `ontology_version`: it published `after` as the
 *  family's next version; `before` was the family's head then (null: not installed). */
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
]);
export type ChangeItemWire = z.infer<typeof ChangeItemWireSchema>;

/** `get_change_segment`: a segment with its items, in order. */
export const ChangeSegmentDetailWireSchema = z
  .object({
    segment: ChangeSegmentWireSchema,
    items: z.array(ChangeItemWireSchema),
  })
  .strict();
export type ChangeSegmentDetailWire = z.infer<typeof ChangeSegmentDetailWireSchema>;

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

/** One item of a rollback dry run, by kind. `ontology_version`: the family goes back from `from`
 *  (the version the item published) to `to` (the version before it; null — the family is no longer
 *  installed). Its classification is the rollback's own, by the same whitelist as applying
 *  (I-A4): an `authority_widening` item is confirmed by its ordinal in `roll_back_change_segment`. */
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
      /** Why this item cannot be rolled back now; null when it can. */
      blocker: ChangeRollbackBlockerSchema.nullable(),
      /** For `blocker: 'replaced'`: the segment whose change came after this one — roll that one
       *  back first; null when the later change was made outside the ChangePlan core, and for every
       *  other blocker. */
      blockedBy: z.object({ segmentId: z.string() }).strict().nullable(),
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

/** Which ChangeItem put an ontology family's installed version there (`list_workspace_modules`'s
 *  `provenance`). `recorded`: `segmentId`'s item — applied by `appliedBy` at `appliedAt`, or, for
 *  `channel: 'platform'`, by the platform on the workspace's behalf. `provenance_unknown`: installed
 *  before the ChangePlan core recorded changes, or published outside it — nothing to roll back
 *  from here. `not_installed`: no published version. */
export const OntologyProvenanceWireSchema = z.discriminatedUnion('status', [
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
export type OntologyProvenanceWire = z.infer<typeof OntologyProvenanceWireSchema>;
