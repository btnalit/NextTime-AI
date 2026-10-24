import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  HttpTransport,
  InMemoryIdempotencyStore,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  GatekeeperClientError,
  HttpGatekeeperClient,
  deriveConnectionSecret,
} from '../../adapters/gatekeeper-client/index.js';
import { createOutboundTargetGuard } from '../../adapters/outbound-target/index.js';
import { ApprovalDrainer } from '../../governance/approval/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * gate-absence.integration.test (S11 「门确认不存在」 A): an observe Operation declares which of
 * the target's own answers mean "it has no such thing"; the whole path — a real target system, a
 * real `@nexttime/gatekeeper-base` gate over its http transport, the kernel's `observe_operation` —
 * answers such a call `absent`, and only such a call:
 *
 *   - the target's declared 404 → `absent: { status: 404 }`, `data: null`, no Facts, audited;
 *   - a 200 whose body says it is absent → an ordinary result: a target's body can never say so;
 *   - an undeclared status → the call fails, as before;
 *   - a gate that states an absence the published definition does not declare → refused.
 *
 * DB-gated (real Postgres; auto-skip without DATABASE_URL).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const GATE_TEST_TOKEN = 'gate-absence-integration-test-token-0123456789abcdef0123';
const GATE_CONNECTION_SALT = 'a'.repeat(32);

const RECORD_GET: Operation = {
  name: 'record.get',
  binding: { kind: 'http', method: 'GET', path: '/records/{id}', absent_statuses: [404] },
  params_schema: {
    type: 'object',
    properties: { id: { type: 'string', 'x-in': 'path' } },
    required: ['id'],
  },
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: ['Record'],
  writes: [],
  result_mapping: { jmes_path: '@', object_type: 'test.Record', identity_keys: ['id'] },
};

/** The same call with no declaration: the gate that runs it is the lying gate below. */
const RECORD_PEEK: Operation = {
  ...RECORD_GET,
  name: 'record.peek',
  binding: { kind: 'http', method: 'GET', path: '/records/{id}' },
  result_mapping: undefined,
};

