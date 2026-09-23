import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { setWorkspaceContext } from '../../adapters/db/platform-context.js';
import {
  type OntologyDefinition,
  type OntologyVersionDbRow,
  type OntologyVersionRow,
  deriveOntologyPackId,
  loadOntologyDefinitionFile,
  mapOntologyVersionRow,
  publishOntologyDomainPack,
  resolveOntologyDir,
} from '../../substrate/ontology/index.js';

/**
 * application/platform/modules: the P-B2b "模块" domain — module registry (§6.4;
 * docs/development-tasks.md §5d S7-D 决定 D1–D3) built from `ontology/modules.yaml` + the domain-
 * pack files it indexes, and the install/upgrade orchestration on top of
 * `substrate/ontology/loader.ts`'s existing `publishOntologyDomainPack`. `application/gateway/
 * platform-modules-handlers.ts` is the thin `CapabilityHandler` layer over this file; this file has
 * no dependency on dispatch, capability registration, or wire schemas (`@nexttime/shared`'s own
 * `wire/platform.ts` projects `WorkspaceModuleState`/`ModuleRegistryEntry` below to the wire shape,
 * kept separate the same way every other `application/gateway/*-handlers.ts` / domain-module pair
 * already is in this codebase).
 *
 * **A module is a versioned domain pack** (D1): `ontology/modules.yaml` names a family (`name`,
 * matching `publishOntologyDomainPack`'s own `packName`) and its dense, 1-based version list
 * (`{file, version, notes, breaking}` — see that YAML file's own header comment for why no gaps are
 * allowed). `platform-meta` / `entry-agent` / `ops-runner` are not modules and are not indexed here
 * (D1) — `platform-meta` is seeded once per workspace by `seedPlatformMetaOntology`, and the other
 * two are WorkerDefinition templates, a different publish path entirely.
 *
 * **"Installed version" = hash match** (D2): at call time, this module hashes each index version's
 * *parsed* `OntologyDefinition` (`parseOntologyDefinition`'s own output — the same normalization
 * every publish already goes through, `substrate/ontology/loader.ts`'s `loadOntologyDefinitionFile`)
 * with a key-sorted canonical JSON + sha256, the same recipe `application/gateway/action-
 * executor.ts`'s `hashStableParams` and `substrate/graph/store.ts`'s own `stableStringify` already
 * use elsewhere in this codebase (copied here rather than factored into a shared helper — each of
 * those two sites made the same "small, self-contained, stateless, not worth a new module" call,
 * doc-commented at their own `stableStringify`; this is the third, same reasoning). The hash is
 * never persisted anywhere (`ontology/modules.yaml` itself, and `ontology_versions`, both stay
 * exactly as they already are) — it is recomputed from the image's own `ontology/` directory
 * (`resolveOntologyDir()`) on every call that needs it, so it can never drift against what
 * `publishOntologyDomainPack` itself would actually publish.
 *
 * **The index's own version number is not `ontology_versions.version`.** The latter is a per-
 * workspace, per-family publish counter (`nextOntologyVersion`'s own `max(version) + 1`, advanced
 * by every `publishOntologyDomainPack` call regardless of content) — it can run ahead of, or never
 * equal, the module family's own `1, 2, 3, …` index numbering (republishing identical content still
 * consumes a DB version number; a workspace whose DB row is version 5 may still match the index's
 * own version 1 by hash). Every function here that reports "the installed version"
 * (`WorkspaceModuleState.installedVersion`, `ModuleConfirmRequiredDetails.currentVersion`) means
 * the **index** version found by hash match (D2), `null` when there is none (`customized`) —
 * `install_module`/`upgrade_module` always target the index's own **latest** version directly, in
 * one publish, never by incrementing the DB version number.
 */

// -------------------------------------------------------------------------------------------
// ontology/modules.yaml — index file parsing
// -------------------------------------------------------------------------------------------

const ModuleIndexVersionSchema = z
  .object({
    file: z.string().min(1),
    version: z.number().int().positive(),
    notes: z.string(),
    breaking: z.boolean(),
  })
  .strict();

