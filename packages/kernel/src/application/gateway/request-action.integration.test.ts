import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  InMemoryIdempotencyStore,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
import type { Transport, TransportInvokeResult } from '@nexttime/gatekeeper-base';
import type { Operation, Role } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HttpGatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import {
  ApprovalDrainer,
  approveActionRequest,
  getActionRequest,
} from '../../governance/approval/index.js';
import { importManifest, publishOperation } from '../../governance/gatekeepers/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import type { WithTransactionFn } from './action-executor.js';
import { createGatekeeperActionExecutor } from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres + a real fake Gatekeeper HTTP server; auto-skip without
 * DATABASE_URL) for `request_action` end-to-end (design doc §5.1.4/§7.4/§8.1; docs/development-
 * tasks.md S2.4 acceptance): observe path writes an observed Fact; execute path with auto-approve
 * executes once; execute path pending → approve → drainer executes exactly once (idempotent on
 * re-drain); unclassified operation → require_approval; draft operation never executes.
 *
 * The fake Gatekeeper is a *real* `@nexttime/gatekeeper-base` `GatekeeperBase` + Fastify server,
 * listening on a real local port, with a fake `Transport` recording invocation counts — this
 * exercises the actual HTTP wire (adapters/gatekeeper-client ⇄ gatekeeper-base/server.ts), not
 * just an in-process fake of the client port.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role = 'owner',
): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

class RecordingTransport implements Transport {
  readonly kind = 'http' as const;
  readonly calls: Record<string, number> = {};

  async invoke(operation: Operation, params: unknown): Promise<TransportInvokeResult> {
    this.calls[operation.name] = (this.calls[operation.name] ?? 0) + 1;
    if (operation.name === 'observe.stock') {
      return { data: { items: [{ sku: 'X1', qty: 7 }] } };
    }
    return { data: { ok: true, operation: operation.name, params } };
  }
}

const OBSERVE_OP: Operation = {
  name: 'observe.stock',
  binding: { kind: 'http', method: 'GET', path: '/stock' },
  params_schema: {},
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
  result_mapping: {
    jmes_path: 'items[]',
    object_type: 'test.Stock',
    identity_keys: ['sku'],
    attributes: { quantity: 'qty' },
  },
};

