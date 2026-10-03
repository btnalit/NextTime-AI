import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { approveActionRequest, requestAction } from '../../governance/approval/index.js';
import { grantCapability } from '../../governance/capability/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { newChat } from '../chat/index.js';
import {
  type ActionRequestEventSource,
  registerActionRequestConsumers,
} from './action-request-consumer.js';
import { leaseContextItemsToTurn, peekContextItems } from './store.js';

/**
 * application/linkage/action-request-consumer.integration: DB-gated end-to-end test for docs/
 * development-tasks.md S2.11's own named acceptance scenario: "ActionRequestPending with two
 * holders → card message in both holders' chats, status-only in the requester's."
 *
 * Reuses `governance/approval/service.integration.test.ts`'s exact `requestAction` recipe for
 * producing a real `pending_approval` row with a real holder fan-out (`blastRadius: 'medium'`,
 * `operationAutoApprovable: true` → policy `require_approval`) rather than hand-writing one.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const GATEKEEPER_RESOURCE_SCOPE = 'gatekeeper';

function scopeCovering(...gatekeeperIds: string[]): CapabilityScope {
  return {
    capabilities: ['request_action'],
    resources: { [GATEKEEPER_RESOURCE_SCOPE]: gatekeeperIds },
  };
}

type Consumer = Parameters<ActionRequestEventSource['subscribe']>[1];

function createFakeDispatcher(): ActionRequestEventSource & {
  emit: (
    eventType: 'ActionRequestPending' | 'ActionRequestUpdated',
    outboxId: string,
    event: Parameters<Consumer>[0],
  ) => Promise<void>;
} {
  const registered = new Map<string, Consumer>();
  return {
    subscribe: (eventType, consumer) => {
      registered.set(eventType, consumer as Consumer);
      return () => {
        registered.delete(eventType);
      };
    },
    emit: async (eventType, outboxId, event) => {
      await registered.get(eventType)?.(event, { outboxId, workspaceId: event.workspaceId });
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/linkage/action-request-consumer — integration (real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string; // workspace owner — automatically a holder (I14)
    let holderId: string; // operator with a matching capability_grants row — the second holder
    let requesterId: string; // member, no grant, not owner — on_behalf_of, not a holder
    let gatekeeperId: string;

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

    async function insertGatekeeperObject(principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [workspaceId, id],
        );
        return id;
      });
    }

    async function chatMessagesFor(
      principalId: string,
    ): Promise<readonly { role: string; content: Record<string, unknown> }[]> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const result = await client.query<{ role: string; content: Record<string, unknown> }>(
          `select cm.role, cm.content from chat_messages cm
           join chats c on c.workspace_id = cm.workspace_id and c.id = cm.chat_id
           where cm.workspace_id = $1 and c.owner_principal_id = $2
           order by cm.sequence asc`,
          [workspaceId, principalId],
        );
        return result.rows;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('linkage-action-request-consumer-integration-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      holderId = await adminInsertPrincipal('operator', 'holder-with-grant');
      requesterId = await adminInsertPrincipal('member', 'requester-no-grant');
      gatekeeperId = await insertGatekeeperObject(ownerId);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId: holderId,
          resourceType: 'linkage.test.action',
          grantedBy: ownerId,
        }),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('ActionRequestPending: card message in both holders’ Chats, status-only in the requester’s', async () => {
      const row = await withWorkspace(pool, { workspaceId, principalId: requesterId }, (client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind: 'linkage.test.action',
          blastRadius: 'medium',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: requesterId,
          actorRuntime: 'pi',
          requesterScope: scopeCovering(gatekeeperId),
        }),
      );
      expect(row.status).toBe('pending_approval');

      const outboxRow = await withWorkspace(
        pool,
        { workspaceId, principalId: requesterId },
        async (client) => {
          const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
            `select id, payload from outbox
             where workspace_id = $1 and event_type = 'ActionRequestPending'
               and payload->>'actionRequestId' = $2
             order by id desc limit 1`,
            [workspaceId, row.id],
          );
          const found = result.rows[0];
          if (!found) throw new Error('expected an ActionRequestPending outbox row');
          return found;
        },
      );
      const holderPrincipalIds = (outboxRow.payload as { holderPrincipalIds?: string[] })
        .holderPrincipalIds;
      expect(holderPrincipalIds).toEqual(expect.arrayContaining([ownerId, holderId]));
      expect(holderPrincipalIds).not.toContain(requesterId);

      const dispatcher = createFakeDispatcher();
      registerActionRequestConsumers(dispatcher, { pool });
      await dispatcher.emit('ActionRequestPending', outboxRow.id, outboxRow.payload as never);

      // Both holders got a card message (isHolder: true) in their own Chat.
      for (const holder of [ownerId, holderId]) {
        const messages = await chatMessagesFor(holder);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.role).toBe('system');
        expect(messages[0]?.content).toMatchObject({
          kind: 'system.action_pending',
          actionRequestId: row.id,
          isHolder: true,
        });
      }

      // The requester got a status-only message (isHolder: false).
      const requesterMessages = await chatMessagesFor(requesterId);
      expect(requesterMessages).toHaveLength(1);
      expect(requesterMessages[0]?.content).toMatchObject({
        kind: 'system.action_pending',
        actionRequestId: row.id,
        isHolder: false,
      });

      // Only the requester gets a pending_context_items row (§8.5: holders act through the web
      // queue, not next-turn context — see action-request-consumer.ts's own doc comment).
      const requesterContext = await withWorkspace(
        pool,
        { workspaceId, principalId: requesterId },
        (client) => peekContextItems(client, workspaceId, requesterId),
      );
      expect(requesterContext.pendingApprovals).toHaveLength(1);
      expect(requesterContext.pendingApprovals[0]).toMatchObject({ actionRequestId: row.id });

      const holderContext = await withWorkspace(
        pool,
        { workspaceId, principalId: holderId },
        (client) => peekContextItems(client, workspaceId, holderId),
      );
      expect(holderContext.pendingApprovals).toHaveLength(0);

      // ActionRequestUpdated (approve, by a holder) fans out an update message too.
      const approved = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId: row.id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
      expect(approved.status).toBe('approved');

      const updatedOutboxRow = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
            `select id, payload from outbox
             where workspace_id = $1 and event_type = 'ActionRequestUpdated'
               and payload->>'actionRequestId' = $2 and payload->>'status' = 'approved'
             order by id desc limit 1`,
            [workspaceId, row.id],
          );
          const found = result.rows[0];
          if (!found) throw new Error('expected an ActionRequestUpdated{approved} outbox row');
          return found;
        },
      );
      await dispatcher.emit(
        'ActionRequestUpdated',
        updatedOutboxRow.id,
        updatedOutboxRow.payload as never,
      );

      const requesterMessagesAfterApproval = await chatMessagesFor(requesterId);
      expect(requesterMessagesAfterApproval).toHaveLength(2);
      expect(requesterMessagesAfterApproval[1]?.content).toMatchObject({
        kind: 'system.action_update',
        actionRequestId: row.id,
        status: 'approved',
        isHolder: false,
      });
    });

    // Lane-4 P3 fix (docs/development-tasks.md; action-request-consumer.ts's own module doc
    // comment has the full decision writeup): a single-owner workspace's owner is automatically a
    // holder (I14) — when that same owner is *also* the requester (they asked their own entry
    // agent to do the thing), the old `isHolder ? undefined : {...}` condition silently dropped
    // their pending_context_items row, since `isHolder` was true. The entry agent acting for that
    // owner would then never learn, via get_entry_context, what happened to an action it had just
    // asked for — the exact scenario this test covers.
    it('a requester who is also a holder (single-owner workspace) still gets pending_context_items', async () => {
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind: 'linkage.test.action',
          blastRadius: 'medium',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: ownerId,
          actorRuntime: 'pi',
          requesterScope: scopeCovering(gatekeeperId),
        }),
      );
      expect(row.status).toBe('pending_approval');

      const outboxRow = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
            `select id, payload from outbox
           where workspace_id = $1 and event_type = 'ActionRequestPending'
             and payload->>'actionRequestId' = $2
           order by id desc limit 1`,
            [workspaceId, row.id],
          );
          const found = result.rows[0];
          if (!found) throw new Error('expected an ActionRequestPending outbox row');
          return found;
        },
      );
      const holderPrincipalIds = (outboxRow.payload as { holderPrincipalIds?: string[] })
        .holderPrincipalIds;
      // ownerId is both the requester (onBehalfOf above) and a holder — I14.
      expect(holderPrincipalIds).toContain(ownerId);

      // ownerId's own Chat already accumulated messages from the earlier test in this same
      // describe block (ownerId is a holder there too) — this test only asserts on the *new*
      // message this dispatch adds, not on an absolute count from an assumed-empty Chat.
      const ownerMessagesBefore = await chatMessagesFor(ownerId);

      const dispatcher = createFakeDispatcher();
      registerActionRequestConsumers(dispatcher, { pool });
      await dispatcher.emit('ActionRequestPending', outboxRow.id, outboxRow.payload as never);

      // The card message still shows isHolder:true (unaffected — that field governs the chat
      // message's own rendering, not the context-injection decision below).
      const ownerMessages = await chatMessagesFor(ownerId);
      expect(ownerMessages).toHaveLength(ownerMessagesBefore.length + 1);
      expect(ownerMessages.at(-1)?.content).toMatchObject({
        kind: 'system.action_pending',
        actionRequestId: row.id,
        isHolder: true,
      });

      // The fix under test: despite isHolder:true, a pending_context_items row is still written,
      // because ownerId is also the requester.
      const ownerContext = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => peekContextItems(client, workspaceId, ownerId),
      );
      expect(ownerContext.pendingApprovals).toHaveLength(1);
      expect(ownerContext.pendingApprovals[0]).toMatchObject({ actionRequestId: row.id });
    });

    // Leftover 78 (docs/STATUS.md §4): `resolveDefaultChat`'s "most recently created Chat" rule is
    // resolved independently per outbox event — a `system.action_update` for an ActionRequest whose
    // `system.action_pending` card landed in an older Chat must still land there too, even if the
    // principal created a newer Chat in between. A fresh principal is used so this test's own two
    // Chats are the only ones that exist for it (no interference from the earlier tests in this
    // shared workspace, which already wrote into ownerId's/holderId's/requesterId's default Chats).
    it('system.action_update stays pinned to the Chat that received system.action_pending, even after a newer Chat is created (leftover 78)', async () => {
      const pinnedPrincipalId = await adminInsertPrincipal('member', 'pinned-chat-requester');

      const olderChat = await withWorkspace(
        pool,
        { workspaceId, principalId: pinnedPrincipalId },
        (client) => newChat(client, workspaceId, pinnedPrincipalId, {}),
      );

      const row = await withWorkspace(
        pool,
        { workspaceId, principalId: pinnedPrincipalId },
        (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'linkage.test.action',
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: pinnedPrincipalId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(gatekeeperId),
          }),
      );
      expect(row.status).toBe('pending_approval');

      const pendingOutboxRow = await withWorkspace(
        pool,
        { workspaceId, principalId: pinnedPrincipalId },
        async (client) => {
          const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
            `select id, payload from outbox
             where workspace_id = $1 and event_type = 'ActionRequestPending'
               and payload->>'actionRequestId' = $2
             order by id desc limit 1`,
            [workspaceId, row.id],
          );
          const found = result.rows[0];
          if (!found) throw new Error('expected an ActionRequestPending outbox row');
          return found;
        },
      );

      const dispatcher = createFakeDispatcher();
      registerActionRequestConsumers(dispatcher, { pool });
      await dispatcher.emit(
        'ActionRequestPending',
        pendingOutboxRow.id,
        pendingOutboxRow.payload as never,
      );

      // The pending card landed in the older Chat — the only one that existed at the time.
      const pendingInOlderChat = await withWorkspace(
        pool,
        { workspaceId, principalId: pinnedPrincipalId },
        (client) =>
          client.query<{ content: Record<string, unknown> }>(
            'select content from chat_messages where workspace_id = $1 and chat_id = $2',
            [workspaceId, olderChat.id],
          ),
      );
      expect(pendingInOlderChat.rows).toHaveLength(1);
      expect(pendingInOlderChat.rows[0]?.content).toMatchObject({ kind: 'system.action_pending' });

      // A newer Chat is created afterwards — `resolveDefaultChat`'s own "most recently created"
      // rule would otherwise pick this one for the update message.
      const newerChat = await withWorkspace(
        pool,
        { workspaceId, principalId: pinnedPrincipalId },
        (client) => newChat(client, workspaceId, pinnedPrincipalId, {}),
      );

      const approved = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId: row.id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
      expect(approved.status).toBe('approved');

      const updatedOutboxRow = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
            `select id, payload from outbox
             where workspace_id = $1 and event_type = 'ActionRequestUpdated'
               and payload->>'actionRequestId' = $2 and payload->>'status' = 'approved'
             order by id desc limit 1`,
            [workspaceId, row.id],
          );
          const found = result.rows[0];
          if (!found) throw new Error('expected an ActionRequestUpdated{approved} outbox row');
          return found;
        },
      );
      await dispatcher.emit(
        'ActionRequestUpdated',
        updatedOutboxRow.id,
        updatedOutboxRow.payload as never,
      );

      // The update is pinned to the OLDER Chat, not the newer one `resolveDefaultChat` would have
      // picked.
      const olderChatMessagesAfter = await withWorkspace(
        pool,
        { workspaceId, principalId: pinnedPrincipalId },
        (client) =>
          client.query<{ content: Record<string, unknown> }>(
            'select content from chat_messages where workspace_id = $1 and chat_id = $2 order by sequence asc',
            [workspaceId, olderChat.id],
          ),
      );
      expect(olderChatMessagesAfter.rows).toHaveLength(2);
      expect(olderChatMessagesAfter.rows[1]?.content).toMatchObject({
        kind: 'system.action_update',
        status: 'approved',
      });

      const newerChatMessages = await withWorkspace(
        pool,
        { workspaceId, principalId: pinnedPrincipalId },
        (client) =>
          client.query(
            'select content from chat_messages where workspace_id = $1 and chat_id = $2',
            [workspaceId, newerChat.id],
          ),
      );
      expect(newerChatMessages.rows).toHaveLength(0);
    });

    // 2026-10-02 review R-57 (decision D-23: items belong to the Chat that started them): an
    // ActionRequest raised by a Worker belongs, for its requester, to the Chat whose Turn invoked
    // that Worker — its pending card, its update and its context items — not to whichever Chat the
    // requester created last, and a Turn of another Chat never sees its context items.
    it('a Worker-raised ActionRequest lands in the Chat whose Turn invoked the Worker, message and context items alike', async () => {
      const requester = await adminInsertPrincipal('member', 'worker-raised-requester');
      const asRequester = <T>(fn: (client: PoolClient) => Promise<T>) =>
        withWorkspace(pool, { workspaceId, principalId: requester }, fn);

      const originChat = await asRequester((client) => newChat(client, workspaceId, requester, {}));
      const originTurn = await asRequester((client) =>
        startActivity(client, workspaceId, {
          kind: 'agent_turn',
          chatId: originChat.id,
          principalId: requester,
        }),
      );
      // The Task that Turn invoked, and its WorkerRun — inserted directly: only the
      // `parent_worker_run_id → worker_runs.task_id → tasks.created_by_activity_id` chain matters.
      const workerRunId = await withWorkspace(
        pool,
        { workspaceId, principalId: requester },
        async (client) => {
          const task = await client.query<{ id: string }>(
            `insert into tasks (workspace_id, status, on_behalf_of, created_by_activity_id,
                                worker_definition_id, worker_definition_version)
             values ($1, 'running', $2, $3, $4, 1) returning id`,
            [workspaceId, requester, originTurn.id, randomUUID()],
          );
          const run = await client.query<{ id: string }>(
            `insert into worker_runs (workspace_id, status, task_id)
             values ($1, 'running', $2) returning id`,
            [workspaceId, task.rows[0]?.id],
          );
          const id = run.rows[0]?.id;
          if (!id) throw new Error('failed to insert worker run');
          return id;
        },
        { skipRoleSwitch: true },
      );
      // Created after the origin Chat: `resolveDefaultChat` would pick this one.
      const newerChat = await asRequester((client) => newChat(client, workspaceId, requester, {}));
      const newerTurn = await asRequester((client) =>
        startActivity(client, workspaceId, {
          kind: 'agent_turn',
          chatId: newerChat.id,
          principalId: requester,
        }),
      );

      const row = await asRequester((client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind: 'linkage.test.action',
          blastRadius: 'medium',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: requester,
          actorRuntime: 'pi',
          requesterScope: scopeCovering(gatekeeperId),
          parentWorkerRunId: workerRunId,
        }),
      );
      expect(row.status).toBe('pending_approval');

      async function outboxRowFor(eventType: string, status?: string) {
        return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const result = await client.query<{ id: string; payload: Record<string, unknown> }>(
            `select id, payload from outbox
             where workspace_id = $1 and event_type = $2 and payload->>'actionRequestId' = $3
               and ($4::text is null or payload->>'status' = $4)
             order by id desc limit 1`,
            [workspaceId, eventType, row.id, status ?? null],
          );
          const found = result.rows[0];
          if (!found) throw new Error(`expected an ${eventType} outbox row`);
          return found;
        });
      }
      async function messageKindsIn(chatId: string): Promise<unknown[]> {
        const result = await asRequester((client) =>
          client.query<{ content: Record<string, unknown> }>(
            'select content from chat_messages where workspace_id = $1 and chat_id = $2 order by sequence asc',
            [workspaceId, chatId],
          ),
        );
        return result.rows.map((message) => message.content.kind);
      }

      const dispatcher = createFakeDispatcher();
      registerActionRequestConsumers(dispatcher, { pool });
      const pending = await outboxRowFor('ActionRequestPending');
      await dispatcher.emit('ActionRequestPending', pending.id, pending.payload as never);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        approveActionRequest(client, workspaceId, {
          actionRequestId: row.id,
          approverPrincipalId: ownerId,
          approverRole: 'owner',
        }),
      );
      const updated = await outboxRowFor('ActionRequestUpdated', 'approved');
      await dispatcher.emit('ActionRequestUpdated', updated.id, updated.payload as never);

      expect(await messageKindsIn(originChat.id)).toEqual([
        'system.action_pending',
        'system.action_update',
      ]);
      expect(await messageKindsIn(newerChat.id)).toEqual([]);

      const newerChatContext = await asRequester((client) =>
        leaseContextItemsToTurn(client, workspaceId, requester, {
          turnId: newerTurn.id,
          chatId: newerChat.id,
        }),
      );
      expect(newerChatContext.pendingApprovals).toHaveLength(0);

      const originChatContext = await asRequester((client) =>
        leaseContextItemsToTurn(client, workspaceId, requester, {
          turnId: originTurn.id,
          chatId: originChat.id,
        }),
      );
      expect(originChatContext.pendingApprovals).toHaveLength(2);
      expect(originChatContext.pendingApprovals[0]).toMatchObject({
        kind: 'system.action_pending',
        actionRequestId: row.id,
      });
      expect(originChatContext.pendingApprovals[1]).toMatchObject({
        kind: 'system.action_update',
        actionRequestId: row.id,
        status: 'approved',
      });
    });
  },
);
