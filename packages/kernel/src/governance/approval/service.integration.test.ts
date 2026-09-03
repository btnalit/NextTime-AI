import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import type { CapabilityScope } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { grantCapability } from '../capability/index.js';
import { approveActionRequest, rejectActionRequest } from './decide.js';
import { listPendingForApprover } from './reads.js';
import { requestAction } from './request-action.js';
import { ApprovalScopeError } from './types.js';

/**
 * governance/approval/service.integration: DB-backed tests for `request_action`/`approve`/
 * `reject`/I14/idempotency (docs/development-tasks.md S2.3 acceptance: "转移穷举；幂等键；I14").
 * Split from a single larger file per the design doc's own file-size guidance (§7.10 "单文件 ≤ 600
 * 行...超过即拆，不等重构") — `expire`/execution-lifecycle/routing/`set_policy` coverage lives in
 * `service-execution.integration.test.ts` (own `beforeAll` fixtures, same convention every
 * integration test file in this package already follows rather than sharing a common test-utils
 * module — see e.g. `governance/capability/handles.test.ts` / `adapters/db/
 * governance-schema.test.ts`). `drainer.ts`'s own drain-order/stop-at-pending tests live in
 * `drainer.integration.test.ts`. Gated on `DATABASE_URL`.
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
  'governance/approval — request_action/approve/reject (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let operatorId: string; // holds a matching grant
    let otherOperatorId: string; // role=operator, no grant
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

    async function latestOutboxEvent(
      ws: string,
      eventType: string,
    ): Promise<{ payload: Record<string, unknown> } | undefined> {
      return withWorkspace(pool, { workspaceId: ws, principalId: ownerId }, async (client) => {
        const result = await client.query<{ payload: Record<string, unknown> }>(
          'select payload from outbox where workspace_id = $1 and event_type = $2 order by id desc limit 1',
          [ws, eventType],
        );
        return result.rows[0];
      });
    }

    async function latestAuditAction(ws: string, resourceId: string): Promise<string | undefined> {
      return withWorkspace(pool, { workspaceId: ws, principalId: ownerId }, async (client) => {
        const result = await client.query<{ action: string }>(
          'select action from audit_records where workspace_id = $1 and resource_id = $2 order by created_at desc limit 1',
          [ws, resourceId],
        );
        return result.rows[0]?.action;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('approval-service-test-workspace');
      ownerId = await adminInsertPrincipal(workspaceId, { role: 'owner', displayName: 'owner' });
      operatorId = await adminInsertPrincipal(workspaceId, {
        role: 'operator',
        displayName: 'operator-with-grant',
      });
      otherOperatorId = await adminInsertPrincipal(workspaceId, {
        role: 'operator',
        displayName: 'operator-no-grant',
      });
      gatekeeperId = await insertGatekeeperObject(workspaceId, ownerId);

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId: operatorId,
          capability: 'test.action',
          grantedBy: ownerId,
        }),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('requestAction — policy resolution', () => {
      it('auto-approves a low-blast-radius, auto_approvable operation with no workspace policy row', async () => {
        const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.auto',
            blastRadius: 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );

        expect(row.status).toBe('auto_approved');
        expect(row.policyDecision).toBe('allow');

        const event = await latestOutboxEvent(workspaceId, 'ActionRequestUpdated');
        expect(event?.payload).toMatchObject({ actionRequestId: row.id, status: 'auto_approved' });

        const auditAction = await latestAuditAction(workspaceId, row.id);
        expect(auditAction).toBe('action_request.request');
      });

      it('requires approval for a medium-blast-radius action with no workspace policy row, and fans out holders', async () => {
        const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.action',
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );

        expect(row.status).toBe('pending_approval');
        expect(row.policyDecision).toBe('require_approval');

        const event = await latestOutboxEvent(workspaceId, 'ActionRequestPending');
        expect(event?.payload).toMatchObject({
          actionRequestId: row.id,
          actionKind: 'test.action',
        });
        const holderIds =
          (event?.payload as { holderPrincipalIds?: string[] } | undefined)?.holderPrincipalIds ??
          [];
        expect(holderIds).toEqual(expect.arrayContaining([ownerId, operatorId]));
        expect(holderIds).not.toContain(otherOperatorId);
      });

      it('denies when the requester scope does not cover the gatekeeper', async () => {
        const otherGatekeeperId = await insertGatekeeperObject(workspaceId, ownerId);
        const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.denied',
            blastRadius: 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(otherGatekeeperId),
          }),
        );

        expect(row.status).toBe('denied');
        expect(row.policyDecision).toBe('deny');
      });

      it('idempotencyKey: a repeat call returns the existing row unchanged (no duplicate insert)', async () => {
        const idempotencyKey = randomUUID();
        const first = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.idempotent',
            blastRadius: 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            idempotencyKey,
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );
        const second = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.idempotent',
            blastRadius: 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            idempotencyKey,
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );

        expect(second.id).toBe(first.id);

        const count = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const result = await client.query(
              'select count(*)::int as n from action_requests where workspace_id = $1 and idempotency_key = $2',
              [workspaceId, idempotencyKey],
            );
            return (result.rows[0] as { n: number }).n;
          },
        );
        expect(count).toBe(1);
      });
    });

    describe('approve / reject — I14', () => {
      async function pendingActionRequest(actionKind = 'test.action') {
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

      it('403s (ApprovalScopeError) when the operator holds no matching grant', async () => {
        const row = await pendingActionRequest();
        await expect(
          withWorkspace(pool, { workspaceId, principalId: otherOperatorId }, (client) =>
            approveActionRequest(client, workspaceId, {
              actionRequestId: row.id,
              approverPrincipalId: otherOperatorId,
              approverRole: 'operator',
            }),
          ),
        ).rejects.toThrow(ApprovalScopeError);
      });

      it('succeeds when the operator holds a matching grant, writing the Approval Decision', async () => {
        const row = await pendingActionRequest();
        const updated = await withWorkspace(
          pool,
          { workspaceId, principalId: operatorId },
          (client) =>
            approveActionRequest(client, workspaceId, {
              actionRequestId: row.id,
              approverPrincipalId: operatorId,
              approverRole: 'operator',
            }),
        );

        expect(updated.status).toBe('approved');
        expect(updated.approvalDecisionId).not.toBeNull();

        const decisionStatus = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const result = await client.query<{ status: string }>(
              'select status from decisions where workspace_id = $1 and id = $2',
              [workspaceId, updated.approvalDecisionId],
            );
            return result.rows[0]?.status;
          },
        );
        expect(decisionStatus).toBe('approved');
      });

      it('the workspace owner may always approve, regardless of grants', async () => {
        const row = await pendingActionRequest();
        const updated = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          approveActionRequest(client, workspaceId, {
            actionRequestId: row.id,
            approverPrincipalId: ownerId,
            approverRole: 'owner',
          }),
        );
        expect(updated.status).toBe('approved');
      });

      it('reject transitions to rejected and writes a rejected Decision', async () => {
        const row = await pendingActionRequest();
        const updated = await withWorkspace(
          pool,
          { workspaceId, principalId: operatorId },
          (client) =>
            rejectActionRequest(client, workspaceId, {
              actionRequestId: row.id,
              approverPrincipalId: operatorId,
              approverRole: 'operator',
              reason: 'not now',
            }),
        );
        expect(updated.status).toBe('rejected');

        const decisionStatus = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const result = await client.query<{ status: string }>(
              'select status from decisions where workspace_id = $1 and id = $2',
              [workspaceId, updated.approvalDecisionId],
            );
            return result.rows[0]?.status;
          },
        );
        expect(decisionStatus).toBe('rejected');
      });

      it('rejects an illegal transition (approving an already-approved row) with IllegalTransition', async () => {
        const row = await pendingActionRequest();
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          approveActionRequest(client, workspaceId, {
            actionRequestId: row.id,
            approverPrincipalId: ownerId,
            approverRole: 'owner',
          }),
        );

        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
            approveActionRequest(client, workspaceId, {
              actionRequestId: row.id,
              approverPrincipalId: ownerId,
              approverRole: 'owner',
            }),
          ),
        ).rejects.toThrow(IllegalTransition);
      });

      it('list_pending: the owner sees every pending row; a scoped operator sees only matching ones', async () => {
        const row = await pendingActionRequest();

        const ownerView = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            listPendingForApprover(client, workspaceId, { principalId: ownerId, role: 'owner' }),
        );
        expect(ownerView.some((r) => r.id === row.id)).toBe(true);

        const operatorView = await withWorkspace(
          pool,
          { workspaceId, principalId: operatorId },
          (client) =>
            listPendingForApprover(client, workspaceId, {
              principalId: operatorId,
              role: 'operator',
            }),
        );
        expect(operatorView.some((r) => r.id === row.id)).toBe(true);

        const otherOperatorView = await withWorkspace(
          pool,
          { workspaceId, principalId: otherOperatorId },
          (client) =>
            listPendingForApprover(client, workspaceId, {
              principalId: otherOperatorId,
              role: 'operator',
            }),
        );
        expect(otherOperatorView.some((r) => r.id === row.id)).toBe(false);
      });
    });
  },
);
