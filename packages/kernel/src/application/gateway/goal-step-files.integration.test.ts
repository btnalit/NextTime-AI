import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims, Role, StepFilesState } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskDirsKeepInput,
  TaskDirsKeepResult,
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import { advanceGoalRun } from '../goal/advance.js';
import { listGoalFilesToKeep, runGoalFilesKeepTick } from '../goal/files-keep.js';
import { createGoalRun } from '../goal/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO14 (步骤间产物文件
 * 交接, s11-w2/go14-default-plan.md), with the advances driven by hand and a
 * worker-supervisor stand-in that records what each spawn asked for and answers `keepTaskDirs` as
 * the test says: a step whose plan entry names earlier steps in `filesFrom` starts with their
 * accepted attempts' Tasks of the same goal run mounted (the spawn's `upstream`, the prompt, the
 * audit), every goal step's spawn carries its goal run; an upstream container still exiting puts
 * the step off a moment without spending an attempt; a directory not there, or not this run's,
 * pauses the run for a person, naming the step, again without spending one, as does a step read
 * from that was skipped; after a revision redefines the step read from, the live one's files are
 * mounted; a step put off for an upstream container does not hold the others; and the retention
 * lease lists the accepted attempts of the steps of runs that have not ended.
 *
 * Every run this file moves is left with no `next_tick_at`, so no advancer of another file claims
 * it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 };

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();
  readonly spawned: TaskSpawnInput[] = [];
  readonly asked: (readonly TaskDirsKeepInput[])[] = [];
  /** What `keepTaskDirs` answers for a Task (default `kept`). */
  readonly states = new Map<string, StepFilesState>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    this.spawned.push(input);
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.24',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.24' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    return this.statuses.delete(workerRunId);
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }

  async keepTaskDirs(tasks: readonly TaskDirsKeepInput[]): Promise<readonly TaskDirsKeepResult[]> {
    this.asked.push(tasks);
    return tasks.map((task) => ({
      taskId: task.taskId,
      state: this.states.get(task.taskId) ?? 'kept',
    }));
  }

  spawnOf(taskId: string): TaskSpawnInput {
    const found = this.spawned.filter((input) => input.taskId === taskId).at(-1);
    if (!found) throw new Error(`no spawn for Task ${taskId}`);
    return found;
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'goal step file handoff — S11 GO14 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let worker: { definitionId: string; version: number };
    const supervisor = new FakeTaskSupervisorClient();

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

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

    const human = (principalId: string): ResolvedCaller => ({
      channel: 'human',
      principal: { workspaceId, id: principalId, kind: 'human', role: 'member', displayName: null },
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
    });

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

    async function advanceOnce(
      goalRunId: string,
      requesterId: string,
      supervisorClient: TaskSupervisorClientPort = supervisor,
    ) {
      const outcome = await advanceGoalRun(
        {
          pool,
          taskRuntime: { pool, privateKey, supervisorClient },
          options: { retryBackoffMs: () => 60 * 60 * 1000 },
        },
        { workspaceId, goalRunId, requesterId },
      );
      await parkGoal(goalRunId);
      return outcome;
    }

    /** Proposed with `steps` (each given the file's Worker), confirmed, and advanced once. */
    async function startGoal(requesterId: string, steps: readonly Record<string, unknown>[]) {
      const created = await as(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'hand files from one step to the next',
          plan: { steps: steps.map((step) => ({ worker, ...step })) },
          budget: BUDGET,
        }),
      );
      await dispatchCapability({ pool }, human(requesterId), 'confirm_goal', {
        goalRunId: created.goalRunId,
        revision: 1,
      });
      await advanceOnce(created.goalRunId, requesterId);
      return created.goalRunId;
    }

    async function stepRun(goalRunId: string, key: string) {
      const [row] = await raw<{ id: string; status: string; attempt_count: number }>(
        `select id, status, attempt_count from step_runs
          where workspace_id = $1 and goal_run_id = $2 and step_key = $3
            and status <> 'superseded'`,
        [workspaceId, goalRunId, key],
      );
      if (!row) throw new Error(`no step ${key}`);
      return row;
    }

    async function latestTask(goalRunId: string, key: string) {
      const [row] = await raw<{ id: string; status: string }>(
        `select id, status from tasks where workspace_id = $1 and step_run_id = $2
          order by step_attempt desc limit 1`,
        [workspaceId, (await stepRun(goalRunId, key)).id],
      );
      if (!row) throw new Error(`step ${key} has no attempt`);
      return row;
    }

    const goalRow = async (goalRunId: string) =>
      (
        await raw<{ status: string; pause_reason: string | null; next_tick_at: Date | null }>(
          'select status, pause_reason, next_tick_at from goal_runs where workspace_id = $1 and id = $2',
          [workspaceId, goalRunId],
        )
      )[0];

    const lastPause = async (goalRunId: string) =>
      (
        await raw<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and resource_id = $2 and action = 'goal_run.pause'
            order by created_at desc, id desc limit 1`,
          [workspaceId, goalRunId],
        )
      )[0]?.payload;

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

    /** The step's latest attempt reports, and an advance makes the step succeed. */
    async function finishStep(goalRunId: string, requesterId: string, key: string) {
      const task = await latestTask(goalRunId, key);
      await dispatchCapability({ pool }, await workerOf(task.id), 'report_task_result', {
        summary: `step ${key} done`,
      });
      await advanceOnce(goalRunId, requesterId);
      return task.id;
    }

    const STEPS = [
      { key: 'a', input: { what: 'write a report' } },
      { key: 'b', dependsOn: ['a'], filesFrom: ['a'], input: { what: 'read it' } },
    ];

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
            'go14-step-files',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
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
      await raw(
        `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                paused_by_authority = null, ended_at = now(), next_tick_at = null
          where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
        [workspaceId],
      );
      await pool.end();
    });

    it('a step mounts the accepted attempt of the step it names, of its own run: spawn, prompt and audit say so; every goal step carries its run', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, STEPS);
      const aTask = await latestTask(goalRunId, 'a');

      // Step a's spawn: its goal run (owner marker, handoff directory), nothing mounted; its prompt
      // says where to leave files for later steps.
      const aSpawn = supervisor.spawnOf(aTask.id);
      expect(aSpawn.goalRunId).toBe(goalRunId);
      expect(aSpawn.upstream).toBeUndefined();
      expect(aSpawn.systemPrompt).toContain('/workspace/out');
      expect(aSpawn.systemPrompt).not.toContain('/upstream/');

      const askedBefore = supervisor.asked.length;
      const aTaskId = await finishStep(goalRunId, requester, 'a');
      expect(await stepRun(goalRunId, 'a')).toMatchObject({ status: 'succeeded' });
      // The advance that made a succeed could not start b yet (b becomes ready after it); one more.
      if ((await stepRun(goalRunId, 'b')).status === 'ready')
        await advanceOnce(goalRunId, requester);
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'running', attempt_count: 1 });

      // The supervisor was asked about a's Task, for this workspace and run.
      expect(supervisor.asked.slice(askedBefore)).toContainEqual([
        { taskId: aTaskId, workspaceId, goalRunId },
      ]);
      const bTask = await latestTask(goalRunId, 'b');
      const bSpawn = supervisor.spawnOf(bTask.id);
      expect(bSpawn.goalRunId).toBe(goalRunId);
      expect(bSpawn.upstream).toEqual([{ stepKey: 'a', taskId: aTaskId }]);
      expect(bSpawn.systemPrompt).toContain('- step a: /upstream/a');

      const [queued] = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and resource_id = $2 and action = 'task.queue'`,
        [workspaceId, bTask.id],
      );
      expect(queued?.payload.upstreamFiles).toEqual([{ stepKey: 'a', taskId: aTaskId }]);
      const [started] = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and resource_id = $2 and action = 'step_run.start'
          order by created_at desc limit 1`,
        [workspaceId, (await stepRun(goalRunId, 'b')).id],
      );
      expect(started?.payload).toMatchObject({ taskId: bTask.id, filesFrom: ['a'] });

      // The lease lists a's accepted attempt while the run has not ended.
      const kept = (await listGoalFilesToKeep(pool)).filter(
        (entry) => entry.workspaceId === workspaceId && entry.goalRunId === goalRunId,
      );
      expect(kept).toEqual([{ taskId: aTaskId, workspaceId, goalRunId }]);
    });

    it('another run’s Task never gets in: each run mounts its own step a', async () => {
      const requester = await newPrincipal('member');
      const first = await startGoal(requester, STEPS);
      const second = await startGoal(requester, STEPS);
      const firstA = await finishStep(first, requester, 'a');
      const secondA = await finishStep(second, requester, 'a');
      for (const goalRunId of [first, second]) {
        if ((await stepRun(goalRunId, 'b')).status === 'ready') {
          await advanceOnce(goalRunId, requester);
        }
      }
      const firstB = supervisor.spawnOf((await latestTask(first, 'b')).id);
      const secondB = supervisor.spawnOf((await latestTask(second, 'b')).id);
      expect(firstB.upstream).toEqual([{ stepKey: 'a', taskId: firstA }]);
      expect(secondB.upstream).toEqual([{ stepKey: 'a', taskId: secondA }]);
      expect(firstB.goalRunId).toBe(first);
      expect(secondB.goalRunId).toBe(second);
    });

    it('an upstream container still exiting puts the step off a moment: no attempt spent, no pause, the run due again soon', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, STEPS);
      const aTask = await latestTask(goalRunId, 'a');
      supervisor.states.set(aTask.id, 'running');
      await finishStep(goalRunId, requester, 'a');
      const outcome = await advanceOnce(goalRunId, requester);
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'ready', attempt_count: 0 });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running', pause_reason: null });
      expect(outcome.nextTickAt).not.toBeNull();
      const due = (outcome.nextTickAt as Date).getTime() - Date.now();
      expect(due).toBeLessThanOrEqual(6_000);

      // Exited: the next advance starts it.
      supervisor.states.delete(aTask.id);
      await advanceOnce(goalRunId, requester);
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'running', attempt_count: 1 });
    });

    it.each([
      ['missing', 'are no longer there'],
      ['not_owned', "are not marked as this goal run's"],
      ['not_a_directory', 'replaced its handoff directory with something else'],
    ] as const)(
      'a directory found %s pauses the run for a person, naming the step and attempt, without spending an attempt',
      async (state, says) => {
        const requester = await newPrincipal('member');
        const goalRunId = await startGoal(requester, STEPS);
        const aTask = await latestTask(goalRunId, 'a');
        supervisor.states.set(aTask.id, state);
        await finishStep(goalRunId, requester, 'a');
        if ((await goalRow(goalRunId))?.status === 'running')
          await advanceOnce(goalRunId, requester);
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'paused',
          pause_reason: 'needs_decision',
        });
        expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'ready', attempt_count: 0 });
        const detail = String((await lastPause(goalRunId))?.detail);
        expect(detail).toContain('step b: the files of step a (attempt 1)');
        expect(detail).toContain(says);
        supervisor.states.delete(aTask.id);
      },
    );

    // Review #493 on #884 (K1): a skipped step left no accepted files, even when the Worker of its
    // last attempt reported and that Task completed — those files are not mounted.
    it('a step reading the files of a skipped step pauses the run for a person, though that step’s last Task completed', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, STEPS);
      const aTask = await latestTask(goalRunId, 'a');
      await dispatchCapability({ pool }, await workerOf(aTask.id), 'report_task_result', {
        summary: 'step a done, but not accepted',
      });
      expect(await latestTask(goalRunId, 'a')).toMatchObject({ status: 'completed' });
      await raw(
        `update step_runs set status = 'skipped', ended_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, (await stepRun(goalRunId, 'a')).id],
      );
      const askedBefore = supervisor.asked.length;
      await advanceOnce(goalRunId, requester);
      if ((await goalRow(goalRunId))?.status === 'running') await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'ready', attempt_count: 0 });
      expect(String((await lastPause(goalRunId))?.detail)).toContain(
        'step b: the files of step a: step a was skipped, so it left no files to read',
      );
      expect(
        supervisor.asked
          .slice(askedBefore)
          .flat()
          .some((entry) => entry.taskId === aTask.id),
      ).toBe(false);
    });

    // Review #493 on #884 (K3): a revision that redefines the step read from gives it a new
    // StepRun; the files are the live one's, not the superseded one's.
    it('after a revision redefines the step it reads from, a step mounts the new step’s files', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, STEPS);
      const oldA = await latestTask(goalRunId, 'a');
      await dispatchCapability({ pool }, human(requester), 'pause_goal', { goalRunId });
      await dispatchCapability({ pool }, human(requester), 'revise_goal', {
        goalRunId,
        basedOnRevision: 1,
        plan: {
          steps: [
            { worker, key: 'a', input: { what: 'write the report again' } },
            ...STEPS.slice(1).map((step) => ({ worker, ...step })),
          ],
        },
        reason: 'a again, differently',
      });
      await dispatchCapability({ pool }, human(requester), 'resume_goal', { goalRunId });
      for (let i = 0; i < 3 && (await stepRun(goalRunId, 'a')).status !== 'running'; i++) {
        await advanceOnce(goalRunId, requester);
      }
      const newA = await latestTask(goalRunId, 'a');
      expect(newA.id).not.toBe(oldA.id);
      await finishStep(goalRunId, requester, 'a');
      if ((await stepRun(goalRunId, 'b')).status === 'ready')
        await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running', pause_reason: null });
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'running', attempt_count: 1 });
      expect(supervisor.spawnOf((await latestTask(goalRunId, 'b')).id).upstream).toEqual([
        { stepKey: 'a', taskId: newA.id },
      ]);
    });

    // Review #493 on #884 (K6): waiting for one step's upstream container holds that step only.
    it('while a step waits for an upstream container to exit, a step that reads no files starts as usual', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, [
        ...STEPS,
        { key: 'c', dependsOn: ['a'], input: { what: 'something else' } },
      ]);
      const aTask = await latestTask(goalRunId, 'a');
      supervisor.states.set(aTask.id, 'running');
      // The advancer goes through ready steps in creation order; b and c were made in one
      // transaction (ties broken by id), so b is put first: c must start after b is put off.
      await raw(
        `update step_runs set created_at = created_at - interval '1 second'
          where workspace_id = $1 and goal_run_id = $2 and step_key = 'b'`,
        [workspaceId, goalRunId],
      );
      await finishStep(goalRunId, requester, 'a');
      if ((await stepRun(goalRunId, 'c')).status === 'ready')
        await advanceOnce(goalRunId, requester);
      expect(await stepRun(goalRunId, 'c')).toMatchObject({ status: 'running', attempt_count: 1 });
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'ready', attempt_count: 0 });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running', pause_reason: null });

      supervisor.states.delete(aTask.id);
      await advanceOnce(goalRunId, requester);
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'running', attempt_count: 1 });
    });

    it('a step that reads files cannot start where the supervisor cannot be asked: the advance fails and is tried again', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, STEPS);
      const aTask = await latestTask(goalRunId, 'a');
      await dispatchCapability({ pool }, await workerOf(aTask.id), 'report_task_result', {
        summary: 'step a done',
      });
      const noKeep: TaskSupervisorClientPort = {
        spawn: (input) => supervisor.spawn(input),
        terminate: (id) => supervisor.terminate(id),
        status: (id) => supervisor.status(id),
      };
      // The advance that ends a would start b: it throws, and nothing of it is kept.
      await expect(advanceOnce(goalRunId, requester, noKeep)).rejects.toThrow(
        'cannot be asked whether they are there',
      );
      await parkGoal(goalRunId);
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ attempt_count: 0 });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running', pause_reason: null });
      // With the supervisor back, the same advance goes through.
      await advanceOnce(goalRunId, requester);
      expect(await stepRun(goalRunId, 'a')).toMatchObject({ status: 'succeeded' });
      expect(await stepRun(goalRunId, 'b')).toMatchObject({ status: 'running', attempt_count: 1 });
    });

    it('the lease renews in batches and reports what it found; a run that ended is no longer listed', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, [
        { key: 'a' },
        { key: 'c' },
        { key: 'b', dependsOn: ['a', 'c'], filesFrom: ['a', 'c'] },
      ]);
      const aTask = await finishStep(goalRunId, requester, 'a');
      const cTask = await finishStep(goalRunId, requester, 'c');
      const mine = (await listGoalFilesToKeep(pool)).filter(
        (entry) => entry.goalRunId === goalRunId,
      );
      expect(mine.map((entry) => entry.taskId).sort()).toEqual([aTask, cTask].sort());

      supervisor.states.set(cTask, 'not_owned');
      const askedBefore = supervisor.asked.length;
      const result = await runGoalFilesKeepTick(
        { pool, supervisorClient: supervisor },
        { batch: 1 },
      );
      const batches = supervisor.asked.slice(askedBefore);
      expect(batches.every((batch) => batch.length === 1)).toBe(true);
      expect(batches.flat()).toEqual(expect.arrayContaining(mine));
      expect(result.notOwned).toContain(cTask);
      expect(result.byState.not_owned ?? 0).toBeGreaterThanOrEqual(1);
      supervisor.states.delete(cTask);

      await raw(
        `update goal_runs set status = 'cancelled', ended_at = now(), next_tick_at = null
          where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId],
      );
      expect(
        (await listGoalFilesToKeep(pool)).filter((entry) => entry.goalRunId === goalRunId),
      ).toEqual([]);
    });
  },
);
