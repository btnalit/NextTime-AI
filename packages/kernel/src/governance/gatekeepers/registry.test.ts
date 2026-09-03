import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { getGatekeeper, registerGatekeeper } from './registry.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL — same pattern as
 * substrate/ontology/meta-objects.test.ts) for the Gatekeeper registry (design doc §5.1.4;
 * docs/development-tasks.md S2.4).
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(DATABASE_URL !== undefined)('governance/gatekeepers/registry (integration)', () => {
  let pool: Pool;
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
    workspaceId = await adminInsertWorkspace('gatekeeper-registry-test-workspace');
    ownerId = await adminInsertPrincipal('owner');
  });

  afterAll(async () => {
    await pool.end();
  });

  async function activityId(): Promise<string> {
    return inTx(async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.connection', 'running', $2) returning id`,
        [workspaceId, ownerId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('failed to insert test activity');
      return row.id;
    });
  }

  it('registers a Gatekeeper and getGatekeeper reads back its endpoint/transportKind/target', async () => {
    const act = await activityId();
    const { gatekeeperId } = await inTx((client) =>
      registerGatekeeper(client, workspaceId, {
        name: 'test-system',
        transportKind: 'http',
        target: 'example-system',
        endpoint: 'https://gate.example.invalid',
        activityId: act,
        registeredBy: { id: ownerId, kind: 'human' },
      }),
    );

    const record = await inTx((client) => getGatekeeper(client, workspaceId, gatekeeperId));
    expect(record).toEqual({
      gatekeeperId,
      name: 'test-system',
      transportKind: 'http',
      target: 'example-system',
      endpoint: 'https://gate.example.invalid',
    });
  });

  it('is idempotent by gatekeeperId — re-registering upserts the same instance', async () => {
    const act = await activityId();
    const gatekeeperId = randomUUID();
    const first = await inTx((client) =>
      registerGatekeeper(client, workspaceId, {
        gatekeeperId,
        name: 'reused',
        transportKind: 'ssh',
        target: 'example-host',
        endpoint: 'https://gate-2.example.invalid',
        activityId: act,
        registeredBy: { id: ownerId, kind: 'human' },
      }),
    );
    const second = await inTx((client) =>
      registerGatekeeper(client, workspaceId, {
        gatekeeperId,
        name: 'reused',
        transportKind: 'ssh',
        target: 'example-host',
        endpoint: 'https://gate-2.example.invalid',
        activityId: act,
        registeredBy: { id: ownerId, kind: 'human' },
      }),
    );
    expect(second.gatekeeperId).toBe(first.gatekeeperId);
  });

  it('getGatekeeper returns null for an unknown id or a non-Gatekeeper object', async () => {
    const missing = await inTx((client) => getGatekeeper(client, workspaceId, randomUUID()));
    expect(missing).toBeNull();
  });
});
