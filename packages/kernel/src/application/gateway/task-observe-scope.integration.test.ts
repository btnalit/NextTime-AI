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
import {
  HttpGatekeeperClient,
  deriveConnectionSecret,
} from '../../adapters/gatekeeper-client/index.js';
import { createOutboundTargetGuard } from '../../adapters/outbound-target/index.js';
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
  type InvokeWorkerTaskOptions,
  invokeWorker,
  readWorkerRunRow,
  setQuotaValue,
} from '../task/index.js';
import type { TaskRuntimeDeps } from '../task/runtime.js';
import {
  proposeProcedure,
  proposeWorkerDefinition,
  publishProcedure,
  publishWorkerDefinition,
} from '../worker/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { dispatchCapability } from './dispatch.js';
import { setRequestActionDeps } from './request-action-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * task-observe-scope.integration.test: S11 GO11 "任务级观察范围" (docs/goal-orchestration-and-admin-
 * agent-plan-2026-10-16.md §4.11; S10 I-E1; migrations/task/0010). A Task that fixes the gates its
 * Workers may observe through: every other gate is refused `excluded_by_policy` on both observe
 * paths, left out of the tool list and of `find_procedures`, and never called; a Worker it starts
 * stays within it; the database refuses a change of the scope and a nested run outside it.
 * DB-gated (real Postgres + two real fake Gatekeeper HTTP servers; auto-skip without
 * DATABASE_URL), the harness `gate-observation.integration.test.ts` uses.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const GATE_TEST_TOKEN = 'task-observe-scope-integration-test-token-0123456789abcdef';
const SALT_IN = 'a'.repeat(32);
const SALT_OUT = 'b'.repeat(32);

class CountingTransport implements Transport {
  readonly kind = 'http' as const;
  calls = 0;

  async invoke(operation: Operation): Promise<TransportInvokeResult> {
    this.calls += 1;
    return { data: { operation: operation.name, hosts: ['h1'] } };
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

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.13',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.13' };
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
  'Task observation scope (S11 GO11): a Worker observes only the gates its Task names',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    /** In the scope of the scoped Tasks below. */
    let gateIn: string;
    /** Outside it. */
    let gateOut: string;
    let workerDefinitionId: string;
    const transportIn = new CountingTransport();
    const transportOut = new CountingTransport();
    const gateApps: FastifyInstance[] = [];

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

    async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    function deps(): TaskRuntimeDeps {
      return { pool, privateKey, supervisorClient: new FakeTaskSupervisorClient() };
    }

    async function claimsForWorkerRunSession(sessionId: string): Promise<HandleClaims> {
      const row = await inTx(async (client) => {
        const result = await client.query<{
          jti: string;
          on_behalf_of: string;
          scope: HandleClaims['scope'];
          expires_at: Date;
          parent_jti: string | null;
        }>(
          `select jti, on_behalf_of, scope, expires_at, parent_jti from capability_handles
           where workspace_id = $1 and session_id = $2`,
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
        ...(row.parent_jti ? { par: row.parent_jti } : {}),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
      };
    }

    interface SpawnedWorker {
      readonly taskId: string;
      readonly workerRunId: string;
      readonly claims: HandleClaims;
    }

    async function spawned(invoked: {
      taskId: string;
      workerRunId: string;
    }): Promise<SpawnedWorker> {
      const workerRun = await inTx((client) =>
        readWorkerRunRow(client, workspaceId, invoked.workerRunId),
      );
      if (!workerRun?.sessionId) throw new Error('spawned WorkerRun has no session');
      return {
        taskId: invoked.taskId,
        workerRunId: invoked.workerRunId,
        claims: await claimsForWorkerRunSession(workerRun.sessionId),
      };
    }

    /** A Worker the owner starts from the console (a root Handle, like a goal step's attempt),
     *  with the Task options a kernel-internal creator passes. */
    async function startWorker(options: InvokeWorkerTaskOptions = {}): Promise<SpawnedWorker> {
      const invoked = await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'human' },
        {
          definitionId: workerDefinitionId,
          version: 1,
          input: { need: 'inventory' },
          wait: false,
          gates: [gateIn, gateOut],
        },
        deps(),
        options,
      );
      return spawned(invoked);
    }

