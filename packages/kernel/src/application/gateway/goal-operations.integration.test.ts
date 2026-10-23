import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CancelGoalResultWireSchema,
  type CapabilityScope,
  ConfirmGoalAcceptanceResultWireSchema,
  ConfirmGoalResultWireSchema,
  EndGoalResultWireSchema,
  GoalDetailWireSchema,
  GoalOperationResultWireSchema,
  ReconcileGoalActionResultWireSchema,
  ResumeGoalResultWireSchema,
  ReviseGoalResultWireSchema,
  type Role,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { advanceGoalRun } from '../goal/advance.js';
import { createGoalRun } from '../goal/index.js';
import { completeTaskWithResult } from '../task/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO5b: a person's
 * operations on a goal run — `confirm_goal`, `reject_goal`, `pause_goal`, `resume_goal`,
 * `cancel_goal`, `release_goal_hold`, `revise_goal`, `confirm_goal_acceptance`, `end_goal`,
 * `reconcile_goal_action` — dispatched through the capability gateway, as the console calls them:
 * the actor and their role come from the authenticated caller (legacy 389), a run the caller cannot
 * read is not found (404), one they can read but may not act on this way is 403, one whose state
 * does not allow it now is 409, and free text that carries a suspected credential is refused (400)
 * with nothing written. Each refusal is checked through the HTTP transport's mapping, and each
 * result against its wire schema. What each operation does to the run is `application/goal`'s
 * tests' (advancer.integration.test.ts); this file checks the gateway's side of it.
 *
 * Every run this file moves is left with no `next_tick_at`, so no advancer of another file claims
 * it; the advances a test needs are driven by hand, with an in-memory supervisor.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 };
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

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

function handleCaller(workspaceId: string, obo: string, scope: CapabilityScope): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope,
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

/** Every spawn starts `running`; a test ends one by reporting the Task's result. */
class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.22',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.22' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    return this.statuses.delete(workerRunId);
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }
}

/** What the HTTP transport answers for the call's refusal (it must refuse). */
async function refusal(call: Promise<unknown>) {
  let thrown: unknown;
  try {
    await call;
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) throw new Error('expected the call to be refused');
  return mapCapabilityError(thrown);
}