function ownerCaller(workspaceId: string, principalId: string): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role: 'owner', displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      expiresAt: new Date(Date.now() + 60_000),
    },
  } as ResolvedCaller;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe.runIf(DATABASE_URL !== undefined)(
  'gate-confirmed absence end to end (S11 「门确认不存在」 A)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;
    let lyingGatekeeperId: string;
    let target: http.Server;
    let lyingGate: http.Server;
    let gateApp: FastifyInstance;

    async function admin<T>(fn: Parameters<typeof withWorkspace<T>>[2]): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function register(name: string, endpoint: string, operations: Operation[]) {
      return admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: 'example-records',
          endpoint,
          connectionSecretSalt: GATE_CONNECTION_SALT,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        await importManifest(client, workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          operations,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        for (const operation of operations) {
          await publishOperation(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            name: operation.name,
          });
        }
        return registered.gatekeeperId;
      });
    }

    const observe = (gate: string, operation: string, id: string) =>
      dispatchCapability({ pool }, ownerCaller(workspaceId, ownerId), 'observe_operation', {
        gatekeeperId: gate,
        operation,
        params: { id },
      });

    async function auditPayloads(): Promise<Record<string, unknown>[]> {
      const rows = await admin((client) =>
        queryAudit(client, workspaceId, {
          action: 'observe_operation',
          resourceType: 'gatekeeper',
          resourceId: gatekeeperId,
          limit: 100,
        }),
      );
      return rows.map((row) => row.payload as Record<string, unknown>);
    }

    async function factCount(): Promise<number> {
      const rows = await admin((client) =>
        client.query<{ n: number }>(
          "select count(*)::int as n from objects where workspace_id = $1 and object_type = 'test.Record'",
          [workspaceId],
        ),
      );
      return rows.rows[0]?.n ?? 0;
    }

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
            'gate-absence-integration-test',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );

      // The target system: one record is missing (its 404 body claims otherwise), one record's
      // body claims to be absent, one is gone (410).
      target = http.createServer((request, response) => {
        const id = request.url?.split('/').pop();
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (id === 'missing') return send(404, { id: 'missing', found: true });
        if (id === 'gone') return send(410, { id: 'gone' });
        if (id === 'forged') return send(200, { id: 'forged', absent: { status: 404 } });
        return send(200, { id });
      });
      const targetUrl = await listen(target);

      const gate = new GatekeeperBase({
        manifest: [RECORD_GET],
        transport: new HttpTransport({ baseUrl: targetUrl }),
        credentialResolver: { resolve: async () => ({}) },
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      gateApp = createGatekeeperServer({
        gate,
        token: deriveConnectionSecret(GATE_TEST_TOKEN, workspaceId, GATE_CONNECTION_SALT),
      });
      await gateApp.listen({ port: 0, host: '127.0.0.1' });
      const gateUrl = `http://127.0.0.1:${(gateApp.server.address() as AddressInfo).port}`;

      // A gate that says absent for an Operation whose published definition declares nothing.
      lyingGate = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: true,
            result: { data: null, observedFacts: [], absent: { status: 404 } },
          }),
        );
      });
      const lyingUrl = await listen(lyingGate);

      gatekeeperId = await register('records-gate', gateUrl, [RECORD_GET]);
      lyingGatekeeperId = await register('lying-records-gate', lyingUrl, [RECORD_PEEK]);

      const gatekeeperClient = new HttpGatekeeperClient({
        token: GATE_TEST_TOKEN,
        outboundTargetGuard: createOutboundTargetGuard({
          policy: { platformSubnets: [], allowHosts: ['127.0.0.1'] },
        }),
      });
      const adminWithTransaction = createAdminWithTransaction(pool);
      setRequestActionDeps({
        gatekeeperClient,
        drainer: new ApprovalDrainer({
          executor: createGatekeeperActionExecutor({
            gatekeeperClient,
            withTransaction: adminWithTransaction,
          }),
          withTransaction: adminWithTransaction,
        }),
        awaitDecisionTimeoutMs: 800,
      });
    });

    afterAll(async () => {
      await gateApp?.close();
      await new Promise((resolve) => target?.close(resolve));
      await new Promise((resolve) => lyingGate?.close(resolve));
      await pool?.end();
    });

    it('the catalog lists the declaration with the Operation, and nothing for one that has none', async () => {
      const listed = (await dispatchCapability(
        { pool },
        ownerCaller(workspaceId, ownerId),
        'list_operations',
        {},
      )) as { items: Array<{ name: string; absentAnswers?: unknown }> };
      const byName = new Map(listed.items.map((item) => [item.name, item]));
      expect(byName.get(RECORD_GET.name)?.absentAnswers).toEqual({ statuses: [404] });
      expect(byName.get(RECORD_PEEK.name)).not.toHaveProperty('absentAnswers');
    });

    it('the target’s declared 404 answers absent: no data, no Facts, and the audit row says so', async () => {
      const before = await factCount();
      expect(await observe(gatekeeperId, RECORD_GET.name, 'missing')).toEqual({
        status: 'ok',
        data: null,
        observedFactCount: 0,
        absent: { status: 404 },
      });
      expect(await factCount()).toBe(before);
      expect((await auditPayloads()).filter((payload) => 'absent' in payload)).toEqual([
        expect.objectContaining({ absent: { status: 404 } }),
      ]);
    });

    it('a body that says it is absent is an ordinary result: a target cannot forge an absence', async () => {
      const before = await factCount();
      const result = await observe(gatekeeperId, RECORD_GET.name, 'forged');
      expect(result).toEqual({
        status: 'ok',
        data: { id: 'forged', absent: { status: 404 } },
        observedFactCount: 1,
      });
      expect(await factCount()).toBe(before + 1);
      expect((await auditPayloads()).filter((payload) => 'absent' in payload)).toHaveLength(1);
    });

    it('an answer the Operation does not declare stays a failed call', async () => {
      await expect(observe(gatekeeperId, RECORD_GET.name, 'gone')).rejects.toMatchObject({
        code: 'transport_error',
      });
    });

    it('a gate that states an absence the published definition does not declare is refused', async () => {
      const err = await observe(lyingGatekeeperId, RECORD_PEEK.name, 'missing').then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(err).toBeInstanceOf(GatekeeperClientError);
      expect(err).toMatchObject({ code: 'invalid_response' });
      expect((err as Error).message).toMatch(/does not declare/);
    });
  },
);
