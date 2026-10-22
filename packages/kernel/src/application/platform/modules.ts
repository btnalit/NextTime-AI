import type { PoolClient } from 'pg';
import { setWorkspaceContext } from '../../adapters/db/platform-context.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { assertReviewedVersion } from '../../governance/capability/index.js';
import {
  type OntologyDefinition,
  type OntologyVersionRow,
  deriveOntologyPackId,
  loadPublishedOntologyHead,
} from '../../substrate/ontology/index.js';
import {
  applyWorkspaceSegment,
  assertWideningConfirmed,
  contentDigest,
} from '../change-plan/index.js';
import { withAdminClient } from '../gateway/auth.js';
import {
  PACK_INSTALL_STATUS_VALUES,
  type PackEntry,
  type PackInstallStatus,
  type PackRegistry,
  type PackRegistryOptions,
  loadPackRegistry,
  matchInstalledVersion,
  planPackInstall,
} from '../packs/index.js';
import { readPlatformSettings } from './settings.js';

/**
 * application/platform/modules: the P-B2b "模块" domain — the module registry (§6.4;
 * docs/development-tasks.md §5d S7-D 决定 D1–D3) and install/upgrade, which applies a module as a
 * ChangePlan workspace segment (`application/change-plan`, S11 P1). `application/gateway/
 * platform-modules-handlers.ts` is the thin `CapabilityHandler` layer over this file; this file has
 * no dependency on dispatch, capability registration, or wire schemas (`@nexttime/shared`'s own
 * `wire/platform.ts` projects `WorkspaceModuleState`/`ModuleRegistryEntry` below to the wire shape,
 * kept separate the same way every other `application/gateway/*-handlers.ts` / domain-module pair
 * already is in this codebase).
 *
 * **A module is a pack with one ontology component named after it** (S11 P1-C; S10 plan §6.4 "模块
 * 是只含本体组件的包"): every version of the pack publishes exactly one ontology family, the pack's
 * own name (`deriveOntologyPackId`'s `packName`). The registry is read from the deployment's packs
 * (`application/packs`, `packs/<name>/<version>/pack.yaml`) — the former `ontology/modules.yaml`
 * index moved there, version numbers, notes and `breaking` unchanged. A pack with several
 * components is not a module: it is installed with `install_pack`. `platform-meta` and the
 * WorkerDefinition templates beside it in `ontology/` are neither (D1).
 *
 * **"Installed version" = digest match** (D2): the family's published head is compared, by
 * `contentDigest` of its definition, with each version's (`application/packs/state.ts`'s rule —
 * the latest when it matches, otherwise the earliest that does). Nothing is persisted; the digests
 * are recomputed from the image's own `packs/` and `ontology/` on every call, so they can never
 * drift against what an install would actually publish.
 *
 * **A module version number is not `ontology_versions.version`.** The latter is a per-workspace,
 * per-family publish counter (`nextOntologyVersion`'s own `max(version) + 1`, advanced by every
 * publish regardless of content) — it can run ahead of, or never equal, the pack's own `1, 2, 3, …`
 * numbering (republishing identical content still consumes a DB version number; a workspace whose
 * DB row is version 5 may still match the pack's version 1). Every function here that reports "the
 * installed version" (`WorkspaceModuleState.installedVersion`, `ModuleConfirmRequiredDetails.
 * currentVersion`) means the **pack** version found by digest match (D2), `null` when there is none
 * (`customized`) — `install_module`/`upgrade_module` always target the pack's **latest** version
 * directly, in one publish, never by incrementing the DB version number.
 */

// -------------------------------------------------------------------------------------------
// module registry — the packs that are modules
// -------------------------------------------------------------------------------------------

export interface ModuleRegistryVersion {
  readonly version: number;
  /** The domain pack file in the ontology library this version publishes. */
  readonly file: string;
  readonly notes: string;
  readonly breaking: boolean;
  /** `contentDigest` of the definition (D2). */
  readonly definitionDigest: string;
}

export interface ModuleRegistryEntry {
  readonly name: string;
  /** Ascending by `version`, dense from 1 (the pack registry's own rule). */
  readonly versions: readonly ModuleRegistryVersion[];
  /** The pack the module is. */
  readonly pack: PackEntry;
}

export type ModuleRegistry = ReadonlyMap<string, ModuleRegistryEntry>;

/** Every version publishes one ontology component, into the family named after the pack. */
export function isModulePack(entry: PackEntry): boolean {
  return entry.versions.every(
    (version) => version.components.length === 1 && version.components[0]?.family === entry.name,
  );
}

