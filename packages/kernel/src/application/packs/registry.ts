import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SkillApplicableSchema,
  type WorkerWorkerDefinitionContent,
  WorkerWorkerDefinitionContentSchema,
} from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { WORKER_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import {
  type OntologyDefinition,
  loadOntologyDefinitionFile,
  resolveOntologyDir,
} from '../../substrate/ontology/index.js';
import { type SkillItemContent, contentDigest } from '../change-plan/index.js';
import { validateSkillContent } from '../worker/index.js';
import { PACK_NAME_PATTERN, PackManifestError, parsePackManifest } from './manifest.js';

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
 *     `capabilities`, when declared, are within the worker ceiling.
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
 *   - every domain pack a component names exists in the ontology library and parses.
 *
 * A Skill's or Worker's family id is derived from the pack and the name (`derivePackComponentId`),
 * the same in every workspace — as an ontology family's is from its name (`deriveOntologyPackId`).
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
  /** The definition as published: the file's content with `name`, parsed (so normalized). */
  readonly definition: WorkerWorkerDefinitionContent;
  /** `contentDigest(definition)` — the digest a change item records for it. */
  readonly contentDigest: string;
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

const PACK_COMPONENT_NAMESPACE_HEX = '468a8e7084742c0f6e0f32f642b20c82';

/** The deterministic family id of pack `pack`'s Skill or Worker `name`: a name-based (version 5)
 *  uuid, the same construction as `deriveOntologyPackId` under its own namespace, over the kind,
 *  the pack and the name — so no workspace's own Skills or WorkerDefinitions (random ids) and no
 *  other pack's can be taken for it. */
export function derivePackComponentId(
  pack: string,
  kind: 'skill' | 'worker',
  name: string,
): string {
  const bytes = Buffer.from(
    createHash('sha1')
      .update(Buffer.from(PACK_COMPONENT_NAMESPACE_HEX, 'hex'))
      .update(Buffer.from(`${kind}\n${pack}\n${name}`, 'utf8'))
      .digest()
      .subarray(0, 16),
  );
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PackVersion {
  readonly name: string;
  readonly version: number;
  readonly summary: string;
  readonly notes: string;
  readonly breaking: boolean;
  /** The connectors its components work with (`manifest.ts`' `requires.connectors`), in the
   *  manifest's order; empty when it declares none. */
  readonly requiredConnectors: readonly string[];
  /** Ontology components in the manifest's order, then Skills, then Workers — the order the
   *  install's items publish them in (a Worker after the Skills it mounts). */
  readonly components: readonly PackComponent[];
  /** `sha256:` digest of the manifest and each component's content: the source digest of every
   *  change segment applied from this version. */
  readonly digest: string;
}

export interface PackEntry {
  readonly name: string;
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

export interface PackRegistryOptions {
  /** Default `resolvePacksDir()`. */
  readonly packsDir?: string;
  /** Where `domainPack` files are read. Default `resolveOntologyDir()`. */
  readonly ontologyDir?: string;
}

async function subdirectories(dir: string): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new PackRegistryError(`cannot read ${dir}: ${String(err)}`, { cause: err });
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

async function readComponentFile(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw new PackManifestError(file, `cannot be read: ${String(err)}`, { cause: err });
  }
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
  versionDir: string,
  pack: string,
  name: string,
): Promise<PackSkillComponent> {
  const source = path.join(versionDir, 'skills', `${name}.md`);
  const match = FRONTMATTER.exec(await readComponentFile(source));
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
  gates: 'the systems a Worker acts on are the workspace’s own, never a pack’s',
  model: 'the models a Worker runs on are the workspace’s own, never a pack’s',
};

async function loadWorkerComponent(
  versionDir: string,
  pack: string,
  name: string,
  skills: ReadonlySet<string>,
): Promise<PackWorkerComponent> {
  const source = path.join(versionDir, 'workers', `${name}.yaml`);
  let raw: unknown;
  try {
    raw = parseYaml(await readComponentFile(source));
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
  const parsed = WorkerWorkerDefinitionContentSchema.safeParse({ ...raw, name });
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
  };
}

async function loadPackVersion(
  packDir: string,
  name: string,
  version: number,
  ontologyDir: string,
): Promise<PackVersion> {
  const versionDir = path.join(packDir, String(version));
  const source = path.join(versionDir, 'pack.yaml');
  const manifest = parsePackManifest(await readComponentFile(source), source);
  if (manifest.name !== name || manifest.version !== version) {
    throw new PackManifestError(
      source,
      `declares ${manifest.name} v${manifest.version} but sits at ${name}/${version}`,
    );
  }
  const components: PackComponent[] = [];
  for (const component of manifest.components.ontology ?? []) {
    const definition = await loadOntologyDefinitionFile(
      path.join(ontologyDir, component.domainPack),
    );
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
    components.push(await loadSkillComponent(versionDir, name, skill));
  }
  for (const worker of manifest.components.workers ?? []) {
    components.push(await loadWorkerComponent(versionDir, name, worker, new Set(skills)));
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
        : { kind: c.kind, name: c.name, contentDigest: c.contentDigest },
    ),
  });
  return {
    name,
    version,
    summary: manifest.summary,
    notes: manifest.notes,
    breaking: manifest.breaking,
    requiredConnectors: manifest.requires?.connectors ?? [],
    components,
    digest,
  };
}

/** Reads every pack (see this module's comment for the rules it checks). */
export async function loadPackRegistry(options: PackRegistryOptions = {}): Promise<PackRegistry> {
  const packsDir = options.packsDir ?? resolvePacksDir();
  const ontologyDir = options.ontologyDir ?? resolveOntologyDir();
  const registry = new Map<string, PackEntry>();
  const componentOwner = new Map<string, string>();
  for (const name of await subdirectories(packsDir)) {
    if (!PACK_NAME_PATTERN.test(name)) {
      throw new PackRegistryError(`packs/${name}: not a pack name (${PACK_NAME_PATTERN})`);
    }
    const packDir = path.join(packsDir, name);
    const versionDirs = await subdirectories(packDir);
    const numbers = versionDirs.map((dir) =>
      /^[1-9][0-9]*$/.test(dir) ? Number(dir) : Number.NaN,
    );
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
      const loaded = await loadPackVersion(packDir, name, version, ontologyDir);
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
    for (const version of versions) {
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
    registry.set(name, { name, versions });
  }
  return registry;
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
