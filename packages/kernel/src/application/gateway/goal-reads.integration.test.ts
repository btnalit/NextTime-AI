import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  GOAL_LIST_MAX_LIMIT,
  GoalDetailWireSchema,
  GoalRunWireSchema,
  PlanRevisionWireSchema,
  type Role,
  UnresolvedGoalActionWireSchema,
  listEnvelope,
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
import { advanceGoalRun } from '../goal/advance.js';
import { cancelGoalRun } from '../goal/control.js';
import {
  GoalRevisionNotFoundError,
  GoalRunNotFoundError,
  confirmGoalRun,
  createGoalRun,
} from '../goal/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO5a: the `goal` reads
 * — `get_goal`, `list_goals`, `get_goal_revision`, `list_goal_unresolved_actions` — dispatched
 * through the capability gateway on both channels: who may read a run (the owner and the
 * requester; anyone else gets "not found", like an unknown id), what each result holds (parsed
 * against its wire schema here too, not only under KERNEL_VALIDATE_RESULTS), a step input's
 * suspected credentials redacted for every reader while the stored plan keeps them, and the list's
 * filters and keyset pages.
 *
 * Every run this file confirms is left with no `next_tick_at`, so no advancer of another file
 * claims it; the one advance a test needs is driven by hand, with an in-memory supervisor.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 };

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

