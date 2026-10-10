import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Operation, Role } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  importManifest,
  proposeOperation,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { setGatekeeperReadHandlerDeps } from './gatekeeper-read-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/task-operation-visibility.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) dispatch-level coverage of two review 2026-10-02 decisions:
 *
 *   - D-21 (L2-11): `get_task` is visible only to the workspace owner, the Task's requester
 *     (`on_behalf_of`) and the Task's own WorkerRun Handle; anyone else gets the same
 *     `TaskNotFoundError` (404) an unknown id gets. `cancel_task`'s owner-or-requester rule is
 *     unchanged (still 403 for someone else's Task).
 *   - D-26 (L2-15): an Operation draft is listed (`list_operations`, `get_gatekeeper`,
 *     `list_gatekeepers.operationCount`) only to its proposer, a builder or the owner; published
 *     and deprecated Operations stay visible to every member.
 *
 * Tasks / WorkerRuns / sessions are seeded directly under the admin login role (no Worker runtime
 * here), the same convention `approval-history.integration.test.ts` uses.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function testOperation(name: string): Operation {
  return {
    name,
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
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'D-21 Task read visibility and D-26 Operation draft visibility (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let requesterId: string;
    let otherMemberId: string;

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

    function handleCaller(obo: string, sid: string, scope: CapabilityScope): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: { ws: workspaceId, sid, obo, scope, jti: randomUUID(), iat: now, exp: now + 600 },
      };
    }

    async function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function insertPrincipal(role: Role, name: string): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, name],
        ),
      );
      return id;
    }

    /** One Task on behalf of `onBehalfOf` with one WorkerRun whose `worker_run` session's Handle
     *  acts for `sessionOnBehalfOf` — the same principal in production; a different one here only
     *  so the WorkerRun-Handle branch of the predicate is exercised on its own. */
    async function seedTask(
      onBehalfOf: string,
      sessionOnBehalfOf: string = onBehalfOf,
      input: unknown = { text: 'private chat content' },
    ): Promise<{ taskId: string; sessionId: string }> {
      return admin(async (client) => {
        const session = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'worker_run', $2, 'active') returning id`,
          [workspaceId, sessionOnBehalfOf],
        );
        const sessionId = session.rows[0]?.id as string;
        const task = await client.query<{ id: string }>(
          `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id,
                              worker_definition_version, input)
           values ($1, 'running', $2, $3, 1, $4::jsonb) returning id`,
          [workspaceId, onBehalfOf, randomUUID(), JSON.stringify(input)],
        );
        const taskId = task.rows[0]?.id as string;
        await client.query(
          `insert into worker_runs (workspace_id, status, task_id, session_id)
           values ($1, 'running', $2, $3)`,
          [workspaceId, taskId, sessionId],
        );
        return { taskId, sessionId };
      });
    }

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
            'visibility-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner')`,
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      builderId = await insertPrincipal('builder', 'builder');
      requesterId = await insertPrincipal('member', 'requester');
      otherMemberId = await insertPrincipal('member', 'other-member');
      // Never make a real network call for get_gatekeeper's health probe.
      setGatekeeperReadHandlerDeps({
        gatekeeperClient: {
          describeOperations: async () => ({ operations: [] }),
          observe: async () => ({ data: null }),
          simulate: async () => ({ description: 'no-op (test fake)' }),
          apply: async () => ({ data: null, replayed: false }),
          revert: async () => ({ data: null }),
          health: async () => ({ status: 'ok' }),
          storeConnectedAccount: async () => {},
          deleteConnectedAccount: async () => {},
        },
      });
    });

    afterAll(async () => {
      setGatekeeperReadHandlerDeps({});
      await pool.end();
    });

    describe('D-21 get_task', () => {
      it('the requester and the owner read the Task; another member gets 404 like an unknown id', async () => {
        const { taskId } = await seedTask(requesterId);

        const asRequester = (await dispatchCapability(
          { pool },
          humanCaller(requesterId, 'member'),
          'get_task',
          { taskId },
        )) as { id: string; input: unknown };
        expect(asRequester.id).toBe(taskId);
        expect(asRequester.input).toEqual({ text: 'private chat content' });

        const asOwner = (await dispatchCapability(
          { pool },
          humanCaller(ownerId, 'owner'),
          'get_task',
          { taskId },
        )) as { id: string };
        expect(asOwner.id).toBe(taskId);

        await expect(
          dispatchCapability({ pool }, humanCaller(otherMemberId, 'member'), 'get_task', {
            taskId,
          }),
        ).rejects.toMatchObject({ name: 'TaskNotFoundError' });
        await expect(
          dispatchCapability({ pool }, humanCaller(otherMemberId, 'member'), 'get_task', {
            taskId: randomUUID(),
          }),
        ).rejects.toMatchObject({ name: 'TaskNotFoundError' });
        // A builder is not a reviewer of Tasks: only the owner overrides.
        await expect(
          dispatchCapability({ pool }, humanCaller(builderId, 'builder'), 'get_task', { taskId }),
        ).rejects.toMatchObject({ name: 'TaskNotFoundError' });
      });

      it("the Task's own WorkerRun Handle reads it; another member's Handle does not", async () => {
        // The WorkerRun session acts for otherMember here, so only the sid branch can admit it.
        const { taskId, sessionId } = await seedTask(requesterId, otherMemberId);
        const scope: CapabilityScope = { capabilities: ['get_task'], resources: {} };

        const asOwnWorkerRun = (await dispatchCapability(
          { pool },
          handleCaller(otherMemberId, sessionId, scope),
          'get_task',
          { taskId },
        )) as { id: string; workerRuns: readonly unknown[] };
        expect(asOwnWorkerRun.id).toBe(taskId);
        expect(asOwnWorkerRun.workerRuns).toHaveLength(1);

        await expect(
          dispatchCapability(
            { pool },
            handleCaller(otherMemberId, randomUUID(), scope),
            'get_task',
            {
              taskId,
            },
          ),
        ).rejects.toMatchObject({ name: 'TaskNotFoundError' });

        // The requester's own entry Handle (obo = requester) still reads it.
        const asRequesterHandle = (await dispatchCapability(
          { pool },
          handleCaller(requesterId, randomUUID(), scope),
          'get_task',
          { taskId },
        )) as { id: string };
        expect(asRequesterHandle.id).toBe(taskId);
      });

      it('shows a Task’s input masked to everyone but its own Worker, which reads it as stored (legacy 184)', async () => {
        // Synthetic: one value only its field name gives away, one a value pattern finds.
        const input = {
          text: 'deploy it',
          db: { password: 'hunter2-plain-word' },
          note: 'PGPASSWORD=abcdefghijklmnopqrstuvwxyz0123',
        };
        const masked = {
          text: 'deploy it',
          db: { password: '[redacted]' },
          note: 'PGPASSWORD=[redacted]',
        };
        const { taskId, sessionId } = await seedTask(requesterId, requesterId, input);
        const scope: CapabilityScope = { capabilities: ['get_task'], resources: {} };
        const read = async (caller: ResolvedCaller, capability = 'get_task') =>
          (await dispatchCapability(
            { pool },
            caller,
            capability,
            capability === 'get_task' ? { taskId } : {},
          )) as {
            input?: unknown;
            items?: readonly { id: string; input: unknown }[];
          };

        expect((await read(humanCaller(requesterId, 'member'))).input).toEqual(masked);
        expect((await read(humanCaller(ownerId, 'owner'))).input).toEqual(masked);
        // The requester's entry agent — the one that wrote the input — gets the masked copy too.
        expect((await read(handleCaller(requesterId, randomUUID(), scope))).input).toEqual(masked);
        const listed = await read(humanCaller(requesterId, 'member'), 'list_tasks');
        expect(listed.items?.find((task) => task.id === taskId)?.input).toEqual(masked);

        // The Worker runs on the input as written.
        expect((await read(handleCaller(requesterId, sessionId, scope))).input).toEqual(input);
      });

      it('list_tasks still lists only the caller’s own Tasks, for the owner too', async () => {
        const { taskId } = await seedTask(requesterId);
        const listed = (await dispatchCapability(
          { pool },
          humanCaller(ownerId, 'owner'),
          'list_tasks',
          {},
        )) as { items: readonly { id: string }[] };
        expect(listed.items.some((task) => task.id === taskId)).toBe(false);
        const own = (await dispatchCapability(
          { pool },
          humanCaller(requesterId, 'member'),
          'list_tasks',
          {},
        )) as { items: readonly { id: string }[] };
        expect(own.items.some((task) => task.id === taskId)).toBe(true);
      });

      it('cancel_task keeps its owner-or-requester rule (403 for another member)', async () => {
        const { taskId } = await seedTask(requesterId);
        await expect(
          dispatchCapability({ pool }, humanCaller(otherMemberId, 'member'), 'cancel_task', {
            taskId,
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      });
    });

    describe('D-26 Operation drafts', () => {
      let gatekeeperId: string;
      const publishedName = `vis.published.${randomUUID().slice(0, 8)}`;
      const importDraftName = `vis.import-draft.${randomUUID().slice(0, 8)}`;
      const memberDraftName = `vis.member-draft.${randomUUID().slice(0, 8)}`;

      beforeAll(async () => {
        const activity = await inTx((client) =>
          startActivity(client, workspaceId, {
            kind: 'test.register_gatekeeper',
            principalId: ownerId,
          }),
        );
        gatekeeperId = (
          await inTx((client) =>
            registerGatekeeper(client, workspaceId, {
              name: `visibility-gate-${randomUUID().slice(0, 8)}`,
              transportKind: 'http',
              target: 'visibility-test-system',
              endpoint: `https://gate-${randomUUID()}.visibility-test.invalid`,
              activityId: activity.id,
              registeredBy: { id: ownerId, kind: 'human' },
            }),
          )
        ).gatekeeperId;
        await inTx((client) =>
          importManifest(client, workspaceId, {
            gatekeeperId,
            operations: [testOperation(publishedName), testOperation(importDraftName)],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          }),
        );
        await inTx((client) =>
          publishOperation(client, workspaceId, { gatekeeperId, name: publishedName }),
        );
        // A member's Worker proposal (report_task_result proposedOperations): proposedBy = the
        // member the Task acts for.
        await withWorkspace(pool, { workspaceId, principalId: requesterId }, (client) =>
          proposeOperation(client, workspaceId, {
            gatekeeperId,
            operation: testOperation(memberDraftName),
            proposedBy: { id: requesterId, kind: 'agent' },
            activityId: activity.id,
          }),
        );
      });

      async function namesVisibleTo(principalId: string, role: Role) {
        const caller = humanCaller(principalId, role);
        const listed = (await dispatchCapability({ pool }, caller, 'list_operations', {
          gatekeeperId,
        })) as { items: readonly { name: string }[] };
        const detail = (await dispatchCapability({ pool }, caller, 'get_gatekeeper', {
          gatekeeperId,
        })) as { operationCount: number; operations: readonly { name: string }[] };
        const gates = (await dispatchCapability({ pool }, caller, 'list_gatekeepers', {})) as {
          items: readonly { id: string; operationCount: number }[];
        };
        return {
          listed: listed.items.map((op) => op.name).sort(),
          detail: detail.operations.map((op) => op.name).sort(),
          detailCount: detail.operationCount,
          count: gates.items.find((gate) => gate.id === gatekeeperId)?.operationCount,
        };
      }

      it('another member sees only published Operations', async () => {
        const seen = await namesVisibleTo(otherMemberId, 'member');
        expect(seen.listed).toEqual([publishedName]);
        expect(seen.detail).toEqual([publishedName]);
        expect(seen.detailCount).toBe(1);
        expect(seen.count).toBe(1);
      });

      it('the proposer sees published Operations plus their own draft', async () => {
        const seen = await namesVisibleTo(requesterId, 'member');
        const expected = [memberDraftName, publishedName].sort();
        expect(seen.listed).toEqual(expected);
        expect(seen.detail).toEqual(expected);
        expect(seen.count).toBe(2);
      });

      it('builder and owner see every draft', async () => {
        const expected = [importDraftName, memberDraftName, publishedName].sort();
        for (const [principalId, role] of [
          [builderId, 'builder'],
          [ownerId, 'owner'],
        ] as const) {
          const seen = await namesVisibleTo(principalId, role);
          expect(seen.listed).toEqual(expected);
          expect(seen.detail).toEqual(expected);
          expect(seen.count).toBe(3);
        }
      });
    });
  },
);
