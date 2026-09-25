import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Operation, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  getOperation,
  getPublishedOperation,
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { insertGateLink, upsertAnnouncement } from '../gates/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { GateInstanceNotAvailableError } from './gate-instance-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/operation-governance.integration.test: DB-gated dispatch-level coverage of
 * S8 W3-K1's two new capabilities — `refresh_operation_governance` (leftover 79) and
 * `update_operation_description` (leftover 81). Exercises them through `dispatchCapability` (real
 * authorization + the per-call AuditRecord dispatch.ts itself writes, plus this task's own
 * domain-transition AuditRecord) — the domain functions themselves
 * (`refreshOperationGovernance`/`updateOperationDescription`/`diffOperationGovernanceFields`/
 * `classifyOperationGovernanceChange`) have their own unit/integration coverage in
 * `governance/gatekeepers/manifest.test.ts`, in that file's existing no-HTTP-server style; this
 * file only adds what that one cannot — role-based authorization and the audit trail. No isolated
 * per-file database (same convention `manifest.test.ts` already uses): every row this file writes
 * is scoped to this file's own randomly-generated workspace/gate ids.
 */

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DATABASE_URL = process.env.DATABASE_URL;

/** `connectors`/`gate_instances` are platform-scope tables — only `*_read_all` (select) and
 *  `*_platform_admin` (app_platform()) RLS policies exist on them, no policy at all admits a
 *  normal workspace `nexttime_app` write (migrations/core/0023_gate_instances.sql). The real
 *  `POST /internal/gates/announce` route (interfaces/http/internal/gates.ts) writes them the same
 *  way: `withWorkspace` with `skipRoleSwitch: true`, staying on the connection's login role
 *  instead of switching to `nexttime_app` — mirrored here rather than standing up a full HTTP
 *  server just to seed one announcement. */
const ADMIN_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

function testOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    name: `test.op.${randomUUID()}`,
    description: 'A test operation.',
    binding: { kind: 'http', method: 'GET', path: '/stock' },
    params_schema: {},
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
    ...overrides,
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'S8 W3-K1 operation governance capabilities (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;

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

    async function adminInsertPrincipal(displayName: string, role: Role): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, 'human', role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    function humanCaller(principalId: string, role: Role): ResolvedCaller {
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

    function callAs<T>(
      principalId: string,
      role: Role,
      name: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      return dispatchCapability(
        { pool },
        humanCaller(principalId, role),
        name,
        params,
      ) as Promise<T>;
    }

    async function inTx<T>(fn: Parameters<typeof withWorkspace<T>>[2]): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function asAdmin<T>(fn: Parameters<typeof withWorkspace<T>>[2]): Promise<T> {
      return withWorkspace(
        pool,
        { workspaceId: ADMIN_PLACEHOLDER, principalId: ADMIN_PLACEHOLDER },
        fn,
        { skipRoleSwitch: true },
      );
    }

    async function newActivity(): Promise<string> {
      return inTx(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, status, started_by) values ($1, 'test.operation-governance', 'running', $2) returning id`,
          [workspaceId, ownerId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('failed to insert test activity');
        return row.id;
      });
    }

    /** Registers a Gatekeeper, imports+publishes `operations` under it, announces a platform gate
     *  instance with `announcedOperations` (defaulting to the same `operations`, i.e. no drift
     *  yet), and links the workspace to it — the "enabled through the platform catalog, manifest
     *  now says X" setup `refresh_operation_governance` needs. Returns both ids. */
    async function seedLinkedGatekeeper(
      operations: readonly Operation[],
      announcedOperations: readonly Operation[] = operations,
    ): Promise<{ gatekeeperId: string; gateId: string }> {
      const act = await newActivity();
      const registered = await inTx((client) =>
        registerGatekeeper(client, workspaceId, {
          name: `linked-gate-${randomUUID().slice(0, 8)}`,
          transportKind: 'http',
          target: 'example-system',
          endpoint: `https://gate-${randomUUID()}.example.invalid`,
          activityId: act,
          registeredBy: { id: ownerId, kind: 'human' },
        }),
      );
      const gatekeeperId = registered.gatekeeperId;

      await inTx((client) =>
        importManifest(client, workspaceId, {
          gatekeeperId,
          operations,
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: act,
        }),
      );
      for (const operation of operations) {
        await inTx((client) =>
          publishOperation(client, workspaceId, { gatekeeperId, name: operation.name }),
        );
      }

      const gateId = `linked-gate-instance-${randomUUID().slice(0, 8)}`;
      await asAdmin((client) =>
        upsertAnnouncement(client, {
          gateId,
          connector: 'http',
          transportKind: 'http',
          endpoint: `https://gate-${randomUUID()}.example.invalid`,
          operations: [...announcedOperations],
        }),
      );
      await inTx((client) =>
        insertGateLink(client, {
          workspaceId,
          gateId,
          gatekeeperObjectId: gatekeeperId,
          enabledBy: ownerId,
        }),
      );

      return { gatekeeperId, gateId };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('operation-governance-test-workspace');
      ownerId = await adminInsertPrincipal('owner', 'owner');
      memberId = await adminInsertPrincipal('member', 'member');
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('refresh_operation_governance', () => {
      it('owner: applies the announced fields to a differing published Operation and writes an AuditRecord with before/after/direction', async () => {
        const op = testOperation({
          name: `gov.dispatch.${randomUUID()}`,
          mode: 'execute',
          blast_radius: 'high',
          auto_approvable: false,
        });
        const announced = {
          ...op,
          mode: 'observe' as const,
          blast_radius: 'low' as const,
          auto_approvable: true,
        };
        const { gatekeeperId } = await seedLinkedGatekeeper([op], [announced]);

        const result = await callAs<{
          refreshed: readonly {
            name: string;
            before: unknown;
            after: unknown;
            direction: string;
          }[];
          unchanged: readonly string[];
        }>(ownerId, 'owner', 'refresh_operation_governance', { gatekeeperId });

        expect(result.refreshed).toHaveLength(1);
        expect(result.refreshed[0]).toMatchObject({ name: op.name, direction: 'loosened' });
        expect(result.unchanged).toEqual([]);

        const persisted = await inTx((client) =>
          getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
        );
        expect(persisted?.operation.mode).toBe('observe');

        const audit = await inTx((client) =>
          queryAudit(client, workspaceId, { action: 'operation.governance_refreshed' }),
        );
        // `resource_id` is the Operation Object's own uuid (`audit_records.resource_id` is `uuid`
        // — see gate-instance-handlers.ts's `refreshOperationGovernanceHandler`), not the
        // `{gatekeeperId, name}` identity pair — that pair lives in the payload instead.
        const row = audit.find((r) => r.resourceId === persisted?.id);
        expect(row).toBeDefined();
        expect(row?.actorPrincipalId).toBe(ownerId);
        expect(row?.payload).toMatchObject({
          direction: 'loosened',
          name: op.name,
          gatekeeperId,
        });
      });

      it('a member (non-owner) is refused with ForbiddenError, nothing is written', async () => {
        const op = testOperation({ name: `gov.forbidden.${randomUUID()}`, auto_approvable: false });
        const announced = { ...op, auto_approvable: true };
        const { gatekeeperId } = await seedLinkedGatekeeper([op], [announced]);

        await expect(
          callAs(memberId, 'member', 'refresh_operation_governance', { gatekeeperId }),
        ).rejects.toBeInstanceOf(ForbiddenError);

        const stillOld = await inTx((client) =>
          getPublishedOperation(client, workspaceId, gatekeeperId, op.name),
        );
        expect(stillOld?.operation.auto_approvable).toBe(false);
      });

      it('a Gatekeeper with no linked gate instance refuses no_announced_manifest, before any write', async () => {
        const act = await newActivity();
        const registered = await inTx((client) =>
          registerGatekeeper(client, workspaceId, {
            name: `unlinked-gate-${randomUUID().slice(0, 8)}`,
            transportKind: 'http',
            target: 'example-system',
            endpoint: `https://unlinked-${randomUUID()}.example.invalid`,
            activityId: act,
            registeredBy: { id: ownerId, kind: 'human' },
          }),
        );

        const thrown = await callAs(ownerId, 'owner', 'refresh_operation_governance', {
          gatekeeperId: registered.gatekeeperId,
        }).then(
          () => {
            throw new Error('expected GateInstanceNotAvailableError, but the call resolved');
          },
          (err: unknown) => err,
        );
        expect(thrown).toBeInstanceOf(GateInstanceNotAvailableError);
        expect((thrown as GateInstanceNotAvailableError).code).toBe('no_announced_manifest');
      });
    });

    describe('update_operation_description', () => {
      it('a member (no minRole restriction, same as publish_operation) can edit the description; writes an AuditRecord with before/after', async () => {
        const op = testOperation({
          name: `desc.dispatch.${randomUUID()}`,
          description: 'original',
        });
        const act = await newActivity();
        const registered = await inTx((client) =>
          registerGatekeeper(client, workspaceId, {
            name: `desc-gate-${randomUUID().slice(0, 8)}`,
            transportKind: 'http',
            target: 'example-system',
            endpoint: `https://desc-${randomUUID()}.example.invalid`,
            activityId: act,
            registeredBy: { id: ownerId, kind: 'human' },
          }),
        );
        const gatekeeperId = registered.gatekeeperId;
        await inTx((client) =>
          importManifest(client, workspaceId, {
            gatekeeperId,
            operations: [op],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: act,
          }),
        );

        const result = await callAs<{ description: string }>(
          memberId,
          'member',
          'update_operation_description',
          { gatekeeperId, name: op.name, description: 'updated by a member' },
        );
        expect(result.description).toBe('updated by a member');

        const persisted = await inTx((client) =>
          getOperation(client, workspaceId, gatekeeperId, op.name),
        );
        expect(persisted?.operation.description).toBe('updated by a member');

        const audit = await inTx((client) =>
          queryAudit(client, workspaceId, { action: 'operation.description_updated' }),
        );
        // `resource_id` is the Operation Object's own uuid (`audit_records.resource_id` is
        // `uuid`) — the `{gatekeeperId, name}` identity pair lives in the payload instead.
        const row = audit.find((r) => r.resourceId === persisted?.id);
        expect(row).toBeDefined();
        expect(row?.actorPrincipalId).toBe(memberId);
        expect(row?.payload).toMatchObject({
          before: 'original',
          after: 'updated by a member',
          gatekeeperId,
          name: op.name,
        });
      });

      it('a blank description is rejected through dispatch too, writing nothing', async () => {
        const op = testOperation({ name: `desc.blank.${randomUUID()}` });
        const act = await newActivity();
        const registered = await inTx((client) =>
          registerGatekeeper(client, workspaceId, {
            name: `desc-blank-gate-${randomUUID().slice(0, 8)}`,
            transportKind: 'http',
            target: 'example-system',
            endpoint: `https://desc-blank-${randomUUID()}.example.invalid`,
            activityId: act,
            registeredBy: { id: ownerId, kind: 'human' },
          }),
        );
        const gatekeeperId = registered.gatekeeperId;
        await inTx((client) =>
          importManifest(client, workspaceId, {
            gatekeeperId,
            operations: [op],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: act,
          }),
        );

        await expect(
          callAs(ownerId, 'owner', 'update_operation_description', {
            gatekeeperId,
            name: op.name,
            description: '   ',
          }),
        ).rejects.toMatchObject({ name: 'OperationDescriptionInvalidError' });
      });
    });
  },
);
