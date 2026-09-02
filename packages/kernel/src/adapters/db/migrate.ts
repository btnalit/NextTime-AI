import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * adapters/db/migrate: idempotent migration runner over `packages/kernel/migrations/<module>/
 * NNNN_name.sql` (design doc §7.10 module contract — every module owns its own migrations
 * directory; docs/development-tasks.md R2).
 *
 * `schema_migrations` is created by this runner, not by a migration file.
 */

const MIGRATIONS_TABLE = 'schema_migrations';

/** `NNNN_name.sql` — version is one or more digits, name is lowercase snake_case. */
const FILENAME_PATTERN = /^(\d+)_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export class MigrationFilenameError extends Error {
  constructor(module: string, filename: string) {
    super(
      `migrations/${module}/${filename}: filename does not match the required NNNN_name.sql pattern`,
    );
    this.name = 'MigrationFilenameError';
  }
}

export class DuplicateMigrationVersionError extends Error {
  constructor(module: string, version: number) {
    super(`migrations/${module}: more than one migration file uses version ${version}`);
    this.name = 'DuplicateMigrationVersionError';
  }
}

export interface ChecksumMismatch {
  module: string;
  version: number;
  name: string;
  /** Checksum recorded in schema_migrations when this migration was applied. */
  expectedChecksum: string;
  /** Checksum recomputed from the file on disk right now. */
  actualChecksum: string;
}

export class ChecksumMismatchError extends Error {
  readonly mismatches: ChecksumMismatch[];

  constructor(mismatches: ChecksumMismatch[]) {
    const detail = mismatches
      .map((m) => `${m.module}/${formatFilename(m.version, m.name)}`)
      .join(', ');
    super(
      `refusing to run migrations: checksum changed for already-applied migration(s): ${detail}`,
    );
    this.name = 'ChecksumMismatchError';
    this.mismatches = mismatches;
  }
}

export class MigrationExecutionError extends Error {
  readonly module: string;
  readonly version: number;
  readonly migrationName: string;

  constructor(module: string, version: number, migrationName: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`migration ${module}/${formatFilename(version, migrationName)} failed: ${causeMessage}`, {
      cause,
    });
    this.name = 'MigrationExecutionError';
    this.module = module;
    this.version = version;
    this.migrationName = migrationName;
  }
}

export interface MigrationFile {
  module: string;
  version: number;
  name: string;
  filename: string;
  path: string;
  content: string;
  checksum: string;
}

export interface AppliedMigrationRecord {
  module: string;
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  mismatched: ChecksumMismatch[];
}

export interface MigrationRunResult {
  applied: MigrationFile[];
  pending: MigrationFile[];
  dryRun: boolean;
}

function formatFilename(version: number, name: string): string {
  return `${String(version).padStart(4, '0')}_${name}.sql`;
}

function migrationKey(module: string, version: number): string {
  return `${module}::${version}`;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Parses a migration filename into its version and name, or returns null if it doesn't match. */
export function parseMigrationFilename(filename: string): { version: number; name: string } | null {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) return null;
  const versionStr = match[1];
  const name = match[2];
  if (versionStr === undefined || name === undefined) return null;
  return { version: Number(versionStr), name };
}

/** SHA-256 hex digest of migration file content, computed after CRLF→LF normalization. */
export function computeChecksum(content: string): string {
  return createHash('sha256').update(normalizeLineEndings(content), 'utf8').digest('hex');
}

/**
 * Sorts migration files by module directory name, then by numeric version within the module
 * (docs/development-tasks.md R2: "sorted by module dir then number").
 */
export function sortMigrationFiles(files: MigrationFile[]): MigrationFile[] {
  return [...files].sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    return a.version - b.version;
  });
}

/**
 * Splits a SQL file's content into individually-executable statements. Splits on `;` while
 * respecting single- and double-quoted content, dollar-quoted bodies (`$$...$$`, `$tag$...$tag$`
 * — needed for `create function ... language plpgsql` bodies used by later migrations), and
 * line comments (`--`) and block comments, so a semicolon inside any of those never ends a
 * statement early.
 * Statements that are empty or contain only comments are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let hasContent = false;
  let i = 0;
  const len = sql.length;

  const flush = (): void => {
    if (hasContent) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
    }
    current = '';
    hasContent = false;
  };

  while (i < len) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const slice = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      current += slice;
      i += slice.length;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const slice = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      current += slice;
      i += slice.length;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (sql.charAt(j) === quote && sql.charAt(j + 1) === quote) {
          j += 2;
          continue;
        }
        if (sql.charAt(j) === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j);
      hasContent = true;
      i = j;
      continue;
    }

    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const end = closeIdx === -1 ? len : closeIdx + tag.length;
        current += sql.slice(i, end);
        hasContent = true;
        i = end;
        continue;
      }
    }

    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }

    if (ch.trim() !== '') hasContent = true;
    current += ch;
    i += 1;
  }

  flush();
  return statements;
}

/**
 * Reads `<dir>/<module>/NNNN_name.sql` for every module subdirectory, parses and checksums each
 * file, and returns them sorted (module dir, then version). Returns `[]` if `dir` doesn't exist.
 */
