import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DecidePlanRevisionResultWireSchema,
  type GoalDetailWire,
  GoalDetailWireSchema,
  type HandleClaims,
  PLANNER_OUTPUT_SCHEMA,
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
import { PLANNER_HANDLE_CAPABILITIES } from '../task/index.js';
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO9a: the goal planner
 * proposing a revision of a paused run for its requester (`application/goal/planner.ts`, phase P of
 * `advance.ts`), and the requester deciding about it (`decide_plan_revision`, `decide.ts`) — through
 * the capability gateway as the console and the planner's Worker call it, with an in-memory
 * supervisor and the planner's report written by the test (no model runs).
 *
 * What the plan asked tests for (go9-default-plan.md §5): a failed step opens a round whose
 * proposal, accepted with a resume, takes the goal another way to done; a proposal on an older
 * revision is refused; the requester revising first drops the planner's work; a cancel stops the
 * planner's Task; a report the platform refuses keeps the run at `needs_decision` and says why;
 * only the requester decides, and not resume while an owner holds the run; the planner's Handle
 * reaches nothing but its own Task.
 *
 * Every run this file moves is left with no `next_tick_at`, so no advancer of another file claims
 * it; the advances a test needs are driven by hand.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 400_000, maxSteps: 10, maxRevisions: 3, maxWallClockSeconds: 3600 };

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

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly spawnCalls: TaskSpawnInput[] = [];
  readonly terminated: string[] = [];
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    this.spawnCalls.push(input);
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.29',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.29' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    this.terminated.push(workerRunId);
    const existing = this.statuses.get(workerRunId);
    if (!existing) return false;
    this.statuses.set(workerRunId, { ...existing, status: 'terminated', reason: 'requested' });
    return true;
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }
}

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

async function dbRefusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the database to refuse the write');
}

