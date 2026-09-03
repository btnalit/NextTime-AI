import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { startActivity } from '../epistemic/index.js';
import { SqlGraphStore } from '../graph/index.js';
import { projectWorkerDefinitionObject, registerGatekeeperObject } from './meta-objects.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL — same pattern as
 * substrate/graph/sql-store.test.ts) for the platform meta-ontology's Object-projection helpers.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(DATABASE_URL !== undefined)('meta-objects (integration)', () => {
  let pool: Pool;
  const graphStore = new SqlGraphStore();

  let workspaceId: string;
  let ownerId: string;

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

  async function adminInsertPrincipal(displayName: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', $3)",
          [workspaceId, id, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('meta-objects-test-workspace');
    ownerId = await adminInsertPrincipal('owner');
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('projectWorkerDefinitionObject', () => {
    it('creates a WorkerDefinition Object with the (definitionId, version) identity', async () => {
      const definitionId = randomUUID();
      const object = await inTx((client) =>
        projectWorkerDefinitionObject(client, workspaceId, {
          definitionId,
          version: 1,
          kind: 'entry',
        }),
      );

      expect(object.objectType).toBe('WorkerDefinition');
      expect(object.properties).toMatchObject({ kind: 'entry' });
    });

    it('is idempotent — re-projecting the same (definitionId, version) upserts the same Object', async () => {
      const definitionId = randomUUID();
      const first = await inTx((client) =>
        projectWorkerDefinitionObject(client, workspaceId, {
          definitionId,
          version: 1,
          kind: 'worker',
        }),
      );
      const second = await inTx((client) =>
        projectWorkerDefinitionObject(client, workspaceId, {
          definitionId,
          version: 1,
          kind: 'worker',
        }),
      );

      expect(second.id).toBe(first.id);
    });

    it('a different version of the same definitionId is a distinct Object', async () => {
      const definitionId = randomUUID();
      const v1 = await inTx((client) =>
        projectWorkerDefinitionObject(client, workspaceId, {
          definitionId,
          version: 1,
          kind: 'entry',
        }),
      );
      const v2 = await inTx((client) =>
        projectWorkerDefinitionObject(client, workspaceId, {
          definitionId,
          version: 2,
          kind: 'entry',
        }),
      );

      expect(v2.id).not.toBe(v1.id);
    });
  });

  describe('registerGatekeeperObject', () => {
    it('creates a Gatekeeper Object and a connects_to Fact to the system object', async () => {
      const { systemObjectId, activityId } = await inTx(async (client) => {
        const systemObject = await graphStore.upsertObject(client, workspaceId, {
          objectType: 'test.system',
          properties: { name: 'example-system' },
        });
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        return { systemObjectId: systemObject.id, activityId: activity.id };
      });

      const result = await inTx((client) =>
        registerGatekeeperObject(client, workspaceId, {
          transportKind: 'http',
          target: 'https://example.invalid',
          systemObjectId,
          activityId,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );

      expect(result.gatekeeperObjectId).toBeTruthy();
      expect(result.connectsToFactId).toBeTruthy();

      const fact = await inTx(async (client) => {
        const facts = await graphStore.neighbors(client, workspaceId, {
          objectId: result.gatekeeperObjectId,
          direction: 'out',
          linkType: 'connects_to',
        });
        return facts[0];
      });

      expect(fact?.linkType).toBe('connects_to');
      expect(fact?.targetObjectId).toBe(systemObjectId);
      // human caller -> asserted (design doc §5.6 / substrate/graph/store.ts deriveEpistemicStatus)
      expect(fact?.epistemicStatus).toBe('asserted');
    });

    it('is idempotent by gatekeeperId — re-registering the same id upserts the same Object', async () => {
      const gatekeeperId = randomUUID();
      const { systemObjectId, activityId } = await inTx(async (client) => {
        const systemObject = await graphStore.upsertObject(client, workspaceId, {
          objectType: 'test.system',
          properties: {},
        });
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        return { systemObjectId: systemObject.id, activityId: activity.id };
      });

      const first = await inTx((client) =>
        registerGatekeeperObject(client, workspaceId, {
          gatekeeperId,
          transportKind: 'ssh',
          target: 'example-host',
          systemObjectId,
          activityId,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      const second = await inTx((client) =>
        registerGatekeeperObject(client, workspaceId, {
          gatekeeperId,
          transportKind: 'ssh',
          target: 'example-host',
          systemObjectId,
          activityId,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );

      expect(second.gatekeeperObjectId).toBe(first.gatekeeperObjectId);
    });
  });
});
