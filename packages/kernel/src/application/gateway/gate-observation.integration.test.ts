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
import type { HandleClaims, Operation } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HttpGatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { ApprovalDrainer } from '../../governance/approval/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import {
  MAX_GATE_OBSERVATIONS_PER_WORKER_RUN,
  invokeWorker,
  readWorkerRunRow,
} from '../task/index.js';
import type { TaskRuntimeDeps } from '../task/runtime.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * gate-observation.integration.test: S8 W5-A (leftover 75 second half, docs/STATUS.md §4 row 75)
 * — a Worker's gate operation results (`request_action`, both the observe branch and an executed
 * execute-class branch) are recorded as Observations of that WorkerRun's own epistemic Source
 * (`application/task/gate-observation.ts`), even when the model's `factsToAssert` stays empty.
 * DB-gated (real Postgres + a real fake Gatekeeper HTTP server; auto-skip without DATABASE_URL) —
 * mirrors `request-action.integration.test.ts`'s own fake-gate harness for the gate side and
 * `worker-result.integration.test.ts`'s own WorkerRun-spawning shape for the Worker-caller side.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const GATE_TEST_TOKEN = 'gate-observation-integration-test-token-0123456789abcdef';

class RecordingTransport implements Transport {
  readonly kind = 'http' as const;

  async invoke(operation: Operation, params: unknown): Promise<TransportInvokeResult> {
    if (operation.name === 'observe.inventory') {
      return { data: { hosts: ['h1', 'h2'] } };
    }
    return { data: { ok: true, operation: operation.name, params } };
  }
}