/** The modules among `packs`, in the registry's order. */
export function moduleRegistryOf(packs: PackRegistry): ModuleRegistry {
  const registry = new Map<string, ModuleRegistryEntry>();
  for (const pack of packs.values()) {
    if (!isModulePack(pack)) continue;
    const versions = pack.versions.map((version): ModuleRegistryVersion => {
      const [component] = version.components;
      if (!component) throw new Error(`module "${pack.name}" v${version.version} has no component`);
      return {
        version: version.version,
        file: component.domainPack,
        notes: version.notes,
        breaking: version.breaking,
        definitionDigest: component.definitionDigest,
      };
    });
    registry.set(pack.name, { name: pack.name, versions, pack });
  }
  return registry;
}

/** Not persisted anywhere — read from the packs on every call (this file's own doc comment), the
 *  same "no cache, read fresh" choice as `application/gateway/models-catalog-handler.ts` (the
 *  source is baked into the image and only ever changes on a redeploy). */
export async function loadModuleRegistry(
  options: PackRegistryOptions = {},
): Promise<ModuleRegistry> {
  return moduleRegistryOf(await loadPackRegistry(options));
}

export class ModuleNotFoundError extends Error {
  readonly code = 'module_not_found' as const;
  constructor(name: string) {
    super(`module "${name}" is not a module this deployment ships`);
    this.name = 'ModuleNotFoundError';
  }
}

export function requireModule(registry: ModuleRegistry, name: string): ModuleRegistryEntry {
  const entry = registry.get(name);
  if (!entry) throw new ModuleNotFoundError(name);
  return entry;
}

function latestVersion(entry: ModuleRegistryEntry): ModuleRegistryVersion {
  const last = entry.versions[entry.versions.length - 1];
  if (!last) throw new Error(`module "${entry.name}" has an empty version list — registry bug`);
  return last;
}

// -------------------------------------------------------------------------------------------
// installed-state detection (D2) — one workspace
// -------------------------------------------------------------------------------------------

export const MODULE_INSTALL_STATUS_VALUES = PACK_INSTALL_STATUS_VALUES;
export type ModuleInstallStatus = PackInstallStatus;

/** The latest **published** `ontology_versions` row for `packId` in `workspaceId`, or `null` when
 *  the family was never published there (`substrate/ontology`'s `loadPublishedOntologyHead`).
 *  Deliberately published-only (mirrors `substrate/ontology/registry.ts`'s
 *  `loadPublishedLinkTypes`, not `loadVisibleOntology`): an install never leaves a draft behind
 *  (`loader.ts`'s own doc comment — no draft phase), so a draft under
 *  this same id can only mean a caller reached `propose_ontology_change` with this family's id by
 *  hand; "installed" means "what a Worker/collector actually writes against right now", which is
 *  always the latest published row. */
export async function loadInstalledPackVersion(
  client: PoolClient,
  workspaceId: string,
  packId: string,
): Promise<OntologyVersionRow | null> {
  return loadPublishedOntologyHead(client, workspaceId, packId);
}

export interface WorkspaceModuleState {
  readonly entry: ModuleRegistryEntry;
  /** The **pack** version matching the installed definition's digest (D2) — never the raw
   *  `ontology_versions.version` row number, which is a per-workspace publish counter that can run
   *  ahead of (or never equal) the pack's own numbering. `null` for `not_installed` *and* for
   *  `customized` (a digest matching no known version has no meaningful version to report). */
  readonly installedVersion: number | null;
  readonly status: ModuleInstallStatus;
}

/** Classifies one workspace's install state for `entry` given the installed definition's digest
 *  (D2; `null` = never installed): matching the latest version is `up_to_date`; matching an older
 *  one is `outdated` (the earliest, when two versions have identical content — see
 *  `installOrUpgradeModule` on why that is the conservative choice for the confirm-range check);
 *  matching none is `customized` (D3: published through `propose_ontology_change` directly, or
 *  hand-edited some other way — the raw DB version number is irrelevant, only content is). */
export function classifyModuleState(
  entry: ModuleRegistryEntry,
  installedDigest: string | null,
): WorkspaceModuleState {
  const candidates = entry.versions.map((v) => ({
    version: v.version,
    digest: v.definitionDigest,
  }));
  return {
    entry,
    ...matchInstalledVersion(candidates, latestVersion(entry).version, installedDigest),
  };
}

