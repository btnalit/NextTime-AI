import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { authenticateHuman, hashApiKey, lookupPrincipalByApiKeyHash } from './auth.js';

/**
 * application/gateway/auth.test: `hashApiKey` unit tests (pure) plus DB-gated integration tests
 * for the human channel's DB-backed lookups (docs/development-tasks.md S1.3, item 1) — same
 * `describe.runIf(DATABASE_URL !== undefined)` pattern as substrate/invariants.test.ts.
 */

describe('hashApiKey', () => {
  it('is deterministic sha256 hex', () => {
    expect(hashApiKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('different inputs hash differently', () => {
    expect(hashApiKey('key-a')).not.toBe(hashApiKey('key-b'));
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('gateway/auth — integration (real Postgres)', () => {
  let pool: Pool;
  let workspaceId: string;

  async function adminInsertWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId: id, principalId: randomUUID() },
      async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function adminInsertPrincipalWithKey(opts: {
    role: string;
    displayName: string;
    apiKey: string;
  }): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
           values ($1, $2, 'human', $3, $4, $5)`,
          [workspaceId, id, opts.role, opts.displayName, hashApiKey(opts.apiKey)],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('gateway-auth-test-workspace');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('lookupPrincipalByApiKeyHash finds a principal by its key hash before the workspace is known', async () => {
    const apiKey = `key-${randomUUID()}`;
    const principalId = await adminInsertPrincipalWithKey({
      role: 'member',
      displayName: 'Alice',
      apiKey,
    });

    const found = await lookupPrincipalByApiKeyHash(pool, hashApiKey(apiKey));
    expect(found?.id).toBe(principalId);
    expect(found?.workspaceId).toBe(workspaceId);
    expect(found?.role).toBe('member');
  });

  it('lookupPrincipalByApiKeyHash returns null for an unknown key', async () => {
    const found = await lookupPrincipalByApiKeyHash(pool, hashApiKey('never-registered'));
    expect(found).toBeNull();
  });

  it('authenticateHuman creates a web session on first call and reuses it on the next', async () => {
    const apiKey = `key-${randomUUID()}`;
    await adminInsertPrincipalWithKey({ role: 'member', displayName: 'Bob', apiKey });

    const first = await authenticateHuman(pool, apiKey);
    expect(first?.session.kind).toBe('web');
    expect(first?.session.onBehalfOf).toBe(first?.principal.id);

    const second = await authenticateHuman(pool, apiKey);
    expect(second?.session.id).toBe(first?.session.id);
  });

  it('authenticateHuman returns null for an unknown key (no session created)', async () => {
    const result = await authenticateHuman(pool, `unknown-${randomUUID()}`);
    expect(result).toBeNull();
  });
});
