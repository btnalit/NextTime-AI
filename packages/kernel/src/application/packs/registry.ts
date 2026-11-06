import type { Dirent } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTOR_NAME_PATTERN,
  type PackSource as PackSourceValue,
  SkillApplicableSchema,
  type WorkerWorkerDefinitionContent,
  WorkerWorkerDefinitionContentSchema,
} from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { WORKER_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { findSuspectedSecrets, shownFreeText } from '../../governance/redaction/index.js';
import {
  type OntologyDefinition,
  loadOntologyDefinitionFile,
  parseOntologyDefinition,
  resolveOntologyDir,
} from '../../substrate/ontology/index.js';
import {
  type SkillItemContent,
  contentDigest,
  derivePackComponentId,
} from '../change-plan/index.js';
import { validateSkillContent } from '../worker/index.js';
import {
  PACK_NAME_PATTERN,
  PackManifestError,
  type PackRequirementManifest,
  parsePackManifest,
} from './manifest.js';

/**
 * application/packs/registry: the packs this deployment ships — every `packs/<name>/<version>/
 * pack.yaml` (Pack Contract v1, `manifest.ts`) with its components read and digested (S11 P1-C).
 *
 * Read fresh on every call that needs it (no cache): the manifests and the domain packs they name
 * are baked into the image and change only with a redeploy, the same choice the module index made
 * (`application/platform/modules.ts`). Nothing about a pack is stored in the database: what a
 * workspace has installed is read from its components' current state (`state.ts`).
 *
 * A version's Skills and Workers are files beside its manifest (S11 P1-D):
 *   - `skills/<name>.md` — a `---` frontmatter block (`name`, which is the file's; `description`;
 *     optionally `applicable`, `@nexttime/shared` skill.ts) and then the Skill's body, the text a
 *     Worker that mounts it reads. Checked by `publish_skill`'s own rules (`validateSkillContent`).
 *   - `workers/<name>.yaml` — a `worker` WorkerDefinition's content (`WorkerWorkerDefinitionContent
 *     Schema`) without `name` (the file's) and without `kind`, `gates` or `model`: the systems a
 *     Worker acts on and the models it runs on are the workspace's own, never a pack's. Its
 *     `skills` name Skills of the same version (a pack installs what its Workers mount), and its
 *     `capabilities`, when declared, are within the worker ceiling. Beside the content, `systems`
 *     (S11 P1-E2) names the kinds of system the Worker acts on, by connector name, each one the
 *     version `requires`: never a gate — which gates of those systems it may act on is the
 *     workspace's, offered when the pack is installed (`install.ts`).
 * Neither may carry a suspected credential (`findSuspectedSecrets`, the rule `publish_skill` /
 * `publish_worker_definition` ask a person to confirm): a pack is published by the platform, not
 * reviewed value by value, so one found is a deployment bug like any other here.
 *
 * Rules across manifests, checked here (any break refuses the whole registry with
 * `PackRegistryError` — a deployment bug, loud at the first read, never a pack silently missing):
 *   - `packs/<name>/` is a pack name; its subdirectories are its versions, `1`, `2`, … dense from 1;
 *     each holds a `pack.yaml` whose `name` and `version` are the directory's;
 *   - a component — an ontology family, a Skill name, a Worker name — belongs to one pack: two
 *     packs publishing one family would each read the other's versions as "customized" (and two
 *     Skills of one name could never both be published);
 *   - a component a version publishes is in every later version of its pack: taking a component
 *     out is uninstalling it, which Pack Contract v1 does not do (an upgrade never leaves a family
 *     behind that no version of its pack describes any more);
 *   - every domain pack a component names exists in the ontology library and parses;
 *   - a pack a version requires (`requires.packs`, S11 P1-F) is in this deployment with the version
 *     it names, and no pack requires its way back to itself, through any of its versions.
 *
 * A Skill's or Worker's family id is derived from the pack and the name (`derivePackComponentId`),
 * the same in every workspace — as an ontology family's is from its name (`deriveOntologyPackId`).
 *
 * **Extra packs** (S11 AA5d): a deployment may add packs of its own beside the image's, in
 * `EXTRA_PACKS_DIR` (`/data/config/packs` in the compose file, the host's `config/packs/` through
 * the kernel's read-only config mount) — an applied admin proposal exported as a pack, an
 * organization's own. They are read on every call like the image's (no restart: a maintainer
 * unpacks one beside the directory and moves it in, so a half-written one is never read) and are
 * Pack Contract v1 to the letter, with one difference: a version's `domainPack` files are its own
 * `ontology/<file>`, since a pack from outside the image cannot add to the ontology library. Each
 * is `source: 'extra'` (`PackEntry.source`), never a module (`application/platform/modules.ts`).
 * The image's packs are checked first and alone, as above; an extra pack breaking any rule —
 * its own (a manifest, a component file, versions, a file that is a symbolic link or sits under one
 * — `confinedDiskPackFiles`), or one across packs (a name or a component
 * the image's packs have, a component another extra pack publishes too, a pack it requires that
 * is not here, a cycle) — is left out with the reason (`readPackRegistry`'s `skipped`, logged and
 * shown to platform administrators by `extra_packs_status`), and so is every extra pack requiring
 * one left out. Never the whole registry: one mistyped file would otherwise take listing,
 * installing, verifying, proposing and creating workspaces down with it. Two extra packs that
 * clash are both left out — neither is the one meant. The image's packs never require an extra
 * one (they are checked without them).
 */

/** One ontology component of a PackVersion, its domain pack read. */
export interface PackOntologyComponent {
  readonly kind: 'ontology';
  readonly family: string;
  /** The domain pack file in the ontology library. */
  readonly domainPack: string;
  readonly definition: OntologyDefinition;
  /** `contentDigest(definition)` — the digest a change item records for it. */
  readonly definitionDigest: string;
}

/** One Skill of a PackVersion, its file read. */
export interface PackSkillComponent {
  readonly kind: 'skill';
  readonly name: string;
  /** The Skill family's id (`derivePackComponentId`). */
  readonly skillId: string;
  readonly content: SkillItemContent;
  /** `contentDigest(content)` — the digest a change item records for it. */
  readonly contentDigest: string;
}

/** One `worker` WorkerDefinition of a PackVersion, its file read. */
export interface PackWorkerComponent {
  readonly kind: 'worker';
  readonly name: string;
  /** The WorkerDefinition family's id (`derivePackComponentId`). */
  readonly definitionId: string;
  /** The definition as the pack ships it: the file's content with `name`, parsed (so normalized),
   *  without `systems` — never `gates` or `model`, which are the workspace's
   *  (`WORKSPACE_OWNED_WORKER_FIELDS`). */
  readonly definition: WorkerWorkerDefinitionContent;
  /** `contentDigest(definition)` — what the pack's part of an installed head is compared with
   *  (`packOwnedWorkerDigest`). */
  readonly contentDigest: string;
  /** The connectors of the systems it acts on (the file's `systems`, in its order), each one the
   *  version requires; empty when it names none. */
  readonly systems: readonly string[];
}

/** The fields of a pack's Worker that are the workspace's own (see this module's comment): a pack
 *  never ships them, an install keeps whatever the workspace has set (`install.ts`), and a head that
 *  differs from a pack version only in them still has that version's content (`state.ts`). */
export const WORKSPACE_OWNED_WORKER_FIELDS = ['gates', 'model'] as const;

/** The digest of the part of a `worker` definition a pack ships: `contentDigest` of it without the
 *  workspace's own fields — what `PackWorkerComponent.contentDigest` is for the pack's file. */
export function packOwnedWorkerDigest(definition: Readonly<Record<string, unknown>>): string {
  const owned: Record<string, unknown> = { ...definition };
  for (const field of WORKSPACE_OWNED_WORKER_FIELDS) delete owned[field];
  return contentDigest(owned);
}

export type PackComponent = PackOntologyComponent | PackSkillComponent | PackWorkerComponent;

/** A component's identity across a pack's versions and across packs (`ontology:<family>`,
 *  `skill:<name>`, `worker:<name>`). */
export function packComponentKey(component: PackComponent): string {
  return component.kind === 'ontology'
    ? `ontology:${component.family}`
    : `${component.kind}:${component.name}`;
}

/** The digest of what a component installs — what its family's head has once it is installed. */
export function packComponentDigest(component: PackComponent): string {
  return component.kind === 'ontology' ? component.definitionDigest : component.contentDigest;
}

/** A component as people read it in an error. */
function describeComponent(component: PackComponent): string {
  switch (component.kind) {
    case 'ontology':
      return `ontology family "${component.family}"`;
    case 'skill':
      return `Skill "${component.name}"`;
    case 'worker':
      return `Worker "${component.name}"`;
  }
}

// S11 AA3b-2: lives in `application/change-plan` (an admin proposal's new families are named the same
// way), re-exported here for the pack code that always used it.
export { derivePackComponentId };

export interface PackVersion {
  readonly name: string;
  readonly version: number;
  readonly summary: string;
  readonly notes: string;
  readonly breaking: boolean;
  /** The connectors its components work with (`manifest.ts`' `requires.connectors`), in the
   *  manifest's order; empty when it declares none. */
  readonly requiredConnectors: readonly string[];
  /** The packs it builds on (`manifest.ts`' `requires.packs`, S11 P1-F), each with the lowest
   *  version that will do, in the manifest's order; empty when it declares none. */
  readonly requiredPacks: readonly PackRequirementManifest[];
  /** Ontology components in the manifest's order, then Skills, then Workers — the order the
   *  install's items publish them in (a Worker after the Skills it mounts). */
  readonly components: readonly PackComponent[];
  /** `sha256:` digest of the manifest and each component's content: the source digest of every
   *  change segment applied from this version. */
  readonly digest: string;
}

/** Where a pack comes from (S11 AA5d; `@nexttime/shared` `PACK_SOURCE_VALUES`): the image's own
 *  `packs/` (`builtin`), or the deployment's extra packs directory (`extra`, this module's
 *  comment). */
export type PackSource = PackSourceValue;

export interface PackEntry {
  readonly name: string;
  readonly source: PackSource;
  /** Ascending by `version`, dense from 1. */
  readonly versions: readonly PackVersion[];
}

export type PackRegistry = ReadonlyMap<string, PackEntry>;

/** The registry breaks a rule across manifests, or cannot be read (see this module's comment). */
export class PackRegistryError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`pack registry: ${reason}`, options);
    this.name = 'PackRegistryError';
  }
}

