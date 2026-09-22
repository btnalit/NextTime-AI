import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/approval-history.integration.test: DB-gated (auto-skip without
 * DATABASE_URL) end-to-end coverage, through `dispatchCapability`, for two S6-A additions to the
 * approval capabilities (docs/console-completion-plan.md §5.5, §5.8, §6; §2b C25 / C28):
 *
 *   - `approve{reason?}` (C25): kernel-enforced for `blast_radius = 'high'` (400
 *     `reason_required` — the error's own `code`; the HTTP/WS mapping lives in
 *     interfaces/), optional otherwise; the decision's reason / decider / time come back on the
 *     wire row as `decisionReason` / `decidedBy` / `decidedAt` from `approve`, `reject`,
 *     `get_action`, `list_action_requests` (and `null` on rows never decided by a human).
 *   - `list_action_requests{taskId?, parentWorkerRunId?}` (C28): a *decided* request is found by
 *     the Task its WorkerRun belongs to; an unknown Task is an empty page, not an error; the two
 *     filters intersect; I14 visibility and keyset paging are untouched.
 *
 * Rows are seeded directly (`action_requests` under the admin login role, a `tasks` /
 * `worker_runs` pair the same way) — `requestAction` always stamps `pending_approval` from policy
 * and there is no Worker runtime in this test to produce a real WorkerRun, so the seed is the
 * exact shape the real writers produce (same convention `governance/approval/
 * reads.integration.test.ts` already uses).
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

interface ActionRequestWire {
  id: string;
  status: string;
  blastRadius: string;
  parentWorkerRunId: string | null;
  approvalDecisionId: string | null;
  decisionReason?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'S6-A approve.reason (C25) and list_action_requests taskId / parentWorkerRunId (C28) (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let gatekeeperId: string;

    async function admin<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function seedTaskWithWorkerRuns(runCount: number): Promise<{
      taskId: string;
      workerRunIds: string[];
    }> {
      return admin(async (client) => {
        const task = await client.query<{ id: string }>(
          `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, 'running', $2, $3, 1) returning id`,
          [workspaceId, ownerId, randomUUID()],
        );
        const taskId = task.rows[0]?.id as string;
        const workerRunIds: string[] = [];
        for (let i = 0; i < runCount; i += 1) {
          const run = await client.query<{ id: string }>(
            `insert into worker_runs (workspace_id, status, task_id) values ($1, 'running', $2) returning id`,
            [workspaceId, taskId],
          );
          workerRunIds.push(run.rows[0]?.id as string);
        }
        return { taskId, workerRunIds };
      });
    }

