import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { grantCapability } from '../capability/index.js';
import { registerGatekeeper } from '../gatekeepers/index.js';
import { getOperationStats, listActionRequestsForApprover } from './reads.js';

/**
 * governance/approval/reads.integration: two independent DB-gated suites, each with its own
 * `beforeAll`/`afterAll` pool (same per-suite-fixture convention this package's integration tests
 * already follow, e.g. `service.integration.test.ts`/`service-execution.integration.test.ts`):
 *
 *   - S3.8's observe-class attribution test for `getOperationStats` (docs/development-tasks.md
 *     S3.8 deliverable 4 — "Integration test with seeded audit rows"). Seeds `audit_records` rows
 *     directly via `writeAudit` (the shape `application/gateway/dispatch.ts` writes for every
 *     dispatched capability, `observe_operation` included — see `reads.ts`'s own
 *     `OperationStatsRow` doc comment for the full merge rule) rather than driving a real
 *     `observe_operation` capability call end to end (which would need a fake `GatekeeperClient`,
 *     `application/gateway`'s full dispatch stack, and the WorkerDefinition/Handle machinery only
 *     a Worker session has — out of this test's bounded scope; the pre-existing
 *     `application/gateway/members-flow.integration.test.ts` already covers `get_operation_stats`'s
 *     execute-class path end to end through `dispatchCapability` and is left untouched).
 *   - S5.5 leftover 21's `listActionRequestsForApprover` (`list_action_requests`): status filter
 *     (single/array), I14 visibility across decided and pending rows alike, and keyset pagination
 *     across a same-millisecond pair — the same three properties this task's own dispatch named.
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

    /** Seeds one `observe_operation` AuditRecord — the exact payload shape `dispatch.ts`'s
     *  `dispatchCapability` writes for a real call (`payload.params` = the parsed capability
     *  params verbatim, `observe_operation` has no `redactedParamKeys`). Raw SQL, not
     *  `substrate/audit`'s `writeAudit` — `writeAudit` always stamps `created_at = now()` with no
     *  override, and `audit_records` is append-only (0004_audit.sql's own trigger blocks *every*
     *  UPDATE unconditionally, not just of content columns — insert-then-back-date does not work
     *  here), so a caller that needs a specific `created_at` (the days-window test below) must
     *  set it at INSERT time. `resource_type`/`resource_id` are omitted (default null), matching
     *  what `writeAudit` itself would produce for a call with neither given. */
    async function seedObserveCall(params: {
      gatekeeperId: string;
      operation: string;
      at?: Date;
    }): Promise<void> {
      const payload = JSON.stringify({
        channel: 'handle',
        onBehalfOf: ownerId,
        params: { gatekeeperId: params.gatekeeperId, operation: params.operation, params: {} },
      });
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        params.at
          ? client.query(
              `insert into audit_records (workspace_id, actor_principal_id, action, payload, created_at)
               values ($1, $2, 'observe_operation', $3::jsonb, $4)`,
              [workspaceId, ownerId, payload, params.at],
            )
          : client.query(
              `insert into audit_records (workspace_id, actor_principal_id, action, payload)
               values ($1, $2, 'observe_operation', $3::jsonb)`,
              [workspaceId, ownerId, payload],
            ),
      );
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

