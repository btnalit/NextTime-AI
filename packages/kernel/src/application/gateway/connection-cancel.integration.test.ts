import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition, type Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ConnectionRequestNotFoundError } from '../../governance/connections/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/connection-cancel.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) end-to-end test, through `dispatchCapability`, for S6-A C26's
 * `cancel_connection_request` (docs/console-completion-plan.md §5.6, §6; runbook web-console.md
 * 已知缺口 8): the requester cancels their own `requested` card, another member is 403, the
 * workspace owner may cancel any, a non-`requested` row is 409 `IllegalTransition`, an unknown
 * id 404, the wire row carries `status: 'cancelled'`, and `list_connection_requests
 * {status:'cancelled'}` lists it. The service-level state machine and audit row are covered in
 * governance/connections/service.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

interface ConnectionRequestWire {
  id: string;
  status: string;
  requestedBy: string;
  gatekeeperId: string | null;
  completedAt: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'S6-A cancel_connection_request (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberAId: string;
    let memberBId: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      memberAId = randomUUID();
      memberBId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'connection-cancel-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'),
                    ($1, $3, 'human', 'member', 'member-a'),
                    ($1, $4, 'human', 'member', 'member-b')`,
            [workspaceId, ownerId, memberAId, memberBId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    async function request(caller: ResolvedCaller, target: string): Promise<ConnectionRequestWire> {
      return (await dispatchCapability({ pool }, caller, 'request_connection', {
        kind: 'http',
        target,
      })) as ConnectionRequestWire;
    }

    it('the requester cancels their own request; the wire row and the owner queue both show status cancelled', async () => {
      const memberA = humanCaller(workspaceId, memberAId, 'member');
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const requested = await request(memberA, 'own-request');
      expect(requested.status).toBe('requested');

      const cancelled = (await dispatchCapability({ pool }, memberA, 'cancel_connection_request', {
        connectionRequestId: requested.id,
      })) as ConnectionRequestWire;
      expect(cancelled).toMatchObject({
        id: requested.id,
        status: 'cancelled',
        requestedBy: memberAId,
        gatekeeperId: null,
        completedAt: null,
      });

      const queue = (await dispatchCapability({ pool }, owner, 'list_connection_requests', {
        status: 'cancelled',
      })) as { items: ConnectionRequestWire[] };
      expect(queue.items.some((row) => row.id === requested.id)).toBe(true);
      const pending = (await dispatchCapability({ pool }, owner, 'list_connection_requests', {
        status: 'requested',
      })) as { items: ConnectionRequestWire[] };
      expect(pending.items.some((row) => row.id === requested.id)).toBe(false);

      // A second cancel of the same row: no legal edge left (409-shaped), row unchanged.
      await expect(
        dispatchCapability({ pool }, memberA, 'cancel_connection_request', {
          connectionRequestId: requested.id,
        }),
      ).rejects.toBeInstanceOf(IllegalTransition);
    });

    it("another member's request is 403 for a member and allowed for the workspace owner; unknown id is 404", async () => {
      const memberA = humanCaller(workspaceId, memberAId, 'member');
      const memberB = humanCaller(workspaceId, memberBId, 'member');
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const requested = await request(memberA, 'someone-elses-request');

      await expect(
        dispatchCapability({ pool }, memberB, 'cancel_connection_request', {
          connectionRequestId: requested.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const stillRequested = (await dispatchCapability(
        { pool },
        owner,
        'list_connection_requests',
        { status: 'requested' },
      )) as { items: ConnectionRequestWire[] };
      expect(stillRequested.items.some((row) => row.id === requested.id)).toBe(true);

      const cancelled = (await dispatchCapability({ pool }, owner, 'cancel_connection_request', {
        connectionRequestId: requested.id,
      })) as ConnectionRequestWire;
      expect(cancelled.status).toBe('cancelled');

      const actor = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ actor_principal_id: string }>(
          `select actor_principal_id from audit_records
           where workspace_id = $1 and action = 'connection.request_cancelled' and resource_id = $2`,
          [workspaceId, requested.id],
        ),
      );
      expect(actor.rows.map((row) => row.actor_principal_id)).toEqual([ownerId]);

      await expect(
        dispatchCapability({ pool }, owner, 'cancel_connection_request', {
          connectionRequestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ConnectionRequestNotFoundError);
    });
  },
);
