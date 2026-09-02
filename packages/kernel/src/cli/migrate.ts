import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../adapters/db/migrate.js';
import type { MigrationFile } from '../adapters/db/migrate.js';
import { createPool } from '../adapters/db/pool.js';

/**
 * CLI entry for the migration runner (docs/development-tasks.md R2). Wired to the kernel
 * package.json `migrate` script and the root Makefile `migrate` target.
 *
 * Usage: node dist/cli/migrate.js [--dry-run]
 * Reads DATABASE_URL from the environment; migrations live in packages/kernel/migrations/.
 */

function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'migrations');
}

function describeFile(file: MigrationFile): string {
  return `${file.module}/${file.filename}`;
}

async function run(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const pool = createPool();

  try {
    const result = await runMigrations(pool, defaultMigrationsDir(), { dryRun });

    if (dryRun) {
      if (result.pending.length === 0) {
        console.log('migrate --dry-run: nothing pending, already up to date.');
      } else {
        console.log(`migrate --dry-run: ${result.pending.length} pending migration(s):`);
        for (const file of result.pending) {
          console.log(`  ${describeFile(file)}`);
        }
      }
      return;
    }

    if (result.applied.length === 0) {
      console.log('migrate: nothing to do, already up to date.');
    } else {
      console.log(`migrate: applied ${result.applied.length} migration(s):`);
      for (const file of result.applied) {
        console.log(`  ${describeFile(file)}`);
      }
    }
  } finally {
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