/** `404 pack_not_found`: no pack of this name in this deployment. */
export class PackNotFoundError extends Error {
  readonly code = 'pack_not_found' as const;
  constructor(name: string) {
    super(`pack "${name}" is not in this deployment`);
    this.name = 'PackNotFoundError';
  }
}

// `packs/` is repo-root content like `ontology/` (`substrate/ontology/loader.ts`'s
// `resolveOntologyDir` explains the layout): the image copies it to /app/packs and sets PACKS_DIR;
// the relative fallback is local development's.
function defaultPacksDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = packages/kernel/{src,dist}/application/packs: five levels up is the repo root.
  return path.join(here, '..', '..', '..', '..', '..', 'packs');
}

/** The `packs/` directory: `PACKS_DIR` when set (always, in the image), else the repo root's. */
export function resolvePacksDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PACKS_DIR || defaultPacksDir();
}

/** S11 AA5d: the extra packs directory (this module's comment) — `EXTRA_PACKS_DIR`, or none. */
export function resolveExtraPacksDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.EXTRA_PACKS_DIR || null;
}

export interface PackRegistryOptions {
  /** Default `resolvePacksDir()`. */
  readonly packsDir?: string;
  /** Where a built-in pack's `domainPack` files are read. Default `resolveOntologyDir()`. */
  readonly ontologyDir?: string;
  /** S11 AA5d: where extra packs are read. Default `resolveExtraPacksDir()`; `null`: none. */
  readonly extraPacksDir?: string | null;
}