    async function seedPendingActionRequest(input: {
      readonly blastRadius: 'low' | 'medium' | 'high';
      readonly parentWorkerRunId?: string;
      readonly actionKind?: string;
    }): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into action_requests
             (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
              policy_decision, await_decision, on_behalf_of, parent_worker_run_id, actor_runtime,
              requester_can_approve)
           values ($1, $2, 'pending_approval', $3::uuid, $4, $3::text, $5, 'require_approval', false,
                   $6, $7::uuid, 'pi', true)`,
          [
            workspaceId,
            id,
            gatekeeperId,
            input.actionKind ?? 'ah.test.action',
            input.blastRadius,
            memberId,
            input.parentWorkerRunId ?? null,
          ],
        ),
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'approval-history-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, memberId],
          );
        },
        { skipRoleSwitch: true },
      );
      gatekeeperId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.register_gatekeeper',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: 'approval-history-gate',
            transportKind: 'http',
            target: 'approval-history-system',
            endpoint: 'https://gate.approval-history-test.invalid/',
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          return registered.gatekeeperId;
        },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('approve on a high-blast-radius request without a reason is refused with code reason_required and leaves the row pending', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const id = await seedPendingActionRequest({ blastRadius: 'high' });

      await expect(
        dispatchCapability({ pool }, owner, 'approve', { actionRequestId: id }),
      ).rejects.toMatchObject({ name: 'ApprovalReasonRequiredError', code: 'reason_required' });
      await expect(
        dispatchCapability({ pool }, owner, 'approve', { actionRequestId: id, reason: '  ' }),
      ).rejects.toMatchObject({ code: 'reason_required' });

      const still = (await dispatchCapability({ pool }, owner, 'get_action', {
        actionRequestId: id,
      })) as ActionRequestWire;
      expect(still.status).toBe('pending_approval');
      expect(still.decisionReason).toBeNull();
      expect(still.decidedBy).toBeNull();
      expect(still.decidedAt).toBeNull();

      // With a reason it goes through, and the wire row carries the decision.
      const approved = (await dispatchCapability({ pool }, owner, 'approve', {
        actionRequestId: id,
        reason: 'target verified out of band',
      })) as ActionRequestWire;
      expect(approved.status).toBe('approved');
      expect(approved.decisionReason).toBe('target verified out of band');
      expect(approved.decidedBy).toBe(ownerId);
      expect(typeof approved.decidedAt).toBe('string');
      expect(approved.approvalDecisionId).toEqual(expect.any(String));

      const read = (await dispatchCapability({ pool }, owner, 'get_action', {
        actionRequestId: id,
      })) as ActionRequestWire;
      expect(read).toMatchObject({
        decisionReason: 'target verified out of band',
        decidedBy: ownerId,
        decidedAt: approved.decidedAt,
      });
    });

    it('approve on a medium-blast-radius request needs no reason; reject keeps its optional reason; both expose the decision on the wire', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const mediumId = await seedPendingActionRequest({ blastRadius: 'medium' });
      const approved = (await dispatchCapability({ pool }, owner, 'approve', {
        actionRequestId: mediumId,
      })) as ActionRequestWire;
      expect(approved.status).toBe('approved');
      expect(approved.decisionReason).toBeNull();
      expect(approved.decidedBy).toBe(ownerId);

      const lowId = await seedPendingActionRequest({ blastRadius: 'low' });
      const rejected = (await dispatchCapability({ pool }, owner, 'reject', {
        actionRequestId: lowId,
        reason: 'not in this change window',
      })) as ActionRequestWire;
      expect(rejected.status).toBe('rejected');
      expect(rejected.decisionReason).toBe('not in this change window');
      expect(rejected.decidedBy).toBe(ownerId);
    });

    it('list_action_requests{taskId} finds a decided request through its WorkerRun; parentWorkerRunId narrows; unknown taskId is an empty page', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const { taskId, workerRunIds } = await seedTaskWithWorkerRuns(2);
      const [runA, runB] = workerRunIds as [string, string];
      const onRunA = await seedPendingActionRequest({
        blastRadius: 'high',
        parentWorkerRunId: runA,
        actionKind: 'ah.task.action',
      });
      const onRunB = await seedPendingActionRequest({
        blastRadius: 'low',
        parentWorkerRunId: runB,
        actionKind: 'ah.task.action',
      });
      const unrelated = await seedPendingActionRequest({
        blastRadius: 'low',
        actionKind: 'ah.task.action',
      });

      // Decide one of them so the "decided rows are found" half is real.
      await dispatchCapability({ pool }, owner, 'reject', {
        actionRequestId: onRunA,
        reason: 'wrong target',
      });

      const byTask = (await dispatchCapability({ pool }, owner, 'list_action_requests', {
        taskId,
      })) as { items: ActionRequestWire[]; nextCursor?: string };
      const byTaskIds = byTask.items.map((row) => row.id);
      expect(byTaskIds).toEqual(expect.arrayContaining([onRunA, onRunB]));
      expect(byTaskIds).not.toContain(unrelated);
      const decided = byTask.items.find((row) => row.id === onRunA);
      expect(decided).toMatchObject({
        status: 'rejected',
        parentWorkerRunId: runA,
        decisionReason: 'wrong target',
        decidedBy: ownerId,
      });
      expect(byTask.items.find((row) => row.id === onRunB)?.decisionReason).toBeNull();

      const byRun = (await dispatchCapability({ pool }, owner, 'list_action_requests', {
        parentWorkerRunId: runB,
      })) as { items: ActionRequestWire[] };
      expect(byRun.items.map((row) => row.id)).toEqual([onRunB]);

      // Intersection: a WorkerRun that belongs to the Task → its rows; one that does not → none.
      const both = (await dispatchCapability({ pool }, owner, 'list_action_requests', {
        taskId,
        parentWorkerRunId: runA,
      })) as { items: ActionRequestWire[] };
      expect(both.items.map((row) => row.id)).toEqual([onRunA]);
      const { workerRunIds: otherRuns } = await seedTaskWithWorkerRuns(1);
      const mismatch = (await dispatchCapability({ pool }, owner, 'list_action_requests', {
        taskId,
        parentWorkerRunId: otherRuns[0],
      })) as { items: ActionRequestWire[] };
      expect(mismatch.items).toEqual([]);

      // Status filter still composes with the new ones; an unknown Task matches nothing.
      const rejectedOnly = (await dispatchCapability({ pool }, owner, 'list_action_requests', {
        taskId,
        status: 'rejected',
      })) as { items: ActionRequestWire[] };
      expect(rejectedOnly.items.map((row) => row.id)).toEqual([onRunA]);
      const unknownTask = (await dispatchCapability({ pool }, owner, 'list_action_requests', {
        taskId: randomUUID(),
      })) as { items: ActionRequestWire[] };
      expect(unknownTask.items).toEqual([]);
    });

    it('list_action_requests{taskId} keeps I14 visibility: an operator with no grant sees none of the Task’s rows', async () => {
      const { taskId, workerRunIds } = await seedTaskWithWorkerRuns(1);
      await seedPendingActionRequest({
        blastRadius: 'low',
        parentWorkerRunId: workerRunIds[0],
        actionKind: 'ah.i14.action',
      });
      const operatorId = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'operator', 'operator-no-grant')`,
          [workspaceId, operatorId],
        ),
      );
      const operator = humanCaller(workspaceId, operatorId, 'operator');
      const page = (await dispatchCapability({ pool }, operator, 'list_action_requests', {
        taskId,
      })) as { items: ActionRequestWire[] };
      expect(page.items).toEqual([]);
    });
  },
);
