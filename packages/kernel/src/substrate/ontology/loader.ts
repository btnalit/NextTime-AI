import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * substrate/ontology/loader: parses and publishes a `ontology/*.yaml` file as an `ontology_versions`
 * row (design doc §5.1.2 OntologyVersion/ObjectType/LinkType, §7.10 "机制与内容分离...`ontology/
 * <domain>/`...走 git 与 PR，经 human 通道发布进图"; docs/development-tasks.md S2.6).
 *
 * No such loader existed before S2.6 — `substrate/ontology/index.ts` was an R1 placeholder with no
 * implementation (`export {}`), and the core domain ontology itself has not landed yet (S3.1 is
 * still ahead in the roadmap). This is therefore the *first* mechanism to read an `ontology/*.yaml`
 * file and publish it as an `ontology_versions` row, built to the shape §9.2's own DDL already
 * fixed (`(workspace_id, id, version)` identity, `status`, `definition jsonb`, `proposed_by`/
 * `published_by`) — S3.1 is expected to reuse `publishOntologyVersion`/`OntologyDefinitionSchema`
 * for the core domain ontology rather than write a second loader.
 *
 * Seeding happens at **bootstrap time** (`packages/kernel/src/cli/bootstrap.ts`'s `create-workspace`
 * calls `publishOntologyVersion` for `ontology/platform-meta.yaml`), not inside a SQL migration —
 * `ontology_versions` rows are workspace-scoped (I1: every row carries `workspace_id`, RLS-gated),
 * while migrations run once per *database*, before any workspace exists. Each workspace therefore
 * gets its own `ontology_versions` row for the platform meta-ontology, published directly (no
 * separate draft phase — a bootstrap seed has no other reviewer than the same owner who is
 * creating the workspace), mirroring how `worker/definitions.ts`'s `create-workspace` seeding
 * publishes the entry WorkerDefinition's v1 in the same call.
 */

// -------------------------------------------------------------------------------------------
// OntologyDefinition — the YAML content shape (I2: LinkType domain/range must be explicit)
// -------------------------------------------------------------------------------------------

const ObjectTypeDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type ObjectTypeDefinition = z.infer<typeof ObjectTypeDefinitionSchema>;

/** `domain`/`range` name an ObjectType from this same definition's `objectTypes`, or the sentinel
 *  `"*"` for a Link whose other end is not confined to one platform-meta ObjectType — e.g.
 *  `Operation --reads/writes--> ObjectType` (any domain ObjectType, not one of the six platform
 *  meta-ontology types) and `Gatekeeper --connects_to--> 系统对象` (an arbitrary connected-system
 *  object). I2 ("Link 符合 LinkType 的 domain/range") still holds — `"*"` is an explicit, named
 *  wildcard, not an omitted field. */
const LinkTypeDefinitionSchema = z
  .object({
    name: z.string().min(1),
    domain: z.string().min(1),
    range: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type LinkTypeDefinition = z.infer<typeof LinkTypeDefinitionSchema>;

export const OntologyDefinitionSchema = z
  .object({
    objectTypes: z.array(ObjectTypeDefinitionSchema).min(1),
    linkTypes: z.array(LinkTypeDefinitionSchema).min(1),
  })
  .strict();
export type OntologyDefinition = z.infer<typeof OntologyDefinitionSchema>;

export class OntologyDefinitionParseError extends Error {
  constructor(source: string, cause: unknown) {
    super(`failed to parse ontology definition "${source}": ${String(cause)}`, { cause });
    this.name = 'OntologyDefinitionParseError';
  }
}

/** Parses and validates raw YAML text against `OntologyDefinitionSchema`. Pure — no IO. `source`
 *  is only used to make a parse error identify which file it came from. */
export function parseOntologyDefinition(yamlText: string, source = '<inline>'): OntologyDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new OntologyDefinitionParseError(source, err);
  }
  const result = OntologyDefinitionSchema.safeParse(raw);
  if (!result.success) {
    throw new OntologyDefinitionParseError(source, result.error);
  }
  return result.data;
}

/** Reads and parses one `ontology/*.yaml` file from disk. */
export async function loadOntologyDefinitionFile(filePath: string): Promise<OntologyDefinition> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new OntologyDefinitionParseError(filePath, err);
  }
  return parseOntologyDefinition(text, filePath);
}