/**
 * The files packs are read from (S11 AA5d): a directory on disk (`diskPackFiles`) — the image's,
 * or the extra packs directory — or files held in memory (`memoryPackFiles`), so a pack written
 * by the platform itself is read by the same rules before anyone is handed it. Paths are built
 * with `path.join`.
 */
export interface PackFiles {
  /** The file's text; throws when there is none or it cannot be read. */
  readonly readText: (file: string) => Promise<string>;
  /** `dir`'s subdirectories by name, sorted, hidden ones (`.name`) left out; throws when `dir`
   *  cannot be read. */
  readonly subdirectories: (dir: string) => Promise<readonly string[]>;
}

export const diskPackFiles: PackFiles = {
  readText: (file) => readFile(file, 'utf8'),
  subdirectories: async (dir) => {
    const entries: Dirent[] = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  },
};

/**
 * `diskPackFiles` confined to `root` (S11 AA5d, the extra packs directory): a file read is refused
 * when it is a symbolic link or sits under one beneath `root` — its real path must be its path under
 * `root`'s real path. An extra pack comes from outside the image, and a link in it would read
 * whatever the kernel can (`/run/secrets/…`) into a pack a workspace installs; a pack's files are
 * its own. Directories need nothing more: a link is never listed as one (`Dirent.isDirectory`).
 */
export function confinedDiskPackFiles(root: string): PackFiles {
  let realRoot: Promise<string> | undefined;
  return {
    readText: async (file) => {
      realRoot ??= realpath(root);
      const expected = path.join(await realRoot, path.relative(root, file));
      const real = await realpath(file);
      if (real !== expected) {
        throw new Error(
          `"${file}" is a symbolic link or under one; a pack's files are its own, not links`,
        );
      }
      return readFile(real, 'utf8');
    },
    subdirectories: diskPackFiles.subdirectories,
  };
}

/** Files in memory, keyed by their path under `root` (`<pack>/<version>/pack.yaml`, …, with `/`):
 *  a directory is any path prefix of a file. */
