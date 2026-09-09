import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { registerGatekeeper } from '../gatekeepers/index.js';
import { getOperationStats } from './reads.js';

/**
 * governance/approval/reads.integration: S3.8's observe-class attribution test for
 * `getOperationStats` (docs/development-tasks.md S3.8 deliverable 4 — "Integration test with
 * seeded audit rows"). Seeds `audit_records` rows directly via `writeAudit` (the shape
 * `application/gateway/dispatch.ts` writes for every dispatched capability, `observe_operation`
 * included — see `reads.ts`'s own `OperationStatsRow` doc comment for the full merge rule) rather
 * than driving a real `observe_operation` capability call end to end (which would need a fake
 * `GatekeeperClient`, `application/gateway`'s full dispatch stack, and the WorkerDefinition/Handle
 * machinery only a Worker session has — out of this test's bounded scope; the pre-existing
 * `application/gateway/members-flow.integration.test.ts` already covers `get_operation_stats`'s
 * execute-class path end to end through `dispatchCapability` and is left untouched).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'governance/approval/reads — getOperationStats observe-class attribution (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'reads-observe-stats-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, ownerId, 'human', 'owner', 'owner'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    /** Seeds one `observe_operation` AuditRecord — the exact shape `dispatch.ts`'s
     *  `dispatchCapability` writes for a real call (`payload.params` = the parsed capability
     *  params verbatim, `observe_operation` has no `redactedParamKeys`). */
    async function seedObserveCall(params: {
      gatekeeperId: string;
      operation: string;
      at?: Date;
    }): Promise<void> {
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        writeAudit(client, {
          workspaceId,
          actorPrincipalId: ownerId,
          action: 'observe_operation',
          payload: {
            channel: 'handle',
            onBehalfOf: ownerId,
            params: { gatekeeperId: params.gatekeeperId, operation: params.operation, params: {} },
          },
        }),
      );
      if (params.at) {
        // writeAudit always stamps created_at = now(); back-date it for the days-window test below
        // the same way a real production row from days ago would already have one.
        await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query(
              `update audit_records set created_at = $1
               where workspace_id = $2 and action = 'observe_operation'
                 and payload->'params'->>'gatekeeperId' = $3
                 and payload->'params'->>'operation' = $4
                 and created_at > now() - interval '1 minute'`,
              [params.at, workspaceId, params.gatekeeperId, params.operation],
            ),
          { skipRoleSwitch: true },
        );
      }
    }

    it('an observe-class Operation with no action_requests rows appears with calls === observeCalls, execute counters at 0', async () => {
      const gatekeeperId = randomUUID();

      await seedObserveCall({ gatekeeperId, operation: 'opObserveOnly' });
      await seedObserveCall({ gatekeeperId, operation: 'opObserveOnly' });
      await seedObserveCall({ gatekeeperId, operation: 'opObserveOnly' });

      const stats = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getOperationStats(client, workspaceId, { days: 30 }),
      );
      const row = stats.find(
        (r) => r.gatekeeperId === gatekeeperId && r.operationName === 'opObserveOnly',
      );
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        calls: 3,
        observeCalls: 3,
        approved: 0,
        rejected: 0,
        autoApproved: 0,
        failed: 0,
      });
    });

    it('an observe call older than the days window is excluded; widening the window includes it', async () => {
      const gatekeeperId = randomUUID();
      const days45Ago = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);

      await seedObserveCall({ gatekeeperId, operation: 'opOldObserve', at: days45Ago });

      const defaultWindow = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getOperationStats(client, workspaceId, { days: 30 }),
      );
      expect(
        defaultWindow.find(
          (r) => r.gatekeeperId === gatekeeperId && r.operationName === 'opOldObserve',
        ),
      ).toBeUndefined();

      const widerWindow = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getOperationStats(client, workspaceId, { days: 60 }),
      );
      expect(
        widerWindow.find(
          (r) => r.gatekeeperId === gatekeeperId && r.operationName === 'opOldObserve',
        )?.observeCalls,
      ).toBe(1);
    });

    it('gatekeeperId filters observe-class rows the same way it already filters execute-class ones', async () => {
      const gateA = randomUUID();
      const gateB = randomUUID();
      await seedObserveCall({ gatekeeperId: gateA, operation: 'opFilterA' });
      await seedObserveCall({ gatekeeperId: gateB, operation: 'opFilterB' });

      const scoped = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getOperationStats(client, workspaceId, { days: 30, gatekeeperId: gateA }),
      );
      expect(scoped.some((r) => r.gatekeeperId === gateA)).toBe(true);
      expect(scoped.some((r) => r.gatekeeperId === gateB)).toBe(false);
    });

    it('merges with an execute-class row sharing the same {gatekeeperId, operationName}: calls sums both sources, observeCalls stays the observe-only subset', async () => {
      const gatekeeperId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.register_gatekeeper',
            principalId: ownerId,
          });
          const { gatekeeperId: id } = await registerGatekeeper(client, workspaceId, {
            name: 'reads-observe-stats-merge-gate',
            transportKind: 'http',
            target: 'reads-observe-stats-merge-system',
            endpoint: 'https://gate.reads-observe-stats-test.invalid/merge',
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          return id;
        },
      );

      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            `insert into action_requests
               (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
                policy_decision, await_decision, on_behalf_of, actor_runtime, requested_at)
             values ($1, $2, 'auto_approved', $3::uuid, $4, $3::text, 'low', 'allow', false, $5, 'human', now())`,
            [workspaceId, randomUUID(), gatekeeperId, 'opShared', ownerId],
          ),
        { skipRoleSwitch: true },
      );
      await seedObserveCall({ gatekeeperId, operation: 'opShared' });
      await seedObserveCall({ gatekeeperId, operation: 'opShared' });

      const stats = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getOperationStats(client, workspaceId, { days: 30 }),
      );
      const row = stats.find(
        (r) => r.gatekeeperId === gatekeeperId && r.operationName === 'opShared',
      );
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        calls: 3, // 1 execute + 2 observe
        observeCalls: 2,
        autoApproved: 1,
        approved: 0,
        rejected: 0,
        failed: 0,
      });
    });
  },
);
