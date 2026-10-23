import { CONNECTOR_NAME_PATTERN, isGenericConnector } from '@nexttime/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * application/packs/manifest: Pack Contract v1 — the shape of `packs/<name>/<version>/pack.yaml`
 * (S11 P1-C; docs/s10-evolution-plan-2026-10-04.md §6.2, §6.4). One manifest is one **PackVersion**:
 * immutable once shipped, its content digest fixed (`registry.ts`). A **pack** is the family of its
 * versions, named by `name`.
 *
 * Components, each kind a list under `components` (at least one component in all):
 *   - `ontology` — a domain pack file in the platform's ontology library (`domainPack`, resolved in
 *     `ONTOLOGY_DIR`; never a path) and the ontology family it publishes into (`family`, the stable
 *     name `deriveOntologyPackId` derives the family's id from);
 *   - `skills` — Skill names; each one's file is `skills/<name>.md` beside the manifest (P1-D);
 *   - `workers` — `worker` WorkerDefinition names; each one's file is `workers/<name>.yaml` (P1-D).
 * The two files' formats are `registry.ts`'s. Further component kinds (Procedure, Operation,
 * connector preset) join this schema in the PR that implements their change items; until then a
 * manifest naming one is refused by name, so a pack written for a later platform fails closed here
 * instead of installing in part.
 *
 * `requires.connectors` (S11 P1-E; S10 plan §3.3 I-P3): the systems the version's components work
 * with, by connector name — a gate is a code component the platform deploys, so a pack
 * never brings one; it says which it needs, and the console shows where each stands in the
 * workspace (`requirements.ts`). Installing does not wait for them (S10: waiting for someone to
 * connect a system is a verification state, not an install failure); verifying a segment of the
 * version checks them. A generic connector (`http`, `mcp`, `cli`, `ssh`) names a transport, not a
 * system, so it is refused.
 *
 * `requires.packs` (S11 P1-F): the other packs the version's components build on, each by name and
 * the lowest version that has what they need (`minVersion`) — the ontology types its systems'
 * Operations read and write, say, which another pack publishes (a type belongs to one family, and a
 * family to one pack). Unlike a system, a pack is something the workspace's owner installs on the
 * same page, so installing waits for them: `install_pack` refuses while one is not installed at
 * `minVersion` or later (`requirements.ts`); verifying a segment of the version checks them again.
 * A pack never requires itself; the registry checks the packs named exist with that version, and
 * that no pack requires its way back to itself (`registry.ts`).
 *
 * What a manifest must keep that one Zod shape cannot say (`parsePackManifest` checks it): version
 * 1 is never `breaking` (nothing precedes it), it has at least one component, and it names each
 * component once. Rules across manifests (directory names, versions dense from 1, a component in
 * one pack) are `registry.ts`'s.
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

/** The component kinds this platform implements, and the `components` key that lists each. */
export const PACK_COMPONENT_KINDS = ['ontology', 'skill', 'worker'] as const;
export type PackComponentKind = (typeof PACK_COMPONENT_KINDS)[number];
const COMPONENT_KEY: Readonly<Record<PackComponentKind, string>> = {
  ontology: 'ontology',
  skill: 'skills',
  worker: 'workers',
};

/** A Skill's or Worker's name in a pack: a pack name's shape, which is also a valid pi Skill name. */
const ComponentNameSchema = z.string().regex(PACK_NAME_PATTERN);

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

/** One pack a version builds on (`requires.packs`, see this module's comment). */
const PackRequirementManifestSchema = z
  .object({
    name: z.string().regex(PACK_NAME_PATTERN),
    minVersion: z.number().int().positive(),
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
    requires: z
      .object({
        connectors: z
          .array(
            z
              .string()
              .regex(CONNECTOR_NAME_PATTERN)
              .refine((name) => !isGenericConnector(name), {
                message: 'names a transport (http, mcp, cli, ssh), not a system',
              }),
          )
          .min(1)
          .optional(),
        packs: z.array(PackRequirementManifestSchema).min(1).optional(),
      })
      .strict()
      .refine((requires) => requires.connectors !== undefined || requires.packs !== undefined, {
        message: 'requires names connectors, packs or both; leave it out when it needs neither',
      })
      .optional(),
    components: z
      .object({
        ontology: z.array(OntologyComponentSchema).min(1).optional(),
        skills: z.array(ComponentNameSchema).min(1).optional(),
        workers: z.array(ComponentNameSchema).min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type PackManifest = z.infer<typeof PackManifestSchema>;
export type PackRequirementManifest = z.infer<typeof PackRequirementManifestSchema>;
export type PackOntologyComponentManifest = NonNullable<
  PackManifest['components']['ontology']
>[number];

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
    const keys = Object.values(COMPONENT_KEY);
    const supported: ReadonlySet<string> = new Set(keys);
    const unsupported = Object.keys(components).filter((key) => !supported.has(key));
    if (unsupported.length > 0) {
      throw new PackManifestError(
        source,
        `component kind(s) ${unsupported.map((key) => JSON.stringify(key)).join(', ')} not supported by this platform (it implements ${keys.join(', ')})`,
      );
    }
  }
  const result = PackManifestSchema.safeParse(raw);
  if (!result.success) throw new PackManifestError(source, result.error.message);
  const manifest = result.data;
  if (manifest.version === 1 && manifest.breaking) {
    throw new PackManifestError(source, 'version 1 cannot be breaking: nothing precedes it');
  }
  const { ontology = [], skills = [], workers = [] } = manifest.components;
  if (ontology.length + skills.length + workers.length === 0) {
    throw new PackManifestError(source, 'has no components; a version installs at least one');
  }
  const named: readonly [string, readonly string[]][] = [
    ['ontology family', ontology.map((component) => component.family)],
    ['Skill', skills],
    ['Worker', workers],
  ];
  const connectors = manifest.requires?.connectors ?? [];
  const repeatedConnector = connectors.find((name, index) => connectors.indexOf(name) !== index);
  if (repeatedConnector !== undefined) {
    throw new PackManifestError(
      source,
      `requires connector ${JSON.stringify(repeatedConnector)} twice`,
    );
  }
  const packs = (manifest.requires?.packs ?? []).map((required) => required.name);
  const repeatedPack = packs.find((name, index) => packs.indexOf(name) !== index);
  if (repeatedPack !== undefined) {
    throw new PackManifestError(source, `requires pack ${JSON.stringify(repeatedPack)} twice`);
  }
  if (packs.includes(manifest.name)) {
    throw new PackManifestError(source, 'requires its own pack; a pack never requires itself');
  }
  for (const [what, names] of named) {
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated !== undefined) {
      throw new PackManifestError(
        source,
        `${what} ${JSON.stringify(repeated)} is named twice; a version publishes each once`,
      );
    }
  }
  return manifest;
}