const ModuleIndexEntrySchema = z
  .object({
    name: z.string().min(1),
    versions: z.array(ModuleIndexVersionSchema).min(1),
  })
  .strict();

const ModulesIndexFileSchema = z
  .object({
    modules: z.array(ModuleIndexEntrySchema),
  })
  .strict();

export type ModuleIndexVersion = z.infer<typeof ModuleIndexVersionSchema>;
export type ModuleIndexEntry = z.infer<typeof ModuleIndexEntrySchema>;

export class ModuleIndexParseError extends Error {
  constructor(source: string, cause: unknown) {
    super(`failed to parse module index "${source}": ${String(cause)}`, { cause });
    this.name = 'ModuleIndexParseError';
  }
}

/** Reads and validates `<dir>/modules.yaml`, then checks the one invariant its own schema cannot
 *  express: each family's `versions` is dense and 1-based (1, 2, 3, … — no gaps, no duplicates).
 *  Not required by `installOrUpgradeModule`'s own algorithm any more (it always targets the latest
 *  entry directly and range-checks by iterating `versions`, neither of which needs density) — kept
 *  as a data-hygiene guard against an index author leaving a confusing gap (e.g. `1, 3` reading as
 *  though version 2 was withdrawn). A misconfigured index is a deployment bug, not a caller error —
 *  this throws rather than silently skipping the offending family. */
export async function readModulesIndexFile(
  dir: string = resolveOntologyDir(),
): Promise<readonly ModuleIndexEntry[]> {
  const filePath = path.join(dir, 'modules.yaml');
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new ModuleIndexParseError(filePath, err);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ModuleIndexParseError(filePath, err);
  }
  const result = ModulesIndexFileSchema.safeParse(raw);
  if (!result.success) throw new ModuleIndexParseError(filePath, result.error);
  for (const entry of result.data.modules) {
    const sorted = [...entry.versions].map((v) => v.version).sort((a, b) => a - b);
    const dense = sorted.every((version, index) => version === index + 1);
    if (!dense) {
      throw new ModuleIndexParseError(
        filePath,
        `module "${entry.name}": versions must be dense from 1 (got: ${sorted.join(', ')})`,
      );
    }
  }
  return result.data.modules;
}

// -------------------------------------------------------------------------------------------
// hashing (D2)
// -------------------------------------------------------------------------------------------

/** Deterministic JSON serialization — sorts object keys recursively, same recipe as
 *  `application/gateway/action-executor.ts`'s own `stableStringify` (see that function's doc
 *  comment: not a general-purpose canonical-JSON implementation, but `OntologyDefinition` is always
 *  the output of `parseOntologyDefinition`'s own Zod validation, which can never contain a BigInt,
 *  Date, or cycle). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 of `definition`'s stable serialization, hex-encoded (D2). Exported for tests. */
export function hashOntologyDefinition(definition: OntologyDefinition): string {
  return createHash('sha256').update(stableStringify(definition), 'utf8').digest('hex');
}

// -------------------------------------------------------------------------------------------
// module registry — the index, with every version's hash computed against `dir`'s actual files
// -------------------------------------------------------------------------------------------

export interface ModuleRegistryVersion extends ModuleIndexVersion {
  readonly hash: string;
}

export interface ModuleRegistryEntry {
  readonly name: string;
  /** Ascending by `version`, 1-based, dense (`readModulesIndexFile`'s own invariant). */
  readonly versions: readonly ModuleRegistryVersion[];
}

/** Not persisted anywhere — recomputed from `dir` on every call (this file's own doc comment).
 *  Cheap: `ontology/modules.yaml` and the handful of domain-pack files it indexes are small, and
 *  this mirrors `application/gateway/models-catalog-handler.ts`'s own "no cache, read fresh"
 *  choice for the same reason (the source is baked into the image and only ever changes on a
 *  redeploy — a cache would only add invalidation the process restart already provides for free). */