describe.runIf(DATABASE_URL !== undefined)(
  'goal planner — S11 GO9a (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let worker: { definitionId: string; version: number };
    let otherWorker: { definitionId: string; version: number };
    const supervisor = new FakeTaskSupervisorClient();
    const roles = new Map<string, Role>();

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });
    const asApp = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
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
      roles.set(id, role);
      return id;
    }

    const human = (principalId: string) =>
      humanCaller(workspaceId, principalId, roles.get(principalId) ?? 'member');

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

    async function call(caller: ResolvedCaller, name: string, params: Record<string, unknown>) {
      try {
        return await dispatchCapability({ pool }, caller, name, params);
      } finally {
        if (typeof params.goalRunId === 'string') await parkGoal(params.goalRunId);
      }
    }

    async function advanceOnce(goalRunId: string, requesterId: string) {
      const outcome = await advanceGoalRun(
        {
          pool,
          taskRuntime: { pool, privateKey, supervisorClient: supervisor },
          options: { retryBackoffMs: () => 0 },
        },
        { workspaceId, goalRunId, requesterId },
      );
      await parkGoal(goalRunId);
      return outcome;
    }

    const planOf = (steps: readonly { key: string; worker?: typeof worker }[]) => ({
      steps: steps.map((step) => ({
        key: step.key,
        worker: step.worker ?? worker,
        input: { step: step.key },
        maxAttempts: 1,
      })),
    });

    /** Proposed, confirmed (with the planner's leave unless `planner` is false) and started. */
    async function startGoal(requesterId: string, planner = true) {
      const created = await asApp(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'renew the certificate of the site',
          plan: planOf([{ key: 'renew' }]),
          budget: BUDGET,
        }),
      );
      const goalRunId = created.goalRunId;
      await call(human(requesterId), 'confirm_goal', {
        goalRunId,
        revision: 1,
        ...(planner ? { planner: 'propose' } : {}),
      });
      await advanceOnce(goalRunId, requesterId);
      return goalRunId;
    }

    async function liveStep(goalRunId: string, key: string) {
      const [row] = await raw<{ id: string; status: string; attempt_count: number }>(
        `select id, status, attempt_count from step_runs
          where workspace_id = $1 and goal_run_id = $2 and step_key = $3
            and status <> 'superseded'`,
        [workspaceId, goalRunId, key],
      );
      if (!row) throw new Error(`no live step ${key}`);
      return row;
    }

    async function lastAttempt(stepRunId: string) {
      const [row] = await raw<{ id: string; status: string }>(
        `select id, status from tasks where workspace_id = $1 and step_run_id = $2
          order by step_attempt desc limit 1`,
        [workspaceId, stepRunId],
      );
      if (!row) throw new Error(`step ${stepRunId} has no attempt`);
      return row;
    }

    const loseTask = (taskId: string, requesterId: string) =>
      failTaskAndReapWorkerRuns(
        { pool, privateKey, supervisorClient: supervisor },
        workspaceId,
        requesterId,
        taskId,
        'spawn_lost',
      );

    /** Started, its one step's only attempt lost: paused `needs_decision`, a round opened. */
    async function failedForPerson(requesterId: string, planner = true) {
      const goalRunId = await startGoal(requesterId, planner);
      const step = await liveStep(goalRunId, 'renew');
      await loseTask((await lastAttempt(step.id)).id, requesterId);
      await advanceOnce(goalRunId, requesterId);
      return { goalRunId, step };
    }

    const goalRow = async (goalRunId: string) => {
      const [row] = await raw<{
        status: string;
        pause_reason: string | null;
        current_revision: number | null;
      }>(
        `select status, pause_reason, current_revision from goal_runs
          where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId],
      );
      if (!row) throw new Error(`goal run ${goalRunId} is gone`);
      return row;
    };

    const rounds = (goalRunId: string) =>
      raw<{
        id: string;
        status: string;
        revision: number | null;
        outcome_reason: string | null;
        detail: string | null;
        step_attempt: number;
      }>(
        `select id, status, revision, outcome_reason, detail, step_attempt
           from goal_planning_rounds where workspace_id = $1 and goal_run_id = $2
          order by created_at`,
        [workspaceId, goalRunId],
      );

    async function plannerTask(roundId: string) {
      const [row] = await raw<{
        id: string;
        status: string;
        purpose: string;
        observe_scope: string[] | null;
        on_behalf_of: string;
        output_schema: unknown;
        input: Record<string, unknown>;
        step_run_id: string | null;
      }>(
        `select id, status, purpose, observe_scope, on_behalf_of, output_schema, input,
                step_run_id
           from tasks where workspace_id = $1 and planning_round_id = $2`,
        [workspaceId, roundId],
      );
      if (!row) throw new Error(`round ${roundId} has no Task`);
      return row;
    }

    /** The planner's Worker, as its Handle calls the gateway. */
    async function workerOf(taskId: string): Promise<ResolvedCaller> {
      const [row] = await raw<{
        session_id: string;
        jti: string;
        on_behalf_of: string;
        scope: HandleClaims['scope'];
        expires_at: Date;
      }>(
        `select wr.session_id, h.jti, h.on_behalf_of, h.scope, h.expires_at
           from worker_runs wr
           join capability_handles h
             on h.workspace_id = wr.workspace_id and h.session_id = wr.session_id
          where wr.workspace_id = $1 and wr.task_id = $2
          order by wr.started_at desc limit 1`,
        [workspaceId, taskId],
      );
      if (!row) throw new Error(`no WorkerRun Handle for Task ${taskId}`);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: row.session_id,
          obo: row.on_behalf_of,
          scope: row.scope,
          jti: row.jti,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
        },
      };
    }

    const report = async (taskId: string, output: Record<string, unknown>) =>
      dispatchCapability({ pool }, await workerOf(taskId), 'report_task_result', {
        summary: 'planned',
        output,
      });

    const getGoal = async (goalRunId: string, by: string): Promise<GoalDetailWire> =>
      GoalDetailWireSchema.parse(await call(human(by), 'get_goal', { goalRunId }));

    /** The plan the requester reads, its one step given another Worker under a new key. */
    const reroute = (goal: GoalDetailWire) => ({
      ...goal.planRevision.plan,
      steps: [
        { key: 'renew-other', worker: otherWorker, input: { step: 'renew' }, maxAttempts: 1 },
      ],
    });

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
            'go9a-goal-planner',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      roles.set(ownerId, 'owner');
      const publish = async (prompt: string) => {
        const proposed = await asApp(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: { systemPrompt: prompt },
          }),
        );
        await asApp(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: proposed.id,
            version: proposed.version,
          }),
        );
        return { definitionId: proposed.id, version: proposed.version };
      };
      worker = await publish('You renew a certificate one way.');
      otherWorker = await publish('You renew a certificate another way.');
    });

    afterAll(async () => {
      await raw(
        `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                paused_by_authority = null, ended_at = now(), next_tick_at = null
          where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
        [workspaceId],
      );
      await pool.end();
    });

    // -------------------------------------------------------------------------------------------

    it('a step failing for a person opens a round; the planner Task reads only its own Task, has no egress, observes nothing', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId, step } = await failedForPerson(requester);
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      const [round, ...more] = await rounds(goalRunId);
      expect(more).toEqual([]);
      expect(round).toMatchObject({ status: 'running', step_attempt: 1, revision: null });
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      expect(task).toMatchObject({
        status: 'running',
        purpose: 'planning',
        observe_scope: [],
        on_behalf_of: requester,
        output_schema: PLANNER_OUTPUT_SCHEMA,
        step_run_id: null,
      });
      expect(task.input).toMatchObject({
        kind: 'goal_planning',
        basedOnRevision: 1,
        failedStep: { key: 'renew', attempt: 1, failureCategory: 'transient' },
      });
      expect((task.input.workers as { definitionId: string }[]).map((w) => w.definitionId)).toEqual(
        expect.arrayContaining([worker.definitionId, otherWorker.definitionId]),
      );
      const spawned = supervisor.spawnCalls.find((input) => input.taskId === task.id);
      expect(spawned?.egressDenyAll).toBe(true);

      const planner = await workerOf(task.id);
      if (planner.channel !== 'handle') throw new Error('not a Handle');
      expect(new Set(planner.claims.scope.capabilities)).toEqual(
        new Set(PLANNER_HANDLE_CAPABILITIES),
      );
      // Nothing beyond its own Task: no Worker, no action, no read of the graph or of the goal.
      for (const [name, params] of [
        ['invoke_worker', { definitionId: worker.definitionId, input: {} }],
        ['get_goal', { goalRunId }],
        ['list_tasks', {}],
      ] as const) {
        expect((await refusal(dispatchCapability({ pool }, planner, name, params))).status).toBe(
          403,
        );
      }
      // A second advance opens nothing more for the same failed attempt.
      await advanceOnce(goalRunId, requester);
      expect(await rounds(goalRunId)).toHaveLength(1);
      expect((await liveStep(goalRunId, 'renew')).id).toBe(step.id);
    });

    it('the planner proposes another Worker; the requester accepts and resumes; the goal reaches done the other way', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      const before = await getGoal(goalRunId, requester);
      expect(before.planner).toBe('propose');
      expect(before.planningRounds).toMatchObject([
        { id: round.id, status: 'running', stepKey: 'renew', taskId: task.id },
      ]);

      await report(task.id, {
        decision: 'revise',
        plan: reroute(before),
        reason: 'The first Worker lost its run twice; the other Worker renews the same way.',
      });
      await advanceOnce(goalRunId, requester);
      expect(await rounds(goalRunId)).toMatchObject([{ status: 'proposed', revision: 2 }]);
      const proposed = await getGoal(goalRunId, requester);
      expect(proposed.status).toBe('paused');
      expect(proposed.currentRevision).toBe(1);
      expect(proposed.revisions.at(-1)).toMatchObject({
        revision: 2,
        status: 'proposed',
        proposer: 'planner',
        basedOnRevision: 1,
      });
      // The owner reads it, but does not decide it — the planner acts for the requester.
      expect(
        await refusal(
          call(human(ownerId), 'decide_plan_revision', {
            goalRunId,
            revision: 2,
            decision: 'accept',
          }),
        ),
      ).toMatchObject({ status: 403 });

      const decided = DecidePlanRevisionResultWireSchema.parse(
        await call(human(requester), 'decide_plan_revision', {
          goalRunId,
          revision: 2,
          decision: 'accept',
          resume: true,
        }),
      );
      expect(decided).toMatchObject({
        goalRunId,
        status: 'running',
        changed: true,
        revision: 2,
        decision: 'accept',
        resumed: true,
      });
      expect(decided.supersededStepRunIds).toHaveLength(1);
      expect(decided.createdStepRunIds).toHaveLength(1);
      // The same decision again changes nothing.
      expect(
        await call(human(requester), 'decide_plan_revision', {
          goalRunId,
          revision: 2,
          decision: 'accept',
        }),
      ).toMatchObject({ changed: false });

      await advanceOnce(goalRunId, requester);
      const step = await liveStep(goalRunId, 'renew-other');
      const attempt = await lastAttempt(step.id);
      await dispatchCapability({ pool }, await workerOf(attempt.id), 'report_task_result', {
        summary: 'renewed',
      });
      await advanceOnce(goalRunId, requester);
      // The plan has no check of its own: the requester confirms what they asked for.
      expect((await goalRow(goalRunId)).status).toBe('verifying');
      expect((await liveStep(goalRunId, 'renew-other')).status).toBe('succeeded');
      await call(human(requester), 'confirm_goal_acceptance', { goalRunId });
      await advanceOnce(goalRunId, requester);
      const done = await getGoal(goalRunId, requester);
      expect(done.status).toBe('completed');
      expect(done.revisions.at(-1)).toMatchObject({
        revision: 2,
        status: 'accepted',
        proposer: 'planner',
        decidedBy: requester,
      });
    });

    it('a report the platform refuses keeps the Task open with each place named; a no_revision report leaves the run waiting for the requester', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      const goal = await getGoal(goalRunId, requester);

      // A Worker that is not published: the plan check names the place.
      const unknown = await refusal(
        report(task.id, {
          decision: 'revise',
          plan: {
            ...goal.planRevision.plan,
            steps: [
              {
                key: 'renew-x',
                worker: { definitionId: randomUUID(), version: 1 },
                input: { step: 'renew' },
              },
            ],
          },
          reason: 'try a Worker nobody published',
        }),
      );
      expect(unknown).toMatchObject({ status: 400, code: 'invalid_params' });
      expect(JSON.stringify(unknown.details)).toContain('output.plan');
      // Facts are not the planner's to report.
      expect(
        await refusal(
          dispatchCapability({ pool }, await workerOf(task.id), 'report_task_result', {
            summary: 'planned',
            output: { decision: 'no_revision', reason: 'nothing helps' },
            facts: [{ subject: 'x', predicate: 'y', object: 'z' }],
          }),
        ),
      ).toMatchObject({ status: 400 });
      expect((await plannerTask(round.id)).status).toBe('running');

      await report(task.id, {
        decision: 'no_revision',
        reason: 'The certificate authority refuses the domain; a person has to fix the DNS record.',
      });
      await advanceOnce(goalRunId, requester);
      expect(await rounds(goalRunId)).toMatchObject([
        { status: 'no_revision', detail: expect.stringContaining('fix the DNS record') },
      ]);
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      await advanceOnce(goalRunId, requester);
      expect(await rounds(goalRunId)).toHaveLength(1);
    });

    it('the requester revising first drops the round; a proposal on an older revision is refused', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      const goal = await getGoal(goalRunId, requester);

      // The planner proposes; before the requester decides, they revise the plan themselves.
      await report(task.id, { decision: 'revise', plan: reroute(goal), reason: 'another Worker' });
      await advanceOnce(goalRunId, requester);
      expect(await rounds(goalRunId)).toMatchObject([{ status: 'proposed', revision: 2 }]);
      await call(human(requester), 'revise_goal', {
        goalRunId,
        basedOnRevision: 1,
        plan: {
          ...goal.planRevision.plan,
          steps: [{ key: 'renew-mine', worker, input: { step: 'mine' }, maxAttempts: 1 }],
        },
        reason: 'I will do it my way',
      });
      const after = await getGoal(goalRunId, requester);
      expect(after.currentRevision).toBe(3);
      expect(after.revisions.find((r) => r.revision === 2)).toMatchObject({
        status: 'rejected',
        proposer: 'planner',
        decidedBy: requester,
      });
      expect(
        await refusal(
          call(human(requester), 'decide_plan_revision', {
            goalRunId,
            revision: 2,
            decision: 'accept',
          }),
        ),
      ).toMatchObject({ status: 409, code: 'illegal_transition' });

      // A round still running when the requester revises is abandoned, its Task terminated.
      const second = await failedForPerson(requester);
      const [running] = await rounds(second.goalRunId);
      if (!running) throw new Error('no round');
      const runningTask = await plannerTask(running.id);
      const secondGoal = await getGoal(second.goalRunId, requester);
      await call(human(requester), 'revise_goal', {
        goalRunId: second.goalRunId,
        basedOnRevision: 1,
        plan: reroute(secondGoal),
        reason: 'mine',
      });
      expect(await rounds(second.goalRunId)).toMatchObject([
        { status: 'abandoned', outcome_reason: 'plan_revised' },
      ]);
      await advanceOnce(second.goalRunId, requester);
      expect((await plannerTask(running.id)).status).toBe('cancelled');
      expect(
        supervisor.terminated.some((runId) =>
          supervisor.spawnCalls.some(
            (input) => input.workerRunId === runId && input.taskId === runningTask.id,
          ),
        ),
      ).toBe(true);
    });

    it('cancelling the run abandons the round and stops the planner Task', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      await call(human(requester), 'cancel_goal', { goalRunId });
      expect(await rounds(goalRunId)).toMatchObject([
        { status: 'abandoned', outcome_reason: 'run_left_pause' },
      ]);
      await advanceOnce(goalRunId, requester);
      await advanceOnce(goalRunId, requester);
      expect((await plannerTask(round.id)).status).toBe('cancelled');
      expect((await goalRow(goalRunId)).status).toBe('cancelled');
    });

    it('while an owner holds the run, its requester may accept but not resume; the hold drops a running round', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const goal = await getGoal(goalRunId, requester);
      await report((await plannerTask(round.id)).id, {
        decision: 'revise',
        plan: reroute(goal),
        reason: 'another Worker',
      });
      await advanceOnce(goalRunId, requester);
      await call(human(ownerId), 'pause_goal', { goalRunId });
      // The proposal waits through the hold.
      expect(await rounds(goalRunId)).toMatchObject([{ status: 'proposed', revision: 2 }]);
      expect(
        await refusal(
          call(human(requester), 'decide_plan_revision', {
            goalRunId,
            revision: 2,
            decision: 'accept',
            resume: true,
          }),
        ),
      ).toMatchObject({ status: 409, code: 'illegal_transition' });
      expect(
        await call(human(requester), 'decide_plan_revision', {
          goalRunId,
          revision: 2,
          decision: 'accept',
        }),
      ).toMatchObject({ status: 'paused', changed: true, resumed: false });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'paused', current_revision: 2 });

      // A round running when the owner holds the run is dropped; none opens while held.
      const second = await failedForPerson(requester);
      await call(human(ownerId), 'pause_goal', { goalRunId: second.goalRunId });
      expect(await rounds(second.goalRunId)).toMatchObject([
        { status: 'abandoned', outcome_reason: 'run_left_pause' },
      ]);
      await advanceOnce(second.goalRunId, requester);
      expect(await rounds(second.goalRunId)).toHaveLength(1);
    });

    it('without the leave no round opens; resume without accept is refused', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester, false);
      expect(await goalRow(goalRunId)).toMatchObject({ pause_reason: 'needs_decision' });
      expect(await rounds(goalRunId)).toEqual([]);
      expect((await getGoal(goalRunId, requester)).planner).toBeNull();
      expect(
        await refusal(
          call(human(requester), 'decide_plan_revision', {
            goalRunId,
            revision: 1,
            decision: 'reject',
            resume: true,
          }),
        ),
      ).toMatchObject({ status: 400 });
    });

    it('the database refuses a planner revision nobody asked for and anyone but the requester accepting one', async () => {
      const requester = await newPrincipal('member');
      const other = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const goal = await getGoal(goalRunId, requester);
      await report((await plannerTask(round.id)).id, {
        decision: 'no_revision',
        reason: 'nothing to change',
      });
      await advanceOnce(goalRunId, requester);
      const [planner] = await raw<{ id: string }>(
        "select id from principals where workspace_id = $1 and display_name = '__goal_planner__'",
        [workspaceId],
      );
      if (!planner) throw new Error('no planner Principal');
      // No running round on this base: a planner revision is refused.
      expect(
        await dbRefusal(
          asApp(requester, (client) =>
            client.query(
              `insert into plan_revisions (workspace_id, goal_run_id, revision, status,
                 based_on_revision, plan, proposed_by, removals)
               values ($1, $2, 2, 'proposed', 1, $3::jsonb, $4, '{}'::jsonb)`,
              [workspaceId, goalRunId, JSON.stringify(goal.planRevision.plan), planner.id],
            ),
          ),
        ),
      ).toMatch(/planning round|planner/i);
      // The leave cannot be given after confirming, nor by anyone but the requester.
      expect(
        await dbRefusal(
          asApp(other, (client) =>
            client.query(
              `insert into goal_planner_delegations (workspace_id, goal_run_id, mode, granted_by)
               values ($1, $2, 'propose', $3)`,
              [workspaceId, goalRunId, other],
            ),
          ),
        ),
      ).toBeTruthy();
    });
  },
);
