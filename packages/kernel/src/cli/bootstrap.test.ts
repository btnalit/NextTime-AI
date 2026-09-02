import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../adapters/db/pool.js';
import { hashApiKey } from '../application/gateway/index.js';
import { createWorkspace } from './bootstrap.js';

/**
 * cli/bootstrap.test: integration tests (real Postgres; auto-skip without DATABASE_URL) for
 * `create-workspace` (docs/development-tasks.md S1.3, item 6) — the workspace and its owner
 * Principal exist afterward, the printed API key resolves back to that Principal via the human
 * channel's own hashing (`application/gateway/auth.ts`'s `hashApiKey`, which `bootstrap.ts`
 * itself calls — see its module doc), and only the hash, never the raw key, is stored.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('createWorkspace (integration, real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a Workspace and an owner Principal whose api_key_hash matches the returned key', async () => {
    const result = await createWorkspace(pool, 'bootstrap-test-workspace', 'Test Owner');

    const row = await withWorkspace(
      pool,
      { workspaceId: result.workspaceId, principalId: result.ownerPrincipalId },
      async (client) => {
        const workspaceResult = await client.query<{ name: string }>(
          'select name from workspaces where id = $1',
          [result.workspaceId],
        );
        const principalResult = await client.query<{
          kind: string;
          role: string;
          display_name: string;
          api_key_hash: string;
        }>(
          'select kind, role, display_name, api_key_hash from principals where workspace_id = $1 and id = $2',
          [result.workspaceId, result.ownerPrincipalId],
        );
        return {
          workspaceName: workspaceResult.rows[0]?.name,
          principal: principalResult.rows[0],
        };
      },
    );

    expect(row.workspaceName).toBe('bootstrap-test-workspace');
    expect(row.principal?.kind).toBe('human');
    expect(row.principal?.role).toBe('owner');
    expect(row.principal?.display_name).toBe('Test Owner');
    expect(row.principal?.api_key_hash).toBe(hashApiKey(result.apiKey));
    // The raw key is never itself a valid sha256 hex digest of anything predictable — the real
    // assertion that matters is the one above (hash matches); this just confirms the key looks
    // like an opaque token, not e.g. the workspace id or a guessable string.
    expect(result.apiKey).not.toBe(result.workspaceId);
  });

  it('two calls produce different workspaces, principals, and API keys', async () => {
    const a = await createWorkspace(pool, 'bootstrap-test-workspace-a', 'Owner A');
    const b = await createWorkspace(pool, 'bootstrap-test-workspace-b', 'Owner B');

    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.ownerPrincipalId).not.toBe(b.ownerPrincipalId);
    expect(a.apiKey).not.toBe(b.apiKey);
  });
});