export function memoryPackFiles(root: string, files: ReadonlyMap<string, string>): PackFiles {
  const under = (target: string): string[] => {
    const relative = path.relative(root, target);
    return relative === '' ? [] : relative.split(path.sep);
  };
  const keys = [...files.keys()].map((key) => key.split('/'));
  return {
    readText: async (file) => {
      const text = files.get(under(file).join('/'));
      if (text === undefined) throw new Error(`ENOENT: no such file "${file}"`);
      return text;
    },
    subdirectories: async (dir) => {
      const prefix = under(dir);
      const names = new Set<string>();
      let found = prefix.length === 0;
      for (const key of keys) {
        if (key.length <= prefix.length || !prefix.every((part, index) => key[index] === part)) {
          continue;
        }
        found = true;
        const name = key[prefix.length] as string;
        // A file directly in `dir` is not a subdirectory.
        if (key.length > prefix.length + 1 && !name.startsWith('.')) names.add(name);
      }
      if (!found) throw new Error(`ENOENT: no such directory "${dir}"`);
      return [...names].sort();
    },
  };
}

async function subdirectories(files: PackFiles, dir: string): Promise<readonly string[]> {
  try {
    return await files.subdirectories(dir);
  } catch (err) {
    throw new PackRegistryError(`cannot read ${dir}: ${String(err)}`, { cause: err });
  }
}

async function readComponentFile(files: PackFiles, file: string): Promise<string> {
  try {
    return await files.readText(file);
  } catch (err) {
    throw new PackManifestError(file, `cannot be read: ${String(err)}`, { cause: err });
  }
}

/** Where a version's `domainPack` files are: the platform's ontology library (a built-in pack), or
 *  the version's own `ontology/` directory (an extra pack, this module's comment). */
export type DomainPackLocation = { readonly library: string } | 'version';

async function loadDomainPack(
  files: PackFiles,
  versionDir: string,
  location: DomainPackLocation,
  file: string,
): Promise<OntologyDefinition> {
  if (location !== 'version') return loadOntologyDefinitionFile(path.join(location.library, file));
  const source = path.join(versionDir, 'ontology', file);
  return parseOntologyDefinition(await readComponentFile(files, source), source);
}

/** Refuses content carrying a suspected credential (see this module's comment). */
function assertNoSuspectedSecrets(
  source: string,
  content: unknown,
  options: { readonly secretFields?: boolean } = {},
): void {
  const found = findSuspectedSecrets(content, options);
  if (found.count > 0) {
    throw new PackManifestError(
      source,
      `carries ${found.count} suspected credential value(s) (at ${found.paths.join(', ')}); a pack ships no credentials`,
    );
  }
}

const SkillFrontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    applicable: SkillApplicableSchema.optional(),
  })
  .strict();

/** A `---` line, alone, opens and closes the frontmatter block. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

async function loadSkillComponent(
  files: PackFiles,
  versionDir: string,
  pack: string,
  name: string,
): Promise<PackSkillComponent> {
  const source = path.join(versionDir, 'skills', `${name}.md`);
  const match = FRONTMATTER.exec(await readComponentFile(files, source));
  if (!match) {
    throw new PackManifestError(
      source,
      'a Skill file starts with a `---` frontmatter block (name, description, optionally applicable), then its body',
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? '');
  } catch (err) {
    throw new PackManifestError(source, `frontmatter is not YAML: ${String(err)}`, { cause: err });
  }
  const frontmatter = SkillFrontmatterSchema.safeParse(raw);
  if (!frontmatter.success) throw new PackManifestError(source, frontmatter.error.message);
  if (frontmatter.data.name !== name) {
    throw new PackManifestError(
      source,
      `frontmatter names Skill "${frontmatter.data.name}" but the manifest and file name say "${name}"`,
    );
  }
  const content: SkillItemContent = {
    name,
    description: frontmatter.data.description,
    // Leading blank lines after the block are layout, not body.
    markdown: (match[2] ?? '').replace(/^(?:[ \t]*\r?\n)+/, ''),
    applicable: frontmatter.data.applicable ?? {},
  };
  try {
    validateSkillContent(content);
  } catch (err) {
    throw new PackManifestError(source, String(err instanceof Error ? err.message : err), {
      cause: err,
    });
  }
  assertNoSuspectedSecrets(source, content);
  return {
    kind: 'skill',
    name,
    skillId: derivePackComponentId(pack, 'skill', name),
    content,
    contentDigest: contentDigest(content),
  };
}

/** Fields a pack's Worker file never has, and why. */
const WORKER_FIELDS_NOT_IN_A_PACK: Readonly<Record<string, string>> = {
  name: 'its name is the file name',
  kind: 'a pack installs `worker` WorkerDefinitions only',
  gates:
    'the gates a Worker acts on are the workspace’s own, never a pack’s (name the kinds of system with `systems`)',
  model: 'the models a Worker runs on are the workspace’s own, never a pack’s',
};