describe.runIf(DATABASE_URL !== undefined)(
  'governance/approval/reads — listActionRequestsForApprover (S5.5 leftover 21, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let operatorId: string; // holds a grant on 'la.test.action'
    let otherOperatorId: string; // role=operator, no grant at all

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      ownerId = randomUUID();
      operatorId = randomUUID();
      otherOperatorId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'reads-list-action-requests-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'),
                    ($1, $3, 'human', 'operator', 'operator-with-grant'),
                    ($1, $4, 'human', 'operator', 'operator-no-grant')`,
            [workspaceId, ownerId, operatorId, otherOperatorId],
          );
        },
        { skipRoleSwitch: true },
      );
      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        grantCapability(client, workspaceId, {
          principalId: operatorId,
          resourceType: 'la.test.action',
          grantedBy: ownerId,
        }),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    /** A fresh Gatekeeper object per test — every test filters `listActionRequestsForApprover` by
     *  its own `gatekeeperId`, so rows from one test can never leak into another's page/visibility
     *  assertions even though they share one workspace (same convention this file's own
     *  `getOperationStats` "merges" test already uses `registerGatekeeper` for). */
    async function insertGatekeeperObject(name: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        });
        const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: `${name}-system`,
          endpoint: `https://gate.reads-list-action-requests-test.invalid/${name}`,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return gatekeeperId;
      });
    }

    /** Direct `action_requests` insert (admin, `skipRoleSwitch`) — `requestAction` always sets
     *  `requested_at = now()` and only ever produces `pending_approval`/`auto_approved`/`denied`
     *  (no drainer running in this test), so a test that needs an explicit `requestedAt` (the
     *  same-millisecond pagination case) or a status only execution reaches (`approved`) must
     *  write the row directly — same convention this file's own "merges with an execute-class row"
     *  test above already uses. `approved`/`rejected` need `approval_decision_id` (I7's CHECK); the
     *  other statuses used by this suite (`auto_approved`/`pending_approval`/`denied`) do not. */
    async function insertActionRequest(input: {
      readonly gatekeeperId: string;
      readonly status: string;
      readonly actionKind: string;
      readonly onBehalfOf?: string;
      readonly requestedAt?: Date;
    }): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query(
            `insert into action_requests
               (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
                policy_decision, await_decision, on_behalf_of, actor_runtime, requested_at)
             values ($1, $2, $3, $4::uuid, $5, $4::text, 'low', 'allow', false, $6, 'human',
                     coalesce($7::timestamptz, now()))`,
            [
              workspaceId,
              id,
              input.status,
              input.gatekeeperId,
              input.actionKind,
              input.onBehalfOf ?? ownerId,
              input.requestedAt ?? null,
            ],
          ),
        { skipRoleSwitch: true },
      );
      return id;
    }

    it('status filter: a single status or an array of statuses narrows the result to exactly those rows', async () => {
      const gatekeeperId = await insertGatekeeperObject('la-status-filter-gate');
      const autoApprovedId = await insertActionRequest({
        gatekeeperId,
        status: 'auto_approved',
        actionKind: 'la.test.action',
      });
      const pendingId = await insertActionRequest({
        gatekeeperId,
        status: 'pending_approval',
        actionKind: 'la.test.action',
      });
      const deniedId = await insertActionRequest({
        gatekeeperId,
        status: 'denied',
        actionKind: 'la.test.action',
      });

      const singleStatus = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          listActionRequestsForApprover(
            client,
            workspaceId,
            { principalId: ownerId, role: 'owner' },
            { gatekeeperId, status: 'auto_approved' },
          ),
      );
      expect(singleStatus.items.map((r) => r.id)).toEqual([autoApprovedId]);

      const statusArray = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          listActionRequestsForApprover(
            client,
            workspaceId,
            { principalId: ownerId, role: 'owner' },
            { gatekeeperId, status: ['auto_approved', 'denied'] },
          ),
      );
      expect(new Set(statusArray.items.map((r) => r.id))).toEqual(
        new Set([autoApprovedId, deniedId]),
      );
      expect(statusArray.items.some((r) => r.id === pendingId)).toBe(false);

      const noFilter = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        listActionRequestsForApprover(
          client,
          workspaceId,
          { principalId: ownerId, role: 'owner' },
          { gatekeeperId },
        ),
      );
      expect(new Set(noFilter.items.map((r) => r.id))).toEqual(
        new Set([autoApprovedId, pendingId, deniedId]),
      );
    });

    it('visibility (I14): the owner sees every status; a scoped operator sees only matching action_kind rows, decided or not; an unscoped operator sees none of them', async () => {
      const gatekeeperId = await insertGatekeeperObject('la-visibility-gate');
      const matchingPending = await insertActionRequest({
        gatekeeperId,
        status: 'pending_approval',
        actionKind: 'la.test.action',
      });
      const matchingDecided = await insertActionRequest({
        gatekeeperId,
        status: 'auto_approved',
        actionKind: 'la.test.action',
      });
      const nonMatching = await insertActionRequest({
        gatekeeperId,
        status: 'auto_approved',
        actionKind: 'la.unscoped.action',
      });

      const ownerView = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        listActionRequestsForApprover(
          client,
          workspaceId,
          { principalId: ownerId, role: 'owner' },
          { gatekeeperId },
        ),
      );
      expect(new Set(ownerView.items.map((r) => r.id))).toEqual(
        new Set([matchingPending, matchingDecided, nonMatching]),
      );

      const operatorView = await withWorkspace(
        pool,
        { workspaceId, principalId: operatorId },
        (client) =>
          listActionRequestsForApprover(
            client,
            workspaceId,
            { principalId: operatorId, role: 'operator' },
            { gatekeeperId },
          ),
      );
      expect(new Set(operatorView.items.map((r) => r.id))).toEqual(
        new Set([matchingPending, matchingDecided]),
      );
      expect(operatorView.items.some((r) => r.id === nonMatching)).toBe(false);

      const otherOperatorView = await withWorkspace(
        pool,
        { workspaceId, principalId: otherOperatorId },
        (client) =>
          listActionRequestsForApprover(
            client,
            workspaceId,
            { principalId: otherOperatorId, role: 'operator' },
            { gatekeeperId },
          ),
      );
      expect(otherOperatorView.items).toEqual([]);
    });

    it('pagination: a limit of 1 pages through two rows sharing the same millisecond requested_at without skipping or repeating either', async () => {
      const gatekeeperId = await insertGatekeeperObject('la-pagination-gate');
      const sharedInstant = new Date('2026-02-02T02:02:02.345Z');
      const first = await insertActionRequest({
        gatekeeperId,
        status: 'auto_approved',
        actionKind: 'la.test.action',
        requestedAt: sharedInstant,
      });
      const second = await insertActionRequest({
        gatekeeperId,
        status: 'auto_approved',
        actionKind: 'la.test.action',
        requestedAt: sharedInstant,
      });

      const page1 = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        listActionRequestsForApprover(
          client,
          workspaceId,
          { principalId: ownerId, role: 'owner' },
          { gatekeeperId, limit: 1 },
        ),
      );
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        listActionRequestsForApprover(
          client,
          workspaceId,
          { principalId: ownerId, role: 'owner' },
          { gatekeeperId, limit: 1, cursor: page1.nextCursor },
        ),
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeUndefined();

      // Together, both pages account for exactly the two rows — id desc breaks the tie
      // deterministically, so the higher id comes first (`ar.id desc`, `buildSearchQuery`'s own
      // tie-break convention this cursor mirrors).
      const seen = [page1.items[0]?.id, page2.items[0]?.id];
      expect(new Set(seen)).toEqual(new Set([first, second]));
      const [higherId, lowerId] = [first, second].sort().reverse();
      expect(seen).toEqual([higherId, lowerId]);
    });
  },
);