export async function loadModuleRegistry(
  dir: string = resolveOntologyDir(),
): Promise<ReadonlyMap<string, ModuleRegistryEntry>> {
  const index = await readModulesIndexFile(dir);
  const registry = new Map<string, ModuleRegistryEntry>();
  for (const entry of index) {
    const sorted = [...entry.versions].sort((a, b) => a.version - b.version);
    const versions: ModuleRegistryVersion[] = [];
    for (const version of sorted) {
      const definition = await loadOntologyDefinitionFile(path.join(dir, version.file));
      versions.push({ ...version, hash: hashOntologyDefinition(definition) });
    }
    registry.set(entry.name, { name: entry.name, versions });
  }
  return registry;
}

export class ModuleNotFoundError extends Error {
  readonly code = 'module_not_found' as const;
  constructor(name: string) {
    super(`module "${name}" is not in this deployment's module index`);
    this.name = 'ModuleNotFoundError';
  }
}

export function requireModule(
  registry: ReadonlyMap<string, ModuleRegistryEntry>,
  name: string,
): ModuleRegistryEntry {
  const entry = registry.get(name);
  if (!entry) throw new ModuleNotFoundError(name);
  return entry;
}

function latestVersion(entry: ModuleRegistryEntry): ModuleRegistryVersion {
  const last = entry.versions[entry.versions.length - 1];
  if (!last) throw new Error(`module "${entry.name}" has an empty version list — index bug`);
  return last;
}

// -------------------------------------------------------------------------------------------
// installed-state detection (D2) — one workspace
// -------------------------------------------------------------------------------------------

export const MODULE_INSTALL_STATUS_VALUES = [
  'not_installed',
  'up_to_date',
  'outdated',
  'customized',
] as const;
export type ModuleInstallStatus = (typeof MODULE_INSTALL_STATUS_VALUES)[number];

/** The latest **published** `ontology_versions` row for `packId` in `workspaceId`, or `null` when
 *  the family was never published there. Deliberately published-only (mirrors `substrate/ontology/
 *  registry.ts`'s `loadPublishedLinkTypes`, not `loadVisibleOntology`): `publishOntologyDomainPack`
 *  never leaves a draft behind (`loader.ts`'s own doc comment — no draft phase), so a draft under
 *  this same id can only mean a caller reached `propose_ontology_change` with this family's id by
 *  hand; "installed" means "what a Worker/collector actually writes against right now", which is
 *  always the latest published row. */
export async function loadInstalledPackVersion(
  client: PoolClient,
  workspaceId: string,
  packId: string,
): Promise<OntologyVersionRow | null> {
  const result = await client.query<OntologyVersionDbRow>(
    `select workspace_id, id, version, status, definition, proposed_by, published_by,
            created_at, published_at
       from ontology_versions
      where workspace_id = $1 and id = $2 and status = 'published'
      order by version desc
      limit 1`,
    [workspaceId, packId],
  );
  const row = result.rows[0];
  return row ? mapOntologyVersionRow(row) : null;
}

export interface WorkspaceModuleState {
  readonly entry: ModuleRegistryEntry;
  /** The **index** version matching the installed definition's hash (D2) — never the raw
   *  `ontology_versions.version` row number, which is a per-workspace publish counter that can run
   *  ahead of (or never equal) the index's own numbering (e.g. the same index version republished
   *  twice bumps the DB version but is still index version N). `null` for `not_installed` *and*
   *  for `customized` (a hash matching no known index version has no meaningful index version to
   *  report). */
  readonly installedVersion: number | null;
  readonly status: ModuleInstallStatus;
}

/** Classifies one workspace's install state for `entry` given the installed definition's hash (D2;
 *  `null` = never installed). A hash matching *some* known index version but not the latest one is
 *  `outdated`; matching no known version at all is `customized` (D3: a caller reached this family's
 *  id through `propose_ontology_change` directly, republished the same content over itself, or a
 *  version was hand-edited some other way — the raw DB version number is irrelevant to this
 *  classification, only content hash is); matching the latest known version is `up_to_date`. On a
 *  hash collision between two different index versions (two versions with byte-identical
 *  `OntologyDefinition` content), the **earliest** one matches — see `installOrUpgradeModule`'s own
 *  doc comment on why that is the conservative, safe choice for the confirm-range check. */
