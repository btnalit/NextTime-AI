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
import { queryAudit, writeAudit } from './writer.js';

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
    const objectId = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      store
        .upsertObject(client, workspaceId, {
          objectType: 'test.reconstruct-thing',
          properties: { name: 'first' },
        })
        .then((object) => object.id),
    );

    // Two separate transactions (like two separate capability calls) rather than two writeAudit
    // calls in one transaction — Postgres's `now()` is stable for the lifetime of a transaction,
    // so same-transaction writes would tie on `created_at` and "newest first" would be undefined.
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      writeAudit(client, {
        workspaceId,
        actorPrincipalId: ownerId,
        action: 'get_object',
        resourceType: 'object',
        resourceId: objectId,
      }),
    );
    await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      writeAudit(client, {
        workspaceId,
        actorPrincipalId: ownerId,
        action: 'traverse',
        resourceType: 'object',
        resourceId: objectId,
      }),
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

  it('legacy 291: the action set and the time cutoff narrow the query, so newer rows of other actions never take the slots', async () => {
    const resourceId = randomUUID();
    const write = (action: string) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action,
          resourceType: 'action_request',
          resourceId,
        }),
      );
    await write('action_request.complete');
    // One audited `get_action` poll per transaction — more than any small page would hold.
    for (let i = 0; i < 12; i += 1) await write('get_action');

    const [terminal] = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      queryAudit(client, workspaceId, {
        resourceId,
        actions: ['action_request.complete', 'action_request.fail'],
        limit: 1,
      }),
    );
    expect(terminal?.action).toBe('action_request.complete');

    const cutoff = terminal?.createdAt;
    if (!cutoff) throw new Error('terminal row missing');
    const upToCutoff = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
      queryAudit(client, workspaceId, { resourceId, createdAtOrBefore: cutoff, limit: 1 }),
    );
    expect(upToCutoff.map((r) => r.action)).toEqual(['action_request.complete']);
  });
});
