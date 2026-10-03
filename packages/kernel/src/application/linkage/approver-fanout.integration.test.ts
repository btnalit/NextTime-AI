import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { approverHasScope, requestAction } from '../../governance/approval/index.js';
import { GATEKEEPER_GRANT_CAPABILITY, grantCapability } from '../../governance/capability/index.js';
import { type PrincipalPushEvent, subscribeToPrincipalPushEvents } from '../chat/index.js';
import {
  type ActionRequestEventSource,
  registerActionRequestConsumers,
} from './action-request-consumer.js';

/**
 * application/linkage/approver-fanout.integration: R-38 (maintainer decision D-13, docs/
 * code-review-2026-10-02.md) — the "Approval needed" fan-out goes only to principals who could
 * actually decide the request: active (not disabled), a role that satisfies `approve`'s `minRole`,
 * and a matching scope (owner, or a grant — here the gatekeeper grant on the request's gate).
 *
 *   - a disabled owner and a disabled operator with the grant: no push, no system message;
 *   - a member with the gatekeeper grant (their agent may use the gate, they may not approve):
 *     no push, no system message;
 *   - an operator with no grant: no push;
 *   - the active owner and the operator with the grant: the push and a holder card;
 *   - the requester still gets the status push and their status-only message.
 *
 * The decision side is checked with the same inputs (`approverHasScope`, `decide.ts`'s I14
 * precheck): the member with the grant is refused, the operator with the grant is not.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

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
  'R-38 approval fan-out = principals who could decide (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let disabledOwnerId: string;
    let operatorWithGrantId: string;
    let disabledOperatorWithGrantId: string;
    let memberWithGrantId: string;
    let operatorNoGrantId: string;
    let requesterId: string;
    let gatekeeperId: string;
    const unsubscribers: (() => void)[] = [];

    async function adminInsertPrincipal(
      role: Role,
      displayName: string,
      options: { readonly disabled?: boolean } = {},
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, disabled_at)
             values ($1, $2, 'human', $3, $4, case when $5::boolean then now() end)`,
            [workspaceId, id, role, displayName, options.disabled === true],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function chatMessageCount(principalId: string): Promise<number> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const result = await client.query<{ n: string }>(
          `select count(*)::bigint as n from chat_messages cm
           join chats c on c.workspace_id = cm.workspace_id and c.id = cm.chat_id
           where cm.workspace_id = $1 and c.owner_principal_id = $2`,
          [workspaceId, principalId],
        );
        return Number(result.rows[0]?.n ?? 0);
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'linkage-approver-fanout-integration-test',
          ]);
        },
        { skipRoleSwitch: true },
      );
      ownerId = await adminInsertPrincipal('owner', 'owner');
      disabledOwnerId = await adminInsertPrincipal('owner', 'disabled-owner', { disabled: true });
      operatorWithGrantId = await adminInsertPrincipal('operator', 'operator-with-grant');
      disabledOperatorWithGrantId = await adminInsertPrincipal(
        'operator',
        'disabled-operator-with-grant',
        { disabled: true },
      );
      memberWithGrantId = await adminInsertPrincipal('member', 'member-with-grant');
      operatorNoGrantId = await adminInsertPrincipal('operator', 'operator-no-grant');
      requesterId = await adminInsertPrincipal('member', 'requester');

      gatekeeperId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const id = randomUUID();
          await client.query(
            "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
            [workspaceId, id],
          );
          return id;
        },
      );

      // The ordinary console grant ("授权给成员"): a gatekeeper grant on this one gate.
      for (const principalId of [
        operatorWithGrantId,
        disabledOperatorWithGrantId,
        memberWithGrantId,
        requesterId,
      ]) {
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          grantCapability(client, workspaceId, {
            principalId,
            resourceType: GATEKEEPER_GRANT_CAPABILITY,
            resourceId: gatekeeperId,
            grantedBy: ownerId,
          }),
        );
      }
    });

    afterEach(() => {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    });

    afterAll(async () => {
      await pool.end();
    });

    it('pushes "Approval needed" only to active principals whose role may approve and who hold the scope', async () => {
      const requesterScope: CapabilityScope = {
        capabilities: ['request_action'],
        resources: { gatekeeper: [gatekeeperId] },
      };
      const row = await withWorkspace(pool, { workspaceId, principalId: requesterId }, (client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind: 'fanout.test.action',
          resourceScope: gatekeeperId,
          blastRadius: 'medium',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: requesterId,
          actorRuntime: 'pi',
          requesterScope,
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
      expect([...(holderPrincipalIds ?? [])].sort()).toEqual([ownerId, operatorWithGrantId].sort());

      const everyone = [
        ownerId,
        disabledOwnerId,
        operatorWithGrantId,
        disabledOperatorWithGrantId,
        memberWithGrantId,
        operatorNoGrantId,
        requesterId,
      ];
      const pushes = new Map<string, PrincipalPushEvent[]>(everyone.map((id) => [id, []]));
      for (const principalId of everyone) {
        unsubscribers.push(
          subscribeToPrincipalPushEvents(principalId, (event) => {
            pushes.get(principalId)?.push(event);
          }),
        );
      }
      const messagesBefore = new Map<string, number>();
      for (const principalId of everyone) {
        messagesBefore.set(principalId, await chatMessageCount(principalId));
      }

      const dispatcher = createFakeDispatcher();
      registerActionRequestConsumers(dispatcher, { pool });
      await dispatcher.emit('ActionRequestPending', outboxRow.id, outboxRow.payload as never);

      const pushedTo = everyone.filter((id) =>
        (pushes.get(id) ?? []).some((event) => event.type === 'action.pending'),
      );
      expect(pushedTo.sort()).toEqual([ownerId, operatorWithGrantId, requesterId].sort());

      for (const principalId of [
        disabledOwnerId,
        disabledOperatorWithGrantId,
        memberWithGrantId,
        operatorNoGrantId,
      ]) {
        expect(await chatMessageCount(principalId)).toBe(messagesBefore.get(principalId));
      }
      for (const principalId of [ownerId, operatorWithGrantId, requesterId]) {
        expect(await chatMessageCount(principalId)).toBe(
          (messagesBefore.get(principalId) ?? 0) + 1,
        );
      }

      // One predicate: the decision-side I14 precheck agrees with the fan-out.
      const target = { actionKind: row.actionKind, resourceScope: row.resourceScope };
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        await expect(
          approverHasScope(
            client,
            workspaceId,
            { principalId: operatorWithGrantId, role: 'operator' },
            target,
          ),
        ).resolves.toBe(true);
        await expect(
          approverHasScope(
            client,
            workspaceId,
            { principalId: memberWithGrantId, role: 'member' },
            target,
          ),
        ).resolves.toBe(false);
        await expect(
          approverHasScope(
            client,
            workspaceId,
            { principalId: operatorNoGrantId, role: 'operator' },
            target,
          ),
        ).resolves.toBe(false);
      });
    });
  },
);