/** Every spawn starts `running`; nothing here ends one. */
class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.21',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.21' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    return this.statuses.delete(workerRunId);
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'goal reads — S11 GO5a (integration, real Postgres)',
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
          // A synthetic value under a field the credential review counts — never a real one.
          input: { step: key, password: `synthetic-${key}` },
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

    /** Confirmed, then left with no tick: only this file moves it. */
    async function startGoal(by: string, keys?: readonly string[]) {
      const goalRunId = await proposeGoal(by, keys);
      await as(by, (client) => confirmGoalRun(client, workspaceId, { goalRunId, confirmedBy: by }));
      await parkGoal(goalRunId);
      return goalRunId;
    }

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

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

    const human = (principalId: string, role: Role) => humanCaller(workspaceId, principalId, role);
    const call = (caller: ResolvedCaller, name: string, params: Record<string, unknown>) =>
      dispatchCapability({ pool }, caller, name, params);

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
            'go5a-goal-reads',
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

    describe('get_goal', () => {
      it('a proposed run: revision 1 with its plan typed, its step inputs redacted, its hint', async () => {
        const goalRunId = await proposeGoal(requesterId);
        const result = GoalDetailWireSchema.parse(
          await call(human(requesterId, 'member'), 'get_goal', { goalRunId }),
        );
        expect(result).toMatchObject({
          id: goalRunId,
          status: 'proposed',
          onBehalfOf: requesterId,
          currentRevision: null,
          confirmedAt: null,
          budget: BUDGET,
          usage: { tokens: 0, steps: 0, revisions: 0 },
          steps: [],
          acceptance: { rounds: [], steps: [], overriddenChecks: [] },
          leftovers: null,
        });
        expect(Object.values(result.stepCounts).every((count) => count === 0)).toBe(true);
        expect(result.planRevision).toMatchObject({
          revision: 1,
          status: 'proposed',
          proposedBy: requesterId,
          basedOnRevision: null,
          removals: {},
          hints: [{ code: 'requester_confirm_only' }],
        });
        expect(result.planRevision.plan.steps.map((step) => step.input)).toEqual([
          { step: 'a', password: '[redacted]' },
          { step: 'b', password: '[redacted]' },
        ]);
        expect(result.revisions).toHaveLength(1);
        expect(result.revisions[0]).not.toHaveProperty('plan');

        // The Worker still runs on what was written: only readers get the redacted copy.
        const [stored] = await raw<{ plan: { steps: { input: unknown }[] } }>(
          'select plan from plan_revisions where workspace_id = $1 and goal_run_id = $2',
          [workspaceId, goalRunId],
        );
        expect(stored?.plan.steps[0]?.input).toEqual({ step: 'a', password: 'synthetic-a' });
      });

      it('a running run: StepRuns with their attempts and actions, counts and usage', async () => {
        const goalRunId = await startGoal(requesterId);
        await advanceOnce(goalRunId, requesterId);
        const [first] = await raw<{ id: string }>(
          `select id from step_runs where workspace_id = $1 and goal_run_id = $2 and step_key = 'a'`,
          [workspaceId, goalRunId],
        );
        const stepRunId = first?.id;
        if (!stepRunId) throw new Error('step a has no StepRun');
        // A request the step raised — inserted as a fixture (the gate side is not this test's).
        const [action] = await raw<{ id: string }>(
          `insert into action_requests (workspace_id, gatekeeper_id, action_kind, blast_radius,
                                        on_behalf_of, actor_runtime, step_run_id)
           values ($1, $2, 'fixture.act', 'low', $3, 'worker', $4)
           returning id`,
          [workspaceId, randomUUID(), requesterId, stepRunId],
        );

        const result = GoalDetailWireSchema.parse(
          await call(human(ownerId, 'owner'), 'get_goal', { goalRunId }),
        );
        expect(result).toMatchObject({ status: 'running', currentRevision: 1 });
        expect(result.confirmedAt).not.toBeNull();
        expect(result.usage).toMatchObject({ steps: 1, revisions: 0 });
        expect(result.stepCounts).toMatchObject({ running: 1, pending: 1 });
        expect(result.planRevision).toMatchObject({ revision: 1, status: 'accepted' });
        // Plan order: both steps were created by the confirmation, `a` comes first in the plan.
        expect(result.steps.map((step) => step.stepKey)).toEqual(['a', 'b']);
        const [stepA, stepB] = result.steps;
        expect(stepA).toMatchObject({
          id: stepRunId,
          stepKey: 'a',
          status: 'running',
          attemptCount: 1,
          introducedInRevision: 1,
          supersededInRevision: null,
          actions: [
            {
              actionRequestId: action?.id,
              status: 'proposed',
              failureKind: null,
              reconciliation: null,
            },
          ],
        });
        expect(stepA?.attempts).toHaveLength(1);
        expect(stepA?.attempts[0]).toMatchObject({ attempt: 1 });
        expect(stepB).toMatchObject({ stepKey: 'b', status: 'pending', attempts: [], actions: [] });

        // What a cancel waits for: the attempt's Task is still live.
        await as(requesterId, (client) =>
          cancelGoalRun(client, workspaceId, {
            goalRunId,
            actor: { principalId: requesterId, role: 'member' },
          }),
        );
        await parkGoal(goalRunId);
        const cancelling = GoalDetailWireSchema.parse(
          await call(human(requesterId, 'member'), 'get_goal', { goalRunId }),
        );
        expect(cancelling.status).toBe('cancelling');
        expect(cancelling.leftovers?.liveTaskIds).toEqual([stepA?.attempts[0]?.taskId]);
      });

      it('anyone but the owner and the requester gets not found, as for an unknown id — on both channels', async () => {
        const goalRunId = await proposeGoal(requesterId);
        for (const caller of [human(otherMemberId, 'member'), human(auditorId, 'auditor')]) {
          await expect(call(caller, 'get_goal', { goalRunId })).rejects.toBeInstanceOf(
            GoalRunNotFoundError,
          );
        }
        await expect(
          call(human(requesterId, 'member'), 'get_goal', { goalRunId: randomUUID() }),
        ).rejects.toBeInstanceOf(GoalRunNotFoundError);

        const scope: CapabilityScope = { capabilities: ['get_goal'], resources: {} };
        // A Handle reads as its `obo`: the requester's entry agent sees the run, another's does not.
        const viaHandle = GoalDetailWireSchema.parse(
          await call(handleCaller(workspaceId, requesterId, scope), 'get_goal', { goalRunId }),
        );
        expect(viaHandle.id).toBe(goalRunId);
        await expect(
          call(handleCaller(workspaceId, otherMemberId, scope), 'get_goal', { goalRunId }),
        ).rejects.toBeInstanceOf(GoalRunNotFoundError);
        // …and only with the capability in its scope.
        await expect(
          call(
            handleCaller(workspaceId, requesterId, { capabilities: ['get_task'], resources: {} }),
            'get_goal',
            { goalRunId },
          ),
        ).rejects.toBeInstanceOf(ForbiddenError);
      });
    });

    describe('list_goals', () => {
      let mine: string[];
      let theirs: string;

      beforeAll(async () => {
        // Oldest first; the list is newest first.
        mine = [await proposeGoal(requesterId, ['x']), await startGoal(requesterId, ['y'])];
        theirs = await proposeGoal(otherMemberId, ['z']);
      });

      const ids = (result: unknown) =>
        listEnvelope(GoalRunWireSchema)
          .parse(result)
          .items.map((item) => item.id);

      it('a member lists only the runs they requested, newest first; another requester lists nothing', async () => {
        const listed = ids(await call(human(requesterId, 'member'), 'list_goals', {}));
        expect(listed).toEqual(expect.arrayContaining(mine));
        expect(listed).not.toContain(theirs);
        expect(listed.indexOf(mine[1] as string)).toBeLessThan(listed.indexOf(mine[0] as string));
        expect(
          ids(
            await call(human(requesterId, 'member'), 'list_goals', { onBehalfOf: otherMemberId }),
          ),
        ).toEqual([]);
        expect(ids(await call(human(auditorId, 'auditor'), 'list_goals', {}))).toEqual([]);
      });

      it('the owner lists every run, by requester and by status', async () => {
        const all = ids(await call(human(ownerId, 'owner'), 'list_goals', {}));
        expect(all).toEqual(expect.arrayContaining([...mine, theirs]));
        const byRequester = ids(
          await call(human(ownerId, 'owner'), 'list_goals', { onBehalfOf: otherMemberId }),
        );
        expect(byRequester).toEqual([theirs]);
        const running = ids(
          await call(human(ownerId, 'owner'), 'list_goals', {
            onBehalfOf: requesterId,
            status: ['running'],
          }),
        );
        expect(running).toContain(mine[1]);
        expect(running).not.toContain(mine[0]);
      });

      it('an item carries its usage and its StepRuns counted by status', async () => {
        const page = listEnvelope(GoalRunWireSchema).parse(
          await call(human(requesterId, 'member'), 'list_goals', { status: ['running'] }),
        );
        const started = page.items.find((item) => item.id === mine[1]);
        expect(started).toMatchObject({ status: 'running', usage: { steps: 0, revisions: 0 } });
        expect(started?.stepCounts).toMatchObject({ pending: 1, running: 0 });
      });

      it('pages by keyset: limit → nextCursor → the next page; a limit over the ceiling is truncated', async () => {
        const first = listEnvelope(GoalRunWireSchema).parse(
          await call(human(ownerId, 'owner'), 'list_goals', { onBehalfOf: requesterId, limit: 1 }),
        );
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeDefined();
        const second = listEnvelope(GoalRunWireSchema).parse(
          await call(human(ownerId, 'owner'), 'list_goals', {
            onBehalfOf: requesterId,
            limit: 1,
            cursor: first.nextCursor,
          }),
        );
        expect(second.items).toHaveLength(1);
        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
        const over = listEnvelope(GoalRunWireSchema).parse(
          await call(human(ownerId, 'owner'), 'list_goals', { limit: GOAL_LIST_MAX_LIMIT + 1 }),
        );
        expect(over.truncated).toBe(true);
      });
    });

    describe('get_goal_revision and list_goal_unresolved_actions', () => {
      it('reads a revision of a visible run; an unknown revision and an invisible run are not found', async () => {
        const goalRunId = await proposeGoal(requesterId);
        const revision = PlanRevisionWireSchema.parse(
          await call(human(requesterId, 'member'), 'get_goal_revision', { goalRunId, revision: 1 }),
        );
        expect(revision).toMatchObject({ goalRunId, revision: 1, status: 'proposed' });
        expect(revision.plan.steps[1]?.input).toEqual({ step: 'b', password: '[redacted]' });
        await expect(
          call(human(requesterId, 'member'), 'get_goal_revision', { goalRunId, revision: 2 }),
        ).rejects.toBeInstanceOf(GoalRevisionNotFoundError);
        await expect(
          call(human(otherMemberId, 'member'), 'get_goal_revision', { goalRunId, revision: 1 }),
        ).rejects.toBeInstanceOf(GoalRunNotFoundError);
      });

      it('lists what still needs a person for the owner and the requester only', async () => {
        const goalRunId = await startGoal(requesterId);
        const listed = listEnvelope(UnresolvedGoalActionWireSchema).parse(
          await call(human(requesterId, 'member'), 'list_goal_unresolved_actions', { goalRunId }),
        );
        expect(listed).toEqual({ items: [] });
        await expect(
          call(human(otherMemberId, 'member'), 'list_goal_unresolved_actions', { goalRunId }),
        ).rejects.toBeInstanceOf(GoalRunNotFoundError);
      });
    });
  },
);