/** `list_workspace_modules`: every module's state in one workspace. */
export async function loadWorkspaceModuleStates(
  client: PoolClient,
  workspaceId: string,
  registry: ModuleRegistry,
): Promise<readonly WorkspaceModuleState[]> {
  const states: WorkspaceModuleState[] = [];
  for (const entry of registry.values()) {
    const packId = deriveOntologyPackId(entry.name);
    const installed = await loadInstalledPackVersion(client, workspaceId, packId);
    states.push(classifyModuleState(entry, installed ? contentDigest(installed.definition) : null));
  }
  return states;
}

// -------------------------------------------------------------------------------------------
// install / upgrade (D3) — `install_module` and `upgrade_module` share this one function
// -------------------------------------------------------------------------------------------

export interface ModuleConfirmRequiredDetails {
  readonly name: string;
  /** The current **pack** version (D2's digest match), `null` when `currentStatus` is `customized`. */
  readonly currentVersion: number | null;
  readonly currentStatus: Extract<ModuleInstallStatus, 'outdated' | 'customized'>;
  readonly targetVersion: number;
  /** True when the target itself, or any version *between* the current one and the target, is
   *  `breaking` — advancing straight to the target would silently skip past it otherwise. */
  readonly breaking: boolean;
}

/** Thrown by `installOrUpgradeModule` when advancing would overwrite a customized install, or the
 *  target version is marked `breaking`, and the caller did not pass `confirm: true` (D3). Mapped to
 *  400 `module_confirm_required` with `details` (interfaces/http/capability-route.ts), the same
 *  shape `substrate/graph/ontology-guard.ts`'s `OntologyViolationError` already established for a
 *  "here is exactly what to confirm" 400. */
export class ModuleConfirmRequiredError extends Error {
  readonly code = 'module_confirm_required' as const;
  readonly details: ModuleConfirmRequiredDetails;
  constructor(details: ModuleConfirmRequiredDetails) {
    const from =
      details.currentVersion === null ? details.currentStatus : `v${details.currentVersion}`;
    super(
      `module "${details.name}": upgrading from ${from} (${details.currentStatus}) to v${details.targetVersion}${details.breaking ? ' (breaking)' : ''} needs confirm: true`,
    );
    this.name = 'ModuleConfirmRequiredError';
    this.details = details;
  }
}

export interface InstallOrUpgradeModuleInput {
  readonly name: string;
  readonly confirm?: boolean;
  /** Legacy 300: the version the owner was shown as the target (`WorkspaceModuleWire.
   *  latestVersion`). The call always targets the latest, and refuses `ReviewedVersionChangedError`
   *  (409 `version_changed`) when that is another one — an upgrade shipped a newer pack version
   *  between the read and the click. Internal callers (workspace creation's default modules) omit
   *  it. */
  readonly version?: number;
  /** Who is applying, for the ChangePlan audit rows: `human` — the owner's `install_module` /
   *  `upgrade_module` call; `platform` — workspace creation's default modules (a platform
   *  administrator's `create_workspace`). */
  readonly channel: 'human' | 'platform';
}

/**
 * `install_module` / `upgrade_module`'s one shared implementation (D3: "底层同一调用"), and S11
 * P1-C's "单组件包的安装 / 升级": the module installs as its pack does (`application/packs/
 * install.ts`'s `planPackInstall` — one ChangePlan workspace segment that publishes the pack's
 * **latest** version into the family), with this capability pair's own confirmation instead of a
 * reviewed digest. Present or absent, the target is the latest version (never
 * `installedVersion + 1` — D3's "族不存在 → v1；存在 → 下一版本" describes the
 * `ontology_versions` DB version number `publishOntologyVersion` advances by one on every publish,
 * not the pack's own numbering; a workspace's pack version is only ever known by digest match, D2).
 * One publish reaches the target directly, never stepping through intermediate versions.
 *
 * Planning locks the family first (with the workspace's ontology namespace before it, I-P1):
 * another install_module / upgrade_module (P2 hotfix, post-v0.16.0 review: two calls both passing
 * the "not installed" check and racing to INSERT the same version) or `publish_ontology_version` on
 * the same family waits until this transaction ends, so what was read is what gets replaced.
 *
 * No-op before anything is published (never waste a version number, D3's own words): the target's
 * content is already what is installed. Returns the current state.
 *
 * Otherwise:
 *   - S11 P1 (I-A4): an authority-widening change — an ActionType added, removed or loosened
 *     (`application/change-plan/classify.ts`) — refuses 400 `change_confirmation_required`
 *     whatever `confirm` says. `confirm` answers D3's question (overwrite a customized install,
 *     cross a breaking version), and the console sends it before the call when it already knows
 *     the answer is yes; it cannot also stand for confirming each widening item, which these
 *     capabilities do not take (`install_pack` does). No module this deployment ships declares an
 *     ActionType.
 *   - `confirm: true` is required (`ModuleConfirmRequiredError` — 400 `module_confirm_required` —
 *     otherwise) when either the current install is `customized` (D2: its digest matches no known
 *     version), or **any** version strictly after the currently-matched one, up to and including
 *     the target, is `breaking` — jumping straight to the target must not silently skip past an
 *     intermediate breaking version nobody confirmed.
 *
 * The segment's review binding stays legacy 300's `version` (the owner is shown a module version,
 * not a segment digest): the segment is planned and applied in this one transaction under the
 * family lock, so the digest it re-checks is the one just computed. The definition is published
 * under `principalId` (D4's own `proposed_by = principalId` — the no-draft-phase bootstrap shape
 * `loader.ts` documents), and the segment, its item and the item's audit row record what changed.
 */
