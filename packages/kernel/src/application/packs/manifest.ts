import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * application/packs/manifest: Pack Contract v1 — the shape of `packs/<name>/<version>/pack.yaml`
 * (S11 P1-C; docs/s10-evolution-plan-2026-10-04.md §6.2, §6.4). One manifest is one **PackVersion**:
 * immutable once shipped, its content digest fixed (`registry.ts`). A **pack** is the family of its
 * versions, named by `name`.
 *
 * Components (v1): `ontology` only — a domain pack file in the platform's ontology library
 * (`domainPack`, resolved in `ONTOLOGY_DIR`; never a path) and the ontology family it publishes into
 * (`family`, the stable name `deriveOntologyPackId` derives the family's id from). Further component
 * kinds (WorkerDefinition, Skill, Procedure, Operation, connector preset) join this schema in the PR
 * that implements their change items; until then a manifest naming one is refused by name, so a
 * pack written for a later platform fails closed here instead of installing in part.
 *
 * What a manifest must keep that one Zod shape cannot say (`parsePackManifest` checks it): version
 * 1 is never `breaking` (nothing precedes it), and one version names each family once. Rules across
 * manifests (directory names, versions dense from 1, a family in one pack) are `registry.ts`'s.
 */

/** The only `schema` this platform reads. */
export const PACK_CONTRACT_SCHEMA = 1;

/** Pack and ontology family names: lower-case words joined by single hyphens (`ops-assets`). */
export const PACK_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A domain pack file name in the ontology library — a bare `.yaml` / `.yml` name, never a path. */
const DOMAIN_PACK_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;

/** Files in the ontology library that are not domain packs: the platform meta-ontology is seeded
 *  once per workspace (`seedPlatformMetaOntology`), never installed into a family. (The two
 *  WorkerDefinition templates beside it do not parse as an `OntologyDefinition`.) */
const NOT_DOMAIN_PACKS: ReadonlySet<string> = new Set(['platform-meta.yaml']);

/** The component kinds this platform implements. */
export const PACK_COMPONENT_KINDS = ['ontology'] as const;
export type PackComponentKind = (typeof PACK_COMPONENT_KINDS)[number];

const OntologyComponentSchema = z
  .object({
    family: z.string().regex(PACK_NAME_PATTERN),
    domainPack: z
      .string()
      .regex(DOMAIN_PACK_FILE_PATTERN)
      .refine((file) => !NOT_DOMAIN_PACKS.has(file), {
        message: 'names a file of the ontology library that is not a domain pack',
      }),
  })
  .strict();

const PackManifestSchema = z
  .object({
    schema: z.literal(PACK_CONTRACT_SCHEMA),
    name: z.string().regex(PACK_NAME_PATTERN),
    version: z.number().int().positive(),
    /** What the pack is, in a sentence a workspace owner reads before installing. */
    summary: z.string().trim().min(1),
    /** What this version brings, read before installing or upgrading to it. The console shows it
     *  as written in the pack's detail and the install review, so it is for workspace owners: plain
     *  words, no type names or implementation notes. */
    notes: z.string(),
    /** Upgrading to this version from the one before may leave Facts or Links a workspace already
     *  holds outside the new shapes (the same meaning as a module's `breaking`, S7-D D3). */
    breaking: z.boolean(),
    components: z
      .object({
        ontology: z.array(OntologyComponentSchema).min(1),
      })
      .strict(),
  })
  .strict();

export type PackManifest = z.infer<typeof PackManifestSchema>;
export type PackOntologyComponentManifest = PackManifest['components']['ontology'][number];

/** A manifest that is not Pack Contract v1, or breaks one of its rules — a deployment bug (the
 *  manifests ship with the image), never a caller error. */
export class PackManifestError extends Error {
  constructor(source: string, reason: string, options?: { cause?: unknown }) {
    super(`pack manifest "${source}": ${reason}`, options);
    this.name = 'PackManifestError';
  }
}

/** Parses one `pack.yaml`'s text. `source` names it in errors. */
export function parsePackManifest(text: string, source: string): PackManifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new PackManifestError(source, `not YAML: ${String(err)}`, { cause: err });
  }
  if (raw !== null && typeof raw === 'object' && 'schema' in raw) {
    const schema = (raw as { schema: unknown }).schema;
    if (schema !== PACK_CONTRACT_SCHEMA) {
      throw new PackManifestError(
        source,
        `schema ${JSON.stringify(schema)} is not supported by this platform (it reads schema ${PACK_CONTRACT_SCHEMA})`,
      );
    }
  }
  // A component kind a later platform implements is refused by its name, before the shape check
  // reports it as an unrecognized key.
  const components = (raw as { components?: unknown } | null)?.components;
  if (components !== null && typeof components === 'object') {
    const supported: ReadonlySet<string> = new Set(PACK_COMPONENT_KINDS);
    const unsupported = Object.keys(components).filter((kind) => !supported.has(kind));
    if (unsupported.length > 0) {
      throw new PackManifestError(
        source,
        `component kind(s) ${unsupported.map((kind) => JSON.stringify(kind)).join(', ')} not supported by this platform (it implements ${PACK_COMPONENT_KINDS.join(', ')})`,
      );
    }
  }
  const result = PackManifestSchema.safeParse(raw);
  if (!result.success) throw new PackManifestError(source, result.error.message);
  const manifest = result.data;
  if (manifest.version === 1 && manifest.breaking) {
    throw new PackManifestError(source, 'version 1 cannot be breaking: nothing precedes it');
  }
  const families = manifest.components.ontology.map((component) => component.family);
  const repeated = families.filter((family, index) => families.indexOf(family) !== index);
  if (repeated.length > 0) {
    throw new PackManifestError(
      source,
      `ontology family ${JSON.stringify(repeated[0])} is named twice; a version publishes each family once`,
    );
  }
  return manifest;
}