describe.runIf(DATABASE_URL !== undefined)(
  'goal operations — S11 GO5b (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let requesterId: string;
    let otherMemberId: string;
    let auditorId: string;
    let worker: { definitionId: string; version: number };
    const supervisor = new FakeTaskSupervisorClient();

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    /** A write with the guards off — fixtures the write paths of this wave do not reach. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });

    const as = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);

    async function newPrincipal(role: Role): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, `${role}-${id.slice(0, 8)}`],
        ),
      );
      return id;
    }

    function planOf(keys: readonly string[]) {
      return {
        steps: keys.map((key, index) => ({
          key,
          worker,
          input: { step: key },
          ...(index > 0 ? { dependsOn: [keys[index - 1]] } : {}),
        })),
      };
    }

    async function proposeGoal(by: string, keys: readonly string[] = ['a', 'b']) {
      const created = await as(by, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId: by,
          proposedBy: by,
          statement: `goal of ${by.slice(0, 8)}`,
          plan: planOf(keys),
          budget: BUDGET,
        }),
      );
      return created.goalRunId;
    }

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

    const human = (principalId: string, role: Role) => humanCaller(workspaceId, principalId, role);
    const requester = () => human(requesterId, 'member');
    const owner = () => human(ownerId, 'owner');
    const otherMember = () => human(otherMemberId, 'member');

    /** A call through the gateway; the run it names is parked again afterwards, refused or not. */
    async function call(caller: ResolvedCaller, name: string, params: Record<string, unknown>) {
      try {
        return await dispatchCapability({ pool }, caller, name, params);
      } finally {
        if (typeof params.goalRunId === 'string') await parkGoal(params.goalRunId);
      }
    }

    /** Proposed, then confirmed through the gateway by its requester. */
    async function startGoal(by: string, keys?: readonly string[]) {
      const goalRunId = await proposeGoal(by, keys);
      await call(human(by, 'member'), 'confirm_goal', { goalRunId, revision: 1 });
      return goalRunId;
    }

    /** Confirmed, then paused by its requester. */
    async function pausedGoal(by: string, keys?: readonly string[]) {
      const goalRunId = await startGoal(by, keys);
      await call(human(by, 'member'), 'pause_goal', { goalRunId });
      return goalRunId;
    }

    async function advanceOnce(goalRunId: string, by: string) {
      await advanceGoalRun(
        {
          pool,
          taskRuntime: { pool, privateKey, supervisorClient: supervisor },
          options: { retryBackoffMs: () => 0 },
        },
        { workspaceId, goalRunId, requesterId: by },
      );
      await parkGoal(goalRunId);
    }

    const goalRow = async (goalRunId: string) => {
      const [row] = await raw<{
        status: string;
        current_revision: number | null;
        paused_by: string | null;
        paused_by_authority: string | null;
        outcome: string | null;
      }>(
        `select status, current_revision, paused_by, paused_by_authority, outcome
           from goal_runs where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId],
      );
      if (!row) throw new Error(`goal run ${goalRunId} is gone`);
      return row;
    };

    const revisionRows = (goalRunId: string) =>
      raw<{ revision: number; status: string; decided_by: string | null }>(
        `select revision, status, decided_by from plan_revisions
          where workspace_id = $1 and goal_run_id = $2 order by revision`,
        [workspaceId, goalRunId],
      );

    const stepRows = (goalRunId: string) =>
      raw<{ id: string; step_key: string; status: string }>(
        `select id, step_key, status from step_runs
          where workspace_id = $1 and goal_run_id = $2 order by step_key, created_at`,
        [workspaceId, goalRunId],
      );

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go5b-goal-operations',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      requesterId = await newPrincipal('member');
      otherMemberId = await newPrincipal('member');
      auditorId = await newPrincipal('auditor');
      const proposed = await as(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You do one step of a goal.' },
        }),
      );
      await as(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      worker = { definitionId: proposed.id, version: proposed.version };
    });

    afterAll(async () => {
      // Leave nothing for another file's kernel to advance.
      await raw(
        `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                paused_by_authority = null, ended_at = now(), next_tick_at = null
          where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
        [workspaceId],
      );
      await pool.end();
    });

    describe('confirm_goal', () => {
      it('the requester confirms revision 1: the run starts with its StepRuns; a replay changes nothing', async () => {
        const goalRunId = await proposeGoal(requesterId);
        const confirmed = ConfirmGoalResultWireSchema.parse(
          await call(requester(), 'confirm_goal', { goalRunId, revision: 1 }),
        );
        const steps = await stepRows(goalRunId);
        expect(confirmed).toEqual({
          goalRunId,
          status: 'running',
          changed: true,
          createdStepRunIds: steps.map((step) => step.id),
        });
        expect(steps).toHaveLength(2);

        // No key: the run's state and the revision bound to are what make a retry safe.
        const replay = ConfirmGoalResultWireSchema.parse(
          await call(requester(), 'confirm_goal', { goalRunId, revision: 1 }),
        );
        expect(replay).toEqual({
          goalRunId,
          status: 'running',
          changed: false,
          createdStepRunIds: [],
        });
        expect(await stepRows(goalRunId)).toHaveLength(2);
        expect((await revisionRows(goalRunId))[0]).toMatchObject({
          status: 'accepted',
          decided_by: requesterId,
        });
      });

      it('a confirmation bound to another revision is refused (409) and starts nothing', async () => {
        const goalRunId = await proposeGoal(requesterId);
        expect(
          await refusal(call(requester(), 'confirm_goal', { goalRunId, revision: 2 })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        expect((await goalRow(goalRunId)).status).toBe('proposed');
        expect(await stepRows(goalRunId)).toEqual([]);
      });

      it('only the requester confirms: an owner 403, another member 404, an auditor and a Handle refused', async () => {
        const goalRunId = await proposeGoal(requesterId);
        expect(
          await refusal(call(owner(), 'confirm_goal', { goalRunId, revision: 1 })),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        // Another member cannot read the run: not found, as for an unknown id.
        expect(
          await refusal(call(otherMember(), 'confirm_goal', { goalRunId, revision: 1 })),
        ).toMatchObject({ status: 404, code: 'not_found' });
        expect(
          await refusal(
            call(otherMember(), 'confirm_goal', { goalRunId: randomUUID(), revision: 1 }),
          ),
        ).toMatchObject({ status: 404, code: 'not_found' });
        expect(
          await refusal(
            call(human(auditorId, 'auditor'), 'confirm_goal', { goalRunId, revision: 1 }),
          ),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        // A person's operation is never a Handle's, even one carrying it in its scope.
        const scope: CapabilityScope = { capabilities: ['confirm_goal'], resources: {} };
        expect(
          await refusal(
            call(handleCaller(workspaceId, requesterId, scope), 'confirm_goal', {
              goalRunId,
              revision: 1,
            }),
          ),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        expect((await goalRow(goalRunId)).status).toBe('proposed');
      });
    });

    describe('reject_goal', () => {
      it("an owner rejects a member's proposal: cancelled, revision 1 rejected by them; a replay changes nothing", async () => {
        const goalRunId = await proposeGoal(requesterId);
        const rejected = GoalOperationResultWireSchema.parse(
          await call(owner(), 'reject_goal', { goalRunId, revision: 1 }),
        );
        expect(rejected).toEqual({ goalRunId, status: 'cancelled', changed: true });
        expect(await revisionRows(goalRunId)).toEqual([
          { revision: 1, status: 'rejected', decided_by: ownerId },
        ]);
        expect(await stepRows(goalRunId)).toEqual([]);

        expect(
          GoalOperationResultWireSchema.parse(
            await call(requester(), 'reject_goal', { goalRunId, revision: 1 }),
          ),
        ).toEqual({ goalRunId, status: 'cancelled', changed: false });
        // Rejected is final: it is not confirmed after.
        expect(
          await refusal(call(requester(), 'confirm_goal', { goalRunId, revision: 1 })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        const detail = GoalDetailWireSchema.parse(
          await call(requester(), 'get_goal', { goalRunId }),
        );
        expect(detail).toMatchObject({ status: 'cancelled', currentRevision: null });
        expect(detail.planRevision).toMatchObject({ revision: 1, status: 'rejected' });
      });

      it('a confirmed run is not rejected (409); another member gets not found', async () => {
        const running = await startGoal(requesterId);
        expect(
          await refusal(call(requester(), 'reject_goal', { goalRunId: running, revision: 1 })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        const proposed = await proposeGoal(requesterId);
        expect(
          await refusal(call(otherMember(), 'reject_goal', { goalRunId: proposed, revision: 1 })),
        ).toMatchObject({ status: 404, code: 'not_found' });
        expect(
          await refusal(call(requester(), 'reject_goal', { goalRunId: proposed, revision: 3 })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        expect((await goalRow(proposed)).status).toBe('proposed');
      });
    });

    describe('pause_goal / release_goal_hold / resume_goal', () => {
      it("an owner's pause holds the run: the requester cannot resume it until an owner lifts the hold", async () => {
        const goalRunId = await startGoal(requesterId);
        expect(
          GoalOperationResultWireSchema.parse(await call(owner(), 'pause_goal', { goalRunId })),
        ).toEqual({ goalRunId, status: 'paused', changed: true });
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'paused',
          paused_by: ownerId,
          paused_by_authority: 'owner',
        });

        expect(await refusal(call(requester(), 'resume_goal', { goalRunId }))).toMatchObject({
          status: 409,
          code: 'illegal_transition',
        });
        // The requester's own pause over a hold changes nothing; the hold stays.
        expect(
          GoalOperationResultWireSchema.parse(await call(requester(), 'pause_goal', { goalRunId })),
        ).toEqual({ goalRunId, status: 'paused', changed: false });
        // Lifting a hold is an owner's: a member's call is refused by role before it runs.
        expect(await refusal(call(requester(), 'release_goal_hold', { goalRunId }))).toMatchObject({
          status: 403,
          code: 'forbidden',
        });
        expect((await goalRow(goalRunId)).paused_by_authority).toBe('owner');

        expect(
          GoalOperationResultWireSchema.parse(
            await call(owner(), 'release_goal_hold', { goalRunId }),
          ),
        ).toEqual({ goalRunId, status: 'paused', changed: true });
        expect(
          GoalOperationResultWireSchema.parse(
            await call(owner(), 'release_goal_hold', { goalRunId }),
          ),
        ).toEqual({ goalRunId, status: 'paused', changed: false });
        // Lifting the hold does not resume the run: the requester does.
        expect((await goalRow(goalRunId)).status).toBe('paused');
        expect(
          ResumeGoalResultWireSchema.parse(await call(requester(), 'resume_goal', { goalRunId })),
        ).toEqual({ goalRunId, status: 'running', changed: true, retriedStepRunIds: [] });
      });

      it('resume names the steps it retries: on a running run that is refused (409), a plain resume changes nothing', async () => {
        const goalRunId = await startGoal(requesterId);
        expect(
          await refusal(call(requester(), 'resume_goal', { goalRunId, retrySteps: ['a'] })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        expect(
          ResumeGoalResultWireSchema.parse(await call(requester(), 'resume_goal', { goalRunId })),
        ).toEqual({ goalRunId, status: 'running', changed: false, retriedStepRunIds: [] });
        // Only a failed step is retried: a pending one is refused on a paused run.
        await call(requester(), 'pause_goal', { goalRunId });
        expect(
          await refusal(call(requester(), 'resume_goal', { goalRunId, retrySteps: ['b'] })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        expect(
          await refusal(call(requester(), 'resume_goal', { goalRunId, retrySteps: [] })),
        ).toMatchObject({ status: 400, code: 'invalid_params' });
        // Someone else cannot resume it: an owner may stop a run, not resume it.
        expect(await refusal(call(owner(), 'resume_goal', { goalRunId }))).toMatchObject({
          status: 403,
          code: 'forbidden',
        });
        expect(await refusal(call(otherMember(), 'pause_goal', { goalRunId }))).toMatchObject({
          status: 404,
          code: 'not_found',
        });
        expect((await goalRow(goalRunId)).status).toBe('paused');
      });
    });

    describe('cancel_goal', () => {
      it('the requester cancels: its steps cancelled; a replay changes nothing; a proposed run is rejected, not cancelled', async () => {
        const goalRunId = await startGoal(requesterId);
        const before = await stepRows(goalRunId);
        const cancelled = CancelGoalResultWireSchema.parse(
          await call(requester(), 'cancel_goal', { goalRunId }),
        );
        expect(cancelled).toEqual({
          goalRunId,
          status: 'cancelling',
          changed: true,
          cancelledStepRunIds: expect.arrayContaining(before.map((step) => step.id)),
          withdrawnActionRequestIds: [],
        });
        expect(cancelled.cancelledStepRunIds).toHaveLength(before.length);
        expect((await stepRows(goalRunId)).map((step) => step.status)).toEqual([
          'cancelled',
          'cancelled',
        ]);
        expect(
          CancelGoalResultWireSchema.parse(await call(requester(), 'cancel_goal', { goalRunId })),
        ).toEqual({
          goalRunId,
          status: 'cancelling',
          changed: false,
          cancelledStepRunIds: [],
          withdrawnActionRequestIds: [],
        });

        const proposed = await proposeGoal(requesterId);
        expect(
          await refusal(call(requester(), 'cancel_goal', { goalRunId: proposed })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
      });

      it("an owner cancels a member's run; another member gets not found", async () => {
        const goalRunId = await startGoal(requesterId);
        expect(await refusal(call(otherMember(), 'cancel_goal', { goalRunId }))).toMatchObject({
          status: 404,
          code: 'not_found',
        });
        expect(
          CancelGoalResultWireSchema.parse(await call(owner(), 'cancel_goal', { goalRunId })),
        ).toMatchObject({ status: 'cancelling', changed: true });
      });
    });

    describe('revise_goal', () => {
      it('a reason carrying a credential is refused (400 credentials_in_text) and nothing is written', async () => {
        const goalRunId = await pausedGoal(requesterId);
        const mapped = await refusal(
          call(requester(), 'revise_goal', {
            goalRunId,
            basedOnRevision: 1,
            plan: planOf(['a', 'c']),
            reason: `step b failed: PGPASSWORD=${FAKE} psql was refused`,
          }),
        );
        expect(mapped).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: { field: 'reason', suspectedSecretValues: 1 },
        });
        expect(mapped.message).not.toContain(FAKE);
        expect(await revisionRows(goalRunId)).toHaveLength(1);
        expect((await goalRow(goalRunId)).current_revision).toBe(1);
      });

      it('the requester revises a paused run: a new revision, the dropped step superseded, the new one created', async () => {
        const goalRunId = await pausedGoal(requesterId);
        const before = await stepRows(goalRunId);
        const revised = ReviseGoalResultWireSchema.parse(
          await call(requester(), 'revise_goal', {
            goalRunId,
            basedOnRevision: 1,
            plan: planOf(['a', 'c']),
            reason: 'step b is not needed; step c does the report instead',
          }),
        );
        const after = await stepRows(goalRunId);
        const stepC = after.find((step) => step.step_key === 'c');
        expect(revised).toMatchObject({
          goalRunId,
          status: 'paused',
          changed: true,
          revision: 2,
          supersededStepRunIds: [before.find((step) => step.step_key === 'b')?.id],
          createdStepRunIds: [stepC?.id],
          withdrawnActionRequestIds: [],
          releasedActionRequestIds: [],
          hints: [{ code: 'requester_confirm_only' }],
        });
        expect(await goalRow(goalRunId)).toMatchObject({ status: 'paused', current_revision: 2 });
        expect(await revisionRows(goalRunId)).toEqual([
          { revision: 1, status: 'accepted', decided_by: requesterId },
          { revision: 2, status: 'accepted', decided_by: requesterId },
        ]);
        // A second revision based on the one it replaced is stale.
        expect(
          await refusal(
            call(requester(), 'revise_goal', {
              goalRunId,
              basedOnRevision: 1,
              plan: planOf(['a']),
            }),
          ),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
      });

      it('an owner may not revise (403); a plan that does not pass is 400 with its problems; an over-long reason is 400', async () => {
        const goalRunId = await pausedGoal(requesterId);
        expect(
          await refusal(
            call(owner(), 'revise_goal', { goalRunId, basedOnRevision: 1, plan: planOf(['a']) }),
          ),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        const unknownWorker = {
          steps: [{ key: 'a', worker: { definitionId: randomUUID(), version: 1 }, input: {} }],
        };
        const mapped = await refusal(
          call(requester(), 'revise_goal', { goalRunId, basedOnRevision: 1, plan: unknownWorker }),
        );
        expect(mapped).toMatchObject({ status: 400, code: 'invalid_params' });
        expect(mapped.details?.problems).toEqual([expect.stringContaining('a')]);
        expect(
          await refusal(
            call(requester(), 'revise_goal', {
              goalRunId,
              basedOnRevision: 1,
              plan: planOf(['a']),
              reason: 'x'.repeat(2001),
            }),
          ),
        ).toMatchObject({ status: 400, code: 'invalid_params' });
        // A running run is revised once it is paused.
        const running = await startGoal(requesterId);
        expect(
          await refusal(
            call(requester(), 'revise_goal', {
              goalRunId: running,
              basedOnRevision: 1,
              plan: planOf(['a']),
            }),
          ),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        expect(await revisionRows(goalRunId)).toHaveLength(1);
      });
    });

    describe('end_goal', () => {
      it('the requester ends a paused run not achieved: its steps skipped; a replay changes nothing', async () => {
        const goalRunId = await pausedGoal(requesterId);
        const before = await stepRows(goalRunId);
        const ended = EndGoalResultWireSchema.parse(
          await call(requester(), 'end_goal', {
            goalRunId,
            outcome: 'not_achieved',
            note: 'the report is no longer needed',
          }),
        );
        expect(ended).toMatchObject({
          goalRunId,
          status: 'completed',
          changed: true,
          decisionId: expect.any(String),
          overriddenChecks: [],
          skippedStepRunIds: expect.arrayContaining(before.map((step) => step.id)),
        });
        expect(ended.skippedStepRunIds).toHaveLength(before.length);
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'completed',
          outcome: 'not_achieved',
        });
        expect(
          EndGoalResultWireSchema.parse(
            await call(requester(), 'end_goal', { goalRunId, outcome: 'not_achieved' }),
          ),
        ).toEqual({
          goalRunId,
          status: 'completed',
          changed: false,
          decisionId: ended.decisionId,
          overriddenChecks: [],
          skippedStepRunIds: [],
        });
      });

      it('a note carrying a credential is refused and nothing is written; an owner may not end it (403); a running run is paused first (409)', async () => {
        const goalRunId = await pausedGoal(requesterId);
        const mapped = await refusal(
          call(requester(), 'end_goal', {
            goalRunId,
            outcome: 'not_achieved',
            note: `gave up: the call sent Bearer ${FAKE} and was refused`,
          }),
        );
        expect(mapped).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: { field: 'note', suspectedSecretValues: 1 },
        });
        expect(await goalRow(goalRunId)).toMatchObject({ status: 'paused', outcome: null });
        expect(
          await refusal(call(owner(), 'end_goal', { goalRunId, outcome: 'not_achieved' })),
        ).toMatchObject({ status: 403, code: 'forbidden' });

        const running = await startGoal(requesterId);
        expect(
          await refusal(
            call(requester(), 'end_goal', { goalRunId: running, outcome: 'not_achieved' }),
          ),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
      });
    });

    describe('confirm_goal_acceptance', () => {
      it("the requester confirms the round's check once the run is verifying; a replay changes nothing", async () => {
        const goalRunId = await startGoal(requesterId, ['a']);
        // Not verifying yet.
        expect(
          await refusal(call(requester(), 'confirm_goal_acceptance', { goalRunId })),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });

        await advanceOnce(goalRunId, requesterId);
        const [stepA] = await stepRows(goalRunId);
        const [task] = await raw<{ id: string }>(
          `select id from tasks where workspace_id = $1 and step_run_id = $2
            order by step_attempt desc limit 1`,
          [workspaceId, stepA?.id],
        );
        const [run] = await raw<{ id: string }>(
          'select id from worker_runs where workspace_id = $1 and task_id = $2',
          [workspaceId, task?.id],
        );
        if (!task || !run) throw new Error('step a started no attempt');
        await as(requesterId, (client) =>
          completeTaskWithResult(client, workspaceId, requesterId, task.id, run.id, {
            summary: 'done',
          }),
        );
        await advanceOnce(goalRunId, requesterId);
        expect((await goalRow(goalRunId)).status).toBe('verifying');

        expect(
          await refusal(call(owner(), 'confirm_goal_acceptance', { goalRunId })),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        expect(
          await refusal(
            call(requester(), 'confirm_goal_acceptance', {
              goalRunId,
              note: `checked with PGPASSWORD=${FAKE}`,
            }),
          ),
        ).toMatchObject({ status: 400, code: 'credentials_in_text' });
        expect(
          await refusal(
            call(requester(), 'confirm_goal_acceptance', { goalRunId, checkKey: 'missing' }),
          ),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });

        const confirmed = ConfirmGoalAcceptanceResultWireSchema.parse(
          await call(requester(), 'confirm_goal_acceptance', {
            goalRunId,
            note: 'the report is in the shared folder',
          }),
        );
        expect(confirmed).toEqual({
          goalRunId,
          status: 'verifying',
          changed: true,
          decisionId: expect.any(String),
        });
        expect(
          ConfirmGoalAcceptanceResultWireSchema.parse(
            await call(requester(), 'confirm_goal_acceptance', { goalRunId }),
          ),
        ).toEqual({
          goalRunId,
          status: 'verifying',
          changed: false,
          decisionId: confirmed.decisionId,
        });
      });
    });

    describe('reconcile_goal_action', () => {
      async function outcomeUnknownAction(goalRunId: string): Promise<string> {
        const [stepA] = await stepRows(goalRunId);
        const [action] = await raw<{ id: string }>(
          `insert into action_requests (workspace_id, status, failure_kind, gatekeeper_id,
             action_kind, blast_radius, policy_decision, await_decision, on_behalf_of,
             actor_runtime, requested_at, step_run_id)
           values ($1, 'failed', 'outcome_unknown', $2, 'fixture.act', 'low', 'allow', false, $3,
                   'pi', now(), $4)
           returning id`,
          [workspaceId, randomUUID(), requesterId, stepA?.id],
        );
        if (!action) throw new Error('no fixture action');
        return action.id;
      }

      it('the requester records a finding on an action of the run whose outcome is unknown; a replay changes nothing', async () => {
        const goalRunId = await startGoal(requesterId, ['a']);
        const actionRequestId = await outcomeUnknownAction(goalRunId);
        const reconciled = ReconcileGoalActionResultWireSchema.parse(
          await call(requester(), 'reconcile_goal_action', {
            goalRunId,
            actionRequestId,
            verdict: 'effect_seen',
            note: 'the service answers on its port',
          }),
        );
        expect(reconciled).toMatchObject({
          goalRunId,
          status: 'running',
          changed: true,
          action: {
            actionRequestId,
            status: 'failed',
            failureKind: 'outcome_unknown',
            reconciliation: 'effect_seen',
            reconciliationDecisionId: expect.any(String),
            reexecuteDecisionId: null,
          },
        });
        expect(
          ReconcileGoalActionResultWireSchema.parse(
            await call(requester(), 'reconcile_goal_action', {
              goalRunId,
              actionRequestId,
              verdict: 'effect_seen',
            }),
          ),
        ).toMatchObject({ changed: false, action: { reconciliation: 'effect_seen' } });
      });

      it('a call naming no finding is 400; a credential note is 400; another run’s action is not found; another member’s call is not found', async () => {
        const goalRunId = await startGoal(requesterId, ['a']);
        const actionRequestId = await outcomeUnknownAction(goalRunId);
        expect(
          await refusal(call(requester(), 'reconcile_goal_action', { goalRunId, actionRequestId })),
        ).toMatchObject({ status: 400, code: 'invalid_params' });
        expect(
          await refusal(
            call(requester(), 'reconcile_goal_action', {
              goalRunId,
              actionRequestId,
              verdict: 'effect_absent',
              note: `nothing changed; ran it as sk-ant-${FAKE}`,
            }),
          ),
        ).toMatchObject({ status: 400, code: 'credentials_in_text' });
        const otherRun = await startGoal(requesterId, ['a']);
        expect(
          await refusal(
            call(requester(), 'reconcile_goal_action', {
              goalRunId: otherRun,
              actionRequestId,
              verdict: 'effect_seen',
            }),
          ),
        ).toMatchObject({ status: 404 });
        expect(
          await refusal(
            call(otherMember(), 'reconcile_goal_action', {
              goalRunId,
              actionRequestId,
              verdict: 'effect_seen',
            }),
          ),
        ).toMatchObject({ status: 404, code: 'not_found' });
        const [stored] = await raw<{ reconciliation: string | null }>(
          'select reconciliation from action_requests where workspace_id = $1 and id = $2',
          [workspaceId, actionRequestId],
        );
        expect(stored?.reconciliation).toBeNull();
      });
    });
  },
);
