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
             false, $3, $4, 'worker')
           returning id`,
            [workspaceId, gatekeeperObjectId, ownerId, workerRunId],
          );
          return result.rows[0]?.id as string;
        });

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
            actionKind: 'test.restart',
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
  },
);
