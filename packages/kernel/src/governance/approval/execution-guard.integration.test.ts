import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope } from '@nexttime/shared';
import { IllegalTransition } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADVISORY_LOCK_NAMESPACES } from '../../adapters/db/advisory-lock-namespaces.js';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { type ActionExecutor, ApprovalDrainer } from './drainer.js';
import { markActionRequestExecuted, startActionRequestExecution } from './execution.js';
import { getActionRequest } from './reads.js';
import { requestAction } from './request-action.js';
import { ActionRequestExecutionConflictError, type ActionRequestRow } from './types.js';

/**
 * governance/approval/execution-guard.integration (STATUS legacy 565): two conflicting requests
 * of one Gatekeeper are never `executing` together (I-Q1), even where the drainer's read cannot
 * see that — a row that commits after a conflicting, later-stamped row has started, and two
 * starts in transactions that cannot see each other. `governance/0031` keeps it where a row
 * enters `executing`. What it keeps is mutual exclusion, not `requested_at` order: the
 * late-committed row runs after the one that started first. Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function scopeCovering(gatekeeperId: string): CapabilityScope {
  return { capabilities: ['request_action'], resources: { gatekeeper: [gatekeeperId] } };
}

/** A promise and the function that settles it. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe.runIf(DATABASE_URL !== undefined)(
  'governance/approval — execution guard (legacy 565, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    function withTransaction<T>(
      ws: string,
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId: ws, principalId }, fn);
    }

    function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withTransaction(workspaceId, ownerId, fn);
    }

    async function insertGatekeeperObject(): Promise<string> {
      return asOwner(async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [workspaceId, id],
        );
        return id;
      });
    }

    /** An auto-approved call on Container `container`, inside `client`'s transaction. */
    function requestOn(
      client: PoolClient,
      gatekeeperId: string,
      actionKind: string,
      container: string,
    ): Promise<ActionRequestRow> {
      return requestAction(client, workspaceId, {
        gatekeeperId,
        actionKind,
        blastRadius: 'low',
        operationAutoApprovable: true,
        awaitDecision: false,
        onBehalfOf: ownerId,
        actorRuntime: 'pi',
        requesterScope: scopeCovering(gatekeeperId),
        params: { id: container },
        target: { type: 'Container', params: ['id'], identity: [container] },
      });
    }

    async function statusOf(id: string): Promise<string | undefined> {
      return (await asOwner((client) => getActionRequest(client, workspaceId, id)))?.status;
    }

    /** Whether some transaction is waiting for the execution lock (the two-key advisory lock of
     *  class `actionRequestExecution`). */
    async function waitForBlockedStart(): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await pool.query<{ waiting: number }>(
          `select count(*)::int as waiting from pg_locks
            where locktype = 'advisory' and objsubid = 2 and classid = $1 and not granted`,
          [ADVISORY_LOCK_NAMESPACES.actionRequestExecution],
        );
        if ((rows[0]?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('no start ever waited for the execution lock');
    }

    /** An executor that records the calls, the most that ran at once, and holds `hold` until
     *  `release` opens. */
    function trackingExecutor(hold: string, release: Promise<void>, held: () => void) {
      const calls: string[] = [];
      let running = 0;
      let maxRunning = 0;
      const executor: ActionExecutor = {
        async execute(actionRequest) {
          calls.push(actionRequest.actionKind);
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          if (actionRequest.id === hold) {
            held();
            await release;
          }
          running -= 1;
          return { ok: true };
        },
      };
      return { executor, calls, maxRunning: () => maxRunning };
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
            'approval-execution-guard-test-workspace',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a row committed after a conflicting later-stamped row started waits for it: never both, B then A', async () => {
      const gatekeeperId = await insertGatekeeperObject();

      // A is stamped first (its transaction starts first) but commits last.
      const commitA = latch();
      const aInserted = latch();
      let a: ActionRequestRow | undefined;
      const aTransaction = asOwner(async (client) => {
        a = await requestOn(client, gatekeeperId, 'test.guard.a', 'web');
        aInserted.open();
        await commitA.promise;
      });
      await aInserted.promise;
      const b = await asOwner((client) => requestOn(client, gatekeeperId, 'test.guard.b', 'web'));
      if (a === undefined) throw new Error('A was not inserted');
      expect(a.requestedAt.getTime()).toBeLessThan(b.requestedAt.getTime());

      // One drain starts B — A is not visible yet — and holds it in its executor.
      const releaseB = latch();
      const bHeld = latch();
      const tracked = trackingExecutor(b.id, releaseB.promise, bHeld.open);
      const firstDrain = new ApprovalDrainer({
        executor: tracked.executor,
        withTransaction,
      }).drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      await bHeld.promise;

      // A commits: the queue now reads A (approved) ahead of B (executing).
      commitA.open();
      await aTransaction;

      // Another trigger's drain does not start A ...
      const second = await new ApprovalDrainer({
        executor: tracked.executor,
        withTransaction,
      }).drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      expect(second).toMatchObject({ processed: 0, stoppedAtExecuting: true });
      // ... and a start that skips the queue planner is refused by the database.
      const refused = await asOwner((client) =>
        startActionRequestExecution(client, workspaceId, (a as ActionRequestRow).id),
      ).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ActionRequestExecutionConflictError);
      expect(refused).toBeInstanceOf(IllegalTransition);
      expect(await statusOf(a.id)).toBe('auto_approved');

      // B ends; the first drain reads again and runs A.
      releaseB.open();
      expect(await firstDrain).toMatchObject({ processed: 2, stoppedAtExecuting: false });
      expect(tracked.calls).toEqual(['test.guard.b', 'test.guard.a']);
      expect(tracked.maxRunning()).toBe(1);
      expect(await statusOf(a.id)).toBe('executed');
      expect(await statusOf(b.id)).toBe('executed');
    });

    it('two starts that cannot see each other: the second waits for the first to commit, then is refused', async () => {
      const gatekeeperId = await insertGatekeeperObject();
      const a = await asOwner((client) => requestOn(client, gatekeeperId, 'test.guard.a', 'web'));
      const b = await asOwner((client) => requestOn(client, gatekeeperId, 'test.guard.b', 'web'));

      // T1 starts B and stays open; T2, started from a read that saw B approved, starts A.
      const commitT1 = latch();
      const t1Started = latch();
      const t1 = asOwner(async (client) => {
        await startActionRequestExecution(client, workspaceId, b.id);
        t1Started.open();
        await commitT1.promise;
      });
      await t1Started.promise;
      const t2 = asOwner((client) => startActionRequestExecution(client, workspaceId, a.id)).catch(
        (err: unknown) => err,
      );
      await waitForBlockedStart();

      commitT1.open();
      await t1;
      const outcome = await t2;
      expect(outcome).toBeInstanceOf(ActionRequestExecutionConflictError);
      expect((outcome as ActionRequestExecutionConflictError).actionRequestId).toBe(a.id);
      expect(await statusOf(a.id)).toBe('auto_approved');
      expect(await statusOf(b.id)).toBe('executing');

      // Once B ends, A starts.
      await asOwner((client) => markActionRequestExecuted(client, workspaceId, b.id));
      const started = await asOwner((client) =>
        startActionRequestExecution(client, workspaceId, a.id),
      );
      expect(started.status).toBe('executing');
      await asOwner((client) => markActionRequestExecuted(client, workspaceId, a.id));
    });

    it('two starts on other instances serialize on the lock and both go through', async () => {
      const gatekeeperId = await insertGatekeeperObject();
      const web = await asOwner((client) =>
        requestOn(client, gatekeeperId, 'test.guard.web', 'web'),
      );
      const db = await asOwner((client) => requestOn(client, gatekeeperId, 'test.guard.db', 'db'));

      const commitT1 = latch();
      const t1Started = latch();
      const t1 = asOwner(async (client) => {
        await startActionRequestExecution(client, workspaceId, web.id);
        t1Started.open();
        await commitT1.promise;
      });
      await t1Started.promise;
      const t2 = asOwner((client) => startActionRequestExecution(client, workspaceId, db.id));
      await waitForBlockedStart();

      commitT1.open();
      await t1;
      expect((await t2).status).toBe('executing');
      expect(await statusOf(web.id)).toBe('executing');
      for (const row of [web, db]) {
        await asOwner((client) => markActionRequestExecuted(client, workspaceId, row.id));
      }
    });

    it('starts on another Gatekeeper do not wait for the lock', async () => {
      const first = await insertGatekeeperObject();
      const other = await insertGatekeeperObject();
      const a = await asOwner((client) => requestOn(client, first, 'test.guard.a', 'web'));
      const b = await asOwner((client) => requestOn(client, other, 'test.guard.b', 'web'));

      const commitT1 = latch();
      const t1Started = latch();
      const t1 = asOwner(async (client) => {
        await startActionRequestExecution(client, workspaceId, a.id);
        t1Started.open();
        await commitT1.promise;
      });
      await t1Started.promise;
      // Not blocked: this resolves while T1 is still open.
      const started = await asOwner((client) =>
        startActionRequestExecution(client, workspaceId, b.id),
      );
      expect(started.status).toBe('executing');
      commitT1.open();
      await t1;
      for (const row of [a, b]) {
        await asOwner((client) => markActionRequestExecuted(client, workspaceId, row.id));
      }
    });
  },
);
