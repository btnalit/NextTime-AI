import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { grantCapability } from '../capability/index.js';
import { setPolicy } from '../policy/index.js';
import {
  compensateActionRequest,
  expireActionRequest,
  expireOverduePendingApprovals,
  markActionRequestExecuted,
  markActionRequestFailed,
  startActionRequestExecution,
} from './execution.js';
import { getActionRequest } from './reads.js';
import { requestAction } from './request-action.js';
import { computeActionRequestHolders } from './routing.js';
import { ActionRequestNotFoundError } from './types.js';

/**
 * governance/approval/service-execution.integration: DB-backed tests for `expire`/the execution
 * lifecycle (`start_execution`/`mark_executed`/`mark_failed`/`compensate`)/`routing.ts`/
 * `set_policy`'s write-side guard (docs/development-tasks.md S2.2/S2.3 acceptance). Split from
 * `service.integration.test.ts` per the design doc's file-size guidance (§7.10) — that file covers
 * `request_action`/`approve`/`reject`/I14/idempotency; see its own doc comment. Gated on
 * `DATABASE_URL`.
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
  'governance/approval — expire/execution/routing/set_policy (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let operatorId: string;
    let otherOperatorId: string;
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

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('approval-execution-test-workspace');
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

    describe('expire — reaper', () => {
      it('expires a pending row past the timeout; is a no-op for a non-pending row', async () => {
        const pending = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.expire',
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );

        const expired = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          expireActionRequest(client, workspaceId, pending.id),
        );
        expect(expired?.status).toBe('expired');

        const noop = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          expireActionRequest(client, workspaceId, pending.id),
        );
        expect(noop).toBeNull();
      });

      it('expireOverduePendingApprovals expires only rows older than the cutoff', async () => {
        const pending = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.reaper',
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );

        // `expireOverduePendingApprovals` scans *every* workspace (it is a cross-workspace reaper,
        // like OutboxDispatcher/interruptStaleRunningTurns — see execution.ts's own doc comment),
        // so a call here could in principle also touch a row some other, concurrently-running test
        // file just created (Vitest parallelizes across test files by default — the same reasoning
        // application/outbox/dispatcher.integration.test.ts's own comment gives for asserting
        // `toBeGreaterThanOrEqual` rather than an exact count). To stay safe under that parallelism
        // *and* still exercise the "only overdue rows" cutoff, this row is deliberately backdated
        // (`requested_at` moved 2 hours into the past) rather than relying on a negative timeoutMs
        // that would sweep every pending row in the database, including ones from other files.
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query(
            `update action_requests set requested_at = now() - interval '2 hours'
           where workspace_id = $1 and id = $2`,
            [workspaceId, pending.id],
          ),
        );

        // A 1-hour cutoff cannot match a row any other concurrently-running test just created
        // (fresh rows are seconds old, not hours), only this deliberately-backdated one.
        const expiredCount = await expireOverduePendingApprovals(pool, {
          timeoutMs: 60 * 60 * 1000,
        });
        expect(expiredCount).toBeGreaterThanOrEqual(1);
        const nowExpired = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) => getActionRequest(client, workspaceId, pending.id),
        );
        expect(nowExpired?.status).toBe('expired');
      });
    });

    describe('execution lifecycle', () => {
      it('auto_approved -> executing -> executed, then failed -> compensated on a separate row', async () => {
        const autoApproved = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            requestAction(client, workspaceId, {
              gatekeeperId,
              actionKind: 'test.exec.success',
              blastRadius: 'low',
              operationAutoApprovable: true,
              awaitDecision: false,
              onBehalfOf: ownerId,
              actorRuntime: 'pi',
              requesterScope: scopeCovering(gatekeeperId),
            }),
        );
        expect(autoApproved.status).toBe('auto_approved');

        const executing = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) => startActionRequestExecution(client, workspaceId, autoApproved.id),
        );
        expect(executing.status).toBe('executing');

        const executed = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            markActionRequestExecuted(client, workspaceId, autoApproved.id, {
              resultMetadata: { ok: true },
            }),
        );
        expect(executed.status).toBe('executed');
        expect(executed.executedAt).not.toBeNull();

        // A second row, taken to failed -> compensated.
        const autoApproved2 = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            requestAction(client, workspaceId, {
              gatekeeperId,
              actionKind: 'test.exec.fail',
              blastRadius: 'low',
              operationAutoApprovable: true,
              awaitDecision: false,
              onBehalfOf: ownerId,
              actorRuntime: 'pi',
              requesterScope: scopeCovering(gatekeeperId),
            }),
        );
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          startActionRequestExecution(client, workspaceId, autoApproved2.id),
        );
        const failed = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          markActionRequestFailed(client, workspaceId, autoApproved2.id, { reason: 'boom' }),
        );
        expect(failed.status).toBe('failed');
        expect(failed.failedAt).not.toBeNull();

        const compensated = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) => compensateActionRequest(client, workspaceId, autoApproved2.id),
        );
        expect(compensated.status).toBe('compensated');
      });

      it('getActionRequest returns null / ActionRequestNotFoundError paths behave as documented', async () => {
        const missingId = randomUUID();
        const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          getActionRequest(client, workspaceId, missingId),
        );
        expect(row).toBeNull();

        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
            startActionRequestExecution(client, workspaceId, missingId),
          ),
        ).rejects.toThrow(ActionRequestNotFoundError);
      });
    });

    describe('routing — computeActionRequestHolders', () => {
      it('includes the owner and every matching grant holder, deduplicated', async () => {
        const holders = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          computeActionRequestHolders(client, workspaceId, {
            actionKind: 'test.action',
            resourceScope: null,
          }),
        );
        expect(holders).toEqual(expect.arrayContaining([ownerId, operatorId]));
        expect(holders).not.toContain(otherOperatorId);
        expect(new Set(holders).size).toBe(holders.length);
      });
    });

    describe('setPolicy — I8 write-side guard', () => {
      it('rejects auto_approve:true at blast_radius=high before touching the DB', async () => {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
            setPolicy(client, workspaceId, {
              actionKind: 'test.high_kind',
              blastRadius: 'high',
              autoApprove: true,
              setBy: ownerId,
            }),
          ),
        ).rejects.toThrow();

        const row = await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            const result = await client.query(
              'select 1 from policies where workspace_id = $1 and action_kind = $2',
              [workspaceId, 'test.high_kind'],
            );
            return result.rows[0];
          },
        );
        expect(row).toBeUndefined();
      });

      it('a workspace policy row changes request_action resolution for a medium-blast-radius kind', async () => {
        await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          setPolicy(client, workspaceId, {
            actionKind: 'test.policy_opt_in',
            blastRadius: 'medium',
            autoApprove: true,
            setBy: ownerId,
          }),
        );

        const row = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.policy_opt_in',
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scopeCovering(gatekeeperId),
          }),
        );
        expect(row.status).toBe('auto_approved');
      });
    });
  },
);