/** A Worker file's `systems`: connector names, at least one, each once. */
const WorkerSystemsSchema = z.array(z.string().regex(CONNECTOR_NAME_PATTERN)).min(1);

/** Reads a Worker file's `systems` (see `PackWorkerComponent.systems`): each one a system the
 *  version requires (so never a transport, which the manifest refuses), each named once. */
function workerSystems(
  source: string,
  raw: unknown,
  requiredConnectors: ReadonlySet<string>,
): readonly string[] {
  if (raw === undefined) return [];
  const parsed = WorkerSystemsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PackManifestError(source, `systems: ${parsed.error.message}`);
  }
  const systems = parsed.data;
  const repeated = systems.find((system, index) => systems.indexOf(system) !== index);
  if (repeated !== undefined) {
    throw new PackManifestError(source, `names system ${JSON.stringify(repeated)} twice`);
  }
  const unrequired = systems.filter((system) => !requiredConnectors.has(system));
  if (unrequired.length > 0) {
    throw new PackManifestError(
      source,
      `acts on system(s) ${unrequired.map((system) => JSON.stringify(system)).join(', ')} that the version does not require (add them to requires.connectors)`,
    );
  }
  return systems;
}

async function loadWorkerComponent(
  files: PackFiles,
  versionDir: string,
  pack: string,
  name: string,
  skills: ReadonlySet<string>,
  requiredConnectors: ReadonlySet<string>,
): Promise<PackWorkerComponent> {
  const source = path.join(versionDir, 'workers', `${name}.yaml`);
  let raw: unknown;
  try {
    raw = parseYaml(await readComponentFile(files, source));
  } catch (err) {
    if (err instanceof PackManifestError) throw err;
    throw new PackManifestError(source, `not YAML: ${String(err)}`, { cause: err });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackManifestError(source, 'a Worker file is a mapping of WorkerDefinition fields');
  }
  for (const [field, reason] of Object.entries(WORKER_FIELDS_NOT_IN_A_PACK)) {
    if (field in raw) throw new PackManifestError(source, `declares \`${field}\`: ${reason}`);
  }
  const { systems: rawSystems, ...content } = raw as Record<string, unknown>;
  const systems = workerSystems(source, rawSystems, requiredConnectors);
  const parsed = WorkerWorkerDefinitionContentSchema.safeParse({ ...content, name });
  if (!parsed.success) throw new PackManifestError(source, parsed.error.message);
  const definition = parsed.data;
  const foreign = (definition.skills ?? []).filter((skill) => !skills.has(skill));
  if (foreign.length > 0) {
    throw new PackManifestError(
      source,
      `mounts Skill(s) ${foreign.map((skill) => JSON.stringify(skill)).join(', ')} that this pack version does not ship; a pack's Worker mounts the pack's own Skills`,
    );
  }
  const ceiling: ReadonlySet<string> = new Set(WORKER_CEILING_CAPABILITIES);
  const beyond = (definition.capabilities ?? []).filter((capability) => !ceiling.has(capability));
  if (beyond.length > 0) {
    throw new PackManifestError(
      source,
      `declares capabilities a Worker can never hold: ${beyond.join(', ')}`,
    );
  }
  assertNoSuspectedSecrets(source, definition, { secretFields: true });
  return {
    kind: 'worker',
    name,
    definitionId: derivePackComponentId(pack, 'worker', name),
    definition,
    contentDigest: contentDigest(definition),
    systems,
  };
}

async function loadPackVersion(
  files: PackFiles,
  packDir: string,
  name: string,
  version: number,
  domainPacks: DomainPackLocation,
): Promise<PackVersion> {
  const versionDir = path.join(packDir, String(version));
  const source = path.join(versionDir, 'pack.yaml');
  const manifest = parsePackManifest(await readComponentFile(files, source), source);
  if (manifest.name !== name || manifest.version !== version) {
    throw new PackManifestError(
      source,
      `declares ${manifest.name} v${manifest.version} but sits at ${name}/${version}`,
    );
  }
  const components: PackComponent[] = [];
  for (const component of manifest.components.ontology ?? []) {
    const definition = await loadDomainPack(files, versionDir, domainPacks, component.domainPack);
    components.push({
      kind: 'ontology',
      family: component.family,
      domainPack: component.domainPack,
      definition,
      definitionDigest: contentDigest(definition),
    });
  }
  const skills = manifest.components.skills ?? [];
  for (const skill of skills) {
    components.push(await loadSkillComponent(files, versionDir, name, skill));
  }
  const requiredConnectors = new Set(manifest.requires?.connectors ?? []);
  for (const worker of manifest.components.workers ?? []) {
    components.push(
      await loadWorkerComponent(
        files,
        versionDir,
        name,
        worker,
        new Set(skills),
        requiredConnectors,
      ),
    );
  }
  const digest = contentDigest({
    schema: manifest.schema,
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    notes: manifest.notes,
    breaking: manifest.breaking,
    // Only when declared (P1-E), so the versions shipped before keep their digest.
    ...(manifest.requires ? { requires: manifest.requires } : {}),
    // An ontology component's entry is what it was before Skills and Workers joined (P1-C), so
    // the versions shipped then keep their digest.
    components: components.map((c) =>
      c.kind === 'ontology'
        ? {
            kind: c.kind,
            family: c.family,
            domainPack: c.domainPack,
            definitionDigest: c.definitionDigest,
          }
        : {
            kind: c.kind,
            name: c.name,
            contentDigest: c.contentDigest,
            // Only when declared (P1-E2), so the versions shipped before keep their digest.
            ...(c.kind === 'worker' && c.systems.length > 0 ? { systems: c.systems } : {}),
          },
    ),
  });
  return {
    name,
    version,
    summary: manifest.summary,
    notes: manifest.notes,
    breaking: manifest.breaking,
    requiredConnectors: manifest.requires?.connectors ?? [],
    requiredPacks: manifest.requires?.packs ?? [],
    components,
    digest,
  };
}

