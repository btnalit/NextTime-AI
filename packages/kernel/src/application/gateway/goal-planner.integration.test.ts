import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DecidePlanRevisionResultWireSchema,
  type GoalDetailWire,
  GoalDetailWireSchema,
  type GoalPlannerMode,
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
import { PLANNER_HANDLE_CAPABILITIES, PLANNER_MIN_TOKEN_BUDGET } from '../task/index.js';
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { findGoalPlannerFamily } from '../task/planning-task.js';
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

    /** Proposed, confirmed (with the planner's leave in mode `planner` unless it is false) and
     *  started. */
    async function startGoal(
      requesterId: string,
      planner: GoalPlannerMode | false = 'propose',
      plan: Record<string, unknown> = planOf([{ key: 'renew' }]),
    ) {
      const created = await asApp(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'renew the certificate of the site',
          plan,
          budget: BUDGET,
        }),
      );
      const goalRunId = created.goalRunId;
      await call(human(requesterId), 'confirm_goal', {
        goalRunId,
        revision: 1,
        ...(planner ? { planner } : {}),
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
    async function failedForPerson(
      requesterId: string,
      planner: GoalPlannerMode | false = 'propose',
    ) {
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

    it('ending the run waits for the planner’s Task, then rejects what it proposed (UX P2-5 on #864)', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const refused = await refusal(
        call(human(requester), 'end_goal', { goalRunId, outcome: 'not_achieved' }),
      );
      expect(refused).toMatchObject({ status: 409 });
      expect(refused.message).toContain(
        'the goal planner is still looking at the failure of step renew',
      );
      const before = await getGoal(goalRunId, requester);
      await report((await plannerTask(round.id)).id, {
        decision: 'revise',
        plan: reroute(before),
        reason: 'another Worker renews the same way',
      });
      await advanceOnce(goalRunId, requester);
      expect((await rounds(goalRunId)).map((row) => row.status)).toEqual(['proposed']);

      await call(human(requester), 'end_goal', { goalRunId, outcome: 'not_achieved' });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'completed', current_revision: 1 });
      expect(await revisionRow(goalRunId, 2)).toMatchObject({
        status: 'rejected',
        decided_by: requester,
      });
      const audit = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and action = 'plan_revision.reject' and payload ->> 'goalRunId' = $2`,
        [workspaceId, goalRunId],
      );
      expect(audit.map((row) => row.payload)).toMatchObject([
        { revision: 2, by: 'person', reason: 'run_left_pause' },
      ]);
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

    it('find_workers never offers the planner’s family, not even a version a workspace owner published in it', async () => {
      const requester = await newPrincipal('member');
      await failedForPerson(requester);
      const family = await asApp(ownerId, (client) => findGoalPlannerFamily(client, workspaceId));
      if (family === null) throw new Error('no planner family');
      const mine = await asApp(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: family,
          kind: 'worker',
          definition: {
            name: 'Goal planner',
            description: 'Plans goals the owner’s way.',
            systemPrompt: 'You plan a goal the owner’s way.',
          },
        }),
      );
      await asApp(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: family,
          version: mine.version,
        }),
      );
      for (const by of [ownerId, requester]) {
        const found = (await call(human(by), 'find_workers', { need: 'goal planner' })) as {
          items: readonly { definitionId: string }[];
        };
        expect(found.items.map((item) => item.definitionId)).not.toContain(family);
      }
      // Nor does a plan run it as a step (it plans goals), and a planner is not offered its own.
      const asStep = await refusal(
        asApp(requester, (client) =>
          createGoalRun(client, workspaceId, {
            requesterId: requester,
            proposedBy: requester,
            statement: 'plan with the planner',
            plan: planOf([
              { key: 'plan', worker: { definitionId: family, version: mine.version } },
            ]),
            budget: BUDGET,
          }),
        ),
      );
      expect(asStep).toMatchObject({ status: 400 });
      expect(asStep.message).toContain("is the goal planner's; it plans goals");
      const next = await failedForPerson(requester);
      const [round] = await rounds(next.goalRunId);
      if (!round) throw new Error('no round');
      const offered = (await plannerTask(round.id)).input.workers as readonly {
        definitionId: string;
      }[];
      expect(offered.map((item) => item.definitionId)).toEqual(
        expect.arrayContaining([worker.definitionId, otherWorker.definitionId]),
      );
      expect(offered.map((item) => item.definitionId)).not.toContain(family);
    });

    // ----- #493's probes: what the database and the rules refuse, one by one -----------------

    const insertRound = (
      by: string,
      goalRunId: string,
      stepRunId: string,
      attempt: number,
      base: number,
      settled = "'running', null, null, null",
    ) =>
      asApp(by, (client) =>
        client.query(
          `insert into goal_planning_rounds (workspace_id, goal_run_id, based_on_revision,
             step_run_id, step_attempt, failure_category, status, outcome_reason, detail, settled_at)
           values ($1, $2, $3, $4, $5, 'transient', ${settled})`,
          [workspaceId, goalRunId, base, stepRunId, attempt],
        ),
      );
    const grantAsRaw = (goalRunId: string, by: string) =>
      raw(
        `insert into goal_planner_delegations (workspace_id, goal_run_id, mode, granted_by)
         values ($1, $2, 'propose', $3)`,
        [workspaceId, goalRunId, by],
      );
    const grantAs = (goalRunId: string, by: string) =>
      asApp(by, (client) =>
        client.query(
          `insert into goal_planner_delegations (workspace_id, goal_run_id, mode, granted_by)
           values ($1, $2, 'propose', $3)`,
          [workspaceId, goalRunId, by],
        ),
      );

    /** A failed step's round proposed revision 2 (its step given the other Worker). */
    async function proposed(requesterId: string) {
      const failed = await failedForPerson(requesterId);
      const [round] = await rounds(failed.goalRunId);
      if (!round) throw new Error('no round');
      const before = await getGoal(failed.goalRunId, requesterId);
      await report((await plannerTask(round.id)).id, {
        decision: 'revise',
        plan: reroute(before),
        reason: 'another Worker renews the same way',
      });
      await advanceOnce(failed.goalRunId, requesterId);
      expect((await rounds(failed.goalRunId)).map((row) => row.status)).toEqual(['proposed']);
      return { ...failed, round };
    }

    const revisionRow = async (goalRunId: string, revision: number) => {
      const [row] = await raw<{ status: string; decided_by: string | null; plan: unknown }>(
        `select status, decided_by, plan from plan_revisions
          where workspace_id = $1 and goal_run_id = $2 and revision = $3`,
        [workspaceId, goalRunId, revision],
      );
      if (!row) throw new Error(`no revision ${revision}`);
      return row;
    };

    it('only the requester accepts the planner’s revision, even adopting it in the same transaction', async () => {
      const requester = await newPrincipal('member');
      const other = await newPrincipal('member');
      const { goalRunId } = await proposed(requester);
      const refused = await dbRefusal(
        asApp(other, async (client) => {
          await client.query(
            `update plan_revisions set status = 'accepted', decided_by = $3, decided_at = now()
              where workspace_id = $1 and goal_run_id = $2 and revision = 2`,
            [workspaceId, goalRunId, other],
          );
          await client.query(
            `update goal_runs set current_revision = 2, updated_at = now()
              where workspace_id = $1 and id = $2`,
            [workspaceId, goalRunId],
          );
        }),
      );
      expect(refused).toMatch(/accepted by the requester/);
    });

    it('a round opens only with the requester’s leave, on a failed attempt, the revision in force and no owner hold', async () => {
      const requester = await newPrincipal('member');
      const noLeave = await failedForPerson(requester, false);
      expect(await rounds(noLeave.goalRunId)).toEqual([]);
      const open = (attempt: number, base: number) =>
        insertRound(requester, noLeave.goalRunId, noLeave.step.id, attempt, base);
      expect(await dbRefusal(open(1, 1))).toMatch(/did not let the planner/);
      await grantAsRaw(noLeave.goalRunId, requester);
      expect(await dbRefusal(open(2, 1))).toMatch(/failed attempt of a live step/);
      expect(
        await dbRefusal(
          insertRound(
            requester,
            noLeave.goalRunId,
            noLeave.step.id,
            1,
            1,
            "'no_revision', null, 'x', now()",
          ),
        ),
      ).toMatch(/opened running, or recorded failed/);
      await call(human(ownerId), 'pause_goal', { goalRunId: noLeave.goalRunId });
      expect(await dbRefusal(open(1, 1))).toMatch(/no owner holds it/);

      const revised = await failedForPerson(requester, false);
      await grantAsRaw(revised.goalRunId, requester);
      const goal = await getGoal(revised.goalRunId, requester);
      await call(human(requester), 'revise_goal', {
        goalRunId: revised.goalRunId,
        basedOnRevision: 1,
        plan: reroute(goal),
      });
      expect((await goalRow(revised.goalRunId)).current_revision).toBe(2);
      expect(
        await dbRefusal(insertRound(requester, revised.goalRunId, revised.step.id, 1, 1)),
      ).toMatch(/based on the revision in force/);
    });

    it('a round settles once, proposing only a planner revision, failing only for a reason that fits', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const settle = (set: string) =>
        asApp(requester, (client) =>
          client.query(
            `update goal_planning_rounds set ${set} where workspace_id = $1 and id = $2`,
            [workspaceId, round.id],
          ),
        );
      expect(
        await dbRefusal(settle("status = 'proposed', revision = 1, settled_at = now()")),
      ).toMatch(/a revision the planner proposed/);
      expect(
        await dbRefusal(
          settle("status = 'failed', outcome_reason = 'planner_unavailable', settled_at = now()"),
        ),
      ).toMatch(/gave no usable result/);
      await report((await plannerTask(round.id)).id, { decision: 'no_revision', reason: 'none' });
      await advanceOnce(goalRunId, requester);
      expect((await rounds(goalRunId)).map((row) => row.status)).toEqual(['no_revision']);
      expect(
        await dbRefusal(settle("status = 'failed', outcome_reason = 'task_failed', detail = null")),
      ).toMatch(/settles once/);
    });

    it('the leave is given by the requester only, while the goal is proposed', async () => {
      const requester = await newPrincipal('member');
      const other = await newPrincipal('member');
      const started = await startGoal(requester, false);
      expect(await dbRefusal(grantAs(started, requester))).toMatch(
        /when the goal run is confirmed/,
      );
      const created = await asApp(requester, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId: requester,
          proposedBy: requester,
          statement: 'renew the certificate of the site',
          plan: planOf([{ key: 'renew' }]),
          budget: BUDGET,
        }),
      );
      expect(await dbRefusal(grantAs(created.goalRunId, other))).toMatch(/only the requester/);
    });

    it('a planning Task keeps the requester and its empty observation scope', async () => {
      const requester = await newPrincipal('member');
      const other = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      const change = (set: string, params: readonly unknown[] = []) =>
        asApp(requester, (client) =>
          client.query(`update tasks set ${set} where workspace_id = $1 and id = $2`, [
            workspaceId,
            task.id,
            ...params,
          ]),
        );
      expect(await dbRefusal(change('on_behalf_of = $3', [other]))).toMatch(
        /acts for the requester/,
      );
      expect(await dbRefusal(change('observe_scope = null'))).toMatch(
        /observation scope|tasks_planning_shape/,
      );
    });

    it('a planner report writing Facts or evidence is refused, each field named, and writes nothing', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      // A Fact is a link, asserted with its evidence.
      const facts = async () =>
        (
          await raw<{ n: number }>(
            `select ((select count(*) from links where workspace_id = $1)
                   + (select count(*) from evidence where workspace_id = $1))::int as n`,
            [workspaceId],
          )
        )[0]?.n;
      const before = await facts();
      const refused = await refusal(
        dispatchCapability({ pool }, await workerOf(task.id), 'report_task_result', {
          summary: 'planned',
          output: { decision: 'no_revision', reason: 'nothing to change' },
          factsToAssert: [
            {
              linkType: 'runs_on',
              source: { objectType: 'Host', identity: { name: 'web-1' } },
              target: { objectType: 'Host', identity: { name: 'rack-1' } },
            },
          ],
          evidence: [{ kind: 'note', content: { text: 'planner note' } }],
        }),
      );
      expect(refused).toMatchObject({ status: 400 });
      expect(refused.message).toContain("what the goal planner's report must be");
      expect(refused.message).toContain('factsToAssert:');
      expect(refused.message).toContain('evidence:');
      expect(await facts()).toBe(before);
      expect((await plannerTask(round.id)).status).toBe('running');
    });

    it('a rejected proposal stays rejected: no accepting it after, no new round for the same failure', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await proposed(requester);
      const decide = (decision: 'accept' | 'reject') =>
        call(human(requester), 'decide_plan_revision', { goalRunId, revision: 2, decision });
      expect(await decide('reject')).toMatchObject({ changed: true, decision: 'reject' });
      expect(await decide('reject')).toMatchObject({ changed: false });
      expect(await refusal(decide('accept'))).toMatchObject({ status: 409 });
      await advanceOnce(goalRunId, requester);
      expect((await rounds(goalRunId)).map((row) => row.status)).toEqual(['proposed']);
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
        current_revision: 1,
      });
      expect(await revisionRow(goalRunId, 2)).toMatchObject({
        status: 'rejected',
        decided_by: requester,
      });
    });

    it('resuming the goal rejects the planner’s pending proposal (I-P4)', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await proposed(requester);
      await call(human(requester), 'resume_goal', { goalRunId, retrySteps: ['renew'] });
      expect(await revisionRow(goalRunId, 2)).toMatchObject({
        status: 'rejected',
        decided_by: requester,
      });
    });

    it('no round runs on a goal with no revision or too few tokens left', async () => {
      const requester = await newPrincipal('member');
      const failedWith = async (budget: typeof BUDGET) => {
        const created = await asApp(requester, (client) =>
          createGoalRun(client, workspaceId, {
            requesterId: requester,
            proposedBy: requester,
            statement: 'renew the certificate of the site',
            plan: planOf([{ key: 'renew' }]),
            budget,
          }),
        );
        const goalRunId = created.goalRunId;
        await call(human(requester), 'confirm_goal', {
          goalRunId,
          revision: 1,
          planner: 'propose',
        });
        await advanceOnce(goalRunId, requester);
        const step = await liveStep(goalRunId, 'renew');
        await loseTask((await lastAttempt(step.id)).id, requester);
        await advanceOnce(goalRunId, requester);
        return rounds(goalRunId);
      };
      expect(await failedWith({ ...BUDGET, maxRevisions: 0 })).toEqual([
        expect.objectContaining({ status: 'failed', outcome_reason: 'revision_budget_exhausted' }),
      ]);
      expect(await failedWith({ ...BUDGET, maxTokens: PLANNER_MIN_TOKEN_BUDGET - 1 })).toEqual([
        expect.objectContaining({ status: 'failed', outcome_reason: 'token_budget_exhausted' }),
      ]);
    });

    it('accepting a proposal that kept a value of an older plan as read takes it as kept (#493 P2-1)', async () => {
      const requester = await newPrincipal('member');
      const created = await asApp(requester, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId: requester,
          proposedBy: requester,
          statement: 'renew then notify',
          plan: {
            steps: [
              { key: 'renew', worker, input: { step: 'renew' }, maxAttempts: 1 },
              {
                key: 'notify',
                worker,
                input: { step: 'notify' },
                maxAttempts: 1,
                dependsOn: ['renew'],
              },
            ],
          },
          budget: BUDGET,
        }),
      );
      const goalRunId = created.goalRunId;
      // A plan stored before GO5c refused credentials in a plan: it reads masked ever since.
      await raw(
        `update plan_revisions
            set plan = jsonb_set(plan, '{steps,1,input,password}', '"legacy-pass-1234"')
          where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
        [workspaceId, goalRunId],
      );
      await call(human(requester), 'confirm_goal', { goalRunId, revision: 1, planner: 'propose' });
      await advanceOnce(goalRunId, requester);
      const step = await liveStep(goalRunId, 'renew');
      await loseTask((await lastAttempt(step.id)).id, requester);
      await advanceOnce(goalRunId, requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      const read = task.input.plan as { steps: Record<string, unknown>[] };
      const notify = read.steps[1] as { input: Record<string, unknown> };
      expect(notify.input.password).not.toBe('legacy-pass-1234');
      await report(task.id, {
        decision: 'revise',
        plan: {
          steps: [
            { key: 'renew-other', worker: otherWorker, input: { step: 'renew' }, maxAttempts: 1 },
            { ...notify, dependsOn: ['renew-other'] },
          ],
        },
        reason: 'another Worker renews the same way',
      });
      await advanceOnce(goalRunId, requester);
      const stored = (await revisionRow(goalRunId, 2)).plan as {
        steps: { input: Record<string, unknown> }[];
      };
      expect(stored.steps[1]?.input.password).toBe('legacy-pass-1234');
      expect(
        await call(human(requester), 'decide_plan_revision', {
          goalRunId,
          revision: 2,
          decision: 'accept',
        }),
      ).toMatchObject({ changed: true, decision: 'accept' });
      expect(await goalRow(goalRunId)).toMatchObject({ current_revision: 2 });
      expect(
        ((await revisionRow(goalRunId, 2)).plan as typeof stored).steps[1]?.input.password,
      ).toBe('legacy-pass-1234');
    });

    // ----- S11 GO9b: apply_minor ----------------------------------------------------------------

    const autonomyRounds = (goalRunId: string) =>
      raw<{
        id: string;
        kind: string;
        status: string;
        revision: number | null;
        revision_class: string | null;
        class_reasons: { code: string; stepKey: string | null }[];
        outcome_reason: string | null;
        step_run_id: string;
        step_attempt: number;
      }>(
        `select id, kind, status, revision, revision_class, class_reasons, outcome_reason,
                step_run_id, step_attempt
           from goal_planning_rounds where workspace_id = $1 and goal_run_id = $2
          order by created_at`,
        [workspaceId, goalRunId],
      );

    /** Under `apply_minor`: started, its one step's only attempt lost — the run keeps running and
     *  an autonomous round runs for the failure. */
    async function failedRunning(requesterId: string) {
      const goalRunId = await startGoal(requesterId, 'apply_minor');
      const step = await liveStep(goalRunId, 'renew');
      await loseTask((await lastAttempt(step.id)).id, requesterId);
      await advanceOnce(goalRunId, requesterId);
      return { goalRunId, step };
    }

    async function onlyRound(goalRunId: string) {
      const [round, ...more] = await autonomyRounds(goalRunId);
      expect(more).toEqual([]);
      if (!round) throw new Error('no round');
      return round;
    }

    /** `goal`'s plan in force with the step `key` given `change`, every other step as read. */
    const changeStep = (
      goal: GoalDetailWire,
      key: string,
      change: (step: Record<string, unknown>) => Record<string, unknown>,
    ) => ({
      ...goal.planRevision.plan,
      steps: (goal.planRevision.plan.steps as Record<string, unknown>[]).map((step) =>
        step.key === key ? change(step) : step,
      ),
    });

    it('under apply_minor a failed step does not pause the run; the minor revision is applied for the requester and the goal reaches done', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId, step } = await failedRunning(requester);
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running', current_revision: 1 });
      const round = await onlyRound(goalRunId);
      expect(round).toMatchObject({
        kind: 'autonomous',
        status: 'running',
        step_run_id: step.id,
        step_attempt: 1,
      });
      // While it plans, the run waits: no new attempt, no second round.
      await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running' });
      expect(await autonomyRounds(goalRunId)).toHaveLength(1);
      expect(await liveStep(goalRunId, 'renew')).toMatchObject({
        id: step.id,
        status: 'failed',
        attempt_count: 1,
      });

      const before = await getGoal(goalRunId, requester);
      expect(before.planner).toBe('apply_minor');
      await report((await plannerTask(round.id)).id, {
        decision: 'revise',
        plan: reroute(before),
        reason: 'The first Worker lost its run; the other Worker renews the same way.',
      });
      await advanceOnce(goalRunId, requester);
      expect(await onlyRound(goalRunId)).toMatchObject({
        status: 'applied',
        revision: 2,
        revision_class: 'minor',
        class_reasons: [],
      });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running', current_revision: 2 });
      const applied = await getGoal(goalRunId, requester);
      expect(applied.revisions.at(-1)).toMatchObject({
        revision: 2,
        status: 'accepted',
        proposer: 'planner',
        acceptedBy: 'platform',
        decidedBy: requester,
      });
      expect(applied.revisions[0]).toMatchObject({ revision: 1, acceptedBy: 'person' });
      expect(applied.planningRounds).toMatchObject([
        { kind: 'autonomous', status: 'applied', revisionClass: 'minor', classReasons: [] },
      ]);
      const [accept] = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and action = 'plan_revision.accept'
            and payload ->> 'goalRunId' = $2 and payload ->> 'revision' = '2'`,
        [workspaceId, goalRunId],
      );
      expect(accept?.payload).toMatchObject({
        revision: 2,
        by: 'advancer',
        basis: 'autonomy',
        planningRoundId: round.id,
      });

      await advanceOnce(goalRunId, requester);
      const other = await liveStep(goalRunId, 'renew-other');
      await dispatchCapability(
        { pool },
        await workerOf((await lastAttempt(other.id)).id),
        'report_task_result',
        {
          summary: 'renewed',
        },
      );
      await advanceOnce(goalRunId, requester);
      expect((await goalRow(goalRunId)).status).toBe('verifying');
      await call(human(requester), 'confirm_goal_acceptance', { goalRunId });
      await advanceOnce(goalRunId, requester);
      expect((await goalRow(goalRunId)).status).toBe('completed');
    });

    it('while the planner takes a failure no attempt starts; attempts already running go on', async () => {
      const requester = await newPrincipal('member');
      const plan = {
        steps: [
          { key: 'renew', worker, input: { step: 'renew' }, maxAttempts: 1 },
          { key: 'prep', worker, input: { step: 'prep' }, maxAttempts: 1 },
          { key: 'later', worker, input: { step: 'later' }, dependsOn: ['prep'], maxAttempts: 1 },
        ],
      };
      const goalRunId = await startGoal(requester, 'apply_minor', plan);
      const renew = await liveStep(goalRunId, 'renew');
      const prep = await liveStep(goalRunId, 'prep');
      await loseTask((await lastAttempt(renew.id)).id, requester);
      await dispatchCapability(
        { pool },
        await workerOf((await lastAttempt(prep.id)).id),
        'report_task_result',
        {
          summary: 'prepared',
        },
      );
      await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running' });
      expect((await liveStep(goalRunId, 'prep')).status).toBe('succeeded');
      // `later` is ready, held while the round runs.
      const later = await liveStep(goalRunId, 'later');
      expect(later).toMatchObject({ status: 'ready', attempt_count: 0 });
      await advanceOnce(goalRunId, requester);
      expect(await liveStep(goalRunId, 'later')).toMatchObject({
        status: 'ready',
        attempt_count: 0,
      });

      const round = await onlyRound(goalRunId);
      const goal = await getGoal(goalRunId, requester);
      await report((await plannerTask(round.id)).id, {
        decision: 'revise',
        plan: changeStep(goal, 'renew', (entry) => ({ ...entry, worker: otherWorker })),
        reason: 'The other Worker renews the same way.',
      });
      await advanceOnce(goalRunId, requester);
      expect(await onlyRound(goalRunId)).toMatchObject({
        status: 'applied',
        revision_class: 'minor',
      });
      await advanceOnce(goalRunId, requester);
      expect((await liveStep(goalRunId, 'later')).attempt_count).toBe(1);
      expect((await liveStep(goalRunId, 'renew')).attempt_count).toBe(1);
      expect((await liveStep(goalRunId, 'renew')).id).not.toBe(renew.id);
    });

    it('a major revision pauses the run for the requester, who decides it on the same card', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedRunning(requester);
      const round = await onlyRound(goalRunId);
      const goal = await getGoal(goalRunId, requester);
      await report((await plannerTask(round.id)).id, {
        decision: 'revise',
        plan: {
          ...goal.planRevision.plan,
          steps: [
            {
              key: 'renew-team',
              worker: otherWorker,
              input: { step: 'renew' },
              nested: true,
              maxAttempts: 1,
            },
          ],
        },
        reason: 'A team of Workers renews it.',
      });
      await advanceOnce(goalRunId, requester);
      expect(await onlyRound(goalRunId)).toMatchObject({
        status: 'proposed',
        revision: 2,
        revision_class: 'major',
        class_reasons: [{ code: 'execution_step', stepKey: 'renew-team' }],
      });
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
        current_revision: 1,
      });
      const paused = await getGoal(goalRunId, requester);
      expect(paused.planningRounds).toMatchObject([
        {
          kind: 'autonomous',
          status: 'proposed',
          revisionClass: 'major',
          classReasons: [{ code: 'execution_step', stepKey: 'renew-team' }],
        },
      ]);
      expect(paused.revisions.at(-1)).toMatchObject({ status: 'proposed', acceptedBy: null });
      // The pause opens no proposal round of its own: the failed attempt had its round.
      await advanceOnce(goalRunId, requester);
      expect(await autonomyRounds(goalRunId)).toHaveLength(1);

      await call(human(requester), 'decide_plan_revision', {
        goalRunId,
        revision: 2,
        decision: 'accept',
        resume: true,
      });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running', current_revision: 2 });
      expect((await getGoal(goalRunId, requester)).revisions.at(-1)).toMatchObject({
        revision: 2,
        acceptedBy: 'person',
      });
    });

    it('a planner with no revision pauses the run; a person pausing the run drops the running round', async () => {
      const requester = await newPrincipal('member');
      const first = await failedRunning(requester);
      const round = await onlyRound(first.goalRunId);
      await report((await plannerTask(round.id)).id, {
        decision: 'no_revision',
        reason: 'Nothing in the plan would get past this.',
      });
      await advanceOnce(first.goalRunId, requester);
      expect(await onlyRound(first.goalRunId)).toMatchObject({ status: 'no_revision' });
      expect(await goalRow(first.goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      await advanceOnce(first.goalRunId, requester);
      expect(await autonomyRounds(first.goalRunId)).toHaveLength(1);

      const second = await failedRunning(requester);
      const running = await onlyRound(second.goalRunId);
      const task = await plannerTask(running.id);
      await call(human(requester), 'pause_goal', { goalRunId: second.goalRunId });
      expect(await onlyRound(second.goalRunId)).toMatchObject({
        status: 'abandoned',
        outcome_reason: 'run_not_running',
      });
      await advanceOnce(second.goalRunId, requester);
      expect((await plannerTask(running.id)).status).not.toBe('running');
      expect(task.id).toBe((await plannerTask(running.id)).id);
    });

    it('the platform stops planning a step it already changed twice', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedRunning(requester);
      for (const next of [otherWorker, worker]) {
        const round = (await autonomyRounds(goalRunId)).at(-1);
        if (!round) throw new Error('no round');
        const goal = await getGoal(goalRunId, requester);
        await report((await plannerTask(round.id)).id, {
          decision: 'revise',
          plan: changeStep(goal, 'renew', (entry) => ({ ...entry, worker: next })),
          reason: 'Another Worker for the same step.',
        });
        await advanceOnce(goalRunId, requester);
        expect((await autonomyRounds(goalRunId)).at(-1)).toMatchObject({ status: 'applied' });
        await advanceOnce(goalRunId, requester);
        const step = await liveStep(goalRunId, 'renew');
        await loseTask((await lastAttempt(step.id)).id, requester);
        await advanceOnce(goalRunId, requester);
      }
      const all = await autonomyRounds(goalRunId);
      expect(all.map((round) => round.status)).toEqual(['applied', 'applied', 'failed']);
      expect(all.at(-1)).toMatchObject({ outcome_reason: 'step_keeps_failing' });
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
    });

    it('the database refuses an autonomous round under a propose leave and an applied proposal round', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, 'propose');
      const step = await liveStep(goalRunId, 'renew');
      await loseTask((await lastAttempt(step.id)).id, requester);
      await raw(
        `update step_runs set status = 'failed', failure_category = 'transient'
          where workspace_id = $1 and id = $2`,
        [workspaceId, step.id],
      );
      expect(
        await dbRefusal(
          asApp(requester, (client) =>
            client.query(
              `insert into goal_planning_rounds (workspace_id, goal_run_id, based_on_revision,
                 step_run_id, step_attempt, failure_category, kind)
               values ($1, $2, 1, $3, 1, 'transient', 'autonomous')`,
              [workspaceId, goalRunId, step.id],
            ),
          ),
        ),
      ).toMatch(/apply_minor/);
      const paused = await failedForPerson(requester);
      const round = await onlyRound(paused.goalRunId);
      expect(
        await dbRefusal(
          asApp(requester, (client) =>
            client.query(
              `update goal_planning_rounds set status = 'applied', revision = 1,
                 revision_class = 'minor', settled_at = now()
               where workspace_id = $1 and id = $2`,
              [workspaceId, round.id],
            ),
          ),
        ),
      ).toMatch(/autonomous/);
    });

    // ----- #493's surviving code mutants: the rules other checks would otherwise mask ----------

    const setMaxRevisions = (goalRunId: string, max: number) =>
      raw('update goal_runs set budget_max_revisions = $3 where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
        max,
      ]);

    it('the revision budget is checked again when the round settles and when the requester accepts (C16, C5)', async () => {
      const requester = await newPrincipal('member');
      // Settling: the budget ran out after the planner reported.
      const settling = await failedForPerson(requester);
      const [round] = await rounds(settling.goalRunId);
      if (!round) throw new Error('no round');
      const before = await getGoal(settling.goalRunId, requester);
      await report((await plannerTask(round.id)).id, {
        decision: 'revise',
        plan: reroute(before),
        reason: 'another Worker',
      });
      await setMaxRevisions(settling.goalRunId, 0);
      await advanceOnce(settling.goalRunId, requester);
      const [settled] = await rounds(settling.goalRunId);
      expect(settled).toMatchObject({ status: 'failed', outcome_reason: 'invalid_revision' });
      expect(settled?.detail).toContain('revisions already made');
      expect((await goalRow(settling.goalRunId)).current_revision).toBe(1);

      // Accepting: the budget ran out while the proposal waited.
      const { goalRunId } = await proposed(requester);
      await setMaxRevisions(goalRunId, 0);
      const refused = await refusal(
        call(human(requester), 'decide_plan_revision', {
          goalRunId,
          revision: 2,
          decision: 'accept',
        }),
      );
      expect(refused.status).toBe(409);
      expect(refused.message).toContain('revisions already made');
      expect(await revisionRow(goalRunId, 2)).toMatchObject({ status: 'proposed' });
      expect((await goalRow(goalRunId)).current_revision).toBe(1);
    });

    it('no second round opens while the planner’s proposal waits, even for a later failure (C12)', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId, step } = await proposed(requester);
      // As if the step failed again: a round for that attempt would otherwise be due.
      await raw('update step_runs set attempt_count = 2 where workspace_id = $1 and id = $2', [
        workspaceId,
        step.id,
      ]);
      await advanceOnce(goalRunId, requester);
      expect((await rounds(goalRunId)).map((row) => row.status)).toEqual(['proposed']);
    });

    it('the planner does not start for a requester the seal holds or who cannot start Workers (C23, C24)', async () => {
      const held = await newPrincipal('member');
      const heldGoal = await startGoal(held);
      const heldStep = await liveStep(heldGoal, 'renew');
      await raw(
        `insert into eval_seal_holds (workspace_id, principal_id, hits, places)
         values ($1, $2, 5, '{"capabilityResult": 5, "capabilityError": 0, "workerStart": 0}')`,
        [workspaceId, held],
      );
      await loseTask((await lastAttempt(heldStep.id)).id, held);
      await advanceOnce(heldGoal, held);
      const [heldRound] = await rounds(heldGoal);
      expect(heldRound).toMatchObject({
        status: 'failed',
        outcome_reason: 'requester_cannot_start',
      });
      expect(
        await raw('select 1 from tasks where workspace_id = $1 and planning_round_id = $2', [
          workspaceId,
          heldRound?.id,
        ]),
      ).toEqual([]);

      const disabled = await newPrincipal('member');
      const disabledGoal = await startGoal(disabled);
      const disabledStep = await liveStep(disabledGoal, 'renew');
      await raw('update principals set disabled_at = now() where workspace_id = $1 and id = $2', [
        workspaceId,
        disabled,
      ]);
      await loseTask((await lastAttempt(disabledStep.id)).id, disabled);
      await advanceOnce(disabledGoal, disabled);
      const [disabledRound] = await rounds(disabledGoal);
      expect(disabledRound).toMatchObject({
        status: 'failed',
        outcome_reason: 'requester_cannot_start',
      });
      expect(disabledRound?.detail).toContain('disabled');
    });

    it('a report after its round stopped running is not held to a plan it no longer revises (C28)', async () => {
      const requester = await newPrincipal('member');
      const { goalRunId } = await failedForPerson(requester);
      const [round] = await rounds(goalRunId);
      if (!round) throw new Error('no round');
      const task = await plannerTask(round.id);
      // An owner hold drops the running round; the run stays paused on the same revision.
      await call(human(ownerId), 'pause_goal', { goalRunId });
      expect(await rounds(goalRunId)).toMatchObject([
        { status: 'abandoned', outcome_reason: 'run_left_pause' },
      ]);
      // A plan that would not pass (an unknown Worker) is no longer the planner's to fix.
      await report(task.id, {
        decision: 'revise',
        plan: {
          steps: [
            {
              key: 'nowhere',
              worker: { definitionId: randomUUID(), version: 1 },
              input: {},
              maxAttempts: 1,
            },
          ],
        },
        reason: 'late',
      });
      await advanceOnce(goalRunId, requester);
      expect(await rounds(goalRunId)).toMatchObject([{ status: 'abandoned' }]);
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'paused', current_revision: 1 });
    });

    it('the advance abandons a round its run left without a person closing it (C10, C11)', async () => {
      const requester = await newPrincipal('member');
      // The run left its pause by a path that did not close the planning (an owner hold here).
      const left = await failedForPerson(requester);
      const [leftRound] = await rounds(left.goalRunId);
      if (!leftRound) throw new Error('no round');
      await raw(
        `update goal_runs set paused_by = $3, paused_by_authority = 'owner'
          where workspace_id = $1 and id = $2`,
        [workspaceId, left.goalRunId, ownerId],
      );
      await advanceOnce(left.goalRunId, requester);
      expect(await rounds(left.goalRunId)).toMatchObject([
        { status: 'abandoned', outcome_reason: 'run_left_pause' },
      ]);
      expect((await plannerTask(leftRound.id)).status).toBe('cancelled');

      // The round planned on a revision no longer in force.
      const stale = await failedForPerson(requester);
      const [staleRound] = await rounds(stale.goalRunId);
      if (!staleRound) throw new Error('no round');
      await raw(
        'update goal_planning_rounds set based_on_revision = 2 where workspace_id = $1 and id = $2',
        [workspaceId, staleRound.id],
      );
      await advanceOnce(stale.goalRunId, requester);
      expect((await rounds(stale.goalRunId))[0]).toMatchObject({
        status: 'abandoned',
        outcome_reason: 'plan_revised',
      });
    });
  },
);
