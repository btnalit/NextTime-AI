import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';

/**
 * adapters/db/pool: Postgres connection pool and the `withWorkspace` transaction helper that
 * sets the RLS session variables every governed query relies on (design doc §9.2 RLS predicate,
 * invariant I1; docs/development-tasks.md R2).
 */

/** Thrown when a pool cannot be constructed because no connection string is available. */
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

/** Thrown when `withWorkspace` is called without both a workspaceId and a principalId. */
export class InvalidWorkspaceContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkspaceContextError';
  }
}

export interface CreatePoolOptions {
  /** Overrides `DATABASE_URL`. Mainly for tests; production code should rely on the env var. */
  connectionString?: string;
  /** Extra `pg` Pool options merged in on top of the connection string. */
  poolConfig?: Omit<PoolConfig, 'connectionString'>;
}

/**
 * Builds a `pg` Pool from `DATABASE_URL` (or `options.connectionString`). Throws
 * `DatabaseConfigError` synchronously instead of letting `pg` fall back to its own
 * PG*-env-var defaults, so a missing configuration fails fast and loudly.
 */
export function createPool(options: CreatePoolOptions = {}): Pool {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new DatabaseConfigError(
      'DATABASE_URL is not set and no connectionString was provided to createPool()',
    );
  }
  return new Pool({ ...options.poolConfig, connectionString });
}

export interface WorkspaceContext {
  workspaceId: string;
  principalId: string;
}

export interface WithWorkspaceOptions {
  /**
   * Skip `SET LOCAL ROLE nexttime_app` and stay on the connection's login role for this
   * transaction (design doc S1.1: the compose Postgres login user is a superuser and therefore
   * bypasses RLS). Only for admin/bootstrap operations that must run before RLS can even apply
   * — e.g. creating a workspace before any principal exists in it, or looking a principal up by
   * `api_key_hash` before its workspace is known. Default `false`.
   */
  skipRoleSwitch?: boolean;
}

/**
 * The subset of `pg.Pool` that `withWorkspace` needs. Declared explicitly (rather than
 * requiring the concrete `Pool` class) so unit tests can exercise the transaction/session-var
 * orchestration with a fake pool and client, with no Postgres involved.
 */
export interface PoolLike {
  connect(): Promise<PoolClient>;
}

/**
 * Runs `fn(client)` inside a transaction after setting the two RLS session variables (design
 * doc I1) that every workspace-scoped policy predicate reads:
 *
 *   set_config('app.workspace_id', <workspaceId>, true)
 *   set_config('app.principal_id', <principalId>, true)
 *
 * ...and then, unless `options.skipRoleSwitch` is set, switching the transaction onto the
 * non-login `nexttime_app` role (`SET LOCAL ROLE nexttime_app`) so RLS actually applies —
 * the connection authenticates as a superuser, which would otherwise bypass every policy below
 * (design doc S1.1). A superuser can `SET ROLE` to any role regardless of membership, so this
 * needs no additional grant.
 *
 * The third argument to `set_config` (`is_local = true`) is load-bearing, and so is running the
 * role switch as `SET LOCAL ROLE` rather than plain `SET ROLE`: both scope to the current
 * transaction and are cleared automatically on COMMIT/ROLLBACK. Pool connections are reused
 * across unrelated requests — a session-wide `set_config` or role change would leak one
 * caller's workspace/principal/privilege level into the next request served by the same pooled
 * connection.
 *
 * On any error thrown by `fn` (or by a statement inside the transaction), the transaction is
 * rolled back and the original error is rethrown unchanged.
 */
export async function withWorkspace<T>(
  pool: PoolLike,
  context: WorkspaceContext,
  fn: (client: PoolClient) => Promise<T>,
  options: WithWorkspaceOptions = {},
): Promise<T> {
  if (!context.workspaceId || !context.principalId) {
    throw new InvalidWorkspaceContextError(
      'withWorkspace requires a non-empty workspaceId and principalId',
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.workspace_id', $1, true)", [context.workspaceId]);
    await client.query("select set_config('app.principal_id', $1, true)", [context.principalId]);
    if (!options.skipRoleSwitch) {
      await client.query('set local role nexttime_app');
    }

    const result = await fn(client);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Best-effort: the connection may already be unusable (e.g. it died mid-transaction).
      // The original error below is what matters to the caller.
    });
    throw err;
  } finally {
    client.release();
  }
}