export async function installOrUpgradeModule(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  registry: ModuleRegistry,
  input: InstallOrUpgradeModuleInput,
): Promise<WorkspaceModuleState> {
  const entry = requireModule(registry, input.name);
  const install = await planPackInstall(client, workspaceId, entry.pack);
  const { current, plan, target } = install;
  assertReviewedVersion(
    current.status === 'not_installed' ? 'install_module' : 'upgrade_module',
    `module ${entry.name}`,
    input.version,
    target.version,
  );
  // No-op: the target's content is already what is installed — never spend a version number
  // republishing it (D3).
  if (plan.unchanged) {
    return { entry, installedVersion: current.installedVersion, status: current.status };
  }
  assertWideningConfirmed(plan, [], `module "${entry.name}" v${target.version}`);

  if (current.status === 'outdated' || current.status === 'customized') {
    // `install.breaking`: a version after the matched one, up to the target, is breaking
    // (`outdated`), or the target is (`customized` — no version to count from).
    const needsConfirm = current.status === 'customized' || install.breaking;
    if (needsConfirm && input.confirm !== true) {
      throw new ModuleConfirmRequiredError({
        name: entry.name,
        currentVersion: current.installedVersion,
        currentStatus: current.status,
        targetVersion: target.version,
        breaking: install.breaking,
      });
    }
  }

  await applyWorkspaceSegment(client, workspaceId, {
    ...install.segment,
    reviewedDigest: plan.digest,
    proposedBy: principalId,
    appliedBy: principalId,
    channel: input.channel,
    confirmedOrdinals: [],
  });
  return { entry, installedVersion: target.version, status: 'up_to_date' };
}

// -------------------------------------------------------------------------------------------
// platform-wide aggregate (`list_modules`: "装到 n 个工作区 / m 个有新版") — digest-based, same
// `classifyModuleState` every per-workspace read uses (D2): the raw `ontology_versions.version`
// row number is never compared against the pack's own version numbering (see `WorkspaceModuleState
// .installedVersion`'s own doc comment on why the two are not the same counter).
// -------------------------------------------------------------------------------------------

export interface ModuleInstallCounts {
  readonly installedWorkspaceCount: number;
  /** Of `installedWorkspaceCount`, how many are not `up_to_date` — `outdated` (matches an older
   *  pack version) or `customized` (matches none) both count: either way, the workspace is not on
   *  the module's current standard content. */
  readonly newerAvailableCount: number;
}

/** For every module in `registry`, across every workspace in `workspaceIds`: how many have any
 *  published row for that family, and how many of those are not `up_to_date`. One
 *  `select distinct on (id) ...` per workspace (all module families in one query, via
 *  `setWorkspaceContext` — the same platform-transaction technique `application/gateway/platform-
 *  handlers.ts`'s own `countGatekeepers` already uses for a per-workspace RLS-scoped count), not
 *  one query per (workspace, module) pair — fetches each row's `definition` (not just `version`)
 *  since classification is by content digest. Caller must be inside a platform transaction
 *  (`withPlatform`) — `setWorkspaceContext` is a no-op guard otherwise. Resets the workspace GUC
 *  before returning (`countGatekeepers`'s own convention), so a caller that runs more platform-
 *  scoped queries afterward never inherits a stale workspace context. */
