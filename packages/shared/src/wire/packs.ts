import { z } from 'zod';
import {
  ChangeItemClassificationSchema,
  PackInstallStatusSchema,
  PackRequirementStateSchema,
} from '../enums.js';
import {
  ChangeGateRefWireSchema,
  ChangeInUseWireSchema,
  ChangeProvenanceWireSchema,
  ChangeVerificationWireSchema,
  ChangeWideningReasonWireSchema,
  ContentVersionRefWireSchema,
  OntologyTypeNamesWireSchema,
  OntologyVersionChangeTargetWireSchema,
  OntologyVersionRefWireSchema,
  SkillVersionChangeTargetWireSchema,
  WorkerDefinitionVersionChangeTargetWireSchema,
} from './change-plan.js';

/**
 * wire/packs: capability packs as the console reads them (S11 P1-C / P1-D; Pack Contract v1,
 * docs/s10-evolution-plan-2026-10-04.md §6; the kernel's `application/packs`). A **pack** is a
 * versioned, installable set of components this deployment ships (`packs/<name>/<version>/
 * pack.yaml`): ontology families, Skills and `worker` WorkerDefinitions. What a workspace has of a
 * pack is derived from its components' current content, never stored; installing one is a
 * ChangePlan workspace segment the owner reviews first (`wire/change-plan.ts`). A version may name
 * the systems it needs (`requiredConnectors`, P1-E); where each stands in the workspace is read,
 * not stored, and installing does not wait for them — verifying the install checks them. It may
 * also build on other packs (`requiredPacks`, P1-F): installing waits for those, since the owner
 * installs them on the same page (`dependencies` says how each stands). A module
 * (`wire/platform.ts`) is a pack with one ontology component named after it.
 */

/** One component of a pack version, by kind. `ontology`: the domain pack file (`ontology/<file>`)
 *  it publishes into an ontology family. `skill`: a Skill, by the name Workers mount it under.
 *  `worker`: a `worker` WorkerDefinition, by its name (`description` null when it has none). */
export const PackComponentWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ontology'),
      family: z.string(),
      domainPack: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill'),
      name: z.string(),
      description: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('worker'),
      name: z.string(),
      description: z.string().nullable(),
      /** The systems it acts on, by connector name — each one the version's `requiredConnectors`
       *  has (P1-E2); empty when it names none. Never a gate: which gates it may act on is the
       *  workspace's, chosen when the pack is installed. */
      systems: z.array(z.string()),
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
    /** The systems its components work with, by connector name (`docker`); empty when none. */
    requiredConnectors: z.array(z.string()),
    /** S11 P1-F: the packs it builds on, each with the lowest version that will do; empty when
     *  none. Installing it waits for them (`install_pack` 409 `pack_dependency_unmet`). */
    requiredPacks: z.array(
      z
        .object({
          name: z.string(),
          minVersion: z.number().int().positive(),
        })
        .strict(),
    ),
    components: z.array(PackComponentWireSchema),
  })
  .strict();
export type PackVersionWire = z.infer<typeof PackVersionWireSchema>;

/** S11 P1-F: one pack the latest version builds on (`requiredPacks`), and how this workspace has it
 *  now (`status` / `installedVersion`, that pack's own, `PackWire`). `met`: installed at
 *  `minVersion` or later — a `customized` one never is, since what it has cannot be told. Until
 *  every one is met, `install_pack` refuses (409 `pack_dependency_unmet`, `details.unmet`). */
export const PackDependencyWireSchema = z
  .object({
    name: z.string(),
    minVersion: z.number().int().positive(),
    status: PackInstallStatusSchema,
    installedVersion: z.number().int().positive().nullable(),
    met: z.boolean(),
  })
  .strict();
export type PackDependencyWire = z.infer<typeof PackDependencyWireSchema>;

/** A Gatekeeper of the workspace, by id and the name people know it by (the change plan's own). */
export const PackGateRefWireSchema = ChangeGateRefWireSchema;
export type PackGateRefWire = z.infer<typeof PackGateRefWireSchema>;

