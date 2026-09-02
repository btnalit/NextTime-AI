/**
 * adapters/db: Postgres connection pool and migration runner — implements the persistence port
 * declared by the application/interfaces layers (design doc §7.1, §7.10, R2).
 *
 * Adapters may be imported only by application and interfaces modules — enforced by
 * .dependency-cruiser.cjs.
 */
export {
  createPool,
  withWorkspace,
  DatabaseConfigError,
  InvalidWorkspaceContextError,
} from './pool.js';
export type { CreatePoolOptions, PoolLike, WorkspaceContext } from './pool.js';

export {
  runMigrations,
  discoverMigrations,
  planMigrations,
  parseMigrationFilename,
  sortMigrationFiles,
  splitSqlStatements,
  computeChecksum,
  MigrationFilenameError,
  DuplicateMigrationVersionError,
  ChecksumMismatchError,
  MigrationExecutionError,
} from './migrate.js';
export type {
  AppliedMigrationRecord,
  ChecksumMismatch,
  MigrationFile,
  MigrationPlan,
  MigrationRunResult,
} from './migrate.js';
