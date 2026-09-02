import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ChecksumMismatchError,
  DuplicateMigrationVersionError,
  MigrationFilenameError,
  computeChecksum,
  discoverMigrations,
  parseMigrationFilename,
  planMigrations,
  runMigrations,
  sortMigrationFiles,
  splitSqlStatements,
} from './migrate.js';
import type { MigrationFile } from './migrate.js';
import { createPool } from './pool.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('parseMigrationFilename', () => {
  it('parses a well-formed NNNN_name.sql filename', () => {
    expect(parseMigrationFilename('0000_extensions.sql')).toEqual({
      version: 0,
      name: 'extensions',
    });
    expect(parseMigrationFilename('0012_add_indexes.sql')).toEqual({
      version: 12,
      name: 'add_indexes',
    });
  });

  it('returns null for filenames that do not match the pattern', () => {
    expect(parseMigrationFilename('extensions.sql')).toBeNull();
    expect(parseMigrationFilename('0001-name.sql')).toBeNull();
    expect(parseMigrationFilename('0001_Name.sql')).toBeNull();
    expect(parseMigrationFilename('0001_name.txt')).toBeNull();
    expect(parseMigrationFilename('name_0001.sql')).toBeNull();
  });
});

describe('computeChecksum', () => {
  it('is deterministic for identical content', () => {
    expect(computeChecksum('select 1;')).toBe(computeChecksum('select 1;'));
  });

  it('differs when content differs', () => {
    expect(computeChecksum('select 1;')).not.toBe(computeChecksum('select 2;'));
  });

  it('normalizes CRLF to LF before hashing, so line-ending noise does not look like tampering', () => {
    expect(computeChecksum('select 1;\r\ncreate table t (x int);\r\n')).toBe(
      computeChecksum('select 1;\ncreate table t (x int);\n'),
    );
  });
});

describe('sortMigrationFiles', () => {
  function file(module: string, version: number): MigrationFile {
    return {
      module,
      version,
      name: `m${version}`,
      filename: `${String(version).padStart(4, '0')}_m${version}.sql`,
      path: '/dev/null',
      content: '',
      checksum: '',
    };
  }

  it('sorts by module directory name first, then numeric version within the module', () => {
    const files = [file('core', 1), file('chat', 0), file('core', 0), file('chat', 2)];
    const sorted = sortMigrationFiles(files);
    expect(sorted.map((f) => `${f.module}/${f.version}`)).toEqual([
      'chat/0',
      'chat/2',
      'core/0',
      'core/1',
    ]);
  });

  it('does not mutate the input array', () => {
    const files = [file('core', 1), file('chat', 0)];
    const copy = [...files];
    sortMigrationFiles(files);
    expect(files).toEqual(copy);
  });
});

describe('splitSqlStatements', () => {
  it('splits simple statements on semicolons', () => {
    expect(splitSqlStatements('select 1; select 2;')).toEqual(['select 1', 'select 2']);
  });

  it('includes a trailing statement with no terminating semicolon', () => {
    expect(splitSqlStatements('select 1; select 2')).toEqual(['select 1', 'select 2']);
  });

  it('does not split on a semicolon inside a single-quoted string', () => {
    expect(splitSqlStatements("select ';' as x; select 2;")).toEqual([
      "select ';' as x",
      'select 2',
    ]);
  });

  it("handles an escaped quote (doubled '') inside a single-quoted string", () => {
    expect(splitSqlStatements("select 'it''s; fine' as x; select 2;")).toEqual([
      "select 'it''s; fine' as x",
      'select 2',
    ]);
  });

  it('does not split on a semicolon inside a double-quoted identifier', () => {
    expect(splitSqlStatements('select 1 as "a;b"; select 2;')).toEqual([
      'select 1 as "a;b"',
      'select 2',
    ]);
  });

  it('does not split inside a $$-quoted function body', () => {
    const sql = [
      'create function f() returns void as $$',
      'begin',
      '  insert into t values (1);',
      '  insert into t values (2);',
      'end;',
      '$$ language plpgsql;',
      'select 3;',
    ].join('\n');

    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('insert into t values (1);');
    expect(statements[0]).toContain('insert into t values (2);');
    expect(statements[0]?.endsWith('language plpgsql')).toBe(true);
    expect(statements[1]).toBe('select 3');
  });

  it('respects a custom dollar-quote tag and ignores an unrelated tag inside it', () => {
    const sql = 'select $tag$contains a $other$ nested tag and a ; semicolon$tag$ as x; select 2;';
    expect(splitSqlStatements(sql)).toEqual([
      'select $tag$contains a $other$ nested tag and a ; semicolon$tag$ as x',
      'select 2',
    ]);
  });

  it('does not treat a ; inside a line comment as a statement separator', () => {
    // The comment text is preserved verbatim in the statement (harmless to send to Postgres) —
    // only a semicolon-free split point is what matters here.
    expect(splitSqlStatements('select 1; -- a; b\nselect 2;')).toEqual([
      'select 1',
      '-- a; b\nselect 2',
    ]);
  });

  it('does not treat a ; inside a block comment as a statement separator', () => {
    expect(splitSqlStatements('select 1; /* a; b */ select 2;')).toEqual([
      'select 1',
      '/* a; b */ select 2',
    ]);
  });

  it('drops statements that contain only comments or whitespace', () => {
    expect(splitSqlStatements('-- just a header comment\n\n')).toEqual([]);
    expect(splitSqlStatements('  ;  ;  ')).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(splitSqlStatements('')).toEqual([]);
  });
});

