import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { SqlGraphStore } from '../graph/index.js';
import { queryAudit, writeAudit } from './writer.js';

/**
 * substrate/audit/writer.test: integration tests (real Postgres; auto-skip without DATABASE_URL)
 * for `writeAudit`/`queryAudit`, including docs/development-tasks.md S1.3's acceptance
 * criterion "audit 写失败整体回滚" at the primitive level (application/gateway/dispatch.test.ts
 * covers the same property through `dispatchCapability` itself).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'substrate/audit/writer (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'audit-writer-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner', 'owner'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('writeAudit appends a row; queryAudit finds it by action/resource', async () => {
      const resourceId = randomUUID();
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action: 'test.write',
          resourceType: 'object',
          resourceId,
          payload: { note: 'hello' },
        }),
      );

      const found = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, { action: 'test.write', resourceId }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.actorPrincipalId).toBe(ownerId);
      expect(found[0]?.payload).toEqual({ note: 'hello' });
    });

    it('audit_records is append-only: an UPDATE is rejected by the DB trigger (I11/0004_audit.sql)', async () => {
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        writeAudit(client, { workspaceId, actorPrincipalId: ownerId, action: 'test.immutable' }),
      );

      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query('update audit_records set action = $1 where workspace_id = $2 and id = $3', [
            'tampered',
            workspaceId,
            row.id,
          ]),
        ),
      ).rejects.toThrow();
    });

    it('a failing audit write rolls back a prior write in the same transaction (S1.3 acceptance)', async () => {
      const store = new SqlGraphStore();
      const nonExistentActor = randomUUID(); // no principals row — FK violation forces the failure

      let attemptedObjectId = '';
      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const object = await store.upsertObject(client, workspaceId, {
            objectType: 'test.audit-rollback',
          });
          attemptedObjectId = object.id;
          await writeAudit(client, {
            workspaceId,
            actorPrincipalId: nonExistentActor,
            action: 'test.forced_failure',
          });
        }),
      ).rejects.toThrow();

      const survived = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query('select id from objects where id = $1', [attemptedObjectId]),
      );
      expect(survived.rows).toHaveLength(0);
    });
  },
);
