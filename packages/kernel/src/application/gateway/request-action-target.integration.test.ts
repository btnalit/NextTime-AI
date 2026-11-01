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
import type { Operation } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  HttpGatekeeperClient,
  deriveConnectionSecret,
} from '../../adapters/gatekeeper-client/index.js';
import { createOutboundTargetGuard } from '../../adapters/outbound-target/index.js';
import {
  ApprovalDrainer,
  approveActionRequest,
  getActionRequest,
  rejectActionRequest,
} from '../../governance/approval/index.js';
import {
  importManifest,
  proposeOperation,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * S11 GO12 (I-Q1 / I-Q2 / I-Q3) through `request_action` — real Postgres and a real
 * `@nexttime/gatekeeper-base` gate on a local port, like request-action.integration.test.ts, on a
 * Gatekeeper of its own so its queue holds only these rows:
 *   - a request records the instance its *published* version declares, from its own params; a
 *     draft's (I17), or one whose param is not of its schema type, records none — the whole gate;
 *   - on one gate, a request awaiting approval holds back the calls on its instance and every
 *     call on the whole gate, never a call on another instance — which runs at once;
 *   - why each waits (`queuedBehind.scope`) is what the console reads;
 *   - a revision published later changes no request already made (I-Q2).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const GATE_TEST_TOKEN = 'gate-target-test-token-0123456789abcdef0123';
const GATE_CONNECTION_SALT = 'f'.repeat(32);
const ALLOW_LOOPBACK = createOutboundTargetGuard({
  policy: { platformSubnets: [], allowHosts: ['127.0.0.1'] },
});

/** An execute-class call on one Container, named by its required string param `id`. */
function onContainer(name: string, overrides: Partial<Operation> = {}): Operation {
  return {
    name,
    binding: { kind: 'http', method: 'POST', path: `/${name}` },
    params_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    mode: 'execute',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: ['Container'],
    target: { object_type: 'Container', params: ['id'] },
    ...overrides,
  };
}

const RESTART = onContainer('container.restart');
/** Waits for a person: not auto-approvable, and the caller does not wait for the decision. */
const REPAIR = onContainer('container.repair', { blast_radius: 'medium', auto_approvable: false });
/** Declares no target: acts on the whole gate, as every call did before GO12. */
const PRUNE: Operation = {
  ...onContainer('system.prune'),
  params_schema: {},
  writes: [],
  target: undefined,
};
/** Declares a target, but is never published: a call on it is I17's, on the whole gate. */
const DRAFT_STOP = onContainer('container.stop');

class CountingTransport implements Transport {
  readonly kind = 'http' as const;
  readonly calls: string[] = [];
  async invoke(operation: Operation, params: unknown): Promise<TransportInvokeResult> {
    this.calls.push(`${operation.name}:${(params as { id?: unknown }).id ?? '-'}`);
    return { data: { ok: true } };
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'request_action ordered by target (S11 GO12, integration)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;
    let gateApp: FastifyInstance;
    let drainer: ApprovalDrainer;
    const transport = new CountingTransport();

    function owner(): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: ownerId, kind: 'human', role: 'owner', displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: ownerId,
          kind: 'web',
          onBehalfOf: ownerId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    async function request(operation: string, params: Record<string, unknown>) {
      return (await dispatchCapability({ pool }, owner(), 'request_action', {
        gatekeeperId,
        operation,
        params,
        idempotencyKey: randomUUID(),
      })) as { id: string; status: string };
    }

    async function row(id: string) {
      const found = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, id),
      );
      if (!found) throw new Error(`action request ${id} not found`);
      return found;
    }

    /** `list_action_requests` as the console reads it: each row's status and what it waits for. */
    async function waiting(): Promise<Map<string, { status: string; queuedBehind: unknown }>> {
      const listed = (await dispatchCapability({ pool }, owner(), 'list_action_requests', {
        gatekeeperId,
      })) as { items: { id: string; status: string; queuedBehind?: unknown }[] };
      return new Map(
        listed.items.map((item) => [
          item.id,
          { status: item.status, queuedBehind: item.queuedBehind ?? null },
        ]),
      );
    }

    async function decide(id: string, decision: 'approve' | 'reject') {
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        (decision === 'approve' ? approveActionRequest : rejectActionRequest)(client, workspaceId, {
          actionRequestId: id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
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
            'request-action-target-test',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );

      const manifest = [RESTART, REPAIR, PRUNE, DRAFT_STOP];
      gateApp = createGatekeeperServer({
        gate: new GatekeeperBase({
          manifest,
          transport,
          credentialResolver: { resolve: async () => ({}) },
          idempotencyStore: new InMemoryIdempotencyStore(),
        }),
        token: deriveConnectionSecret(GATE_TEST_TOKEN, workspaceId, GATE_CONNECTION_SALT),
      });
      await gateApp.listen({ port: 0, host: '127.0.0.1' });
      const endpoint = `http://127.0.0.1:${(gateApp.server.address() as AddressInfo).port}`;

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        ({ gatekeeperId } = await registerGatekeeper(client, workspaceId, {
          name: 'target-test-gate',
          transportKind: 'http',
          target: 'example-containers',
          endpoint,
          connectionSecretSalt: GATE_CONNECTION_SALT,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        }));
        await importManifest(client, workspaceId, {
          gatekeeperId,
          operations: manifest,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        for (const op of [RESTART, REPAIR, PRUNE]) {
          await publishOperation(client, workspaceId, { gatekeeperId, name: op.name });
        }
        // DRAFT_STOP stays a draft.
      });

      const gatekeeperClient = () =>
        new HttpGatekeeperClient({ token: GATE_TEST_TOKEN, outboundTargetGuard: ALLOW_LOOPBACK });
      const withTransaction = createAdminWithTransaction(pool);
      const newDrainer = () =>
        new ApprovalDrainer({
          executor: createGatekeeperActionExecutor({
            gatekeeperClient: gatekeeperClient(),
            withTransaction,
          }),
          withTransaction,
        });
      setRequestActionDeps({
        gatekeeperClient: gatekeeperClient(),
        drainer: newDrainer(),
        awaitDecisionTimeoutMs: 400,
      });
      drainer = newDrainer();
    });

    afterAll(async () => {
      await gateApp?.close();
      await pool?.end();
    });

    it('records the instance the published version names, from the call’s own params; a draft’s or a mistyped one records the whole gate', async () => {
      const restarted = await request(RESTART.name, { id: 'web' });
      expect(restarted.status).toBe('executed');
      expect((await row(restarted.id)).target).toEqual({
        type: 'Container',
        params: ['id'],
        identity: ['web'],
      });

      // I-Q3: a param not of its schema type names no instance the platform can tell — the whole
      // gate, which with nothing ahead of it still runs (and the gate answers for its params).
      const mistyped = await request(RESTART.name, { id: 7 });
      expect((await row(mistyped.id)).target).toBeNull();
      const missing = await request(RESTART.name, {});
      expect((await row(missing.id)).target).toBeNull();

      // I17: a draft is unclassified — it waits for a person, on the whole gate, whatever it
      // declares.
      const draft = await request(DRAFT_STOP.name, { id: 'web' });
      expect(draft.status).toBe('pending_approval');
      expect((await row(draft.id)).target).toBeNull();
      await decide(draft.id, 'reject');
    });

    it('I-Q1: awaiting approval on one container holds back that container and the whole gate, never another container', async () => {
      const repairWeb = await request(REPAIR.name, { id: 'web' });
      expect(repairWeb.status).toBe('pending_approval');

      // Another instance: runs at once.
      const restartDb = await request(RESTART.name, { id: 'db' });
      expect(restartDb.status).toBe('executed');

      // The same instance, and the whole gate: approved, held back by the pending repair.
      const restartWeb = await request(RESTART.name, { id: 'web' });
      expect(restartWeb.status).toBe('auto_approved');
      const prune = await request(PRUNE.name, {});
      expect(prune.status).toBe('auto_approved');
      // And a call on another instance behind the whole-gate call waits for it, so for the root.
      const restartCache = await request(RESTART.name, { id: 'cache' });
      expect(restartCache.status).toBe('auto_approved');

      const behind = { status: 'pending_approval', outcomeInDoubt: false };
      const shown = await waiting();
      expect(shown.get(restartWeb.id)?.queuedBehind).toEqual({ ...behind, scope: 'target' });
      expect(shown.get(prune.id)?.queuedBehind).toEqual({ ...behind, scope: 'gate' });
      expect(shown.get(restartCache.id)?.queuedBehind).toEqual({ ...behind, scope: 'gate' });
      expect(shown.get(repairWeb.id)?.queuedBehind).toBeNull();

      // Approved: the queue runs in order — the repair, then what waited for it.
      const before = transport.calls.length;
      await decide(repairWeb.id, 'approve');
      await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      for (const id of [repairWeb.id, restartWeb.id, prune.id, restartCache.id]) {
        expect((await row(id)).status).toBe('executed');
      }
      expect(transport.calls.slice(before)).toEqual([
        'container.repair:web',
        'container.restart:web',
        'system.prune:-',
        'container.restart:cache',
      ]);
    });

    it('I-Q2: a revision published later changes no request already made; the next call takes the new version', async () => {
      const repairWeb = await request(REPAIR.name, { id: 'web' });
      const restartWeb = await request(RESTART.name, { id: 'web' });
      expect(restartWeb.status).toBe('auto_approved');

      // The gate's next version of restart declares no target.
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.revision',
          principalId: ownerId,
        });
        const { target: _target, ...undeclared } = RESTART;
        await proposeOperation(client, workspaceId, {
          gatekeeperId,
          operation: undeclared,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, workspaceId, { gatekeeperId, name: RESTART.name });
      });

      expect((await row(restartWeb.id)).target).toEqual({
        type: 'Container',
        params: ['id'],
        identity: ['web'],
      });
      // Now on the whole gate: it waits for the pending repair on web.
      const restartDb = await request(RESTART.name, { id: 'db' });
      expect(restartDb.status).toBe('auto_approved');
      expect((await row(restartDb.id)).target).toBeNull();
      expect((await waiting()).get(restartDb.id)?.queuedBehind).toEqual({
        status: 'pending_approval',
        outcomeInDoubt: false,
        scope: 'gate',
      });

      await decide(repairWeb.id, 'reject');
      await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      expect((await row(restartWeb.id)).status).toBe('executed');
      expect((await row(restartDb.id)).status).toBe('executed');
    });
  },
);
