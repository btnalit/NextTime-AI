import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims, Role } from '@nexttime/shared';
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
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO5d-1 (plan §4.5,
 * §4.7; legacy 358), through the capability gateway as a Worker and the console call it, with the
 * advances driven by hand: `report_task_result` holding a goal step's output to the step's
 * `outputSchema` (400 naming each place; the refusal recorded on the Task and audited after the
 * call rolled back), the one automatic rework of an attempt that never reported an accepted
 * output (the next attempt told what was refused), the input a later step's bindings take from
 * the output the step before reported — or the pause, naming the binding, when the value is not
 * there or the credential review counts it — and what `get_task` / `get_goal` show of all that.
 * The task/0008 constraints close the file.
 *
 * Every run this file moves is left with no `next_tick_at`, so no advancer of another file claims
 * it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 };
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    hosts: { type: 'array', items: { type: 'string' }, minItems: 1 },
    zone: { type: 'string' },
    word: { type: 'string' },
  },
  required: ['hosts'],
  additionalProperties: false,
};

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.23',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.23' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    return this.statuses.delete(workerRunId);
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }
}

interface AttemptRow {
  id: string;
  status: string;
  step_attempt: number;
  failure_reason: string | null;
  input: unknown;
  result: Record<string, unknown> | null;
  output_schema: unknown;
  rejected_output: Record<string, unknown> | null;
  rework_of: Record<string, unknown> | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'goal step output contract, rework and bindings — S11 GO5d-1 (integration, real Postgres)',
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