/** Reads one pack — `packDir` holds its versions — and checks its own rules (a pack name, versions
 *  dense from 1 whose manifests are theirs, each keeping the components of the one before); the
 *  rules across packs are the caller's. Throws `PackRegistryError` / `PackManifestError` (or the
 *  ontology parser's error) on the first break. */
export async function loadPackEntry(
  files: PackFiles,
  packDir: string,
  name: string,
  source: PackSource,
  domainPacks: DomainPackLocation,
): Promise<PackEntry> {
  if (!PACK_NAME_PATTERN.test(name)) {
    throw new PackRegistryError(`packs/${name}: not a pack name (${PACK_NAME_PATTERN})`);
  }
  const versionDirs = await subdirectories(files, packDir);
  const numbers = versionDirs.map((dir) => (/^[1-9][0-9]*$/.test(dir) ? Number(dir) : Number.NaN));
  const bad = versionDirs.find((_, index) => Number.isNaN(numbers[index]));
  if (bad !== undefined) {
    throw new PackRegistryError(`packs/${name}/${bad}: a version directory is a number from 1`);
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 0 || !sorted.every((version, index) => version === index + 1)) {
    throw new PackRegistryError(
      `packs/${name}: versions must be dense from 1 (got: ${sorted.join(', ') || 'none'})`,
    );
  }
  const versions: PackVersion[] = [];
  for (const version of sorted) {
    const loaded = await loadPackVersion(files, packDir, name, version, domainPacks);
    const previous = versions[versions.length - 1];
    const keys = new Set(loaded.components.map(packComponentKey));
    const dropped = previous?.components.find(
      (component) => !keys.has(packComponentKey(component)),
    );
    if (previous && dropped) {
      throw new PackRegistryError(
        `packs/${name}/${version}: drops ${describeComponent(dropped)} that version ${previous.version} publishes; a later version keeps every component`,
      );
    }
    versions.push(loaded);
  }
  return { name, source, versions };
}

/** The components each pack publishes, by `packComponentKey`. */
function componentKeysOf(entry: PackEntry): ReadonlySet<string> {
  return new Set(entry.versions.flatMap((version) => version.components.map(packComponentKey)));
}

/** An extra pack left out of the registry, and why (S11 AA5d, this module's comment). */
export interface SkippedExtraPack {
  /** Its directory's name under the extra packs directory. */
  readonly name: string;
  /** In words; a file is named by its path under the extra packs directory. */
  readonly reason: string;
}

export interface PackRegistryRead {
  readonly registry: PackRegistry;
  /** The extra packs directory read; `null` when the deployment has none. */
  readonly extraPacksDir: string | null;
  /** Extra packs left out, in name order. */
  readonly skipped: readonly SkippedExtraPack[];
  /** The extra packs directory is there but cannot be read (no extra pack is); `null` otherwise. */
  readonly extraPacksUnreadable: string | null;
}

/** Reads every pack: the image's, which must keep every rule (see this module's comment), and the
 *  extra ones, each left out with the reason when it breaks one. */
