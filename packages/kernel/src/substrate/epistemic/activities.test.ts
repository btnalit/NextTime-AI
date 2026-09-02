import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ActivityNotFoundError, endActivity, startActivity } from './activities.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for the minimal
 * startActivity/endActivity helper (docs/development-tasks.md S1.2: "so callers can satisfy
 * I3"). The graph module's own integration tests (../graph/sql-store.test.ts) exercise this
 * indirectly on every fixture; these are the direct, focused tests.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'startActivity / endActivity (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let principalId: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      principalId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'activities-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, principalId, 'human', 'owner', 'owner'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('starts an Activity with status "running" and the given kind/metadata/sourceId', async () => {
      const activity = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        startActivity(client, workspaceId, {
          kind: 'test.ingest',
          principalId,
          sourceId: 'source-1',
          metadata: { note: 'hello' },
        }),
      );

      expect(activity.kind).toBe('test.ingest');
      expect(activity.status).toBe('running');
      expect(activity.startedBy).toBe(principalId);
      expect(activity.endedAt).toBeNull();
      expect(activity.metadata).toMatchObject({ note: 'hello', sourceId: 'source-1' });
    });

    it('endActivity sets status and ended_at', async () => {
      const activity = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        startActivity(client, workspaceId, { kind: 'test.ingest', principalId }),
      );

      const ended = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        endActivity(client, workspaceId, activity.id, 'completed'),
      );

      expect(ended.status).toBe('completed');
      expect(ended.endedAt).not.toBeNull();
    });

    it('endActivity on a missing Activity throws ActivityNotFoundError', async () => {
      await expect(
        withWorkspace(pool, { workspaceId, principalId }, (client) =>
          endActivity(client, workspaceId, randomUUID(), 'completed'),
        ),
      ).rejects.toThrow(ActivityNotFoundError);
    });
  },
);