    /** Proposed with `steps` (each given the file's Worker), confirmed through the gateway, and
     *  advanced once — its first steps started. */
    async function startGoal(requesterId: string, steps: readonly Record<string, unknown>[]) {
      const created = await as(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'hand values from one step to the next',
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

    async function advanceOnce(goalRunId: string, requesterId: string) {
      await advanceGoalRun(
        {
          pool,
          taskRuntime: { pool, privateKey, supervisorClient: supervisor },
          options: { retryBackoffMs: () => 60 * 60 * 1000 },
        },
        { workspaceId, goalRunId, requesterId },
      );
      await parkGoal(goalRunId);
    }

    async function stepRun(goalRunId: string, key: string) {
      const [row] = await raw<{
        id: string;
        status: string;
        failure_category: string | null;
        attempt_count: number;
      }>(
        `select id, status, failure_category, attempt_count from step_runs
          where workspace_id = $1 and goal_run_id = $2 and step_key = $3
            and status <> 'superseded'`,
        [workspaceId, goalRunId, key],
      );
      if (!row) throw new Error(`no step ${key}`);
      return row;
    }

    const attempts = (stepRunId: string) =>
      raw<AttemptRow>(
        `select id, status, step_attempt, failure_reason, input, result, output_schema,
                rejected_output, rework_of
           from tasks where workspace_id = $1 and step_run_id = $2 order by step_attempt`,
        [workspaceId, stepRunId],
      );

    async function latest(goalRunId: string, key: string): Promise<AttemptRow> {
      const rows = await attempts((await stepRun(goalRunId, key)).id);
      const row = rows.at(-1);
      if (!row) throw new Error(`step ${key} has no attempt`);
      return row;
    }

    const goalRow = async (goalRunId: string) =>
      (
        await raw<{ status: string; pause_reason: string | null }>(
          'select status, pause_reason from goal_runs where workspace_id = $1 and id = $2',
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

    /** The attempt Task's own Worker, as its Handle calls the gateway. */
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

    const report = async (taskId: string, contract: Record<string, unknown>) =>
      dispatchCapability({ pool }, await workerOf(taskId), 'report_task_result', contract);

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
            'go5d-output-contract',
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

    it('report_task_result holds the output to the step’s schema: each place named (400), the refusal recorded and audited, nothing else written; then a fixed output completes the step', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, [{ key: 'scan', outputSchema: SCAN_SCHEMA }]);
      const task = await latest(goalRunId, 'scan');
      expect(task).toMatchObject({
        status: 'running',
        output_schema: SCAN_SCHEMA,
        rework_of: null,
      });

      // No output at all.
      expect(await refusal(report(task.id, { summary: 'scanned' }))).toMatchObject({
        status: 400,
        code: 'invalid_params',
        details: { problemCount: 1, problems: [{ path: 'output' }] },
      });
      // An output that breaks the schema: every place, no value.
      const refused = await refusal(
        report(task.id, { summary: 'scanned', output: { hostz: ['h1'], zone: 7 } }),
      );
      expect(refused).toEqual({
        status: 400,
        code: 'invalid_params',
        message: expect.stringContaining('output.hosts: required, missing'),
        details: {
          problemCount: 3,
          problems: [
            { path: 'output.hosts', message: 'required, missing' },
            {
              path: 'output.hostz',
              message: 'not declared by the schema (additionalProperties is false)',
            },
            { path: 'output.zone', message: 'expected string, got integer' },
          ],
        },
      });
      expect(refused.message).toContain('Fix the output and report the result again.');

      const after = await latest(goalRunId, 'scan');
      expect(after).toMatchObject({ status: 'running', result: null });
      expect(after.rejected_output).toEqual({
        output: { hostz: ['h1'], zone: 7 },
        problems: [
          { path: 'output.hosts', message: 'required, missing' },
          {
            path: 'output.hostz',
            message: 'not declared by the schema (additionalProperties is false)',
          },
          { path: 'output.zone', message: 'expected string, got integer' },
        ],
        problemCount: 3,
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      const audited = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and resource_id = $2 and action = 'report_task_result'
          order by created_at, id`,
        [workspaceId, task.id],
      );
      expect(audited.map((row) => row.payload.refusal)).toEqual([
        expect.objectContaining({ code: 'output_contract', status: 400, problemCount: 1 }),
        expect.objectContaining({ code: 'output_contract', status: 400, problemCount: 3 }),
      ]);

      // What the console reads of the Task meanwhile.
      const shown = (await dispatchCapability({ pool }, human(requester), 'get_task', {
        taskId: task.id,
      })) as Record<string, unknown>;
      expect(shown).toMatchObject({
        outputSchema: SCAN_SCHEMA,
        rejectedOutput: { problemCount: 3, output: { hostz: ['h1'], zone: 7 } },
        reworkOf: null,
      });

      // Fixed: accepted, the output kept with the result.
      await report(task.id, { summary: 'scanned', output: { hosts: ['h1', 'h2'], zone: 'lab' } });
      expect((await latest(goalRunId, 'scan')).result).toMatchObject({
        output: { hosts: ['h1', 'h2'], zone: 'lab' },
      });
      await advanceOnce(goalRunId, requester);
      expect(await stepRun(goalRunId, 'scan')).toMatchObject({ status: 'succeeded' });
      const goal = (await dispatchCapability({ pool }, human(requester), 'get_goal', {
        goalRunId,
      })) as { steps: Array<Record<string, unknown>> };
      expect(goal.steps[0]).toMatchObject({
        output: { hosts: ['h1', 'h2'], zone: 'lab' },
        attempts: [
          expect.objectContaining({
            rework: false,
            outputProblemCount: 3,
            outputProblems: expect.arrayContaining([
              { path: 'output.hosts', message: 'required, missing' },
            ]),
          }),
        ],
      });
    });

    it('a report on a step without an output schema takes an output as it is', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, [{ key: 'free' }]);
      const task = await latest(goalRunId, 'free');
      expect(task.output_schema).toBeNull();
      await report(task.id, { summary: 'done', output: { anything: [1, 'two'] } });
      expect((await latest(goalRunId, 'free')).result).toMatchObject({
        output: { anything: [1, 'two'] },
      });
    });

    it('legacy 358: an attempt that never reports an accepted output is reworked once — the Worker told what was refused — and the second needs a person', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, [{ key: 'scan', outputSchema: SCAN_SCHEMA }]);
      const first = await latest(goalRunId, 'scan');
      await refusal(report(first.id, { summary: 'scanned', output: { hosts: [] } }));
      // The Worker ends without an accepted result: the reaper fails its Task `no_result`.
      await failTaskAndReapWorkerRuns(
        { pool, privateKey, supervisorClient: supervisor },
        workspaceId,
        requester,
        first.id,
        'no_result',
      );
      await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'running' });
      const second = await latest(goalRunId, 'scan');
      expect(second).toMatchObject({ step_attempt: 2, status: 'running' });
      expect(second.rework_of).toEqual({
        taskId: first.id,
        attempt: 1,
        rejectedOutput: {
          output: { hosts: [] },
          problems: [{ path: 'output.hosts', message: 'fewer than 1 items' }],
          problemCount: 1,
          at: expect.any(String),
        },
      });
      const shown = (await dispatchCapability({ pool }, await workerOf(second.id), 'get_task', {
        taskId: second.id,
      })) as Record<string, unknown>;
      expect(shown.reworkOf).toMatchObject({
        taskId: first.id,
        attempt: 1,
        rejectedOutput: { problems: [{ path: 'output.hosts', message: 'fewer than 1 items' }] },
      });
      const goal = (await dispatchCapability({ pool }, human(requester), 'get_goal', {
        goalRunId,
      })) as { steps: Array<{ attempts: Array<Record<string, unknown>> }> };
      expect(goal.steps[0]?.attempts).toEqual([
        expect.objectContaining({
          attempt: 1,
          failureReason: 'no_result',
          rework: false,
          outputProblemCount: 1,
        }),
        expect.objectContaining({ attempt: 2, rework: true, outputProblems: null }),
      ]);

      await failTaskAndReapWorkerRuns(
        { pool, privateKey, supervisorClient: supervisor },
        workspaceId,
        requester,
        second.id,
        'no_result',
      );
      await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toEqual({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      expect(await stepRun(goalRunId, 'scan')).toMatchObject({
        status: 'failed',
        failure_category: 'contract_violation',
        attempt_count: 2,
      });
    });

    it('bindings: the next step starts with its written input and the values it takes from the output the step before reported', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, [
        { key: 'scan', outputSchema: SCAN_SCHEMA },
        {
          key: 'apply',
          dependsOn: ['scan'],
          input: { mode: 'safe', target: { region: 'eu' } },
          bindings: [
            { to: 'host', from: 'scan', path: 'hosts[1]' },
            { to: 'target.zone', from: 'scan', path: 'zone' },
            { to: 'count', from: 'scan', path: 'length(hosts)' },
          ],
        },
      ]);
      await report((await latest(goalRunId, 'scan')).id, {
        summary: 'scanned',
        output: { hosts: ['h1', 'h2'], zone: 'lab' },
      });
      await advanceOnce(goalRunId, requester);
      const apply = await latest(goalRunId, 'apply');
      expect(apply.input).toEqual({
        mode: 'safe',
        target: { region: 'eu', zone: 'lab' },
        host: 'h2',
        count: 2,
      });
      const started = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and resource_id = $2 and action = 'step_run.start'`,
        [workspaceId, (await stepRun(goalRunId, 'apply')).id],
      );
      expect(started[0]?.payload).toMatchObject({ bound: 3 });
    });

    it('bindings: a value that is not there, or one the credential review counts, pauses the run naming the binding — never the value — and starts nothing', async () => {
      const requester = await newPrincipal('member');
      const plan = (bindings: readonly Record<string, unknown>[]) => [
        { key: 'scan', outputSchema: SCAN_SCHEMA },
        { key: 'apply', dependsOn: ['scan'], bindings },
      ];
      const cases = [
        {
          bindings: [{ to: 'target.zone', from: 'scan', path: 'zone' }],
          output: { hosts: ['h1'] },
          detail:
            'step apply: bindings[0] (input.target.zone from step scan, zone): selects nothing of the output of step scan — revise the plan or cancel',
        },
        {
          // A plain word, a credential only where it would sit: under a field named for one.
          bindings: [{ to: 'password', from: 'scan', path: 'word' }],
          output: { hosts: ['h1'], word: 'plain-word-1' },
          detail: expect.stringMatching(
            /^step apply: bindings\[0\] \(input\.password from step scan, word\): the value looks like a credential \(1 suspected\) — a step's input does not carry credentials; revise the plan or cancel$/,
          ),
        },
        {
          // Redacted when the step reported it.
          bindings: [{ to: 'note', from: 'scan', path: 'word' }],
          output: { hosts: ['h1'], word: `sk-ant-${FAKE}` },
          detail:
            "step apply: bindings[0] (input.note from step scan, word): the value was redacted as a suspected credential when step scan reported it — a step's input does not carry credentials; revise the plan or cancel",
        },
      ];
      for (const { bindings, output, detail } of cases) {
        const goalRunId = await startGoal(requester, plan(bindings));
        await report((await latest(goalRunId, 'scan')).id, { summary: 'scanned', output });
        await advanceOnce(goalRunId, requester);
        expect(await goalRow(goalRunId)).toEqual({
          status: 'paused',
          pause_reason: 'needs_decision',
        });
        const pause = await lastPause(goalRunId);
        expect(pause).toMatchObject({ detail });
        expect(JSON.stringify(pause)).not.toContain('plain-word-1');
        expect(JSON.stringify(pause)).not.toContain(FAKE);
        expect(await stepRun(goalRunId, 'apply')).toMatchObject({
          status: 'ready',
          attempt_count: 0,
        });
        expect(await attempts((await stepRun(goalRunId, 'apply')).id)).toEqual([]);
      }
    });

    it('task/0008: an attempt’s output schema and what it redoes never change; a refusal needs a schema; only a later attempt redoes one', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, [
        { key: 'scan', outputSchema: SCAN_SCHEMA },
        { key: 'free' },
      ]);
      const scan = await latest(goalRunId, 'scan');
      const free = await latest(goalRunId, 'free');
      await expect(
        admin((client) =>
          client.query(
            `update tasks set output_schema = '{"type":"object"}' where workspace_id = $1 and id = $2`,
            [workspaceId, scan.id],
          ),
        ),
      ).rejects.toThrow(/never change/);
      await expect(
        admin((client) =>
          client.query(
            `update tasks set rework_of = '{"taskId":"x","attempt":1}' where workspace_id = $1 and id = $2`,
            [workspaceId, scan.id],
          ),
        ),
      ).rejects.toThrow(/never change/);
      // With the trigger off, the CHECKs still hold.
      await expect(
        raw(
          `update tasks set rejected_output = '{"problems":[]}' where workspace_id = $1 and id = $2`,
          [workspaceId, free.id],
        ),
      ).rejects.toThrow(/tasks_rejected_output/);
      await expect(
        raw(
          `update tasks set rework_of = '{"taskId":"x","attempt":0}' where workspace_id = $1 and id = $2`,
          [workspaceId, scan.id],
        ),
      ).rejects.toThrow(/tasks_rework_of/);
      await expect(
        raw(`update tasks set output_schema = '[]' where workspace_id = $1 and id = $2`, [
          workspaceId,
          free.id,
        ]),
      ).rejects.toThrow(/tasks_output_schema/);
    });
  },
);
