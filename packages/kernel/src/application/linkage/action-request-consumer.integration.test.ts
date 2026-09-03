import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { approveActionRequest, requestAction } from '../../governance/approval/index.js';
import { grantCapability } from '../../governance/capability/index.js';
import {
  type ActionRequestEventSource,
  registerActionRequestConsumers,
} from './action-request-consumer.js';
import { drainPendingContextItems } from './store.js';

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
          capability: 'linkage.test.action',
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
      const requesterDrain = await withWorkspace(
        pool,
        { workspaceId, principalId: requesterId },
        (client) => drainPendingContextItems(client, workspaceId, requesterId),
      );
      expect(requesterDrain.pendingApprovals).toHaveLength(1);
      expect(requesterDrain.pendingApprovals[0]).toMatchObject({ actionRequestId: row.id });

      const holderDrain = await withWorkspace(
        pool,
        { workspaceId, principalId: holderId },
        (client) => drainPendingContextItems(client, workspaceId, holderId),
      );
      expect(holderDrain.pendingApprovals).toHaveLength(0);

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
  },
);