export async function discoverMigrations(dir: string): Promise<MigrationFile[]> {
  let moduleEntries: Dirent<string>[];
  try {
    moduleEntries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const files: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const moduleEntry of moduleEntries) {
    if (!moduleEntry.isDirectory()) continue;
    const module = moduleEntry.name;
    const moduleDir = path.join(dir, module);
    const sqlEntries: Dirent<string>[] = await readdir(moduleDir, {
      withFileTypes: true,
      encoding: 'utf8',
    });

    for (const sqlEntry of sqlEntries) {
      if (!sqlEntry.isFile() || !sqlEntry.name.endsWith('.sql')) continue;

      const parsed = parseMigrationFilename(sqlEntry.name);
      if (!parsed) {
        throw new MigrationFilenameError(module, sqlEntry.name);
      }

      const key = migrationKey(module, parsed.version);
      if (seen.has(key)) {
        throw new DuplicateMigrationVersionError(module, parsed.version);
      }
      seen.add(key);

      const filePath = path.join(moduleDir, sqlEntry.name);
      const rawContent = await readFile(filePath, 'utf8');
      const content = normalizeLineEndings(rawContent);

      files.push({
        module,
        version: parsed.version,
        name: parsed.name,
        filename: sqlEntry.name,
        path: filePath,
        content,
        checksum: computeChecksum(content),
      });
    }
  }

  return sortMigrationFiles(files);
}

/**
 * Diffs discovered migration files against what's recorded in `schema_migrations`: files with
 * no matching record are `pending`; files whose recorded checksum no longer matches the file on
 * disk are `mismatched` (tampering/drift — the caller must refuse to proceed).
 */
export function planMigrations(
  files: MigrationFile[],
  applied: AppliedMigrationRecord[],
): MigrationPlan {
  const appliedByKey = new Map<string, AppliedMigrationRecord>();
  for (const record of applied) {
    appliedByKey.set(migrationKey(record.module, record.version), record);
  }

  const pending: MigrationFile[] = [];
  const mismatched: ChecksumMismatch[] = [];

  for (const file of sortMigrationFiles(files)) {
    const record = appliedByKey.get(migrationKey(file.module, file.version));
    if (!record) {
      pending.push(file);
      continue;
    }
    if (record.checksum !== file.checksum) {
      mismatched.push({
        module: file.module,
        version: file.version,
        name: file.name,
        expectedChecksum: record.checksum,
        actualChecksum: file.checksum,
      });
    }
  }

  return { pending, mismatched };
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists ${MIGRATIONS_TABLE} (
      module text not null,
      version integer not null,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      primary key (module, version)
    )
  `);
}

async function loadAppliedMigrations(client: PoolClient): Promise<AppliedMigrationRecord[]> {
  const result = await client.query<{
    module: string;
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(`select module, version, name, checksum, applied_at from ${MIGRATIONS_TABLE}`);

  return result.rows.map((row) => ({
    module: row.module,
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

async function applyMigrationFile(client: PoolClient, file: MigrationFile): Promise<void> {
  const statements = splitSqlStatements(file.content);
  try {
    await client.query('BEGIN');
    for (const statement of statements) {
      await client.query(statement);
    }
    // ON CONFLICT DO NOTHING (rather than a plain INSERT): `plan.pending` above is computed once
    // from a single upfront read of this table, so two independent runMigrations() callers can
    // both decide the same file is pending, each execute it, and race to record it here — this
    // is a real, observed failure mode (two Vitest test files each calling runMigrations()
    // against the same fresh database; see packages/kernel/migrations/core/0001_identity.sql's
    // advisory-lock comment for the matching fix on the statement-execution side). Silently
    // accepting the "loser" here is safe: it was recording the identical (module, version,
    // checksum) the winner already committed, not a conflicting one — a genuinely different
    // checksum for this file is still caught by planMigrations's ChecksumMismatchError on the
    // *next* run, which reads this table fresh and compares against the file on disk,
    // independent of this statement's outcome.
    await client.query(
      `insert into ${MIGRATIONS_TABLE} (module, version, name, checksum) values ($1, $2, $3, $4)
       on conflict (module, version) do nothing`,
      [file.module, file.version, file.name, file.checksum],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new MigrationExecutionError(file.module, file.version, file.name, err);
  }
}

/**
 * Applies every pending migration under `dir`, one file per transaction, in module-then-version
 * order. Refuses to run (throws `ChecksumMismatchError`) if any already-applied file's content
 * no longer matches what was recorded when it ran. With `dryRun: true`, performs the same
 * discovery/verification but only reports the plan — nothing is executed or recorded.
 */
export async function runMigrations(
  pool: Pool,
  dir: string,
  options: { dryRun?: boolean } = {},
): Promise<MigrationRunResult> {
  const dryRun = options.dryRun ?? false;
  const files = await discoverMigrations(dir);

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await loadAppliedMigrations(client);
    const plan = planMigrations(files, applied);

    if (plan.mismatched.length > 0) {
      throw new ChecksumMismatchError(plan.mismatched);
    }

    if (dryRun) {
      return { applied: [], pending: plan.pending, dryRun: true };
    }

    const appliedNow: MigrationFile[] = [];
    for (const file of plan.pending) {
      await applyMigrationFile(client, file);
      appliedNow.push(file);
    }

    return { applied: appliedNow, pending: [], dryRun: false };
  } finally {
    client.release();
  }
}