describe('planMigrations', () => {
  function file(overrides: Partial<MigrationFile> = {}): MigrationFile {
    return {
      module: 'core',
      version: 0,
      name: 'ext',
      filename: '0000_ext.sql',
      path: '/dev/null',
      content: 'select 1;',
      checksum: 'checksum-a',
      ...overrides,
    };
  }

  it('treats a file with no matching applied record as pending', () => {
    const plan = planMigrations([file()], []);
    expect(plan.pending).toHaveLength(1);
    expect(plan.mismatched).toHaveLength(0);
  });

  it('treats a file whose checksum matches the applied record as up to date', () => {
    const plan = planMigrations(
      [file({ checksum: 'checksum-a' })],
      [{ module: 'core', version: 0, name: 'ext', checksum: 'checksum-a', appliedAt: new Date() }],
    );
    expect(plan.pending).toHaveLength(0);
    expect(plan.mismatched).toHaveLength(0);
  });

  it('flags a checksum drift as mismatched, not pending', () => {
    const plan = planMigrations(
      [file({ checksum: 'checksum-b' })],
      [{ module: 'core', version: 0, name: 'ext', checksum: 'checksum-a', appliedAt: new Date() }],
    );
    expect(plan.pending).toHaveLength(0);
    expect(plan.mismatched).toEqual([
      {
        module: 'core',
        version: 0,
        name: 'ext',
        expectedChecksum: 'checksum-a',
        actualChecksum: 'checksum-b',
      },
    ]);
  });
});

describe('discoverMigrations (real filesystem, no Postgres)', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function makeDir(): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'nexttime-migrate-test-'));
    return dir;
  }

  it('returns [] when the migrations directory does not exist', async () => {
    const missing = path.join(tmpdir(), `nexttime-missing-${randomUUID()}`);
    expect(await discoverMigrations(missing)).toEqual([]);
  });

  it('reads module subdirectories, parses filenames, computes checksums, and sorts (module, then version)', async () => {
    const root = await makeDir();
    await mkdir(path.join(root, 'core'), { recursive: true });
    await mkdir(path.join(root, 'chat'), { recursive: true });
    await writeFile(path.join(root, 'core', '0001_more.sql'), 'select 2;');
    await writeFile(path.join(root, 'core', '0000_ext.sql'), 'select 1;');
    await writeFile(path.join(root, 'chat', '0000_init.sql'), 'select 0;');

    const files = await discoverMigrations(root);

    expect(files.map((f) => `${f.module}/${f.filename}`)).toEqual([
      'chat/0000_init.sql',
      'core/0000_ext.sql',
      'core/0001_more.sql',
    ]);
    expect(files[0]?.checksum).toBe(computeChecksum('select 0;'));
  });

  it('throws MigrationFilenameError for a file that does not match NNNN_name.sql', async () => {
    const root = await makeDir();
    await mkdir(path.join(root, 'core'), { recursive: true });
    await writeFile(path.join(root, 'core', 'not-a-migration.sql'), 'select 1;');

    await expect(discoverMigrations(root)).rejects.toThrow(MigrationFilenameError);
  });

  it('throws DuplicateMigrationVersionError when two files in a module share a version', async () => {
    const root = await makeDir();
    await mkdir(path.join(root, 'core'), { recursive: true });
    await writeFile(path.join(root, 'core', '0000_a.sql'), 'select 1;');
    await writeFile(path.join(root, 'core', '0000_b.sql'), 'select 2;');

    await expect(discoverMigrations(root)).rejects.toThrow(DuplicateMigrationVersionError);
  });
});

