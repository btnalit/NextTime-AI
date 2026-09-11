import type { PoolClient } from 'pg';
import type { PoolLike } from './pool.js';

/**
 * adapters/db/platform-context: the transaction shape for `scope: 'platform'` capabilities
 * (P-A1; docs/platform-admin-design.md §7; design doc §7.11 "`scope:'platform'`").
 *
 * Mirrors `withWorkspace` with the platform GUC instead of a workspace: `app.platform = on`
 * satisfies the `app_platform()` policies migrations 0019/0021 added on `users`, `user_sessions`,
 * `principals`, `sessions` and the `workspace_id is null` half of `audit_records`; `app.user_id`
 * carries the acting administrator for anything that wants to record it. The role is still
 * `nexttime_app` — a platform transaction is *not* a superuser session and gains no general RLS
 * bypass: a handler that must touch a workspace-scoped table (adding a membership creates a
 * Principal) does so under the `*_platform_admin` policies, or switches `app.workspace_id`
 * explicitly for that statement (`setWorkspaceContext` below), never by dropping RLS.
 */

export interface PlatformContext {
  readonly userId: string;
}

export async function withPlatform<T>(
  pool: PoolLike,
  context: PlatformContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!context.userId) throw new Error('withPlatform requires a non-empty userId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.platform', 'on', true)");
    await client.query("select set_config('app.user_id', $1, true)", [context.userId]);
    // Never inherit a stale workspace from a pooled connection: policies that read
    // `app_workspace()` must see "no workspace" unless a handler sets one deliberately.
    await client.query("select set_config('app.workspace_id', '', true)");
    await client.query("select set_config('app.principal_id', '', true)");
    await client.query('set local role nexttime_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Best-effort; the original error is what the caller needs.
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Inside a platform transaction: scope the following statements to one workspace as well
 *  (`app_workspace()` policies), e.g. to insert a membership Principal. Still `nexttime_app`. */
export async function setWorkspaceContext(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
  await client.query("select set_config('app.principal_id', $1, true)", [principalId]);
}
