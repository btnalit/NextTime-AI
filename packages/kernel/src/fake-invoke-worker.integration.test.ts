import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './adapters/db/migrate.js';
import { createPool, withWorkspace } from './adapters/db/pool.js';
import type { StartTurnInput } from './application/host-bridge/index.js';
import { readTaskRow } from './application/task/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from './application/worker/index.js';
import {
  FakeTaskSupervisorClient,
  createFakeDelegateHandler,
  resolveFakeDelegateTarget,
} from './fake-invoke-worker.js';
import { generateEphemeralHandleKeyPair } from './governance/capability/index.js';
import { startActivity } from './substrate/epistemic/index.js';

/**
 * fake-invoke-worker.integration: DB-gated (real Postgres; auto-skip without DATABASE_URL) tests
 * for STATUS leftover 83's CI-only glue — see fake-invoke-worker.ts's own doc comment for the
 * design. `FakeAgentRuntime`'s own marker/hook plumbing is unit-tested (no IO) in
 * application/host-bridge/fake-runtime.test.ts; this file covers the two pieces that actually
 * touch the database: resolving a delegation target and running a real `invoke_worker` →
 * `report_task_result` round trip end to end.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'fake-invoke-worker — integration (real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

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

    async function adminInsertPrincipal(
      targetWorkspaceId: string,
      displayName: string,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: targetWorkspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', $3)",
            [targetWorkspaceId, id, displayName],
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

    async function publishWorkerDef(
      content: Record<string, unknown>,
    ): Promise<{ readonly id: string; readonly version: number }> {
      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: content,
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return { id: proposed.id, version: proposed.version };
    }

    /** A real `kind='agent_turn'` Activity — `invoke_worker`'s own `tasks.created_by_activity_id`
     *  foreign key (`migrations/task/0001_tasks.sql`) requires one to actually exist; in production
     *  this is exactly the Activity `application/chat`'s `send_chat_message` already created before
     *  the outbox ever delivers `TurnStarted` to `FakeAgentRuntime.startTurn` — this helper mirrors
     *  that, it does not invent a new relationship. */
    async function insertTurnActivity(): Promise<string> {
      const activity = await inTx(ownerId, (client) =>
        startActivity(client, workspaceId, { kind: 'agent_turn', principalId: ownerId }),
      );
      return activity.id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('fake-invoke-worker-integration-test');
      ownerId = await adminInsertPrincipal(workspaceId, 'owner');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('resolveFakeDelegateTarget: undefined when the workspace has published nothing yet', async () => {
      const target = await resolveFakeDelegateTarget(pool, workspaceId, ownerId);
      expect(target).toBeUndefined();
    });

    it('resolveFakeDelegateTarget: the most recently published kind="worker" WorkerDefinition', async () => {
      const first = await publishWorkerDef({ systemPrompt: 'first' });
      const second = await publishWorkerDef({ systemPrompt: 'second' });

      const target = await resolveFakeDelegateTarget(pool, workspaceId, ownerId);
      expect(target).toEqual({ definitionId: second.id, version: second.version });
      expect(target?.definitionId).not.toBe(first.id);
    });

    it('createFakeDelegateHandler + FakeTaskSupervisorClient: a real invoke_worker round trip ends the Task completed', async () => {
      // An ephemeral keypair, not the real mounted files `main()` reads in production/CI — the
      // fake supervisor's own `loadHandlePublicKey` override (below) is exactly the seam
      // `fake-invoke-worker.ts`'s own doc comment says exists for this reason: `resolveCaller`
      // must verify the Handle `mintWorkerRunHandle` (inside `invokeWorker`, below) signs with
      // *this* keypair, not whatever `HANDLE_PUBLIC_KEY_FILE` happens to resolve to here.
      const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
      const supervisorClient = new FakeTaskSupervisorClient({
        pool,
        loadHandlePublicKey: async () => publicKey,
      });
      const onDelegate = createFakeDelegateHandler({ pool, privateKey, supervisorClient });

      const turnId = await insertTurnActivity();
      const input: StartTurnInput = {
        workspaceId,
        chatId: randomUUID(),
        turnId,
        principalId: ownerId,
        prompt: '__nexttime_fake_delegate__ 委派给 ops-runner 重启测试容器',
      };

      const outcome = await onDelegate(input);

      expect(outcome.status).toBe('completed');
      const task = await inTx(ownerId, (client) =>
        readTaskRow(client, workspaceId, outcome.taskId),
      );
      expect(task?.status).toBe('completed');
      expect((task?.result as { summary?: string } | null)?.summary ?? '').toContain(
        'fake worker executor',
      );
    });

    it('createFakeDelegateHandler rejects clearly when the workspace has nothing published to delegate to', async () => {
      const emptyWorkspaceId = await adminInsertWorkspace(
        'fake-invoke-worker-integration-test-empty',
      );
      const emptyOwnerId = await adminInsertPrincipal(emptyWorkspaceId, 'owner');

      const { privateKey } = await generateEphemeralHandleKeyPair();
      const supervisorClient = new FakeTaskSupervisorClient({ pool });
      const onDelegate = createFakeDelegateHandler({ pool, privateKey, supervisorClient });

      await expect(
        onDelegate({
          workspaceId: emptyWorkspaceId,
          chatId: randomUUID(),
          // Never reaches the invoke_worker/tasks INSERT (resolveFakeDelegateTarget finds nothing
          // and this rejects first) — an arbitrary id here is safe, unlike the happy-path test above.
          turnId: randomUUID(),
          principalId: emptyOwnerId,
          prompt: '__nexttime_fake_delegate__ 委派',
        }),
      ).rejects.toThrow(/no published/);
    });
  },
);