describe.runIf(DATABASE_URL !== undefined)('runMigrations — integration (real Postgres)', () => {
  // Deferred to beforeAll: describe callbacks run during collection even for a skipped suite,
  // so calling createPool() here directly would throw (no DATABASE_URL) before runIf takes effect.
  let pool!: Pool;
  let dir = '';

  beforeAll(() => {
    pool = createPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function makeModuleDir(module: string): Promise<{ root: string; moduleDir: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'nexttime-migrate-it-'));
    dir = root;
    const moduleDir = path.join(root, module);
    await mkdir(moduleDir, { recursive: true });
    return { root, moduleDir };
  }

  function uniqueModuleName(): string {
    return `r2test_${randomUUID().replace(/-/g, '')}`;
  }

  it('applies pending migrations once, and running again is a no-op', async () => {
    const moduleName = uniqueModuleName();
    const { root, moduleDir } = await makeModuleDir(moduleName);
    await writeFile(
      path.join(moduleDir, '0000_init.sql'),
      `create table ${moduleName}_t (id int primary key);`,
    );

    const first = await runMigrations(pool, root);
    expect(first.applied).toHaveLength(1);
    expect(first.pending).toHaveLength(0);

    const second = await runMigrations(pool, root);
    expect(second.applied).toHaveLength(0);
    expect(second.pending).toHaveLength(0);

    const client = await pool.connect();
    try {
      const count = await client.query(
        'select count(*)::int as n from schema_migrations where module = $1',
        [moduleName],
      );
      expect(count.rows[0]?.n).toBe(1);
    } finally {
      client.release();
    }
  });

  it('serializes concurrent runMigrations() calls: each file is applied exactly once, none fail', async () => {
    // Regression for the CI flake fixed by MIGRATION_RUN_LOCK_KEY: without the run-level lock,
    // several runners racing on a fresh module each see both files as pending and race on the
    // (deliberately non-idempotent) `create table` below — the losers fail with "relation
    // already exists". With the lock, the first runner applies both, the rest block, re-plan,
    // and find nothing pending.
    const moduleName = uniqueModuleName();
    const { root, moduleDir } = await makeModuleDir(moduleName);
    await writeFile(
      path.join(moduleDir, '0000_init.sql'),
      `create table ${moduleName}_t (id int primary key);`,
    );
    await writeFile(
      path.join(moduleDir, '0001_more.sql'),
      `create table ${moduleName}_u (id int primary key);`,
    );

    const results = await Promise.all(Array.from({ length: 4 }, () => runMigrations(pool, root)));

    const totalApplied = results.reduce((n, r) => n + r.applied.length, 0);
    expect(totalApplied).toBe(2);
    for (const result of results) {
      expect(result.pending).toHaveLength(0);
    }

    const client = await pool.connect();
    try {
      const count = await client.query(
        'select count(*)::int as n from schema_migrations where module = $1',
        [moduleName],
      );
      expect(count.rows[0]?.n).toBe(2);
    } finally {
      client.release();
    }
  });

  it('refuses to run when an already-applied migration file was tampered with', async () => {
    const moduleName = uniqueModuleName();
    const { root, moduleDir } = await makeModuleDir(moduleName);
    const filePath = path.join(moduleDir, '0000_init.sql');
    await writeFile(filePath, `create table ${moduleName}_t (id int primary key);`);

    await runMigrations(pool, root);

    // Tamper: change the already-applied file's content on disk.
    await writeFile(filePath, `create table ${moduleName}_t (id int primary key, extra int);`);

    await expect(runMigrations(pool, root)).rejects.toThrow(ChecksumMismatchError);
  });

  it('--dry-run reports pending migrations without applying or recording them', async () => {
    const moduleName = uniqueModuleName();
    const { root, moduleDir } = await makeModuleDir(moduleName);
    await writeFile(
      path.join(moduleDir, '0000_a.sql'),
      `create table ${moduleName}_a (id int primary key);`,
    );
    await writeFile(
      path.join(moduleDir, '0001_b.sql'),
      `create table ${moduleName}_b (id int primary key);`,
    );

    const dry = await runMigrations(pool, root, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.pending.map((f) => f.filename)).toEqual(['0000_a.sql', '0001_b.sql']);
    expect(dry.applied).toHaveLength(0);

    const client = await pool.connect();
    try {
      const count = await client.query(
        'select count(*)::int as n from schema_migrations where module = $1',
        [moduleName],
      );
      expect(count.rows[0]?.n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('applies a dollar-quoted plpgsql function body as a single statement', async () => {
    const moduleName = uniqueModuleName();
    const { root, moduleDir } = await makeModuleDir(moduleName);
    const sql = [
      `create table ${moduleName}_audit (id int primary key, note text);`,
      `create function ${moduleName}_touch() returns trigger as $$`,
      'begin',
      "  new.note := 'touched;still one statement';",
      '  return new;',
      'end;',
      '$$ language plpgsql;',
    ].join('\n');
    await writeFile(path.join(moduleDir, '0000_init.sql'), sql);

    const result = await runMigrations(pool, root);
    expect(result.applied).toHaveLength(1);

    const client = await pool.connect();
    try {
      const fn = await client.query('select proname from pg_proc where proname = $1', [
        `${moduleName}_touch`,
      ]);
      expect(fn.rowCount).toBe(1);
    } finally {
      client.release();
    }
  });

  it('applies the real packages/kernel/migrations tree (core/0000_extensions), and a second run is a no-op', async () => {
    const migrationsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'migrations',
    );

    await runMigrations(pool, migrationsDir);
    const second = await runMigrations(pool, migrationsDir);
    expect(second.applied).toHaveLength(0);
    expect(second.pending).toHaveLength(0);

    const client = await pool.connect();
    try {
      const ext = await client.query<{ extname: string }>(
        "select extname from pg_extension where extname in ('vector', 'pgcrypto') order by extname",
      );
      expect(ext.rows.map((r) => r.extname)).toEqual(['pgcrypto', 'vector']);
    } finally {
      client.release();
    }
  });
});