export async function readPackRegistry(
  options: PackRegistryOptions = {},
): Promise<PackRegistryRead> {
  const packsDir = options.packsDir ?? resolvePacksDir();
  const ontologyDir = options.ontologyDir ?? resolveOntologyDir();
  const extraPacksDir =
    options.extraPacksDir !== undefined ? options.extraPacksDir : resolveExtraPacksDir();
  const builtin = new Map<string, PackEntry>();
  const componentOwner = new Map<string, string>();
  for (const name of await subdirectories(diskPackFiles, packsDir)) {
    const entry = await loadPackEntry(diskPackFiles, path.join(packsDir, name), name, 'builtin', {
      library: ontologyDir,
    });
    for (const version of entry.versions) {
      for (const component of version.components) {
        const key = packComponentKey(component);
        const owner = componentOwner.get(key);
        if (owner !== undefined && owner !== name) {
          throw new PackRegistryError(
            `${describeComponent(component)} is published by both pack "${owner}" and pack "${name}"; a component belongs to one pack`,
          );
        }
        componentOwner.set(key, name);
      }
    }
    builtin.set(name, entry);
  }
  assertPackRequirements(builtin);
  if (extraPacksDir === null) {
    return { registry: builtin, extraPacksDir, skipped: [], extraPacksUnreadable: null };
  }
  const extra = await readExtraPacks(extraPacksDir, builtin, componentOwner);
  const registry = new Map<string, PackEntry>(builtin);
  for (const entry of extra.admitted) registry.set(entry.name, entry);
  return {
    registry,
    extraPacksDir,
    skipped: extra.skipped,
    extraPacksUnreadable: extra.unreadable,
  };
}

/** The longest reason an extra pack left out is given with (`SkippedExtraPack.reason`). */
const SKIPPED_REASON_MAX = 2_000;

/** What `readExtraPacks` read. */
interface ExtraPacks {
  readonly admitted: readonly PackEntry[];
  readonly skipped: readonly SkippedExtraPack[];
  readonly unreadable: string | null;
}

/** The extra packs in `dir` that keep every rule, given the image's packs (this module's comment):
 *  each read alone, then the rules across packs applied until no more is left out. */
async function readExtraPacks(
  dir: string,
  builtin: PackRegistry,
  builtinOwner: ReadonlyMap<string, string>,
): Promise<ExtraPacks> {
  // A file is named by its path under `dir`, as the maintainer who put it there sees it; a parser's
  // message may quote the file, so a value that looks like a credential is masked (`shownFreeText`)
  // and the reason is clipped.
  const local = (message: string): string => {
    const text = shownFreeText(message.split(`${dir}${path.sep}`).join(''));
    return text.length > SKIPPED_REASON_MAX ? `${text.slice(0, SKIPPED_REASON_MAX)}…` : text;
  };
  let names: readonly string[];
  try {
    names = await diskPackFiles.subdirectories(dir);
  } catch (err) {
    // No directory: the deployment has no extra packs (one set up before AA5d).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { admitted: [], skipped: [], unreadable: null };
    }
    return { admitted: [], skipped: [], unreadable: local(String(err)) };
  }
  const skipped = new Map<string, string>();
  const loaded = new Map<string, PackEntry>();
  const files = confinedDiskPackFiles(dir);
  for (const name of names) {
    if (builtin.has(name)) {
      skipped.set(name, `a pack named "${name}" ships with the platform`);
      continue;
    }
    try {
      loaded.set(name, await loadPackEntry(files, path.join(dir, name), name, 'extra', 'version'));
    } catch (err) {
      skipped.set(name, local(err instanceof Error ? err.message : String(err)));
    }
  }
  // A component of the image's packs, or of another extra pack: both are left out.
  const extraOwners = new Map<string, string[]>();
  for (const entry of loaded.values()) {
    for (const key of componentKeysOf(entry)) {
      const owner = builtinOwner.get(key);
      if (owner !== undefined && !skipped.has(entry.name)) {
        skipped.set(
          entry.name,
          `publishes ${describeKey(key)}, which pack "${owner}" that ships with the platform publishes`,
        );
      }
      extraOwners.set(key, [...(extraOwners.get(key) ?? []), entry.name]);
    }
  }
  for (const [key, owners] of extraOwners) {
    if (owners.length < 2) continue;
    for (const owner of owners) {
      if (skipped.has(owner)) continue;
      const others = owners.filter((other) => other !== owner);
      skipped.set(
        owner,
        `publishes ${describeKey(key)}, which extra pack(s) ${others.map((other) => `"${other}"`).join(', ')} publish too; a component belongs to one pack`,
      );
    }
  }
  // Packs required: here (the image's or a kept extra one) with the version named, no cycle — until
  // nothing more is left out, so whatever requires a pack left out is left out too.
  for (;;) {
    const kept = [...loaded.values()].filter((entry) => !skipped.has(entry.name));
    const unmet = kept.flatMap((entry) => {
      const reason = unmetRequirement(entry, (name) => {
        const target = builtin.get(name) ?? loaded.get(name);
        return target === undefined || skipped.has(name) ? undefined : target;
      });
      return reason === null ? [] : [[entry.name, reason] as const];
    });
    for (const [name, reason] of unmet) skipped.set(name, reason);
    if (unmet.length > 0) continue;
    const cycle = requirementCycle(kept);
    if (cycle === null) break;
    for (const name of cycle.slice(0, -1)) {
      skipped.set(name, `requires its way back to itself: ${cycle.join(' → ')}`);
    }
  }
  return {
    admitted: [...loaded.values()].filter((entry) => !skipped.has(entry.name)),
    skipped: [...skipped].map(([name, reason]) => ({ name, reason })).sort(byName),
    unreadable: null,
  };
}

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** `ontology:family` → `ontology family "family"`, as `describeComponent` says it. */
function describeKey(key: string): string {
  const [kind, name] = key.split(':') as [string, string];
  return kind === 'ontology'
    ? `ontology family "${name}"`
    : `${kind === 'skill' ? 'Skill' : 'Worker'} "${name}"`;
}

