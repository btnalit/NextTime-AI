import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { withAdminClient } from '../gateway/auth.js';
import { createPlatformAdmin } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { ensureDefaultWorkspace } from './default-workspace.js';
import { readPlatformSettings, updatePlatformSettings } from './settings.js';

/**
 * application/platform/default-workspace.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL, the same `describe.runIf` pattern every other integration suite in this
 * package uses) coverage of P-A1's "登录即对话" startup step (docs/platform-admin-design.md §2/§4)
 * — the three outcomes `ensureDefaultWorkspace` can produce on a real database.
 *
 * **Isolation.** This file creates, migrates and drops a private database of its own, because its
 * whole subject is what happens on an install that has *no workspace at all*: the CI database is
 * shared by every other integration suite here and always carries workspaces theirs created, so
 * the `created` branch could never be observed in it (and deleting other files' workspaces is not
 * an option). The private database needs nothing the shared one does not: CREATE DATABASE on the
 * configured login (CI's `nexttime` is the Postgres container's superuser) and the same
 * `runMigrations` call — which migrations/core/0001_identity.sql's own header already anticipates
 * being run "against a different database in the same Postgres cluster".
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

const PASSWORD = 'correct horse battery staple';

/** Creates and migrates a database of this file's own (see the module doc comment), plus the
 *  `drop` that ends the pool and removes it again. */
async function createIsolatedDatabase(): Promise<{
  readonly pool: Pool;
  readonly drop: () => Promise<void>;
}> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  // Hex only — nothing here can be quoted-identifier trickery, and it stays under Postgres's
  // 63-byte identifier limit.
  const name = `nexttime_default_ws_${randomUUID().replace(/-/g, '')}`;
  try {
    await cluster.query(`create database "${name}"`);
  } catch (err) {
    // Never leave the cluster pool open behind a failure (an open pool keeps the worker alive).
    await cluster.end();
    throw err;
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString() });
  return {
    pool,
    drop: async () => {
      await pool.end();
      // `with (force)` (Postgres 13+): never leave the database behind because a connection of
      // this file's own outlived the pool.
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'ensureDefaultWorkspace (integration, real Postgres, a database of its own)',
  () => {
    let pool: Pool;
    let dropDatabase: (() => Promise<void>) | undefined;
    let admin: UserRow;
    /** The workspace the first `created` outcome produced — the `unchanged` and `adopted` cases
     *  below are both about this same one. */
    let defaultWorkspaceId: string;

    beforeAll(async () => {
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);
      admin = await createPlatformAdmin(pool, {
        login: `default-ws-admin-${randomUUID().slice(0, 8)}`,
        displayName: 'Default Workspace Admin',
        password: PASSWORD,
      });
      // A fresh database's full migration run is well past Vitest's 10s default hook timeout.
    }, 180_000);

    afterAll(async () => {
      await dropDatabase?.();
    }, 60_000);

    it('an install with no workspace at all: creates one, owned by the administrator, and records it', async () => {
      const outcome = await ensureDefaultWorkspace(pool, { ontologyDir: ONTOLOGY_DIR });
      if (outcome.kind !== 'created') {
        throw new Error(`expected a created workspace, got "${outcome.kind}"`);
      }
      defaultWorkspaceId = outcome.workspaceId;

      const workspace = await withAdminClient(pool, (client) =>
        client.query<{ name: string; status: string }>(
          'select name, status from workspaces where id = $1',
          [defaultWorkspaceId],
        ),
      );
      // Named after the site (`PlatformSettings.siteName`, projected from the compiled-in
      // defaults on a fresh install).
      expect(workspace.rows[0]?.name).toBe('NextTime AI');
      expect(workspace.rows[0]?.status).toBe('active');

      // The owner Principal is the administrator's membership, and it holds no API key: a
      // membership's automation credential is issued later, from the console (application/
      // workspace/create.ts's own doc comment).
      const principals = await withAdminClient(pool, (client) =>
        client.query<{ role: string; user_id: string | null; api_key_hash: string | null }>(
          `select role, user_id, api_key_hash from principals
              where workspace_id = $1 and kind = 'human'`,
          [defaultWorkspaceId],
        ),
      );
      expect(principals.rows).toHaveLength(1);
      expect(principals.rows[0]?.role).toBe('owner');
      expect(principals.rows[0]?.user_id).toBe(admin.id);
      expect(principals.rows[0]?.api_key_hash).toBeNull();

      const settings = await withAdminClient(pool, (client) => readPlatformSettings(client));
      expect(settings.settings.defaultWorkspaceId).toBe(defaultWorkspaceId);
    }, 120_000);

    it('a second start changes nothing — the recorded default is still there', async () => {
      const outcome = await ensureDefaultWorkspace(pool, { ontologyDir: ONTOLOGY_DIR });
      expect(outcome).toEqual({ kind: 'unchanged', workspaceId: defaultWorkspaceId });

      const workspaces = await withAdminClient(pool, (client) =>
        client.query('select id from workspaces'),
      );
      expect(workspaces.rowCount).toBe(1);
    });

    it('an upgraded install with one active workspace and no recorded default adopts it', async () => {
      await withAdminClient(pool, (client) =>
        updatePlatformSettings(client, { defaultWorkspaceId: null }, null),
      );

      const outcome = await ensureDefaultWorkspace(pool, { ontologyDir: ONTOLOGY_DIR });
      expect(outcome).toEqual({ kind: 'adopted', workspaceId: defaultWorkspaceId });

      const settings = await withAdminClient(pool, (client) => readPlatformSettings(client));
      expect(settings.settings.defaultWorkspaceId).toBe(defaultWorkspaceId);

      // Adopting is a settings write, never a second workspace.
      const workspaces = await withAdminClient(pool, (client) =>
        client.query('select id from workspaces'),
      );
      expect(workspaces.rowCount).toBe(1);
    });
  },
);