const AUTO_OP: Operation = {
  name: 'auto.op',
  binding: { kind: 'http', method: 'POST', path: '/auto' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

const PENDING_OP: Operation = {
  name: 'pending.op',
  binding: { kind: 'http', method: 'POST', path: '/pending' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: false,
  await_decision: true,
  reads: [],
  writes: [],
};

const DRAFT_OP: Operation = {
  name: 'draft.op',
  binding: { kind: 'http', method: 'POST', path: '/draft' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

describe.runIf(DATABASE_URL !== undefined)(
  'request_action (integration, real Postgres + fake gate)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;
    let fakeGateApp: FastifyInstance;
    let transport: RecordingTransport;
    let drainer: ApprovalDrainer;
    let adminWithTransaction: WithTransactionFn;

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

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('request-action-test-workspace');
      ownerId = await adminInsertPrincipal('owner');

      transport = new RecordingTransport();
      const gate = new GatekeeperBase({
        manifest: [OBSERVE_OP, AUTO_OP, PENDING_OP, DRAFT_OP],
        transport,
        credentialResolver: { resolve: async () => ({}) },
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      fakeGateApp = createGatekeeperServer({ gate });
      await fakeGateApp.listen({ port: 0, host: '127.0.0.1' });
      const address = fakeGateApp.server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'test-gate',
          transportKind: 'http',
          target: 'example-system',
          endpoint,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        gatekeeperId = registered.gatekeeperId;

        await importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [OBSERVE_OP, AUTO_OP, PENDING_OP, DRAFT_OP],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, workspaceId, { gatekeeperId, name: OBSERVE_OP.name });
        await publishOperation(client, workspaceId, { gatekeeperId, name: AUTO_OP.name });
        await publishOperation(client, workspaceId, { gatekeeperId, name: PENDING_OP.name });
        // DRAFT_OP is deliberately never published.
      });

      setRequestActionDeps({
        gatekeeperClient: new HttpGatekeeperClient(),
        awaitDecisionTimeoutMs: 300,
      });

      adminWithTransaction = (ws, principalId, fn) =>
        withWorkspace(pool, { workspaceId: ws, principalId }, fn, { skipRoleSwitch: true });
      drainer = new ApprovalDrainer({
        executor: createGatekeeperActionExecutor({
          gatekeeperClient: new HttpGatekeeperClient(),
          withTransaction: adminWithTransaction,
        }),
        withTransaction: adminWithTransaction,
      });
    });

    afterAll(async () => {
      await fakeGateApp.close();
      await pool.end();
    });

    it('observe path calls the gate and writes an observed Fact', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: 'observe.stock',
        params: {},
      })) as { status: string; data: unknown; observedFactCount: number };

      expect(result.status).toBe('ok');
      expect(result.observedFactCount).toBe(1);

      const graphStore = new SqlGraphStore();
      const facts = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        graphStore.neighbors(client, workspaceId, {
          objectId: gatekeeperId,
          direction: 'out',
          linkType: 'observed',
        }),
      );
      expect(facts.length).toBeGreaterThanOrEqual(1);
      expect(facts[0]?.epistemicStatus).toBe('observed');
    });

    it('execute path with auto-approve executes once', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[AUTO_OP.name] ?? 0;

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { qty: 1 },
      })) as { status: string; actionRequestId: string; data?: unknown };

      expect(result.status).toBe('executed');
      expect(transport.calls[AUTO_OP.name]).toBe(before + 1);
    });

    // Ordering note: this test must run before the "unclassified"/"draft" tests below, which each
    // leave a permanently-`pending_approval` row on this same gatekeeper's queue. `drainGatekeeper`
    // processes `listExecutableQueue`'s rows in `requested_at` order and stops at the first
    // `pending_approval` row it reaches (§8.1 "遇 pending 停") — an earlier-requested stray pending
    // row would make the drain below stop before ever reaching this test's own (now `approved`)
    // row. Vitest runs `it()` blocks within one file in declaration order by default (no
    // `.concurrent`/shuffle configured, packages/kernel/vitest.config.ts), so this is deterministic.
    it('execute path pending → approve → drainer executes exactly once (idempotent on re-drain)', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[PENDING_OP.name] ?? 0;

      const pendingResult = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: PENDING_OP.name,
        params: { qty: 2 },
      })) as { status: string; actionRequestId: string };
      expect(pendingResult.status).toBe('pending_approval');

      const actionRequestId = pendingResult.actionRequestId;
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );

      await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId); // re-drain — must not double-execute

      expect(transport.calls[PENDING_OP.name]).toBe(before + 1);

      const finalRow = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, actionRequestId),
      );
      expect(finalRow?.status).toBe('executed');
    });

    it('an unclassified (unimported) operation → require_approval, never executes', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: 'totally.unknown.op',
        params: {},
      })) as { status: string; actionRequestId: string };
      expect(result.status).toBe('pending_approval');

      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, result.actionRequestId),
      );
      expect(row?.blastRadius).toBe('medium');
      expect(row?.status).toBe('pending_approval');
    });

    it('a draft (unpublished) operation never executes, even though its own manifest entry declares auto_approvable', async () => {
      const caller = humanCaller(workspaceId, ownerId);
      const before = transport.calls[DRAFT_OP.name] ?? 0;

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: DRAFT_OP.name,
        params: {},
      })) as { status: string; actionRequestId: string };

      expect(result.status).toBe('pending_approval');
      expect(transport.calls[DRAFT_OP.name] ?? 0).toBe(before); // never invoked
    });
  },
);