/** One system the latest version needs, and where it stands in this workspace now
 *  (`@nexttime/shared` `PACK_REQUIREMENT_STATE_VALUES`). Read without contacting any gate: a gate's
 *  health is checked when an install is verified (`verify_change_segment`). `gatekeepers`: for
 *  `connected`, the workspace's gates on it (what a Worker of the pack acting on it may be bound
 *  to); `offered`: for `can_enable`, the platform's instances the owner may enable here
 *  (`preview_gate_instance_enable` / `enable_gate_instance`, by `gateId`). Each empty otherwise. */
export const PackRequirementWireSchema = z
  .object({
    connector: z.string(),
    state: PackRequirementStateSchema,
    gatekeepers: z.array(PackGateRefWireSchema),
    offered: z.array(
      z
        .object({
          gateId: z.string(),
          displayName: z.string(),
        })
        .strict(),
    ),
    /** S11 P1-F: for `needs_platform`, the platform ships a connector preset of this name
     *  (`list_connector_presets`) and no packaged gate holds its connector — a platform
     *  administrator connects it from the preset by typing its address and key. `false` otherwise. */
    platformPreset: z.boolean(),
  })
  .strict();
export type PackRequirementWire = z.infer<typeof PackRequirementWireSchema>;

const PackComponentStateShape = {
  status: PackInstallStatusSchema,
  installedVersion: z.number().int().positive().nullable(),
  provenance: ChangeProvenanceWireSchema,
};

/** One component of the pack's latest version, as this workspace has it now. `installedVersion`:
 *  the pack version whose content for this component is installed (`null` for `not_installed` and
 *  `customized`); `provenance`: the change that installed what is there. A Skill's or Worker's
 *  `skillId` / `definitionId` is its family's in every workspace (derived from the pack and the
 *  name), installed or not. */
export const PackComponentStateWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ontology'),
      family: z.string(),
      domainPack: z.string(),
      ...PackComponentStateShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill'),
      name: z.string(),
      skillId: z.string(),
      ...PackComponentStateShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal('worker'),
      name: z.string(),
      definitionId: z.string(),
      /** The WorkerDefinition's published head version (a 「Worker」 tab row is one version:
       *  `definitionId@headVersion`); `null` when it has none. */
      headVersion: z.number().int().positive().nullable(),
      /** The systems it acts on (the latest version's, `PackComponentWire`). */
      systems: z.array(z.string()),
      /** The gates its published head may act on (its `gates`): the workspace's own, kept by every
       *  install. Empty when it has none or is not installed. */
      gates: z.array(PackGateRefWireSchema),
      /** Its published head has `gates` of its own — possibly none, as when the owner kept none
       *  when binding it (`gates` is then empty) — which every install keeps. */
      gatesKept: z.boolean(),
      /** Installing the pack again would bind it: it is installed, has no gates yet, and a gate of
       *  a system it acts on is connected now (one installed before that gate was). */
      bindable: z.boolean(),
      ...PackComponentStateShape,
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
    /** The latest version's `requiredConnectors`, each with where it stands here. */
    requirements: z.array(PackRequirementWireSchema),
    /** S11 P1-F: the latest version's `requiredPacks`, each with how this workspace has it. */
    dependencies: z.array(PackDependencyWireSchema),
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

/** What a Skill item installs, for the person reviewing it: the text a Worker that mounts it reads. */
export const PackSkillContentWireSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    markdown: z.string(),
  })
  .strict();
export type PackSkillContentWire = z.infer<typeof PackSkillContentWireSchema>;

/** What a Worker item installs, for the person reviewing it. `capabilities` null: not declared, so
 *  a Worker of it gets the platform's default — observe and propose, never execute. A pack's Worker
 *  declares no gates and no model: those are the workspace's own (`PackWorkerBindingWire`). */
