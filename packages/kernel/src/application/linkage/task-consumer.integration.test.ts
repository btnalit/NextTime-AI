import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, HandleClaims } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import {
  type IssuedHandle,
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { newChat } from '../chat/index.js';
import { completeTaskWithResult, invokeWorker, readTask } from '../task/index.js';
import type { TaskRuntimeDeps } from '../task/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { drainPendingContextItems } from './store.js';
import { registerTaskUpdatedConsumer } from './task-consumer.js';
import type { TaskUpdatedSource } from './task-consumer.js';

/**
 * application/linkage/task-consumer.integration: DB-gated end-to-end test for docs/development-
 * tasks.md S2.11's own named acceptance scenario: "invoke a Task from a Turn (fake supervisor),
 * publish TaskUpdated{completed} → system message lands in the right chat and get_entry_context on
 * the next Turn includes the outcome once."
 *
 * Fixture/harness style matches `application/task/invoke.integration.test.ts` (same admin-insert
 * helpers, same `FakeTaskSupervisorClient`) and `application/host-bridge/
 * turn-started-consumer.test.ts` (same "fake dispatcher that captures the registered consumer and
 * lets a test `emit` a synthetic event" pattern) — reused rather than re-invented.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly spawnCalls: TaskSpawnInput[] = [];
  private readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    this.spawnCalls.push(input);
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.10',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.10' };
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

/** Same "fake dispatcher that captures the registered consumer" pattern as
 *  `application/host-bridge/turn-started-consumer.test.ts`'s own `createFakeDispatcher`. */
function createFakeTaskUpdatedDispatcher(): TaskUpdatedSource & {
  emit: (
    outboxId: string,
    event: Parameters<Parameters<TaskUpdatedSource['subscribe']>[1]>[0],
  ) => Promise<void>;
} {
  let registered: Parameters<TaskUpdatedSource['subscribe']>[1] | undefined;
  return {
    subscribe: (_eventType, consumer) => {
      registered = consumer;
      return () => {
        registered = undefined;
      };
    },
    emit: async (outboxId, event) => {
      await registered?.(event, { outboxId, workspaceId: event.workspaceId });
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/linkage/task-consumer — integration (real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let workerDefinitionId: string;

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

    async function insertSession(
      kind: string,
      principalId: string,
      onBehalfOf: string,
    ): Promise<string> {
      return inTx(principalId, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $4, 'active') returning id`,
          [workspaceId, principalId, kind, onBehalfOf],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('failed to insert session');
        return id;
      });
    }

    async function issueTestHandle(
      sessionId: string,
      scope: CapabilityScope,
    ): Promise<IssuedHandle> {
      return inTx(ownerId, (client) =>
        issueHandle(client, { sessionId, scope, ttlSeconds: 3600, privateKey }),
      );
    }

    function claimsFromIssued(issued: IssuedHandle): HandleClaims {
      return {
        ws: issued.workspaceId,
        sid: issued.sessionId,
        obo: issued.onBehalfOf,
        scope: issued.scope,
        jti: issued.jti,
        iat: Math.floor(issued.issuedAt.getTime() / 1000),
        exp: Math.floor(issued.expiresAt.getTime() / 1000),
        ...(issued.parentJti !== undefined ? { par: issued.parentJti } : {}),
      };
    }

    function deps(supervisorClient: FakeTaskSupervisorClient): TaskRuntimeDeps {
      return { pool, privateKey, supervisorClient };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const keyPair = await generateEphemeralHandleKeyPair();
      privateKey = keyPair.privateKey;

      workspaceId = await adminInsertWorkspace('linkage-task-consumer-integration-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');

      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You are a plain worker.' },
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      workerDefinitionId = proposed.id;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('TaskUpdated{completed}: system message lands in the originating Chat, context item delivered exactly once', async () => {
      // Set up the Turn: a Chat + a running agent_turn Activity referencing it — exactly the shape
      // `application/gateway/handlers.ts`'s `invokeWorkerHandler` resolves via
      // `findAttributableTurn` before calling `invokeWorker`; this test calls `invokeWorker`
      // directly with the resolved `turnId`, since that hand-off (not the resolution itself, which
      // has its own unit tests) is what this file is testing.
      const chat = await inTx(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      const turn = await inTx(ownerId, (client) =>
        startActivity(client, workspaceId, {
          kind: 'agent_turn',
          chatId: chat.id,
          principalId: ownerId,
        }),
      );

      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new FakeTaskSupervisorClient();

      const spawnResult = await invokeWorker(
        workspaceId,
        {
          principalId: ownerId,
          channel: 'handle',
          claims: claimsFromIssued(issued),
          turnId: turn.id,
        },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        deps(supervisorClient),
      );

      const taskAfterSpawn = await inTx(ownerId, (client) =>
        readTask(client, workspaceId, spawnResult.taskId),
      );
      expect(taskAfterSpawn?.createdByActivityId).toBe(turn.id);

      // Drive the Task to `completed` — this is the real recordTaskTransition/enqueue path
      // (application/task/transition-log.ts), so a genuine TaskUpdated row lands in `outbox`.
      await inTx(ownerId, (client) =>
        completeTaskWithResult(
          client,
          workspaceId,
          ownerId,
          spawnResult.taskId,
          spawnResult.workerRunId,
          { summary: 'did the thing' },
        ),
      );

      const outboxRow = await inTx(ownerId, async (client) => {
        const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
          `select id, payload from outbox
           where workspace_id = $1 and event_type = 'TaskUpdated'
             and payload->>'taskId' = $2 and payload->>'status' = 'completed'
           order by id desc limit 1`,
          [workspaceId, spawnResult.taskId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('expected a TaskUpdated{completed} outbox row');
        return row;
      });

      const dispatcher = createFakeTaskUpdatedDispatcher();
      registerTaskUpdatedConsumer(dispatcher, { pool });
      await dispatcher.emit(outboxRow.id, outboxRow.payload as never);

      // The system message landed in the *originating* Chat.
      const messages = await inTx(ownerId, async (client) => {
        const result = await client.query<{ role: string; content: Record<string, unknown> }>(
          `select role, content from chat_messages
           where workspace_id = $1 and chat_id = $2
           order by sequence asc`,
          [workspaceId, chat.id],
        );
        return result.rows;
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('system');
      expect(messages[0]?.content).toMatchObject({
        kind: 'system.task_update',
        taskId: spawnResult.taskId,
        status: 'completed',
        summary: 'did the thing',
      });

      // get_entry_context's own read path (drainPendingContextItems) sees the outcome exactly
      // once — the first drain returns it and marks it delivered, the second drain (simulating the
      // *next* Turn's context call) sees nothing.
      const firstDrain = await inTx(ownerId, (client) =>
        drainPendingContextItems(client, workspaceId, ownerId),
      );
      expect(firstDrain.tasks).toHaveLength(1);
      expect(firstDrain.tasks[0]).toMatchObject({
        taskId: spawnResult.taskId,
        status: 'completed',
      });
      expect(firstDrain.pendingApprovals).toHaveLength(0);

      const secondDrain = await inTx(ownerId, (client) =>
        drainPendingContextItems(client, workspaceId, ownerId),
      );
      expect(secondDrain.tasks).toHaveLength(0);
    });

    it('redelivering the identical outbox row does not duplicate the context item (unique index)', async () => {
      const chat = await inTx(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      const turn = await inTx(ownerId, (client) =>
        startActivity(client, workspaceId, {
          kind: 'agent_turn',
          chatId: chat.id,
          principalId: ownerId,
        }),
      );
      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new FakeTaskSupervisorClient();

      const spawnResult = await invokeWorker(
        workspaceId,
        {
          principalId: ownerId,
          channel: 'handle',
          claims: claimsFromIssued(issued),
          turnId: turn.id,
        },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        deps(supervisorClient),
      );
      await inTx(ownerId, (client) =>
        completeTaskWithResult(
          client,
          workspaceId,
          ownerId,
          spawnResult.taskId,
          spawnResult.workerRunId,
          { summary: 'done again' },
        ),
      );
      const outboxRow = await inTx(ownerId, async (client) => {
        const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
          `select id, payload from outbox
           where workspace_id = $1 and event_type = 'TaskUpdated'
             and payload->>'taskId' = $2 and payload->>'status' = 'completed'
           order by id desc limit 1`,
          [workspaceId, spawnResult.taskId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('expected a TaskUpdated{completed} outbox row');
        return row;
      });

      // A *fresh* dispatcher/consumer registration — simulates the redelivery happening in a
      // different process lifetime, where the in-memory `seenOutboxIds` guard would not help
      // either (`pending_context_items_dedupe_uidx` is the durable guard for this row).
      const dispatcherA = createFakeTaskUpdatedDispatcher();
      registerTaskUpdatedConsumer(dispatcherA, { pool });
      await dispatcherA.emit(outboxRow.id, outboxRow.payload as never);

      const dispatcherB = createFakeTaskUpdatedDispatcher();
      registerTaskUpdatedConsumer(dispatcherB, { pool });
      await dispatcherB.emit(outboxRow.id, outboxRow.payload as never);

      const itemCount = await inTx(ownerId, async (client) => {
        const result = await client.query<{ count: string }>(
          `select count(*)::bigint as count from pending_context_items
           where workspace_id = $1 and principal_id = $2 and subject_id = $3`,
          [workspaceId, ownerId, spawnResult.taskId],
        );
        return Number(result.rows[0]?.count ?? 0);
      });
      expect(itemCount).toBe(1);
    });
  },
);