export function classifyModuleState(
  entry: ModuleRegistryEntry,
  installedHash: string | null,
): WorkspaceModuleState {
  if (installedHash === null) return { entry, installedVersion: null, status: 'not_installed' };
  const matched = entry.versions.find((v) => v.hash === installedHash);
  if (!matched) return { entry, installedVersion: null, status: 'customized' };
  const latest = latestVersion(entry);
  const status: ModuleInstallStatus =
    matched.version === latest.version ? 'up_to_date' : 'outdated';
  return { entry, installedVersion: matched.version, status };
}

/** `list_workspace_modules`: every indexed module's state in one workspace. */
export async function loadWorkspaceModuleStates(
  client: PoolClient,
  workspaceId: string,
  registry: ReadonlyMap<string, ModuleRegistryEntry>,
): Promise<readonly WorkspaceModuleState[]> {
  const states: WorkspaceModuleState[] = [];
  for (const entry of registry.values()) {
    const packId = deriveOntologyPackId(entry.name);
    const installed = await loadInstalledPackVersion(client, workspaceId, packId);
    states.push(
      classifyModuleState(entry, installed ? hashOntologyDefinition(installed.definition) : null),
    );
  }
  return states;
}

// -------------------------------------------------------------------------------------------
// install / upgrade (D3) — `install_module` and `upgrade_module` share this one function
// -------------------------------------------------------------------------------------------

export interface ModuleConfirmRequiredDetails {
  readonly name: string;
  /** The current **index** version (D2's hash match), `null` when `currentStatus` is `customized`. */
  readonly currentVersion: number | null;
  readonly currentStatus: Extract<ModuleInstallStatus, 'outdated' | 'customized'>;
  readonly targetVersion: number;
  /** True when the target itself, or any index version *between* the current one and the target,
   *  is `breaking` — advancing straight to the target would silently skip past it otherwise. */
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
}

/**
 * `install_module` / `upgrade_module`'s one shared implementation (D3: "底层同一调用"): the family
 * absent in this workspace → publish the **latest** index version; present → also target the
 * **latest** index version (never `installedVersion + 1` — D3's "族不存在 → v1；存在 → 下一版本"
 * describes the *`ontology_versions` DB version number* `publishOntologyDomainPack`/
 * `nextOntologyVersion` themselves advance by one on every publish, not this index's own version
 * numbering; a workspace's *index* version is only ever known by hash match (D2), and the two
 * counters are not the same thing — republishing identical content still bumps the DB number, so a
 * workspace's DB version can run arbitrarily far ahead of, or never equal, its matched index
 * version). One publish call reaches the target directly; this function never steps through
 * intermediate index versions one at a time.
 *
 * No-op short-circuit before ever calling `publishOntologyDomainPack` (never waste a version
 * number, D3's own words): the target's hash already equals what is installed (covers both "already
 * at the latest content" and "nothing to do, called again"). Returns the current state unpublished.
 *
 * Otherwise, `confirm: true` is required (`ModuleConfirmRequiredError` — 400 `module_
 * confirm_required` — otherwise) when either:
 *   - the current install is `customized` (D2: its hash matches no known index version at all), or
 *   - **any** index version strictly after the currently-matched one, up to and including the
 *     target, is `breaking` — jumping straight to the target must not silently skip past an
 *     intermediate breaking version nobody confirmed.
 *
 * `publishOntologyDomainPack` runs under `principalId` (D4's own `proposed_by = principalId`
 * requirement — `publishOntologyVersion`'s `principalId` input already sets both `proposed_by` and
 * `published_by` to it, the no-draft-phase bootstrap shape `loader.ts` already documents).
 */
