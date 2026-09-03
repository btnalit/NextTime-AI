import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  OperationNotFoundError,
  deprecateOperation,
  getOperation,
  getPublishedOperation,
  importManifest,
  publishOperation,
} from './manifest.js';
import { registerGatekeeper } from './registry.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for the Operation manifest
 * registry (design doc §5.1.4/§5.5 draft→published→deprecated, I16/I17; docs/development-tasks.md
 * S2.4). Covers this task's own acceptance note: "draft operation never executes" is
 * `getPublishedOperation` returning `null` for a draft — the caller (request-action-handler.ts)
 * is what turns that into "never execute", exercised end-to-end in
 * application/gateway/request-action.integration.test.ts.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

function testOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    name: `test.op.${randomUUID()}`,
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

describe.runIf(DATABASE_URL !== undefined)('governance/gatekeepers/manifest (integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;
  let gatekeeperId: string;

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

  async function newActivity(): Promise<string> {
    return inTx(async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.manifest', 'running', $2) returning id`,
        [workspaceId, ownerId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('failed to insert test activity');
      return row.id;
    });
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('gatekeeper-manifest-test-workspace');
    ownerId = await adminInsertPrincipal('owner');
    const act = await newActivity();
    const result = await inTx((client) =>
      registerGatekeeper(client, workspaceId, {
        name: 'manifest-test-gate',
        transportKind: 'http',
        target: 'example-system',
        endpoint: 'https://gate.example.invalid',
        activityId: act,
        registeredBy: { id: ownerId, kind: 'human' },
      }),
    );
    gatekeeperId = result.gatekeeperId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('importManifest creates draft Operations invisible to getPublishedOperation', async () => {
    const op = testOperation({ name: `stock.get.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );

    const draft = await inTx((client) => getOperation(client, workspaceId, gatekeeperId, op.name));
    expect(draft?.status).toBe('draft');
    expect(draft?.operation.mode).toBe('observe');

    const published = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
    );
    expect(published).toBeNull();
  });

  it('unknown Operation name resolves to null (I17 "unclassified")', async () => {
    const published = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, 'does.not.exist'),
    );
    expect(published).toBeNull();
  });

  it('publishOperation moves draft -> published, then getPublishedOperation finds it', async () => {
    const op = testOperation({ name: `stock.list.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );

    const published = await inTx((client) =>
      publishOperation(client, workspaceId, { gatekeeperId, name: op.name }),
    );
    expect(published.status).toBe('published');

    const record = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
    );
    expect(record?.status).toBe('published');
    expect(record?.operation.name).toBe(op.name);
  });

  it('publishing an already-published Operation throws IllegalTransition', async () => {
    const op = testOperation({ name: `stock.twice.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );
    await inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: op.name }));
    await expect(
      inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: op.name })),
    ).rejects.toThrow(IllegalTransition);
  });

  it('publishing an unknown Operation throws OperationNotFoundError', async () => {
    await expect(
      inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: 'nope' })),
    ).rejects.toThrow(OperationNotFoundError);
  });

  it('deprecateOperation moves published -> deprecated; getPublishedOperation then returns null', async () => {
    const op = testOperation({ name: `stock.deprecate.${randomUUID()}` });
    const act = await newActivity();
    await inTx((client) =>
      importManifest(client, workspaceId, {
        gatekeeperId,
        operations: [op],
        proposedBy: { id: ownerId, kind: 'human' },
        activityId: act,
      }),
    );
    await inTx((client) => publishOperation(client, workspaceId, { gatekeeperId, name: op.name }));
    const deprecated = await inTx((client) =>
      deprecateOperation(client, workspaceId, { gatekeeperId, name: op.name }),
    );
    expect(deprecated.status).toBe('deprecated');

    const record = await inTx((client) =>
      getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
    );
    expect(record).toBeNull();
  });
});