// -------------------------------------------------------------------------------------------
// ontology/ directory resolution — mirrors cli/migrate.ts's `defaultMigrationsDir()` (see that
// file's own doc comment: the same "here, two levels up" computation resolves correctly for both
// the .ts source (packages/kernel/src/substrate/ontology/loader.ts) and the compiled dist output
// (packages/kernel/dist/substrate/ontology/loader.js) in local dev, since both sit at the same
// depth under packages/kernel/{src,dist}/. Unlike migrations/ (co-located inside packages/kernel/
// and therefore already carried into the deployed image by `pnpm deploy`), ontology/ is
// **repo-root** content (design doc §10.1) — the deployed kernel image has no repo root at all
// (`pnpm deploy --prod --legacy` flattens the package to /app), so the kernel package's own
// container build file explicitly copies ontology/ to /app/ontology in its runtime stage and sets
// `ONTOLOGY_DIR=/app/ontology` — this function's own relative-path fallback below only ever
// executes in local dev.
// -------------------------------------------------------------------------------------------

function defaultOntologyDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = packages/kernel/{src,dist}/substrate/ontology. Five levels up reaches repo root:
  // ontology -> substrate -> {src,dist} -> kernel -> packages -> repo root.
  return path.join(here, '..', '..', '..', '..', '..', 'ontology');
}

/** Resolves the `ontology/` directory: `ONTOLOGY_DIR` env var when set (always set in the
 *  container — see this module's own doc comment), else the repo-root-relative dev default. */
export function resolveOntologyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ONTOLOGY_DIR || defaultOntologyDir();
}

// -------------------------------------------------------------------------------------------
// publishOntologyVersion — bootstrap-time seeding (no draft phase, see this module's doc comment)
// -------------------------------------------------------------------------------------------

interface OntologyVersionDbRow {
  workspace_id: string;
  id: string;
  version: number;
  status: string;
  definition: OntologyDefinition;
  proposed_by: string;
  published_by: string | null;
  created_at: Date;
  published_at: Date | null;
}

export interface OntologyVersionRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly definition: OntologyDefinition;
  readonly proposedBy: string;
  readonly publishedBy: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

function mapRow(row: OntologyVersionDbRow): OntologyVersionRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    version: row.version,
    status: row.status,
    definition: row.definition,
    proposedBy: row.proposed_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

export interface PublishOntologyVersionInput {
  /** Stable ontology identifier (`ontology_versions.id`). Omit to start a new one (a fresh
   *  `gen_random_uuid()`, version 1); given, publishes the next version under that existing id —
   *  `create-workspace` always omits it (each workspace's platform-meta ontology is its own
   *  fresh id, version 1), but re-running the loader against an existing workspace to publish an
   *  updated platform-meta.yaml is the same call with the prior id supplied. */
  readonly id?: string;
  readonly definition: OntologyDefinition;
  /** Both `proposed_by` and `published_by` — see this module's doc comment on why a bootstrap
   *  seed has no separate draft/review step. */
  readonly principalId: string;
}

/** Publishes `input.definition` as a `published` `ontology_versions` row for `workspaceId`
 *  (bootstrap-time seeding — see this module's doc comment). */
export async function publishOntologyVersion(
  client: PoolClient,
  workspaceId: string,
  input: PublishOntologyVersionInput,
): Promise<OntologyVersionRow> {
  const nextVersion = await nextOntologyVersion(client, workspaceId, input.id);
  const result = await client.query<OntologyVersionDbRow>(
    `insert into ontology_versions
       (workspace_id, id, version, status, definition, proposed_by, published_by, published_at)
     values
       ($1, coalesce($2::uuid, gen_random_uuid()), $3, 'published', $4::jsonb, $5, $5, now())
     returning workspace_id, id, version, status, definition, proposed_by, published_by,
       created_at, published_at`,
    [
      workspaceId,
      input.id ?? null,
      nextVersion,
      JSON.stringify(input.definition),
      input.principalId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('publishOntologyVersion: INSERT ... RETURNING produced no row');
  return mapRow(row);
}

async function nextOntologyVersion(
  client: PoolClient,
  workspaceId: string,
  id: string | undefined,
): Promise<number> {
  if (!id) return 1;
  const result = await client.query<{ max: number | null }>(
    'select max(version) as max from ontology_versions where workspace_id = $1 and id = $2',
    [workspaceId, id],
  );
  return (result.rows[0]?.max ?? 0) + 1;
}

/** Reads the platform-meta ontology's `objectTypes`/`linkTypes` file from `dir` (default:
 *  `resolveOntologyDir()`) and publishes it for `workspaceId`/`principalId` — the one call
 *  `create-workspace` makes. */
export async function seedPlatformMetaOntology(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  dir: string = resolveOntologyDir(),
): Promise<OntologyVersionRow> {
  const filePath = path.join(dir, 'platform-meta.yaml');
  const definition = await loadOntologyDefinitionFile(filePath);
  return publishOntologyVersion(client, workspaceId, { definition, principalId });
}