    /** A Worker that `parent` starts with its own Handle — its `invoke_worker`. */
    async function startChildWorker(
      parent: SpawnedWorker,
      options: InvokeWorkerTaskOptions = {},
    ): Promise<SpawnedWorker> {
      const invoked = await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: parent.claims },
        {
          definitionId: workerDefinitionId,
          version: 1,
          input: { need: `inventory ${randomUUID()}` },
          wait: false,
        },
        deps(),
        options,
      );
      return spawned(invoked);
    }

    function asWorker(worker: SpawnedWorker): ResolvedCaller {
      return { channel: 'handle', claims: worker.claims };
    }

    async function observe(worker: SpawnedWorker, gatekeeperId: string) {
      return dispatchCapability({ pool }, asWorker(worker), 'observe_operation', {
        gatekeeperId,
        operation: OBSERVE_OP.name,
        params: {},
      });
    }

    async function taskObserveScope(worker: SpawnedWorker): Promise<unknown> {
      const task = (await dispatchCapability({ pool }, asWorker(worker), 'get_task', {
        taskId: worker.taskId,
      })) as { observeScope: unknown };
      return task.observeScope;
    }

    async function startGate(
      name: string,
      salt: string,
      transport: CountingTransport,
    ): Promise<string> {
      const gate = new GatekeeperBase({
        manifest: [OBSERVE_OP],
        transport,
        credentialResolver: { resolve: async () => ({}) },
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      const app = createGatekeeperServer({
        gate,
        token: deriveConnectionSecret(GATE_TEST_TOKEN, workspaceId, salt),
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      gateApps.push(app);
      const address = app.server.address() as AddressInfo;
      return inTx(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: `${name}-system`,
          endpoint: `http://127.0.0.1:${address.port}`,
          connectionSecretSalt: salt,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        await importManifest(client, workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          operations: [OBSERVE_OP],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          name: OBSERVE_OP.name,
        });
        return registered.gatekeeperId;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;

      workspaceId = await adminInsertWorkspace('task-observe-scope-integration-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      // Every test starts Workers and none finishes them.
      await inTx((client) =>
        setQuotaValue(client, workspaceId, {
          key: 'task.max_concurrent_worker_runs_per_user',
          value: 100,
          updatedBy: ownerId,
        }),
      );
      gateIn = await startGate('scope-gate-in', SALT_IN, transportIn);
      gateOut = await startGate('scope-gate-out', SALT_OUT, transportOut);

      const proposed = await inTx((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: {
            systemPrompt: 'You are a task-observe-scope test worker.',
            capabilities: ['request_action', 'invoke_worker', 'find_operations', 'find_procedures'],
            gates: [gateIn, gateOut],
          },
        }),
      );
      await inTx((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      workerDefinitionId = proposed.id;

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
      for (const app of gateApps) await app.close();
      await pool.end();
    });

    it('a gate outside the Task’s scope is refused excluded_by_policy on both observe paths and never called; the gate it names still reads', async () => {
      const worker = await startWorker({ observeScope: [gateIn] });
      expect(await taskObserveScope(worker)).toEqual([gateIn]);

      const outBefore = transportOut.calls;
      const inBefore = transportIn.calls;
      const refusal = new RegExp(
        `^excluded_by_policy: gatekeeper ${gateOut} is outside the observation scope of Task ${worker.taskId}`,
      );
      await expect(observe(worker, gateOut)).rejects.toThrow(refusal);
      await expect(
        dispatchCapability({ pool }, asWorker(worker), 'request_action', {
          gatekeeperId: gateOut,
          operation: OBSERVE_OP.name,
          params: {},
        }),
      ).rejects.toThrow(refusal);
      expect(transportOut.calls).toBe(outBefore);

      expect(await observe(worker, gateIn)).toMatchObject({ status: 'ok' });
      expect(
        await dispatchCapability({ pool }, asWorker(worker), 'request_action', {
          gatekeeperId: gateIn,
          operation: OBSERVE_OP.name,
          params: {},
        }),
      ).toMatchObject({ status: 'ok' });
      expect(transportIn.calls).toBe(inBefore + 2);
    });

    it('an empty scope reads through no gate at all', async () => {
      const worker = await startWorker({ observeScope: [] });
      expect(await taskObserveScope(worker)).toEqual([]);
      const before = transportIn.calls + transportOut.calls;
      await expect(observe(worker, gateIn)).rejects.toThrow(
        /^excluded_by_policy: .*observation scope/,
      );
      await expect(observe(worker, gateOut)).rejects.toThrow(
        /^excluded_by_policy: .*observation scope/,
      );
      expect(transportIn.calls + transportOut.calls).toBe(before);
    });

    it('a Task that sets no scope is unchanged: its Worker reads both gates', async () => {
      const worker = await startWorker();
      expect(await taskObserveScope(worker)).toBeNull();
      expect(await observe(worker, gateIn)).toMatchObject({ status: 'ok' });
      expect(await observe(worker, gateOut)).toMatchObject({ status: 'ok' });
    });

    it('the tool list offers only the observe tools of the gates in scope', async () => {
      const listed = async (worker: SpawnedWorker) =>
        (
          (await dispatchCapability({ pool }, asWorker(worker), 'list_allowed_operations', {})) as {
            items: { gatekeeperId: string; name: string }[];
          }
        ).items
          .filter((item) => item.name === OBSERVE_OP.name)
          .map((item) => item.gatekeeperId)
          .sort();

      expect(await listed(await startWorker({ observeScope: [gateIn] }))).toEqual([gateIn]);
      expect(await listed(await startWorker({ observeScope: [] }))).toEqual([]);
      expect(await listed(await startWorker())).toEqual([gateIn, gateOut].sort());
    });

    it('find_procedures leaves out a Procedure whose observe step reads a gate outside the scope', async () => {
      const need = `scope-${randomUUID()}`;
      const procedure = await inTx((client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: need,
          description: 'Reads the out-of-scope gate.',
          steps: [{ kind: 'operation', gatekeeperId: gateOut, operationName: OBSERVE_OP.name }],
        }),
      );
      await inTx((client) => publishProcedure(client, workspaceId, ownerId, procedure.id));
      const found = async (worker: SpawnedWorker) =>
        (
          (await dispatchCapability({ pool }, asWorker(worker), 'find_procedures', { need })) as {
            items: { procedureId: string }[];
          }
        ).items.map((item) => item.procedureId);

      expect(await found(await startWorker())).toContain(procedure.id);
      expect(await found(await startWorker({ observeScope: [gateIn] }))).not.toContain(
        procedure.id,
      );
    });

    it('find_operations annotates no Worker — not even one whose Handle has no parent — with the entry agent’s reachability', async () => {
      const worker = await startWorker({ observeScope: [gateIn] });
      expect(worker.claims.par).toBeUndefined();
      const items = (
        (await dispatchCapability({ pool }, asWorker(worker), 'find_operations', {
          need: 'observe.inventory',
        })) as { items: Record<string, unknown>[] }
      ).items;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item).not.toHaveProperty('reachability');
    });

    it('a Worker a scoped Worker starts is scoped within it: it takes the scope, can only narrow it, and is refused outside it', async () => {
      const parent = await startWorker({ observeScope: [gateIn] });

      const child = await startChildWorker(parent);
      expect(await taskObserveScope(child)).toEqual([gateIn]);
      await expect(observe(child, gateOut)).rejects.toThrow(
        new RegExp(`outside the observation scope of Task ${child.taskId}`),
      );
      expect(await observe(child, gateIn)).toMatchObject({ status: 'ok' });

      // Asking for more than the caller's Task allows keeps only what it allows …
      const widened = await startChildWorker(parent, { observeScope: [gateIn, gateOut] });
      expect(await taskObserveScope(widened)).toEqual([gateIn]);
      // … and asking for less narrows it.
      const narrowed = await startChildWorker(parent, { observeScope: [gateOut] });
      expect(await taskObserveScope(narrowed)).toEqual([]);

      // An unscoped caller's child takes only the scope asked for.
      const unscoped = await startWorker();
      expect(await taskObserveScope(await startChildWorker(unscoped))).toBeNull();
      expect(
        await taskObserveScope(await startChildWorker(unscoped, { observeScope: [gateOut] })),
      ).toEqual([gateOut]);
    });

    it('the database never changes a Task’s scope, and refuses a run started by a scoped Task’s Worker whose Task is outside that scope', async () => {
      const scoped = await startWorker({ observeScope: [gateIn] });
      const unscoped = await startWorker();
      const child = await startChildWorker(scoped);

      await expect(
        inTx((client) =>
          client.query('update tasks set observe_scope = $3 where workspace_id = $1 and id = $2', [
            workspaceId,
            scoped.taskId,
            [gateIn, gateOut],
          ]),
        ),
      ).rejects.toThrow(/observation scope never changes/);
      await expect(
        inTx((client) =>
          client.query(
            'update tasks set observe_scope = null where workspace_id = $1 and id = $2',
            [workspaceId, scoped.taskId],
          ),
        ),
      ).rejects.toThrow(/observation scope never changes/);
      // A setting that writes the same scope again is no change.
      await inTx((client) =>
        client.query(
          'update tasks set observe_scope = observe_scope where workspace_id = $1 and id = $2',
          [workspaceId, scoped.taskId],
        ),
      );

      // The unscoped Task's run, re-parented under the scoped Task's run: refused.
      await expect(
        inTx((client) =>
          client.query(
            'update worker_runs set parent_worker_run_id = $3 where workspace_id = $1 and id = $2',
            [workspaceId, unscoped.workerRunId, scoped.workerRunId],
          ),
        ),
      ).rejects.toThrow(/observes only within that Task's observation scope/);
      // The child's run, moved onto the unscoped Task: refused.
      await expect(
        inTx((client) =>
          client.query('update worker_runs set task_id = $3 where workspace_id = $1 and id = $2', [
            workspaceId,
            child.workerRunId,
            unscoped.taskId,
          ]),
        ),
      ).rejects.toThrow(/observes only within that Task's observation scope/);
    });

    it('a scope holds gate ids only: a NULL entry or a nested array is refused', async () => {
      const insert = (scope: string) =>
        inTx((client) =>
          client.query(
            `insert into tasks (workspace_id, on_behalf_of, worker_definition_id,
               worker_definition_version, observe_scope)
             values ($1, $2, $3, 1, $4::uuid[])`,
            [workspaceId, ownerId, workerDefinitionId, scope],
          ),
        );
      await expect(insert(`{${gateIn},NULL}`)).rejects.toThrow(/tasks_observe_scope/);
      await expect(insert(`{{${gateIn}},{${gateOut}}}`)).rejects.toThrow();
    });
  },
);
