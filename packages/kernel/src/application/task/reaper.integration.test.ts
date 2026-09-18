import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { TaskSupervisorClientPort } from '../../adapters/supervisor-client/index.js';
import { entryScope, generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { readTaskRow } from './lifecycle.js';
import {
  type ActionRequestEventMeta,
  type ActionRequestEventSource,
  registerActionRequestRoutingConsumer,
  runTaskReaper,
} from './reaper.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { findWorkers } from './service.js';

/**
 * application/task/reaper.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) tests for the event-driven ActionRequest → Task `waiting_approval` router and
 * `find_workers` (docs/development-tasks.md S2.7 "waiting_approval via an ActionRequestPending
 * event carrying parentWorkerRunId", "find_* over seeded meta-ontology objects").
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

/** A minimal, synchronous-await fake `ActionRequestEventSource` — `emit()` awaits every
 *  registered consumer before returning, so a test can assert DB state immediately after. */
type AnyActionRequestConsumer = (event: unknown, meta: ActionRequestEventMeta) => unknown;

class FakeActionRequestEventSource implements ActionRequestEventSource {
  // The public `subscribe`/`emit` signatures below are what actually get type-checked against
  // real call sites — this internal map is deliberately untyped-per-event (a tiny test double).
  private readonly consumers = new Map<string, Set<AnyActionRequestConsumer>>();

  subscribe<T extends 'ActionRequestPending' | 'ActionRequestUpdated'>(
    eventType: T,
    consumer: (
      event: Extract<DomainEvent, { type: T }>,
      meta: ActionRequestEventMeta,
    ) => Promise<void> | void,
  ): () => void {
    const set = this.consumers.get(eventType) ?? new Set();
    const untypedConsumer = consumer as unknown as AnyActionRequestConsumer;
    set.add(untypedConsumer);
    this.consumers.set(eventType, set);
    return () => {
      set.delete(untypedConsumer);
    };
  }

  async emit<T extends 'ActionRequestPending' | 'ActionRequestUpdated'>(
    eventType: T,
    event: Extract<DomainEvent, { type: T }>,
  ): Promise<void> {
    const set = this.consumers.get(eventType);
    if (!set) return;
    const meta: ActionRequestEventMeta = {
      outboxId: randomUUID(),
      workspaceId: (event as { workspaceId: string }).workspaceId,
    };
    for (const consumer of set) {
      await consumer(event, meta);
    }
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/task reaper — integration (real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    const graphStore = new SqlGraphStore();

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

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('task-reaper-integration-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('ActionRequest -> Task waiting_approval routing', () => {
      /** The fixture every case below shares: a published worker definition, a `running` Task with
       *  one `running` WorkerRun, a Gatekeeper Object, and one `pending_approval` ActionRequest
       *  raised by that WorkerRun with the given `await_decision` (S5.6 leftover 30: the router
       *  reads it now). */
      async function seedPendingChildRequest(awaitDecision: boolean) {
        const definitionId = await inTx(ownerId, async (client) => {
          const proposed = await proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: { systemPrompt: 'ops-runner' },
          });
          await publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: proposed.id,
            version: proposed.version,
          });
          return proposed.id;
        });

        const { taskId, workerRunId } = await inTx(ownerId, async (client) => {
          const taskResult = await client.query<{ id: string }>(
            `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, 'running', $2, $3, 1) returning id`,
            [workspaceId, ownerId, definitionId],
          );
          const insertedTaskId = taskResult.rows[0]?.id as string;
          const workerRunResult = await client.query<{ id: string }>(
            `insert into worker_runs (workspace_id, status, task_id, depth, attempt)
           values ($1, 'running', $2, 0, 1) returning id`,
            [workspaceId, insertedTaskId],
          );
          return { taskId: insertedTaskId, workerRunId: workerRunResult.rows[0]?.id as string };
        });

        const gatekeeperObjectId = await inTx(ownerId, async (client) => {
          const object = await graphStore.upsertObject(client, workspaceId, {
            objectType: 'Gatekeeper',
            properties: { transportKind: 'ssh' },
          });
          return object.id;
        });

        const actionRequestId = await inTx(ownerId, async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into action_requests (
             workspace_id, status, gatekeeper_id, action_kind, blast_radius, policy_decision,
             await_decision, on_behalf_of, parent_worker_run_id, actor_runtime
           ) values ($1, 'pending_approval', $2, 'test.restart', 'medium', 'require_approval',
             $5, $3, $4, 'worker')
           returning id`,
            [workspaceId, gatekeeperObjectId, ownerId, workerRunId, awaitDecision],
          );
          return result.rows[0]?.id as string;
        });

        return { taskId, gatekeeperObjectId, actionRequestId };
      }

      it('S5.6 leftover 30: an ActionRequest the Worker does not await (await_decision=false, the docker_restart shape) leaves the Task running', async () => {
        const { taskId, gatekeeperObjectId, actionRequestId } =
          await seedPendingChildRequest(false);
        const supervisorClient = {} as TaskSupervisorClientPort;
        const { privateKey } = await generateEphemeralHandleKeyPair();
        const dispatcher = new FakeActionRequestEventSource();
        const unsubscribe = registerActionRequestRoutingConsumer(dispatcher, {
          pool,
          privateKey,
          supervisorClient,
        });
        try {
          await dispatcher.emit('ActionRequestPending', {
            type: 'ActionRequestPending',
            workspaceId,
            actionRequestId,
            gatekeeperId: gatekeeperObjectId,
            actionKindTag: 'test.restart',
            holderPrincipalIds: [ownerId],
          });
          const task = await inTx(ownerId, (client) => readTaskRow(client, workspaceId, taskId));
          // Still `running`: the Worker was not blocked, so its own `report_task_result` must keep
          // finding a Task it can complete.
          expect(task?.status).toBe('running');
        } finally {
          unsubscribe();
        }
      });

      it("routes a pending child WorkerRun's ActionRequest back to the parent Task, and resumes on resolution", async () => {
        const definitionId = await inTx(ownerId, async (client) => {
          const proposed = await proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: { systemPrompt: 'ops-runner' },
          });
          await publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: proposed.id,
            version: proposed.version,
          });
          return proposed.id;
        });

        const { taskId, workerRunId } = await inTx(ownerId, async (client) => {
          const taskResult = await client.query<{ id: string }>(
            `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, 'running', $2, $3, 1) returning id`,
            [workspaceId, ownerId, definitionId],
          );
          const insertedTaskId = taskResult.rows[0]?.id as string;
          const workerRunResult = await client.query<{ id: string }>(
            `insert into worker_runs (workspace_id, status, task_id, depth, attempt)
           values ($1, 'running', $2, 0, 1) returning id`,
            [workspaceId, insertedTaskId],
          );
          return { taskId: insertedTaskId, workerRunId: workerRunResult.rows[0]?.id as string };
        });

        const gatekeeperObjectId = await inTx(ownerId, async (client) => {
          const object = await graphStore.upsertObject(client, workspaceId, {
            objectType: 'Gatekeeper',
            properties: { transportKind: 'ssh' },
          });
          return object.id;
        });

        const actionRequestId = await inTx(ownerId, async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into action_requests (
             workspace_id, status, gatekeeper_id, action_kind, blast_radius, policy_decision,
             await_decision, on_behalf_of, parent_worker_run_id, actor_runtime
           ) values ($1, 'pending_approval', $2, 'test.restart', 'medium', 'require_approval',
             true, $3, $4, 'worker')
           returning id`,
            [workspaceId, gatekeeperObjectId, ownerId, workerRunId],
          );
          return result.rows[0]?.id as string;
        });
        // `await_decision: true` (S5.6 leftover 30): this is the case where the Worker really is
        // blocked on the decision, the one the router parks. It used to seed `false` and still
        // expected `waiting_approval`, because the router never read the field.

        const supervisorClient = {} as TaskSupervisorClientPort; // never called by the router itself.
        const { privateKey } = await generateEphemeralHandleKeyPair();
        const taskDeps: TaskRuntimeDeps = { pool, privateKey, supervisorClient };

        const dispatcher = new FakeActionRequestEventSource();
        const unsubscribe = registerActionRequestRoutingConsumer(dispatcher, taskDeps);

        try {
          await dispatcher.emit('ActionRequestPending', {
            type: 'ActionRequestPending',
            workspaceId,
            actionRequestId,
            gatekeeperId: gatekeeperObjectId,
            actionKindTag: 'test.restart',
            holderPrincipalIds: [ownerId],
          });

          const waitingTask = await inTx(ownerId, (client) =>
            readTaskRow(client, workspaceId, taskId),
          );
          expect(waitingTask?.status).toBe('waiting_approval');

          // `denied` rather than `approved`: this test seeds the ActionRequest with a raw SQL
          // INSERT/UPDATE (not through governance/approval's own service functions), and
          // `action_requests`' own I11 CHECK constraint (migrations/governance/0003) requires
          // `approved`/`rejected` to carry a real `approval_decision_id` (a `decisions` row this
          // test has no reason to fabricate) — `denied` carries no such requirement and is just as
          // valid a "left pending_approval" resolution for exercising the router itself.
          await inTx(ownerId, (client) =>
            client.query(
              "update action_requests set status = 'denied' where workspace_id = $1 and id = $2",
              [workspaceId, actionRequestId],
            ),
          );
          await dispatcher.emit('ActionRequestUpdated', {
            type: 'ActionRequestUpdated',
            workspaceId,
            actionRequestId,
            status: 'denied',
          });

          const resumedTask = await inTx(ownerId, (client) =>
            readTaskRow(client, workspaceId, taskId),
          );
          expect(resumedTask?.status).toBe('running');
        } finally {
          unsubscribe();
        }
      });
    });

    describe('find_workers', () => {
      it('finds a published worker definition by a need matching its name/description, ranked over an unrelated one', async () => {
        await inTx(ownerId, async (client) => {
          const target = await proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: {
              systemPrompt: 'You restart RouterOS devices.',
              name: 'routeros-restarter',
              description: 'Finds the top talker on a RouterOS device and restarts a service.',
            },
          });
          await publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: target.id,
            version: target.version,
          });

          const unrelated = await proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: {
              systemPrompt: 'You do something else entirely.',
              name: 'unrelated-worker',
            },
          });
          await publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: unrelated.id,
            version: unrelated.version,
          });
        });

        const matches = await inTx(ownerId, (client) =>
          findWorkers(client, workspaceId, { parentAuthority: entryScope() }, 'RouterOS'),
        );

        expect(matches.some((m) => m.name === 'routeros-restarter')).toBe(true);
        expect(matches.every((m) => m.kind === 'worker')).toBe(true);
      });

      it("excludes a worker definition the caller could never actually invoke (execute-class needs it doesn't hold)", async () => {
        await inTx(ownerId, async (client) => {
          const executeNeeding = await proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: {
              systemPrompt: 'You need real gate access.',
              name: 'gate-execute-worker-unique-xyz',
              capabilities: ['<gate>.<op>:execute'],
              gates: ['gk-somewhere'],
            },
          });
          await publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: executeNeeding.id,
            version: executeNeeding.version,
          });
        });

        const matches = await inTx(ownerId, (client) =>
          findWorkers(
            client,
            workspaceId,
            { parentAuthority: entryScope() },
            'gate-execute-worker-unique-xyz',
          ),
        );

        expect(matches.some((m) => m.name === 'gate-execute-worker-unique-xyz')).toBe(false);
      });
    });

    describe('runTaskReaper — queued crash-gap sweep (S5.6, I-S5-3)', () => {
      /** Inserts a `queued` Task row directly (raw SQL, no `invoke_worker`) — `create_task` is
       *  retired, so the only way this suite can put a row at `queued` and hold it there is to
       *  fabricate one, the same way it stands in for the kernel dying between the INSERT and its
       *  own follow-up spawn. No WorkerDefinition FK exists on `tasks` at this migration ordering
       *  (0001_tasks.sql's own header comment) — an arbitrary uuid is a legal `worker_definition_id`
       *  here, exactly as `invoke.integration.test.ts`'s own fixtures rely on. */
      async function insertQueuedTask(updatedAt: Date): Promise<string> {
        const taskId = randomUUID();
        await inTx(ownerId, (client) =>
          client.query(
            `insert into tasks (
               workspace_id, id, status, on_behalf_of, worker_definition_id,
               worker_definition_version, created_at, updated_at
             ) values ($1, $2, 'queued', $3, $4, 1, $5, $5)`,
            [workspaceId, taskId, ownerId, randomUUID(), updatedAt],
          ),
        );
        return taskId;
      }

      it("fails a Task stuck `queued` past the sweep's own threshold, through the governed path (failure_reason='spawn_lost', audited)", async () => {
        const staleTaskId = await insertQueuedTask(new Date(Date.now() - 90 * 1000)); // 90s ago

        const supervisorClient = {} as TaskSupervisorClientPort; // no worker_runs row exists for
        // this Task — the duration-timeout scan's own SELECT (worker_runs join tasks) never
        // matches it, so the supervisor client is never actually called for this fixture.
        const { privateKey } = await generateEphemeralHandleKeyPair();
        const taskDeps: TaskRuntimeDeps = { pool, privateKey, supervisorClient };

        const result = await runTaskReaper(taskDeps);
        expect(result.spawnLost).toBeGreaterThanOrEqual(1);

        const failed = await inTx(ownerId, (client) =>
          readTaskRow(client, workspaceId, staleTaskId),
        );
        expect(failed?.status).toBe('failed');
        expect(failed?.failureReason).toBe('spawn_lost');

        // "governed path, not a bare UPDATE" — the same `task.fail` audit row every other
        // `failTaskRow` caller in this module produces (`transition-log.ts`'s `recordTaskTransition`).
        const audit = await inTx(ownerId, (client) =>
          client.query<{ action: string }>(
            `select action from audit_records
             where workspace_id = $1 and resource_type = 'task' and resource_id = $2
               and action = 'task.fail'`,
            [workspaceId, staleTaskId],
          ),
        );
        expect(audit.rows.length).toBeGreaterThanOrEqual(1);
      });

      it('leaves a freshly `queued` Task alone — the sweep only fires past its own threshold', async () => {
        const freshTaskId = await insertQueuedTask(new Date());

        const supervisorClient = {} as TaskSupervisorClientPort;
        const { privateKey } = await generateEphemeralHandleKeyPair();
        const taskDeps: TaskRuntimeDeps = { pool, privateKey, supervisorClient };

        await runTaskReaper(taskDeps);

        const stillQueued = await inTx(ownerId, (client) =>
          readTaskRow(client, workspaceId, freshTaskId),
        );
        expect(stillQueued?.status).toBe('queued');
      });
    });
  },
);
