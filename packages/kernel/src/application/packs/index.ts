/**
 * application/packs: capability packs (S11 P1-C; Pack Contract v1, docs/s10-evolution-plan-
 * 2026-10-04.md §6). A pack is a versioned, installable set of components a deployment ships in
 * `packs/<name>/<version>/pack.yaml` (`manifest.ts`, `registry.ts`); its components are ontology
 * families, Skills and `worker` WorkerDefinitions (P1-D). What a workspace has of a pack is
 * derived from its components (`state.ts`); installing one is a ChangePlan workspace segment
 * (`install.ts`). A version may say which systems it needs (`requires.connectors`, P1-E), and
 * `requirements.ts` reads where each stands in a workspace. A module
 * (`application/platform/modules.ts`) is a pack with one ontology component named after it.
 */

export {
  type InstallPackInput,
  type InstalledPack,
  type PackInstallPlan,
  type PackInstallPreview,
  PackWorkerGatesError,
  type PlannedWorkerGates,
  type WorkerBinding,
  type WorkerGateCandidate,
  type WorkerGateChoice,
  installPack,
  packSegment,
  planPackInstall,
  previewPackInstall,
  readWorkerBindings,
  readWorkerGateCandidates,
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
  type PackComponent,
  type PackEntry,
  PackNotFoundError,
  type PackOntologyComponent,
  type PackSkillComponent,
  type PackWorkerComponent,
  type PackRegistry,
  PackRegistryError,
  type PackRegistryOptions,
  type PackVersion,
  derivePackComponentId,
  latestPackVersion,
  loadPackRegistry,
  packComponentDigest,
  packComponentKey,
  packOwnedWorkerDigest,
  requirePack,
  resolvePacksDir,
  WORKSPACE_OWNED_WORKER_FIELDS,
} from './registry.js';
export {
  type PackRequirementGate,
  type PackRequirementOffer,
  type PackRequirementStatus,
  readPackRequirements,
} from './requirements.js';
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