export const PackWorkerContentWireSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    systemPrompt: z.string(),
    skills: z.array(z.string()),
    capabilities: z.array(z.string()).nullable(),
    egressDeny: z.array(z.string()),
  })
  .strict();
export type PackWorkerContentWire = z.infer<typeof PackWorkerContentWireSchema>;

/** How a Worker item sets the Worker's gates and model (P1-E2) — the workspace's own, never the
 *  pack's. `source`: `workspace` — the head's gates, kept as they are; `install` — the Worker has
 *  none yet and the install binds it to `gates`, every one of `candidates` unless the person kept
 *  fewer (`workerGates`); `none` — it has none and gets none (it names no system, none of its
 *  systems is connected, or the person kept none). `candidates`: for a Worker with no gates yet,
 *  the connected gates of its systems (empty for `workspace`). `model`: what the item publishes —
 *  the head's, kept — or `null`. Binding widens what the Worker may act on, so such an item is
 *  `authority_widening` and confirmed by its ordinal. */
export const PackWorkerBindingWireSchema = z
  .object({
    systems: z.array(z.string()),
    source: z.enum(['workspace', 'install', 'none']),
    gates: z.array(PackGateRefWireSchema),
    candidates: z.array(
      PackGateRefWireSchema.extend({
        /** The system it is a gate of. */
        connector: z.string(),
      }).strict(),
    ),
    model: z.string().nullable(),
  })
  .strict();
export type PackWorkerBindingWire = z.infer<typeof PackWorkerBindingWireSchema>;

const PackInstallItemCommonShape = {
  ordinal: z.number().int().positive(),
  unchanged: z.boolean(),
  classification: ChangeItemClassificationSchema,
  widening: z.array(ChangeWideningReasonWireSchema),
};

/** One item of an install's dry run, by kind — `before` the family's head now (null: not
 *  installed), `after` the content it would install; `unchanged`: already there, so not applied.
 *  `ontology_version`: publish the target version's `domainPack` into `target`'s family.
 *  `skill_version` / `worker_definition_version`: publish `skill` / `worker` as the family's next
 *  version; `changedFields` names the fields that differ from the head (every field it has, for a
 *  family not installed; none when `unchanged`). An `authority_widening` item is confirmed by its
 *  ordinal in `install_pack` (I-A4). */
export const PackInstallItemWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...PackInstallItemCommonShape,
      kind: z.literal('ontology_version'),
      target: OntologyVersionChangeTargetWireSchema,
      domainPack: z.string(),
      before: OntologyVersionRefWireSchema.nullable(),
      after: z.object({ definitionDigest: z.string() }).strict(),
      types: OntologyTypeChangesWireSchema,
    })
    .strict(),
  z
    .object({
      ...PackInstallItemCommonShape,
      kind: z.literal('skill_version'),
      target: SkillVersionChangeTargetWireSchema,
      before: ContentVersionRefWireSchema.nullable(),
      after: z.object({ contentDigest: z.string() }).strict(),
      skill: PackSkillContentWireSchema,
      changedFields: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...PackInstallItemCommonShape,
      kind: z.literal('worker_definition_version'),
      target: WorkerDefinitionVersionChangeTargetWireSchema,
      before: ContentVersionRefWireSchema.nullable(),
      after: z.object({ contentDigest: z.string() }).strict(),
      worker: PackWorkerContentWireSchema,
      binding: PackWorkerBindingWireSchema,
      changedFields: z.array(z.string()),
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

/** `install_pack`: the pack's state after the install, the segment that recorded it (`null` when
 *  nothing needed to change), and that segment's first verification — run right after the install,
 *  as the person who installed (`trigger: system`); `null` when nothing was recorded or the run
 *  could not be made (verify the segment from its record then). */
export const PackInstallResultWireSchema = z
  .object({
    pack: PackWireSchema,
    segmentId: z.string().nullable(),
    verification: ChangeVerificationWireSchema.nullable(),
  })
  .strict();
export type PackInstallResultWire = z.infer<typeof PackInstallResultWireSchema>;
