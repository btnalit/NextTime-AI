import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { OntologyDefinitionParseError, parseOntologyDefinition } from './schema.js';
import type { OntologyDefinition } from './schema.js';

/**
 * substrate/ontology/loader: parses and publishes a `ontology/*.yaml` file as an `ontology_versions`
 * row (design doc §5.1.2 OntologyVersion/ObjectType/LinkType, §7.10 "机制与内容分离...`ontology/
 * <domain>/`...走 git 与 PR，经 human 通道发布进图"; docs/development-tasks.md S2.6, S3.1).
 *
 * S2.6 shipped the bootstrap-only path (`publishOntologyVersion`/`seedPlatformMetaOntology`): a
 * single, fixed file (`platform-meta.yaml`) published once per workspace at `create-workspace`
 * time, always starting a fresh `id`. S3.1 (this task) generalizes that into a reusable domain-
 * pack loader (`publishOntologyDomainPack`, `deriveOntologyPackId`) any number of named packs can
 * call, republishing under the *same* `id` family each time — see those functions' own doc
 * comments. The Zod parsing itself (`OntologyDefinitionSchema` et al.) moved to `./schema.ts` (and,
 * beneath that, `@nexttime/shared`'s `ontology-definition.ts`) as part of the same task — re-
 * exported below for every import site that used to reach it through this file.
 *
 * Seeding happens at **bootstrap/publish time** (not inside a SQL migration): `ontology_versions`
 * rows are workspace-scoped (I1: every row carries `workspace_id`, RLS-gated), while migrations
 * run once per *database*, before any workspace exists. `create-workspace` seeds
 * `platform-meta.yaml` directly (no separate draft phase — a bootstrap seed has no other reviewer
 * than the same owner who is creating the workspace), mirroring how `worker/definitions.ts`'s
 * `create-workspace` seeding publishes the entry WorkerDefinition's v1 in the same call.
 * `publishOntologyDomainPack` is not wired into `create-workspace` by this task (`cli/bootstrap.ts`
 * is not in this task's owned files) — it is the seam a bootstrap follow-up or an operator-run CLI
 * calls to publish `ontology/ops-assets-v1.yaml` (or a future domain pack) into a given workspace.
 */

export {
  OntologyDefinitionParseError,
  OntologyDefinitionSchema,
  parseOntologyDefinition,
} from './schema.js';
export type {
  ActionTypeDefinition,
  LinkTypeDefinition,
  ObjectTypeDefinition,
  OntologyDefinition,
} from './schema.js';

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

export interface OntologyVersionDbRow {
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

/** Exported so `registry.ts` maps the identical `ontology_versions` row shape the same way,
 *  rather than redefining an equivalent function against a second copy of `OntologyVersionDbRow`. */
export function mapOntologyVersionRow(row: OntologyVersionDbRow): OntologyVersionRow {
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
  return mapOntologyVersionRow(row);
}

/** Exported for `registry.ts`'s `proposeOntologyChange` to reuse (S3.1) — the same "what's the
 *  next version under this id, or 1 for a fresh one" computation `publishOntologyVersion` already
 *  needed, now shared rather than re-derived a second way. */
export async function nextOntologyVersion(
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

// -------------------------------------------------------------------------------------------
// publishOntologyDomainPack (S3.1 deliverable 1: "Loader for ontology/*.yaml domain packs →
// validated (zod) → published version; publishing identical content again yields the next version
// number"). Generalizes `seedPlatformMetaOntology` above (one fixed file, always a fresh id) into
// "any named pack, republished under its own stable id family" — a domain pack has no `name`
// column to look itself up by (`ontology_versions`' own DDL, migrations/core/0002_substrate.sql,
// only has `(workspace_id, id, version)` — `id` is an opaque uuid, not a human name), so rather
// than add one (a migration outside this task's owned files: `migrations/core/**` belongs to no
// wave-1 item this task inspected, and adding a lookup column is more machinery than this problem
// needs), `deriveOntologyPackId` derives a stable uuid *deterministically* from the pack's own
// name — same name in, same id out, every time, with no DB round trip needed to find it.
// -------------------------------------------------------------------------------------------

/**
 * Fixed, arbitrary namespace for `deriveOntologyPackId` below (RFC 4122 §4.3 UUIDv5-style
 * derivation: `SHA-1(namespace || name)`, version/variant bits forced) — chosen once and never to
 * change: changing it would silently fork every existing domain pack's version history onto a new
 * id on its very next publish (`nextOntologyVersion` would find no rows under the new id and start
 * back at version 1). Not a "real" RFC 4122 namespace registered anywhere — an internal constant,
 * fixed for this platform's own lifetime.
 */
const ONTOLOGY_PACK_NAMESPACE_HEX = '2a611b0a7b0e5b2a9b7b2e6b9f0d6a11';

/** Deterministic `ontology_versions.id` for a domain pack named `packName` — same input always
 *  produces the same uuid-shaped output, so `publishOntologyDomainPack` can find "the existing
 *  version history for this pack" without any lookup table. Exported for tests and for a future
 *  CLI/runbook step that needs to predict a pack's id ahead of publishing it. */
export function deriveOntologyPackId(packName: string): string {
  const namespaceBytes = Buffer.from(ONTOLOGY_PACK_NAMESPACE_HEX, 'hex');
  const nameBytes = Buffer.from(packName, 'utf8');
  const bytes = Buffer.from(
    createHash('sha1').update(namespaceBytes).update(nameBytes).digest().subarray(0, 16),
  );
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PublishOntologyDomainPackInput {
  /** The pack's stable family name (e.g. `"ops-assets"`) — what `deriveOntologyPackId` hashes.
   *  Deliberately separate from `fileName` below: `ops-assets-v1.yaml` and a future
   *  `ops-assets-v2.yaml` (S3.4, "本体 v2") name the *same* family so the second publish stacks a
   *  new version onto the first pack's history rather than starting a sibling family at v1 — a
   *  caller publishing a new file revision passes the same `packName` with a different
   *  `fileName`. */
  readonly packName: string;
  /** YAML file to read, relative to `dir`. Defaults to `` `${packName}.yaml` `` (this task's own
   *  `ops-assets-v1.yaml` is published with `packName: 'ops-assets', fileName: 'ops-assets-v1.yaml'`
   *  — see that file's own header comment). */
  readonly fileName?: string;
  readonly dir?: string;
  readonly principalId: string;
}

/** Loads `<dir>/<fileName ?? packName>.yaml`, validates it, and publishes it as the next version
 *  of `packName`'s own id family (`deriveOntologyPackId`) — republishing byte-identical content
 *  still consumes the next version number (no dedup/no-op short-circuit; `publishOntologyVersion`
 *  itself never compared `definition` across versions, and this function does not add that check
 *  either), which is exactly S3.1's own acceptance criterion ("同内容再发布得 v2"). */
export async function publishOntologyDomainPack(
  client: PoolClient,
  workspaceId: string,
  input: PublishOntologyDomainPackInput,
): Promise<OntologyVersionRow> {
  const dir = input.dir ?? resolveOntologyDir();
  const fileName = input.fileName ?? `${input.packName}.yaml`;
  const definition = await loadOntologyDefinitionFile(path.join(dir, fileName));
  const id = deriveOntologyPackId(input.packName);
  return publishOntologyVersion(client, workspaceId, {
    id,
    definition,
    principalId: input.principalId,
  });
}
