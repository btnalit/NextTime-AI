import { z } from 'zod';
import { ChangeItemClassificationSchema, PackInstallStatusSchema } from '../enums.js';
import {
  ChangeInUseWireSchema,
  ChangeWideningReasonWireSchema,
  OntologyProvenanceWireSchema,
  OntologyTypeNamesWireSchema,
  OntologyVersionChangeTargetWireSchema,
  OntologyVersionRefWireSchema,
} from './change-plan.js';

/**
 * wire/packs: capability packs as the console reads them (S11 P1-C; Pack Contract v1,
 * docs/s10-evolution-plan-2026-10-04.md §6; the kernel's `application/packs`). A **pack** is a
 * versioned, installable set of components this deployment ships (`packs/<name>/<version>/
 * pack.yaml`); v1 components are ontology families. What a workspace has of a pack is derived
 * from its components' current content, never stored; installing one is a ChangePlan workspace
 * segment the owner reviews first (`wire/change-plan.ts`). A module (`wire/platform.ts`) is a pack
 * with one ontology component named after it.
 */

/** One component of a pack version, by kind. `ontology`: the domain pack file (`ontology/<file>`)
 *  it publishes into an ontology family. */
export const PackComponentWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ontology'),
      family: z.string(),
      domainPack: z.string(),
    })
    .strict(),
]);
export type PackComponentWire = z.infer<typeof PackComponentWireSchema>;

/** One version of a pack, as its manifest declares it. Immutable once shipped. */
export const PackVersionWireSchema = z
  .object({
    version: z.number().int().positive(),
    /** What the pack is, in a sentence. */
    summary: z.string(),
    /** What this version brings. */
    notes: z.string(),
    /** Upgrading to it from the version before may leave Objects or Facts the workspace holds
     *  outside the new shapes. Version 1 never is. */
    breaking: z.boolean(),
    components: z.array(PackComponentWireSchema),
  })
  .strict();
export type PackVersionWire = z.infer<typeof PackVersionWireSchema>;

/** One component of the pack's latest version, as this workspace has it now. `installedVersion`:
 *  the pack version whose content for this component is installed (`null` for `not_installed` and
 *  `customized`); `provenance`: the change that installed what is there. */
export const PackComponentStateWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ontology'),
      family: z.string(),
      domainPack: z.string(),
      status: PackInstallStatusSchema,
      installedVersion: z.number().int().positive().nullable(),
      provenance: OntologyProvenanceWireSchema,
    })
    .strict(),
]);
export type PackComponentStateWire = z.infer<typeof PackComponentStateWireSchema>;

/** `list_packs`' item: a pack, its versions, and this workspace's state of it. `installedVersion`:
 *  the version whose content every component has (`null` for `not_installed` and `customized` —
 *  the components say which part is what). */
export const PackWireSchema = z
  .object({
    name: z.string(),
    /** The latest version's. */
    summary: z.string(),
    latestVersion: z.number().int().positive(),
    /** Ascending by `version`, dense from 1. */
    versions: z.array(PackVersionWireSchema),
    status: PackInstallStatusSchema,
    installedVersion: z.number().int().positive().nullable(),
    components: z.array(PackComponentStateWireSchema),
  })
  .strict();
export type PackWire = z.infer<typeof PackWireSchema>;

/** What an item changes in its family's type names (a LinkType name counts once, whatever its
 *  endpoints; `changed`: declared in both, differently). */
export const OntologyTypeChangesWireSchema = z
  .object({
    added: OntologyTypeNamesWireSchema,
    removed: OntologyTypeNamesWireSchema,
    changed: OntologyTypeNamesWireSchema,
  })
  .strict();
export type OntologyTypeChangesWire = z.infer<typeof OntologyTypeChangesWireSchema>;

/** One item of an install's dry run, by kind. `ontology_version`: publish the target version's
 *  `domainPack` into `target`'s family — `before` its head now (null: not installed), `after` the
 *  content it would install; `unchanged`: already there, so not applied. An `authority_widening`
 *  item is confirmed by its ordinal in `install_pack` (I-A4). */
export const PackInstallItemWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ordinal: z.number().int().positive(),
      kind: z.literal('ontology_version'),
      target: OntologyVersionChangeTargetWireSchema,
      domainPack: z.string(),
      before: OntologyVersionRefWireSchema.nullable(),
      after: z.object({ definitionDigest: z.string() }).strict(),
      unchanged: z.boolean(),
      classification: ChangeItemClassificationSchema,
      widening: z.array(ChangeWideningReasonWireSchema),
      types: OntologyTypeChangesWireSchema,
    })
    .strict(),
]);
export type PackInstallItemWire = z.infer<typeof PackInstallItemWireSchema>;

/** `preview_pack_install`: what installing the pack's latest version would do, without doing it. */
export const PackInstallPreviewWireSchema = z
  .object({
    /** This workspace's state of the pack now. */
    pack: PackWireSchema,
    targetVersion: z.number().int().positive(),
    /** I-A8: what the person reviews — `install_pack`'s `reviewedDigest`. */
    digest: z.string(),
    /** Every item is `unchanged`: installing records nothing. */
    unchanged: z.boolean(),
    /** The versions the install moves the workspace through, ascending: after the installed one up
     *  to the target (`outdated`); the target alone (`not_installed`, `customized`); none
     *  (`up_to_date`). Their notes are `pack.versions`'. */
    crossedVersions: z.array(z.number().int().positive()),
    /** Installing may leave Objects or Facts outside the new shapes: a crossed version is
     *  `breaking`, or — for `customized`, with no version to count from — the target is. */
    breaking: z.boolean(),
    items: z.array(PackInstallItemWireSchema),
    /** Of the types the install takes out (a type a component has now and its new version does
     *  not, unless another component of the pack declares it after the install). */
    inUse: ChangeInUseWireSchema,
  })
  .strict();
export type PackInstallPreviewWire = z.infer<typeof PackInstallPreviewWireSchema>;

/** `install_pack`: the pack's state after the install, and the segment that recorded it (`null`
 *  when nothing needed to change). */
export const PackInstallResultWireSchema = z
  .object({
    pack: PackWireSchema,
    segmentId: z.string().nullable(),
  })
  .strict();
export type PackInstallResultWire = z.infer<typeof PackInstallResultWireSchema>;