export async function countModuleInstallations(
  client: PoolClient,
  workspaceIds: readonly string[],
  registry: ModuleRegistry,
): Promise<ReadonlyMap<string, ModuleInstallCounts>> {
  const packIdToName = new Map<string, string>();
  for (const entry of registry.values())
    packIdToName.set(deriveOntologyPackId(entry.name), entry.name);
  const packIds = [...packIdToName.keys()];
  const counts = new Map<string, { installed: number; newer: number }>();
  for (const name of registry.keys()) counts.set(name, { installed: 0, newer: 0 });

  if (packIds.length > 0 && workspaceIds.length > 0) {
    for (const workspaceId of workspaceIds) {
      await setWorkspaceContext(client, workspaceId, '00000000-0000-0000-0000-000000000000');
      const rows = await client.query<{ id: string; definition: OntologyDefinition }>(
        `select distinct on (id) id, definition
           from ontology_versions
          where workspace_id = $1 and id = any($2::uuid[]) and status = 'published'
          order by id, version desc`,
        [workspaceId, packIds],
      );
      for (const row of rows.rows) {
        const name = packIdToName.get(row.id);
        if (!name) continue;
        const entry = registry.get(name);
        if (!entry) continue;
        const bucket = counts.get(name);
        if (!bucket) continue;
        bucket.installed += 1;
        const status = classifyModuleState(entry, contentDigest(row.definition)).status;
        if (status !== 'up_to_date') bucket.newer += 1;
      }
    }
    await client.query("select set_config('app.workspace_id', '', true)");
    await client.query("select set_config('app.principal_id', '', true)");
  }

  const result = new Map<string, ModuleInstallCounts>();
  for (const [name, c] of counts) {
    result.set(name, { installedWorkspaceCount: c.installed, newerAvailableCount: c.newer });
  }
  return result;
}

/** `set_default_modules`'s own input check: every name must be a real module — a typo'd default
 *  would silently install nothing for every new workspace forever (`installOrUpgradeModule` would
 *  just never find it and no one would notice at `create_workspace` time). */
export function assertKnownModuleNames(registry: ModuleRegistry, names: readonly string[]): void {
  for (const name of names) requireModule(registry, name);
}

// -------------------------------------------------------------------------------------------
// startup guard (S8 W5 leftover 65) — see checkDefaultModules's own doc comment
// -------------------------------------------------------------------------------------------

export interface CheckDefaultModulesOptions extends PackRegistryOptions {
  readonly log?: (line: string) => void;
}

/**
 * S8 W5 (leftover 65): startup-time guard for `platform_settings.defaultModules` drifting stale
 * against this deployment's own modules (its `packs/`) — a module family renamed or removed from
 * the image after an administrator set it as a default (`set_default_modules` validates names only
 * at write time, `assertKnownModuleNames` above) previously failed *silently* from then on:
 * `create_workspace`'s own defaultModules skip (`application/workspace/create.ts`'s
 * `skippedDefaultModules`, the P2 hotfix that same file's doc comment already flagged "a deploy-
 * time guard ... is deferred to S8") only logs one `console.warn` line per affected workspace
 * *creation* — invisible on a host that rarely creates new workspaces, for however many releases
 * the drift persists.
 *
 * Called once at kernel startup (`index.ts`, right after `ensureDefaultWorkspace` — same "own try,
 * never fatal, log and continue" shape that step already uses): reads the current
 * `platform_settings.defaultModules`, loads this deployment's live module registry, and warns
 * loudly — every missing name, once, at startup, not buried per-workspace — for any that no longer
 * resolve. Never mutates `platform_settings` itself (an administrator decides whether to clear the
 * drifted names via `set_default_modules` or the platform modules page) and never throws (a broken
 * `packs/` read must not take the kernel down over what is, worst case, a slightly
 * stale default-modules list — same tolerance `ensureDefaultWorkspace`'s own caller in `index.ts`
 * already gives that step).
 *
 * Returns the missing names (`[]` when everything resolves or no default is configured) so a
 * caller other than `index.ts` (a test, the platform status page in a future wave) can act on the
 * result directly instead of re-parsing the log line.
 */
export async function checkDefaultModules(
  pool: PoolLike,
  options: CheckDefaultModulesOptions = {},
): Promise<readonly string[]> {
  const log = options.log ?? (() => {});
  const settings = await withAdminClient(pool, (client) => readPlatformSettings(client));
  const defaultModules = settings.settings.defaultModules;
  if (defaultModules.length === 0) return [];

  const registry = await loadModuleRegistry(options);
  const missing = defaultModules.filter((name) => !registry.has(name));
  if (missing.length > 0) {
    log(
      JSON.stringify({
        level: 'warn',
        msg:
          'platform_settings.defaultModules names module(s) no longer in this deployment’s ' +
          'modules — every new workspace silently skips them (application/workspace/' +
          'create.ts); fix with set_default_modules or the platform modules page',
        names: missing,
      }),
    );
  }
  return missing;
}