const OBSERVE_OP: Operation = {
  name: 'observe.inventory',
  binding: { kind: 'http', method: 'GET', path: '/inventory' },
  params_schema: {},
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

const AUTO_OP: Operation = {
  name: 'auto.restart',
  binding: { kind: 'http', method: 'POST', path: '/restart' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.12',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.12' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    const existing = this.statuses.get(workerRunId);
    if (!existing) return false;
    this.statuses.set(workerRunId, { ...existing, status: 'terminated', reason: 'requested' });
    return true;
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'request_action — gate operation results recorded as Observations (S8 W5-A, leftover 75)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let gatekeeperId: string;
    let workerDefinitionId: string;
    let fakeGateApp: FastifyInstance;

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
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    function deps(supervisorClient: FakeTaskSupervisorClient): TaskRuntimeDeps {
      return { pool, privateKey, supervisorClient };
    }

    async function claimsForWorkerRunSession(sessionId: string): Promise<HandleClaims> {
      const row = await inTx(ownerId, async (client) => {
        const result = await client.query<{
          jti: string;
          on_behalf_of: string;
          scope: HandleClaims['scope'];
          expires_at: Date;
        }>(
          'select jti, on_behalf_of, scope, expires_at from capability_handles where workspace_id = $1 and session_id = $2',
          [workspaceId, sessionId],
        );
        return result.rows[0];
      });
      if (!row) throw new Error(`no capability_handles row for session ${sessionId}`);
      return {
        ws: workspaceId,
        sid: sessionId,
        obo: row.on_behalf_of,
        scope: row.scope,
        jti: row.jti,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
      };
    }

    /** Spawns a fresh WorkerRun of the test WorkerDefinition (declared `capabilities:
     *  ['request_action']`, `gates: [gatekeeperId]`) via an `owner`-channel human caller
     *  (`unconstrained` parent authority — `handle-mint.ts`'s own doc comment — so the child gets
     *  `request_action` and the declared gate without needing a real entry-Handle grant chain set
     *  up first) and returns its Handle claims to call `request_action` as. */
    async function spawnWorkerRun(): Promise<{ workerRunId: string; claims: HandleClaims }> {
      const supervisorClient = new FakeTaskSupervisorClient();
      const invoked = await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'human' },
        {
          definitionId: workerDefinitionId,
          version: 1,
          input: { need: 'inventory' },
          wait: false,
          gates: [gatekeeperId],
        },
        deps(supervisorClient),
      );
      const workerRun = await inTx(ownerId, (client) =>
        readWorkerRunRow(client, workspaceId, invoked.workerRunId),
      );
      if (!workerRun?.sessionId) throw new Error('spawned WorkerRun has no session');
      const claims = await claimsForWorkerRunSession(workerRun.sessionId);
      return { workerRunId: invoked.workerRunId, claims };
    }

    async function gateCallActivities(workerRunId: string) {
      return inTx(ownerId, async (client) => {
        const rows = await client.query<{
          id: string;
          metadata: Record<string, unknown>;
          status: string;
        }>(
          `select id, metadata, status from activities
           where workspace_id = $1 and kind = 'worker_gate_call' and metadata ->> 'workerRunId' = $2
           order by created_at asc`,
          [workspaceId, workerRunId],
        );
        return rows.rows;
      });
    }

    async function observationForActivity(activityId: string) {
      return inTx(ownerId, async (client) => {
        const rows = await client.query<{
          content: Record<string, unknown>;
          source_kind: string;
          source_name: string | null;
          source_visibility: string;
        }>(
          `select o.content, s.kind as source_kind, s.name as source_name, s.visibility as source_visibility
           from observations o
           join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
           where o.workspace_id = $1 and o.activity_id = $2`,
          [workspaceId, activityId],
        );
        return rows.rows;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const keyPair = await generateEphemeralHandleKeyPair();
      privateKey = keyPair.privateKey;

      workspaceId = await adminInsertWorkspace('gate-observation-integration-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');

      const gate = new GatekeeperBase({
        manifest: [OBSERVE_OP, AUTO_OP],
        transport: new RecordingTransport(),
        credentialResolver: { resolve: async () => ({}) },
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      fakeGateApp = createGatekeeperServer({ gate, token: GATE_TEST_TOKEN });
      await fakeGateApp.listen({ port: 0, host: '127.0.0.1' });
      const address = fakeGateApp.server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'gate-observation-test-gate',
          transportKind: 'http',
          target: 'example-system',
          endpoint,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        gatekeeperId = registered.gatekeeperId;

        await importManifest(client, workspaceId, {
          gatekeeperId,
          operations: [OBSERVE_OP, AUTO_OP],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, workspaceId, { gatekeeperId, name: OBSERVE_OP.name });
        await publishOperation(client, workspaceId, { gatekeeperId, name: AUTO_OP.name });
      });

      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: {
            systemPrompt: 'You are a gate-observation test worker.',
            capabilities: ['request_action'],
            gates: [gatekeeperId],
          },
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      workerDefinitionId = proposed.id;

      const gatekeeperClient = new HttpGatekeeperClient({ token: GATE_TEST_TOKEN });
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
      await fakeGateApp.close();
      await pool.end();
    });

    it('an observe-class request_action call from a Worker records one Observation on its own WorkerRun Source — never on the gatekeeper_observe Activity', async () => {
      const { workerRunId, claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: OBSERVE_OP.name,
        params: {},
      })) as { status: string; data: unknown };
      expect(result.status).toBe('ok');
      expect(result.data).toEqual({ hosts: ['h1', 'h2'] });

      const gateCalls = await gateCallActivities(workerRunId);
      expect(gateCalls).toHaveLength(1);
      expect(gateCalls[0]?.status).toBe('completed');
      expect(gateCalls[0]?.metadata).toMatchObject({
        workerRunId,
        gatekeeperId,
        operation: OBSERVE_OP.name,
        mode: 'observe',
        status: 'ok',
      });

      const observations = await observationForActivity(gateCalls[0]?.id ?? '');
      expect(observations).toHaveLength(1);
      expect(observations[0]?.source_kind).toBe('worker_run');
      expect(observations[0]?.source_name).toBe(workerRunId);
      expect(observations[0]?.source_visibility).toBe('workspace');
      expect(observations[0]?.content).toMatchObject({
        gatekeeperId,
        gateName: 'gate-observation-test-gate',
        operation: OBSERVE_OP.name,
        mode: 'observe',
        status: 'ok',
        payload: { hosts: ['h1', 'h2'] },
        truncated: false,
      });

      // The gate's own `gatekeeper_observe` Activity still carries exactly its own Observation
      // (from the Gatekeeper's own Source) — the new bookkeeping Activity above is fully separate,
      // never a second Observation appended to this one (see `gate-observation.ts`'s own doc
      // comment on why that would break `resolveFactOrigin`).
      const observeActivity = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ id: string }>(
          `select id from activities
           where workspace_id = $1 and kind = 'gatekeeper_observe'
             and metadata ->> 'operation' = $2
           order by created_at desc limit 1`,
          [workspaceId, OBSERVE_OP.name],
        );
        return rows.rows[0];
      });
      if (!observeActivity) throw new Error('expected a gatekeeper_observe Activity');
      const observeActivityObservations = await observationForActivity(observeActivity.id);
      expect(observeActivityObservations).toHaveLength(1);
      expect(observeActivityObservations[0]?.source_kind).toBe('gatekeeper');
    });

    it('an executed execute-class request_action call from a Worker records one Observation with the apply result', async () => {
      const { workerRunId, claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: AUTO_OP.name,
        params: { host: 'h1' },
      })) as { status: string; data?: unknown };
      expect(result.status).toBe('executed');

      const gateCalls = await gateCallActivities(workerRunId);
      expect(gateCalls).toHaveLength(1);
      expect(gateCalls[0]?.metadata).toMatchObject({
        workerRunId,
        gatekeeperId,
        operation: AUTO_OP.name,
        mode: 'execute',
        status: 'executed',
      });
      const observations = await observationForActivity(gateCalls[0]?.id ?? '');
      expect(observations).toHaveLength(1);
      expect(observations[0]?.content).toMatchObject({
        mode: 'execute',
        status: 'executed',
        payload: { ok: true, operation: AUTO_OP.name, params: { host: 'h1' } },
      });
    });

    it('a human caller’s observe call (not a WorkerRun) never creates a worker_gate_call Activity', async () => {
      const humanCaller: ResolvedCaller = {
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
      const before = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ count: string }>(
          "select count(*)::text as count from activities where workspace_id = $1 and kind = 'worker_gate_call'",
          [workspaceId],
        );
        return Number.parseInt(rows.rows[0]?.count ?? '0', 10);
      });

      const result = (await dispatchCapability({ pool }, humanCaller, 'request_action', {
        gatekeeperId,
        operation: OBSERVE_OP.name,
        params: {},
      })) as { status: string };
      expect(result.status).toBe('ok');

      const after = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ count: string }>(
          "select count(*)::text as count from activities where workspace_id = $1 and kind = 'worker_gate_call'",
          [workspaceId],
        );
        return Number.parseInt(rows.rows[0]?.count ?? '0', 10);
      });
      expect(after).toBe(before);
    });

    it('stops recording once a WorkerRun reaches MAX_GATE_OBSERVATIONS_PER_WORKER_RUN', async () => {
      const { workerRunId, claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };

      // Seed the cap directly (200 sequential real gate calls would be slow and adds nothing this
      // unit-level fact doesn't already cover) — a bulk INSERT of synthetic worker_gate_call
      // Activities for this WorkerRun, same shape `recordWorkerGateObservation` itself writes.
      await inTx(ownerId, (client) =>
        client.query(
          `insert into activities (workspace_id, kind, status, metadata, started_by)
           select $1, 'worker_gate_call', 'completed',
                  jsonb_build_object('workerRunId', $2::text, 'seed', true), $3
           from generate_series(1, $4)`,
          [workspaceId, workerRunId, ownerId, MAX_GATE_OBSERVATIONS_PER_WORKER_RUN],
        ),
      );

      const result = (await dispatchCapability({ pool }, caller, 'request_action', {
        gatekeeperId,
        operation: OBSERVE_OP.name,
        params: {},
      })) as { status: string };
      expect(result.status).toBe('ok'); // the gate call itself is never blocked by the cap

      const gateCalls = await gateCallActivities(workerRunId);
      expect(gateCalls).toHaveLength(MAX_GATE_OBSERVATIONS_PER_WORKER_RUN); // no new row past the cap
    });
  },
);
