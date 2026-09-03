import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition, type Operation } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { getGrant } from '../capability/index.js';
import { getGatekeeper, getOperation } from '../gatekeepers/index.js';
import {
  GatekeeperNotFoundError,
  completeConnection,
  connectGatekeeper,
  getConnectionRequest,
  listConnectionRequests,
  requestConnection,
} from './service.js';

/**
 * governance/connections/service integration tests (real Postgres; auto-skip without
 * DATABASE_URL — same pattern as governance/gatekeepers/registry.test.ts). Covers the
 * ConnectionRequest state machine (`requested → completed`, I6) and `connectGatekeeper`'s Grant
 * shape; the fuller end-to-end (`create_connection` handler, credential redaction/never-persisted,
 * `find_operations` visibility) is application/gateway/connection-flow.integration.test.ts.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

const SAMPLE_OBSERVE_OP: Operation = {
  name: 'stock.get',
  binding: { kind: 'http', method: 'GET', path: '/stocks' },
  params_schema: {},
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

describe.runIf(DATABASE_URL !== undefined)('governance/connections/service (integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let ownerId: string;
  let memberId: string;

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

  async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
          [workspaceId, id, 'human', role, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
  }

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

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    workspaceId = await adminInsertWorkspace('connections-service-test-workspace');
    ownerId = await adminInsertPrincipal('owner', 'owner');
    memberId = await adminInsertPrincipal('member', 'member');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('requestConnection inserts a `requested` row readable via getConnectionRequest', async () => {
    const row = await inTx((client) =>
      requestConnection(client, workspaceId, {
        kind: 'ssh',
        target: 'example-host',
        requestedBy: { id: memberId, kind: 'human' },
      }),
    );
    expect(row.status).toBe('requested');
    expect(row.requestedBy).toBe(memberId);
    expect(row.gatekeeperId).toBeNull();
    expect(row.completedAt).toBeNull();

    const reread = await inTx((client) => getConnectionRequest(client, workspaceId, row.id));
    expect(reread).toEqual(row);
  });

  it('completeConnection with no connectionRequestId registers the gate and imports drafts (owner-direct path)', async () => {
    const act = await activityId();
    const result = await inTx((client) =>
      completeConnection(client, workspaceId, {
        kind: 'http',
        target: 'example-system',
        endpoint: 'https://gate.example.invalid',
        operations: [SAMPLE_OBSERVE_OP],
        activityId: act,
        completedBy: { id: ownerId, kind: 'human' },
      }),
    );
    expect(result.connectionRequest).toBeNull();
    expect(result.importedOperationNames).toEqual(['stock.get']);

    const gate = await inTx((client) => getGatekeeper(client, workspaceId, result.gatekeeperId));
    expect(gate?.endpoint).toBe('https://gate.example.invalid');

    const operation = await inTx((client) =>
      getOperation(client, workspaceId, result.gatekeeperId, 'stock.get'),
    );
    // I17: freshly imported Operations are always drafts, regardless of what the transport
    // suggested for SAMPLE_OBSERVE_OP's own auto_approvable/mode fields.
    expect(operation?.status).toBe('draft');
  });

  it('completeConnection with a connectionRequestId transitions requested → completed (I6), and a second call is IllegalTransition', async () => {
    const requested = await inTx((client) =>
      requestConnection(client, workspaceId, {
        kind: 'http',
        target: 'example-system-2',
        requestedBy: { id: memberId, kind: 'human' },
      }),
    );

    const act = await activityId();
    const result = await inTx((client) =>
      completeConnection(client, workspaceId, {
        connectionRequestId: requested.id,
        kind: 'http',
        target: 'example-system-2',
        endpoint: 'https://gate-2.example.invalid',
        operations: [],
        activityId: act,
        completedBy: { id: ownerId, kind: 'human' },
      }),
    );
    expect(result.connectionRequest?.status).toBe('completed');
    expect(result.connectionRequest?.gatekeeperId).toBe(result.gatekeeperId);
    expect(result.connectionRequest?.completedBy).toBe(ownerId);
    expect(result.connectionRequest?.completedAt).not.toBeNull();

    const act2 = await activityId();
    await expect(
      inTx((client) =>
        completeConnection(client, workspaceId, {
          connectionRequestId: requested.id,
          kind: 'http',
          target: 'example-system-2',
          endpoint: 'https://gate-2.example.invalid',
          operations: [],
          activityId: act2,
          completedBy: { id: ownerId, kind: 'human' },
        }),
      ),
    ).rejects.toBeInstanceOf(IllegalTransition);
  });

  it('completeConnection with an unknown connectionRequestId throws ConnectionRequestNotFoundError', async () => {
    const act = await activityId();
    await expect(
      inTx((client) =>
        completeConnection(client, workspaceId, {
          connectionRequestId: randomUUID(),
          kind: 'http',
          target: 'x',
          endpoint: 'https://gate.example.invalid',
          operations: [],
          activityId: act,
          completedBy: { id: ownerId, kind: 'human' },
        }),
      ),
    ).rejects.toThrow(/ConnectionRequest not found/);
  });

  it('listConnectionRequests filters by status', async () => {
    const requestedOnly = await inTx((client) =>
      listConnectionRequests(client, workspaceId, { status: 'requested' }),
    );
    expect(requestedOnly.every((row) => row.status === 'requested')).toBe(true);

    const completedOnly = await inTx((client) =>
      listConnectionRequests(client, workspaceId, { status: 'completed' }),
    );
    expect(completedOnly.length).toBeGreaterThan(0);
    expect(completedOnly.every((row) => row.status === 'completed')).toBe(true);
  });

  it('connectGatekeeper writes a CapabilityGrant scoped to one gatekeeperId', async () => {
    const act = await activityId();
    const { gatekeeperId } = await inTx((client) =>
      completeConnection(client, workspaceId, {
        kind: 'http',
        target: 'example-system-3',
        endpoint: 'https://gate-3.example.invalid',
        operations: [],
        activityId: act,
        completedBy: { id: ownerId, kind: 'human' },
      }),
    );

    const grant = await inTx((client) =>
      connectGatekeeper(client, workspaceId, {
        gatekeeperId,
        principalId: memberId,
        grantedBy: ownerId,
      }),
    );
    expect(grant.principalId).toBe(memberId);
    expect(grant.capability).toBe('gatekeeper');
    expect(grant.scope.resourceScope).toBe(gatekeeperId);
    expect(grant.status).toBe('active');

    const reread = await inTx((client) => getGrant(client, workspaceId, grant.id));
    expect(reread).toEqual(grant);
  });

  it('connectGatekeeper throws GatekeeperNotFoundError for an unregistered id', async () => {
    await expect(
      inTx((client) =>
        connectGatekeeper(client, workspaceId, {
          gatekeeperId: randomUUID(),
          principalId: memberId,
          grantedBy: ownerId,
        }),
      ),
    ).rejects.toBeInstanceOf(GatekeeperNotFoundError);
  });
});