/** Why `entry` cannot have the packs it requires (`find` gives a pack that is here), or `null`. */
function unmetRequirement(
  entry: PackEntry,
  find: (name: string) => PackEntry | undefined,
): string | null {
  for (const version of entry.versions) {
    for (const required of version.requiredPacks) {
      const target = find(required.name);
      if (!target) {
        return `version ${version.version} requires pack "${required.name}", which is not here`;
      }
      if (target.versions.length < required.minVersion) {
        return `version ${version.version} requires pack "${required.name}" v${required.minVersion} or later, but it goes up to v${target.versions.length}`;
      }
    }
  }
  return null;
}

/** A cycle of requirements among `entries` (`a → b → a`), or `null`. */
function requirementCycle(entries: readonly PackEntry[]): readonly string[] | null {
  const edges = new Map(
    entries.map((entry) => [
      entry.name,
      new Set(
        entry.versions.flatMap((version) => version.requiredPacks.map((required) => required.name)),
      ),
    ]),
  );
  const done = new Set<string>();
  const visit = (name: string, trail: readonly string[]): readonly string[] | null => {
    if (trail.includes(name)) return [...trail.slice(trail.indexOf(name)), name];
    if (done.has(name)) return null;
    for (const next of edges.get(name) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next, [...trail, name]);
      if (found) return found;
    }
    done.add(name);
    return null;
  };
  for (const name of [...edges.keys()].sort()) {
    const found = visit(name, []);
    if (found) return found;
  }
  return null;
}

/** Each extra pack left out, logged once per reason by this process (the registry is read on
 *  every call). */
const reportedSkips = new Set<string>();

function reportSkipped(read: PackRegistryRead): void {
  const lines = [
    ...read.skipped.map((skip) => ({ pack: skip.name, reason: skip.reason })),
    ...(read.extraPacksUnreadable === null
      ? []
      : [
          {
            pack: null,
            reason: `cannot read the extra packs directory: ${read.extraPacksUnreadable}`,
          },
        ]),
  ];
  for (const line of lines) {
    const key = `${line.pack}\u0000${line.reason}`;
    if (reportedSkips.has(key)) continue;
    reportedSkips.add(key);
    console.warn(JSON.stringify({ event: 'extra_pack_skipped', ...line }));
  }
}

/** Reads every pack (see this module's comment for the rules it checks): `readPackRegistry`'s
 *  registry, an extra pack left out logged. */
export async function loadPackRegistry(options: PackRegistryOptions = {}): Promise<PackRegistry> {
  const read = await readPackRegistry(options);
  reportSkipped(read);
  return read.registry;
}

/** The packs each version requires are here, with the version it names, and none requires its way
 *  back to itself (see this module's comment). */
function assertPackRequirements(registry: PackRegistry): void {
  for (const entry of registry.values()) {
    for (const version of entry.versions) {
      for (const required of version.requiredPacks) {
        const target = registry.get(required.name);
        if (!target) {
          throw new PackRegistryError(
            `packs/${entry.name}/${version.version}: requires pack "${required.name}", which this deployment does not ship`,
          );
        }
        if (target.versions.length < required.minVersion) {
          throw new PackRegistryError(
            `packs/${entry.name}/${version.version}: requires pack "${required.name}" v${required.minVersion} or later, but it goes up to v${target.versions.length}`,
          );
        }
      }
    }
  }
  const cycle = requirementCycle([...registry.values()]);
  if (cycle !== null) {
    throw new PackRegistryError(`packs require each other in a cycle: ${cycle.join(' → ')}`);
  }
}

export function requirePack(registry: PackRegistry, name: string): PackEntry {
  const entry = registry.get(name);
  if (!entry) throw new PackNotFoundError(name);
  return entry;
}

export function latestPackVersion(entry: PackEntry): PackVersion {
  const latest = entry.versions[entry.versions.length - 1];
  if (!latest) throw new Error(`pack "${entry.name}" has no versions`);
  return latest;
}
