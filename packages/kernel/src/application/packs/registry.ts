import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type OntologyDefinition,
  loadOntologyDefinitionFile,
  resolveOntologyDir,
} from '../../substrate/ontology/index.js';
import { contentDigest } from '../change-plan/index.js';
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
 * Rules across manifests, checked here (any break refuses the whole registry with
 * `PackRegistryError` — a deployment bug, loud at the first read, never a pack silently missing):
 *   - `packs/<name>/` is a pack name; its subdirectories are its versions, `1`, `2`, … dense from 1;
 *     each holds a `pack.yaml` whose `name` and `version` are the directory's;
 *   - an ontology family belongs to one pack: two packs publishing one family would each read the
 *     other's versions as "customized";
 *   - a family a version publishes is in every later version of its pack: taking a component out
 *     is uninstalling it, which Pack Contract v1 does not do (an upgrade never leaves a family
 *     behind that no version of its pack describes any more);
 *   - every domain pack a component names exists in the ontology library and parses.
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

export interface PackVersion {
  readonly name: string;
  readonly version: number;
  readonly summary: string;
  readonly notes: string;
  readonly breaking: boolean;
  readonly components: readonly PackOntologyComponent[];
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

async function loadPackVersion(
  packDir: string,
  name: string,
  version: number,
  ontologyDir: string,
): Promise<PackVersion> {
  const source = path.join(packDir, String(version), 'pack.yaml');
  let text: string;
  try {
    text = await readFile(source, 'utf8');
  } catch (err) {
    throw new PackManifestError(source, `cannot be read: ${String(err)}`, { cause: err });
  }
  const manifest = parsePackManifest(text, source);
  if (manifest.name !== name || manifest.version !== version) {
    throw new PackManifestError(
      source,
      `declares ${manifest.name} v${manifest.version} but sits at ${name}/${version}`,
    );
  }
  const components: PackOntologyComponent[] = [];
  for (const component of manifest.components.ontology) {
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
  const digest = contentDigest({
    schema: manifest.schema,
    name: manifest.name,
    version: manifest.version,
    summary: manifest.summary,
    notes: manifest.notes,
    breaking: manifest.breaking,
    components: components.map((c) => ({
      kind: c.kind,
      family: c.family,
      domainPack: c.domainPack,
      definitionDigest: c.definitionDigest,
    })),
  });
  return {
    name,
    version,
    summary: manifest.summary,
    notes: manifest.notes,
    breaking: manifest.breaking,
    components,
    digest,
  };
}

/** Reads every pack (see this module's comment for the rules it checks). */
export async function loadPackRegistry(options: PackRegistryOptions = {}): Promise<PackRegistry> {
  const packsDir = options.packsDir ?? resolvePacksDir();
  const ontologyDir = options.ontologyDir ?? resolveOntologyDir();
  const registry = new Map<string, PackEntry>();
  const familyOwner = new Map<string, string>();
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
      const families = new Set(loaded.components.map((component) => component.family));
      const dropped = previous?.components.find((component) => !families.has(component.family));
      if (previous && dropped) {
        throw new PackRegistryError(
          `packs/${name}/${version}: drops ontology family "${dropped.family}" that version ${previous.version} publishes; a later version keeps every family`,
        );
      }
      versions.push(loaded);
    }
    for (const version of versions) {
      for (const component of version.components) {
        const owner = familyOwner.get(component.family);
        if (owner !== undefined && owner !== name) {
          throw new PackRegistryError(
            `ontology family "${component.family}" is published by both pack "${owner}" and pack "${name}"; a family belongs to one pack`,
          );
        }
        familyOwner.set(component.family, name);
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
