import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { startActivity } from '../epistemic/index.js';
import { SqlGraphStore } from '../graph/index.js';
import { reconstruct } from './reconstruct.js';
import { writeAudit } from './writer.js';

/**
 * substrate/audit/reconstruct.test: integration tests (real Postgres; auto-skip without
 * DATABASE_URL) for `reconstruct` — an Object's `stateAt` plus its AuditRecords up to `at`
 * (docs/development-tasks.md S1.3, item 4).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)('reconstruct (integration, real Postgres)', () => {
  let pool: Pool;
  const store = new SqlGraphStore();
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
          'reconstruct-test-workspace',
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

  it('returns the current object state plus AuditRecords touching it, newest first', async () => {
    const objectId = await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) => {
        const object = await store.upsertObject(client, workspaceId, {
          objectType: 'test.reconstruct-thing',
          properties: { name: 'first' },
        });
        await writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action: 'get_object',
          resourceType: 'object',
          resourceId: object.id,
        });
        await writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action: 'traverse',
          resourceType: 'object',
          resourceId: object.id,
        });
        return object.id;
      },
    );

    const result = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      reconstruct(client, workspaceId, { objectId }),
    );

    expect(result.object?.id).toBe(objectId);
    expect(result.auditRecords).toHaveLength(2);
    expect(result.auditRecords[0]?.action).toBe('traverse'); // newest first
    expect(result.auditRecords[1]?.action).toBe('get_object');
  });

  it('`at` excludes AuditRecords and Facts recorded after it', async () => {
    const { objectId, otherId, t0 } = await withWorkspace(
      pool,
      { workspaceId, principalId: ownerId },
      async (client) => {
        const object = await store.upsertObject(client, workspaceId, {
          objectType: 'test.reconstruct-thing2',
        });
        const other = await store.upsertObject(client, workspaceId, {
          objectType: 'test.reconstruct-thing2',
        });
        await writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action: 'before_cutoff',
          resourceType: 'object',
          resourceId: object.id,
        });
        const t0Result = await client.query<{ now: Date }>('select now()');
        const t0 = t0Result.rows[0]?.now;
        if (!t0) throw new Error('fixture: could not read db now()');
        return { objectId: object.id, otherId: other.id, t0 };
      },
    );

    await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
      const activity = await startActivity(client, workspaceId, {
        kind: 'test.run',
        principalId: ownerId,
      });
      await store.assertFact(
        client,
        workspaceId,
        { id: ownerId, kind: 'human' },
        {
          linkType: 'test.after-cutoff',
          sourceObjectId: objectId,
          targetObjectId: otherId,
          activityId: activity.id,
        },
      );
      await writeAudit(client, {
        workspaceId,
        actorPrincipalId: ownerId,
        action: 'after_cutoff',
        resourceType: 'object',
        resourceId: objectId,
      });
    });

    const result = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      reconstruct(client, workspaceId, { objectId, at: t0 }),
    );

    expect(result.auditRecords.map((r) => r.action)).toEqual(['before_cutoff']);
    expect(result.facts.map((f) => f.linkType)).not.toContain('test.after-cutoff');
  });
});