export async function installOrUpgradeModule(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  registry: ReadonlyMap<string, ModuleRegistryEntry>,
  input: InstallOrUpgradeModuleInput,
  /** Must be the same directory `registry` was built from (`loadModuleRegistry(dir)`) — this is
   *  what `publishOntologyDomainPack` reads the target version's file from. Defaults to
   *  `resolveOntologyDir()`, matching `loadModuleRegistry`'s own default, so every caller that
   *  built its registry with the default dir needs to pass nothing extra; a caller using a
   *  non-default `dir` (a test fixture, `create.ts`'s `ontologyDir`) must pass the identical value
   *  here or the publish reads the wrong file (or none at all). */
  dir: string = resolveOntologyDir(),
): Promise<WorkspaceModuleState> {
  const entry = requireModule(registry, input.name);
  const packId = deriveOntologyPackId(entry.name);
  const installedRow = await loadInstalledPackVersion(client, workspaceId, packId);
  const target = latestVersion(entry);

  if (!installedRow) {
    const published = await publishOntologyDomainPack(client, workspaceId, {
      packName: entry.name,
      fileName: target.file,
      dir,
      principalId,
    });
    return classifyModuleState(entry, hashOntologyDefinition(published.definition));
  }

  const installedHash = hashOntologyDefinition(installedRow.definition);
  const current = classifyModuleState(entry, installedHash);

  // No-op: the target's content is already what is installed (already up to date by content, or
  // this call is a no-op retry) — never spend a version number republishing it (D3).
  if (target.hash === installedHash) return current;

  // `current.status` is `outdated` or `customized` here — `up_to_date` would mean
  // `installedHash === target.hash` (target is always the latest), already handled by the no-op
  // above; `not_installed` cannot occur (`installedRow` is non-null in this branch).
  const currentStatus = current.status as Extract<ModuleInstallStatus, 'outdated' | 'customized'>;
  const rangeHasBreaking =
    currentStatus === 'customized'
      ? false // customized alone already forces confirm below; no "from version" to range over
      : entry.versions.some(
          (v) =>
            v.version > (current.installedVersion as number) &&
            v.version <= target.version &&
            v.breaking,
        );
  const needsConfirm = currentStatus === 'customized' || rangeHasBreaking;

  if (needsConfirm && input.confirm !== true) {
    throw new ModuleConfirmRequiredError({
      name: entry.name,
      currentVersion: current.installedVersion,
      currentStatus,
      targetVersion: target.version,
      breaking: currentStatus === 'customized' ? target.breaking : rangeHasBreaking,
    });
  }

  const published = await publishOntologyDomainPack(client, workspaceId, {
    packName: entry.name,
    fileName: target.file,
    dir,
    principalId,
  });
  return classifyModuleState(entry, hashOntologyDefinition(published.definition));
}

// -------------------------------------------------------------------------------------------
// platform-wide aggregate (`list_modules`: "装到 n 个工作区 / m 个有新版") — hash-based, same
// `classifyModuleState` every per-workspace read uses (D2): the raw `ontology_versions.version`
// row number is never compared against the index's own version numbering (see `WorkspaceModuleState
// .installedVersion`'s own doc comment on why the two are not the same counter).
// -------------------------------------------------------------------------------------------

export interface ModuleInstallCounts {
  readonly installedWorkspaceCount: number;
  /** Of `installedWorkspaceCount`, how many are not `up_to_date` — `outdated` (matches an older
   *  index version) or `customized` (matches none) both count: either way, the workspace is not on
   *  the module's current standard content. */
  readonly newerAvailableCount: number;
}

/** For every module in `registry`, across every workspace in `workspaceIds`: how many have any
 *  published row for that family, and how many of those are not `up_to_date`. One
 *  `select distinct on (id) ...` per workspace (all module families in one query, via
 *  `setWorkspaceContext` — the same platform-transaction technique `application/gateway/platform-
 *  handlers.ts`'s own `countGatekeepers` already uses for a per-workspace RLS-scoped count), not
 *  one query per (workspace, module) pair — fetches each row's `definition` (not just `version`)
 *  since classification is hash-based. Caller must be inside a platform transaction
 *  (`withPlatform`) — `setWorkspaceContext` is a no-op guard otherwise. Resets the workspace GUC
 *  before returning (`countGatekeepers`'s own convention), so a caller that runs more platform-
 *  scoped queries afterward never inherits a stale workspace context. */
export async function countModuleInstallations(
  client: PoolClient,
  workspaceIds: readonly string[],
  registry: ReadonlyMap<string, ModuleRegistryEntry>,
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
        const status = classifyModuleState(entry, hashOntologyDefinition(row.definition)).status;
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
export function assertKnownModuleNames(
  registry: ReadonlyMap<string, ModuleRegistryEntry>,
  names: readonly string[],
): void {
  for (const name of names) requireModule(registry, name);
}
