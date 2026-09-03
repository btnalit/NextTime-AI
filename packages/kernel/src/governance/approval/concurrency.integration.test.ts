import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import type { CapabilityScope } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { approveActionRequest } from './decide.js';
import { getActionRequest } from './reads.js';
import { requestAction } from './request-action.js';
import { updateActionRequestStatusConditional } from './status-transition.js';
import { ActionRequestConcurrentTransitionError } from './types.js';

/**
 * governance/approval/concurrency.integration: I6/I11 concurrency-hardening tests — the coordinator
 * review that followed this PR's first CI-green pass flagged the original `approve`/`reject`/
 * `expire`/execution-lifecycle transitions and `requestAction`'s idempotency check as a
 * state-integrity gap (a lock-free read-then-write race could let two concurrent callers both
 * "win" a transition, or both insert a row for the same `idempotencyKey`), not a nice-to-have. This
 * file is the DB-backed proof the fix (`reads.ts`'s `getActionRequestForUpdate`,
 * `status-transition.ts`'s conditional UPDATE, `request-action.ts`'s `SAVEPOINT`-wrapped INSERT)
 * actually holds under real concurrent Postgres transactions. Gated on `DATABASE_URL`.
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

describe.runIf(DATABASE_URL !== undefined)(
  'governance/approval — concurrency hardening (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
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

    async function adminInsertPrincipal(
      ws: string,
      opts: { role: string; displayName: string },
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [ws, id, opts.role, opts.displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function insertGatekeeperObject(ws: string, principalId: string): Promise<string> {
      return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [ws, id],
        );
        return id;
      });
    }

    async function createPendingActionRequest(actionKind: string) {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind,
          blastRadius: 'medium',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: ownerId,
          actorRuntime: 'pi',
          requesterScope: scopeCovering(gatekeeperId),
        }),
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('approval-concurrency-test-workspace');
      ownerId = await adminInsertPrincipal(workspaceId, { role: 'owner', displayName: 'owner' });
      gatekeeperId = await insertGatekeeperObject(workspaceId, ownerId);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('two concurrent approveActionRequest calls on one pending_approval row: exactly one succeeds, exactly one Decision row exists, the loser gets IllegalTransition', async () => {
      const row = await createPendingActionRequest('test.concurrent_approve');

      const callApprove = () =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          approveActionRequest(client, workspaceId, {
            actionRequestId: row.id,
            approverPrincipalId: ownerId,
            approverRole: 'owner',
          }),
        );

      const results = await Promise.allSettled([callApprove(), callApprove()]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof callApprove>>> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(IllegalTransition);
      expect(fulfilled[0]?.value.status).toBe('approved');

      const finalRow = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, row.id),
      );
      expect(finalRow?.status).toBe('approved');
      expect(finalRow?.approvalDecisionId).not.toBeNull();

      const decisionCount = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ n: number }>(
            "select count(*)::int as n from decisions where workspace_id = $1 and rationale ->> 'actionRequestId' = $2",
            [workspaceId, row.id],
          );
          return result.rows[0]?.n ?? 0;
        },
      );
      expect(decisionCount).toBe(1);
    });

    it('updateActionRequestStatusConditional rejects a stale expectedStatus (unit-level: the conditional UPDATE itself)', async () => {
      const row = await createPendingActionRequest('test.stale_conditional_update');

      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          updateActionRequestStatusConditional(client, workspaceId, row.id, {
            status: 'approved',
            // Wrong on purpose — the row is actually `pending_approval`.
            expectedStatus: 'auto_approved',
          }),
        ),
      ).rejects.toThrow(ActionRequestConcurrentTransitionError);

      // The row itself must be untouched by the rejected UPDATE.
      const untouched = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, row.id),
      );
      expect(untouched?.status).toBe('pending_approval');
    });

    it('requestAction: concurrent calls sharing one idempotencyKey produce exactly one row', async () => {
      const idempotencyKey = randomUUID();

      const callRequestAction = () =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.concurrent_idempotent',
            blastRadius: 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            idempotencyKey,
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );

      const [first, second] = await Promise.all([callRequestAction(), callRequestAction()]);

      expect(second.id).toBe(first.id);

      const count = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ n: number }>(
            'select count(*)::int as n from action_requests where workspace_id = $1 and idempotency_key = $2',
            [workspaceId, idempotencyKey],
          );
          return result.rows[0]?.n ?? 0;
        },
      );
      expect(count).toBe(1);
    });
  },
);
