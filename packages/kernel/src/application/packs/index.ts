/**
 * application/packs: capability packs (S11 P1-C; Pack Contract v1, docs/s10-evolution-plan-
 * 2026-10-04.md §6). A pack is a versioned, installable set of components a deployment ships in
 * `packs/<name>/<version>/pack.yaml` (`manifest.ts`, `registry.ts`); v1 components are ontology
 * families. What a workspace has of a pack is derived from its components (`state.ts`); installing
 * one is a ChangePlan workspace segment (`install.ts`). A module (`application/platform/modules.ts`)
 * is a pack with one ontology component named after it.
 */

export {
  type InstallPackInput,
  type InstalledPack,
  type PackInstallPlan,
  type PackInstallPreview,
  installPack,
  packSegment,
  planPackInstall,
  previewPackInstall,
} from './install.js';
export {
  PACK_COMPONENT_KINDS,
  PACK_CONTRACT_SCHEMA,
  PACK_NAME_PATTERN,
  type PackComponentKind,
  type PackManifest,
  PackManifestError,
} from './manifest.js';
export {
  type PackEntry,
  PackNotFoundError,
  type PackOntologyComponent,
  type PackRegistry,
  PackRegistryError,
  type PackRegistryOptions,
  type PackVersion,
  latestPackVersion,
  loadPackRegistry,
  requirePack,
  resolvePacksDir,
} from './registry.js';
export {
  type InstalledMatch,
  PACK_INSTALL_STATUS_VALUES,
  type PackComponentState,
  type PackHeads,
  type PackInstallStatus,
  type PackState,
  classifyPackState,
  loadPackState,
  matchInstalledVersion,
  readPackHeads,
} from './state.js';
