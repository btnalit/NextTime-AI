import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { type ActionExecutor, type ActionExecutorResult, ApprovalDrainer } from './drainer.js';
import { getActionRequest } from './reads.js';
import { requestAction } from './request-action.js';
import type { ActionRequestRow } from './types.js';

/**
 * governance/approval/drainer.integration: DB-backed tests for the per-Gatekeeper drain loop
 * (docs/development-tasks.md S2.3 acceptance "顺序 drain" — "drain 每 Gatekeeper 单飞、升序、遇
 * pending 停"). Gated on `DATABASE_URL`.
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

/** A scripted fake `ActionExecutor` — records call order and returns a per-actionKind result. */
function fakeExecutor(
  results: Record<string, ActionExecutorResult>,
  calls: string[],
): ActionExecutor {
  return {
    async execute(actionRequest: ActionRequestRow): Promise<ActionExecutorResult> {
      calls.push(actionRequest.actionKind);
      return results[actionRequest.actionKind] ?? { ok: true };
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'governance/approval/drainer — integration (real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

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

    async function adminInsertPrincipal(opts: {
      role: string;
      displayName: string;
    }): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, opts.role, opts.displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function insertGatekeeperObject(): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const id = randomUUID();
        await client.query(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [workspaceId, id],
        );
        return id;
      });
    }

    function withTransaction<T>(
      ws: string,
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId: ws, principalId }, fn);
    }

    async function createAutoApproved(
      gatekeeperId: string,
      actionKind: string,
    ): Promise<ActionRequestRow> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        requestAction(client, workspaceId, {
          gatekeeperId,
          actionKind,
          blastRadius: 'low',
          operationAutoApprovable: true,
          awaitDecision: false,
          onBehalfOf: ownerId,
          actorRuntime: 'pi',
          requesterScope: scopeCovering(gatekeeperId),
        }),
      );
    }

    async function createPending(
      gatekeeperId: string,
      actionKind: string,
    ): Promise<ActionRequestRow> {
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
      workspaceId = await adminInsertWorkspace('approval-drainer-test-workspace');
      ownerId = await adminInsertPrincipal({ role: 'owner', displayName: 'owner' });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('executes auto_approved/approved rows in ascending requested_at order and stops at the first pending row', async () => {
      const gatekeeperId = await insertGatekeeperObject();

      const first = await createAutoApproved(gatekeeperId, 'test.drain.first');
      const second = await createPending(gatekeeperId, 'test.drain.second');
      const third = await createAutoApproved(gatekeeperId, 'test.drain.third');

      const calls: string[] = [];
      const executor = fakeExecutor({}, calls);
      const drainer = new ApprovalDrainer({ executor, withTransaction });

      const result = await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);

      expect(result.stoppedAtPending).toBe(true);
      expect(result.processed).toBe(1);
      expect(calls).toEqual(['test.drain.first']);

      const firstAfter = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getActionRequest(client, workspaceId, first.id),
      );
      expect(firstAfter?.status).toBe('executed');

      const secondAfter = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getActionRequest(client, workspaceId, second.id),
      );
      expect(secondAfter?.status).toBe('pending_approval');

      // `third` sits after the pending row in requested_at order — never touched.
      const thirdAfter = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getActionRequest(client, workspaceId, third.id),
      );
      expect(thirdAfter?.status).toBe('auto_approved');
    });

    it('a failed executor result marks the row failed and the drain continues to the next row', async () => {
      const gatekeeperId = await insertGatekeeperObject();

      const willFail = await createAutoApproved(gatekeeperId, 'test.drain.fails');
      const willSucceed = await createAutoApproved(gatekeeperId, 'test.drain.succeeds');

      const calls: string[] = [];
      const executor = fakeExecutor(
        { 'test.drain.fails': { ok: false, reason: 'simulated failure' } },
        calls,
      );
      const drainer = new ApprovalDrainer({ executor, withTransaction });

      const result = await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);

      expect(result.stoppedAtPending).toBe(false);
      expect(result.processed).toBe(2);
      expect(calls).toEqual(['test.drain.fails', 'test.drain.succeeds']);

      const failedAfter = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getActionRequest(client, workspaceId, willFail.id),
      );
      expect(failedAfter?.status).toBe('failed');

      const succeededAfter = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getActionRequest(client, workspaceId, willSucceed.id),
      );
      expect(succeededAfter?.status).toBe('executed');
    });

    // Real-model regression 2026-10-02: a gate `apply` timeout is "outcome unknown", not failure —
    // the row must stay `executing` (for the stale-executing reaper's idempotent replay), never be
    // written `failed` while the gate may still be completing the effect. R-50 (D-10): that row is
    // then a barrier — the drain stops, and nothing later on the same Gatekeeper runs past it.
    it('an indeterminate executor result writes no terminal state: the row stays executing and the drain stops behind it', async () => {
      const gatekeeperId = await insertGatekeeperObject();

      const unknown = await createAutoApproved(gatekeeperId, 'test.drain.unknown');
      const next = await createAutoApproved(gatekeeperId, 'test.drain.after-unknown');

      const calls: string[] = [];
      const executor = fakeExecutor(
        {
          'test.drain.unknown': {
            ok: false,
            indeterminate: true,
            reason: 'outcome unknown: simulated apply timeout',
          },
        },
        calls,
      );
      const drainer = new ApprovalDrainer({ executor, withTransaction });

      const result = await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);

      expect(result.processed).toBe(1);
      expect(result.stoppedAtExecuting).toBe(true);
      expect(calls).toEqual(['test.drain.unknown']);

      const unknownAfter = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => getActionRequest(client, workspaceId, unknown.id),
      );
      expect(unknownAfter?.status).toBe('executing');

      const nextAfter = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, next.id),
      );
      expect(nextAfter?.status).toBe('auto_approved');

      // A later drain (another trigger, a later tick) stops at the same barrier.
      const again = await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      expect(again).toMatchObject({ processed: 0, stoppedAtExecuting: true });
      expect(calls).toEqual(['test.drain.unknown']);
    });

    // R-50 (D-10): per-Gatekeeper serial order is a guarantee across drainer instances — the
    // request path's phase 2, the outbox consumer and the periodic tick each have their own, so an
    // in-memory single-flight set cannot provide it. The `executing` row is the barrier.
    it('barrier: a second drainer does not start r2 while r1 is executing on the first; the first picks r2 up after r1', async () => {
      const gatekeeperId = await insertGatekeeperObject();
      const r1 = await createAutoApproved(gatekeeperId, 'test.barrier.r1');

      let releaseR1: (() => void) | undefined;
      const r1Running = new Promise<void>((resolve) => {
        releaseR1 = resolve;
      });
      let r1Started: (() => void) | undefined;
      const r1HasStarted = new Promise<void>((resolve) => {
        r1Started = resolve;
      });
      const firstCalls: string[] = [];
      const firstDrainer = new ApprovalDrainer({
        executor: {
          async execute(actionRequest) {
            firstCalls.push(actionRequest.actionKind);
            if (actionRequest.id === r1.id) {
              r1Started?.();
              await r1Running;
            }
            return { ok: true };
          },
        },
        withTransaction,
      });
      const firstDrain = firstDrainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      await r1HasStarted;

      // r2 is approved while r1 is applying; its own trigger drains on a different instance.
      const r2 = await createAutoApproved(gatekeeperId, 'test.barrier.r2');
      const secondCalls: string[] = [];
      const secondDrainer = new ApprovalDrainer({
        executor: fakeExecutor({}, secondCalls),
        withTransaction,
      });
      const secondResult = await secondDrainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      expect(secondResult).toEqual({
        processed: 0,
        stoppedAtPending: false,
        stoppedAtExecuting: true,
        skippedInFlight: false,
      });
      expect(secondCalls).toEqual([]);
      const r2During = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        getActionRequest(client, workspaceId, r2.id),
      );
      expect(r2During?.status).toBe('auto_approved');

      releaseR1?.();
      const firstResult = await firstDrain;
      expect(firstResult).toMatchObject({ processed: 2, stoppedAtExecuting: false });
      expect(firstCalls).toEqual(['test.barrier.r1', 'test.barrier.r2']);
      for (const row of [r1, r2]) {
        const after = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          getActionRequest(client, workspaceId, row.id),
        );
        expect(after?.status).toBe('executed');
      }
    });

    it('single-flight: a concurrent drain call for the same gatekeeper is skipped, not queued', async () => {
      const gatekeeperId = await insertGatekeeperObject();
      await createAutoApproved(gatekeeperId, 'test.drain.slow');

      let releaseExecute: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });

      const slowExecutor: ActionExecutor = {
        async execute() {
          await gate;
          return { ok: true };
        },
      };
      const drainer = new ApprovalDrainer({ executor: slowExecutor, withTransaction });

      const firstCall = drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      // Give the first call a chance to reach (and block inside) the executor before firing the
      // second — otherwise both could race to register in `inFlight` before either actually starts.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const secondResult = await drainer.drainGatekeeper(workspaceId, ownerId, gatekeeperId);
      expect(secondResult).toEqual({
        processed: 0,
        stoppedAtPending: false,
        stoppedAtExecuting: false,
        skippedInFlight: true,
      });

      releaseExecute?.();
      const firstResult = await firstCall;
      expect(firstResult.skippedInFlight).toBe(false);
      expect(firstResult.processed).toBe(1);
    });
  },
);
