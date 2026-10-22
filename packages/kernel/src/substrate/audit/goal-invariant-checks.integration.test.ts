import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  DEFAULT_GOAL_BUDGET_GRACE_MS,
  type GoalInvariantCheckResult,
  checkIG1,
  checkIG2,
  checkIG5,
  checkIG6,
  checkIG9,
} from './goal-invariant-checks.js';
import { renderInvariantMetricsPrometheus, runInvariantChecks } from './invariant-checks.js';

/**
 * substrate/audit/goal-invariant-checks.integration (S11 GO1): each scheduled check counts the
 * breach it is for. Every breach is fabricated with the database's own guards off
 * (`session_replication_role = replica`: no triggers, no foreign keys — the CHECKs still hold),
 * which is the point: these checks are for what got past the write path. A healthy row next to
 * each breach is not counted. The database is shared with every other integration file, so each
 * assertion is about this file's own rows (a sample large enough to hold all of them), never a
 * global zero — same reasoning as `invariant-checks.integration.test.ts`.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const ALL = 100_000;
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

describe.runIf(DATABASE_URL !== undefined)(
  'substrate/audit/goal-invariant-checks (S11 GO1, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    /** A write with the guards off, as a bug or a hand edit would make it. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          return (await client.query(sql, [...params])).rows as T[];
        },
        { skipRoleSwitch: true },
      );

    async function check(
      run: (client: PoolClient) => Promise<GoalInvariantCheckResult>,
    ): Promise<GoalInvariantCheckResult> {
      const client = await pool.connect();
      try {
        return await run(client);
      } finally {
        client.release();
      }
    }

    /** A check run in a transaction that is rolled back — for a breach no other file may see. */
    async function checkRolledBack(
      breach: string,
      run: (client: PoolClient) => Promise<GoalInvariantCheckResult>,
    ): Promise<GoalInvariantCheckResult> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(breach);
        return await run(client);
      } finally {
        await client.query('rollback');
        client.release();
      }
    }

    const flagged = (result: GoalInvariantCheckResult, label: string, id: string) =>
      result.sample.some((line) => line.startsWith(`${label} ${workspaceId}:${id} (`));
    const mentioned = (result: GoalInvariantCheckResult, id: string) =>
      result.sample.some((line) => line.includes(`${workspaceId}:${id} (`));

    interface GoalFields {
      readonly status?: string;
      readonly currentRevision?: number;
      readonly confirmedAgo?: number;
      readonly updatedAgo?: number;
      readonly maxTokens?: number;
      readonly maxSteps?: number;
      readonly maxRevisions?: number;
      readonly maxWallClockSeconds?: number;
      readonly outcome?: 'achieved' | 'not_achieved';
      readonly outcomeBasis?: 'verified_by_check' | 'requester';
    }

    async function goal(fields: GoalFields = {}): Promise<string> {
      const status = fields.status ?? 'running';
      const ended = ['completed', 'cancelled', 'failed'].includes(status);
      const rows = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, on_behalf_of, statement, current_revision,
           confirmed_at, ended_at, updated_at, budget_max_tokens, budget_max_steps,
           budget_max_revisions, budget_max_wall_clock_seconds, outcome, outcome_basis)
         values ($1, $2, $3, 'a goal', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [
          workspaceId,
          status,
          ownerId,
          fields.currentRevision ?? 1,
          ago(fields.confirmedAgo ?? 60),
          ended ? new Date() : null,
          ago(fields.updatedAgo ?? 0),
          fields.maxTokens ?? 1_000_000,
          fields.maxSteps ?? 100,
          fields.maxRevisions ?? 10,
          fields.maxWallClockSeconds ?? 86_400,
          status === 'completed' ? (fields.outcome ?? 'achieved') : null,
          status === 'completed' ? (fields.outcomeBasis ?? 'requester') : null,
        ],
      );
      return rows[0]?.id as string;
    }

    async function revision(
      goalRunId: string,
      revisionNumber: number,
      steps: readonly (string | Record<string, unknown>)[],
      status = 'accepted',
      basedOn: number | null = revisionNumber === 1 ? null : revisionNumber - 1,
    ): Promise<string> {
      const plan = {
        steps: steps.map((step) => (typeof step === 'string' ? { key: step } : step)),
      };
      const rows = await raw<{ id: string }>(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, based_on_revision, status,
           plan, proposed_by, decided_by, decided_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) returning id`,
        [
          workspaceId,
          goalRunId,
          revisionNumber,
          basedOn,
          status,
          JSON.stringify(plan),
          ownerId,
          status === 'proposed' ? null : ownerId,
          status === 'proposed' ? null : new Date(),
        ],
      );
      return rows[0]?.id as string;
    }

    interface StepFields {
      readonly introducedIn?: number;
      readonly status?: string;
      readonly attemptCount?: number;
      readonly supersededIn?: number;
      readonly endedAgo?: number;
    }

    async function step(goalRunId: string, key: string, fields: StepFields = {}): Promise<string> {
      const status = fields.status ?? 'running';
      const ended = ['succeeded', 'superseded', 'cancelled', 'skipped'].includes(status);
      const rows = await raw<{ id: string }>(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision,
           superseded_in_revision, status, waiting_reason, failure_category, attempt_count, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [
          workspaceId,
          goalRunId,
          key,
          fields.introducedIn ?? 1,
          status === 'superseded' ? (fields.supersededIn ?? 2) : null,
          status,
          status === 'waiting' ? 'approval' : null,
          status === 'failed' ? 'transient' : null,
          fields.attemptCount ?? 0,
          ended ? ago(fields.endedAgo ?? 60) : null,
        ],
      );
      return rows[0]?.id as string;
    }

    interface TaskFields {
      readonly planRevision?: number;
      readonly attempt?: number | null;
      readonly status?: string;
      readonly tokens?: number;
      readonly endedAgo?: number;
    }

    async function task(
      goalRunId: string,
      stepRunId: string,
      fields: TaskFields = {},
    ): Promise<string> {
      const status = fields.status ?? 'completed';
      const endedAt = ['completed', 'failed', 'cancelled'].includes(status)
        ? ago(fields.endedAgo ?? 3600)
        : null;
      const attempt = fields.attempt ?? null;
      const rows = await raw<{ id: string }>(
        `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, goal_run_id, step_run_id, plan_revision, step_attempt,
           run_config_snapshot, tokens_used, completed_at, failed_at, cancelled_at)
         values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13) returning id`,
        [
          workspaceId,
          status,
          ownerId,
          randomUUID(),
          goalRunId,
          stepRunId,
          fields.planRevision ?? 1,
          attempt,
          attempt === null ? null : JSON.stringify({ definition: { version: 1 } }),
          fields.tokens ?? 0,
          status === 'completed' ? endedAt : null,
          status === 'failed' ? endedAt : null,
          status === 'cancelled' ? endedAt : null,
        ],
      );
      return rows[0]?.id as string;
    }

    interface RequestFields {
      readonly status: 'pending_approval' | 'auto_approved' | 'executed' | 'denied' | 'withdrawn';
      readonly stepRunId: string | null;
      readonly requestedAgo?: number;
      readonly executingAgo?: number;
      /** The WorkerRun that raised it. Default: for a request of a step, a WorkerRun of a Task of
       *  that step (as `request_action` records it); none for a request outside a goal. */
      readonly workerRunId?: string | null;
    }

    async function request(fields: RequestFields): Promise<string> {
      let workerRunId = fields.workerRunId ?? null;
      if (fields.workerRunId === undefined && fields.stepRunId !== null) {
        const owner = await raw<{ goal_run_id: string }>(
          'select goal_run_id from step_runs where workspace_id = $1 and id = $2',
          [workspaceId, fields.stepRunId],
        );
        const goalRunId = owner[0]?.goal_run_id as string;
        workerRunId = await workerRun(await task(goalRunId, fields.stepRunId, { attempt: null }));
      }
      const policy =
        fields.status === 'pending_approval'
          ? 'require_approval'
          : fields.status === 'denied'
            ? 'deny'
            : 'allow';
      const rows = await raw<{ id: string }>(
        `insert into action_requests (workspace_id, status, gatekeeper_id, action_kind, blast_radius,
           policy_decision, await_decision, on_behalf_of, actor_runtime, requested_at, executing_at,
           step_run_id, parent_worker_run_id)
         values ($1, $2, $3, 'test.go1.check', 'low', $4, false, $5, 'pi', $6, $7, $8, $9)
         returning id`,
        [
          workspaceId,
          fields.status,
          randomUUID(),
          policy,
          ownerId,
          ago(fields.requestedAgo ?? 1200),
          fields.executingAgo === undefined ? null : ago(fields.executingAgo),
          fields.stepRunId,
          workerRunId,
        ],
      );
      return rows[0]?.id as string;
    }

    /** A Decision of `decidedBy` (default: the owner, who is every fixture goal's requester). */
    async function decision(
      rationale: Record<string, unknown>,
      fields: { readonly decidedBy?: string; readonly status?: string } = {},
    ): Promise<string> {
      const rows = await raw<{ id: string }>(
        `insert into decisions (workspace_id, status, activity_id, rationale, decided_by, decided_at)
         values ($1, $2, $3, $4::jsonb, $5, now()) returning id`,
        [
          workspaceId,
          fields.status ?? 'approved',
          randomUUID(),
          JSON.stringify(rationale),
          fields.decidedBy ?? ownerId,
        ],
      );
      return rows[0]?.id as string;
    }

    /** The Observation an attempt of an acceptance check records. */
    async function checkObservation(
      goalRunId: string,
      round: number,
      checkKey: string,
      outcome = 'satisfied',
    ): Promise<string> {
      const rows = await raw<{ id: string }>(
        `insert into observations (workspace_id, source_id, activity_id, content)
         values ($1, $2, $3, $4::jsonb) returning id`,
        [
          workspaceId,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ purpose: 'acceptance_check', goalRunId, round, checkKey, outcome }),
        ],
      );
      return rows[0]?.id as string;
    }

    interface AcceptanceFields {
      readonly round?: number;
      readonly kind?: 'observe_predicate' | 'requester_confirm';
      readonly status?: 'pending' | 'passed' | 'failed';
      readonly planRevision?: number;
      readonly observationId?: string;
      readonly decisionId?: string;
    }

    /** An acceptance check of a round (S11 GO4a). Settled, it rests by default on its own
     *  evidence: an observation on an Observation of it that satisfied its predicate (or, failed,
     *  did not), a passed confirmation on the requester's Decision for it. */
    async function acceptance(
      goalRunId: string,
      key: string,
      fields: AcceptanceFields = {},
    ): Promise<void> {
      const kind = fields.kind ?? 'observe_predicate';
      const status = fields.status ?? 'passed';
      const round = fields.round ?? 1;
      const tried = kind === 'observe_predicate' && status !== 'pending';
      const observationId = tried
        ? (fields.observationId ??
          (await checkObservation(
            goalRunId,
            round,
            key,
            status === 'passed' ? 'satisfied' : 'unsatisfied',
          )))
        : null;
      const decisionId =
        kind === 'requester_confirm' && status === 'passed'
          ? (fields.decisionId ??
            (await decision({
              decision: 'goal_outcome',
              outcome: 'achieved',
              goalRunId,
              round,
              checkKey: key,
            })))
          : null;
      await raw(
        `insert into goal_acceptance_checks (workspace_id, goal_run_id, round, check_key,
           plan_revision, kind, observation_check, prompt, status, attempts, first_attempt_at,
           observation_id, decision_id, settled_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
        [
          workspaceId,
          goalRunId,
          round,
          key,
          fields.planRevision ?? 1,
          kind,
          kind === 'observe_predicate' ? JSON.stringify({ operation: 'svc.status' }) : null,
          kind === 'observe_predicate' ? null : 'Is it done?',
          status,
          tried ? 1 : 0,
          tried ? new Date() : null,
          observationId,
          decisionId,
          status === 'pending' ? null : new Date(),
        ],
      );
    }

    const setOutcomeDecision = (goalRunId: string, decisionId: string) =>
      raw('update goal_runs set outcome_decision_id = $3 where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
        decisionId,
      ]);

    async function workerRun(taskId: string): Promise<string> {
      const rows = await raw<{ id: string }>(
        `insert into worker_runs (workspace_id, status, task_id) values ($1, 'running', $2)
         returning id`,
        [workspaceId, taskId],
      );
      return rows[0]?.id as string;
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
            'go1-goal-invariant-checks',
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

    describe('I-G1: each attempt of a StepRun is at most one Task', () => {
      it('counts attempts that do not number 1..attempt_count, and two unfinished attempts at once', async () => {
        const goalRunId = await goal();
        await revision(goalRunId, 1, ['ok', 'short', 'gap', 'both']);
        const ok = await step(goalRunId, 'ok', { attemptCount: 2 });
        await task(goalRunId, ok, { attempt: 1, status: 'failed' });
        await task(goalRunId, ok, { attempt: 2, status: 'running' });
        await task(goalRunId, ok, { status: 'running' }); // a nested child Task: no attempt
        const short = await step(goalRunId, 'short', { attemptCount: 2 });
        await task(goalRunId, short, { attempt: 1, status: 'failed' });
        const gap = await step(goalRunId, 'gap', { attemptCount: 2 });
        await task(goalRunId, gap, { attempt: 1, status: 'failed' });
        await task(goalRunId, gap, { attempt: 3, status: 'failed' });
        const both = await step(goalRunId, 'both', { attemptCount: 2 });
        await task(goalRunId, both, { attempt: 1, status: 'running' });
        await task(goalRunId, both, { attempt: 2, status: 'queued' });

        const result = await check((client) => checkIG1(client, ALL));
        expect(result.invariant).toBe('I-G1');
        expect(mentioned(result, ok)).toBe(false);
        expect(flagged(result, 'attempts', short)).toBe(true);
        expect(flagged(result, 'attempts', gap)).toBe(true);
        expect(flagged(result, 'concurrent', both)).toBe(true);
        expect(flagged(result, 'attempts', both)).toBe(false);
      });

      it('counts an attempt Task carried by more than one WorkerRun (S11 GO2)', async () => {
        const goalRunId = await goal();
        await revision(goalRunId, 1, ['one-run', 'two-runs']);
        const oneRunStep = await step(goalRunId, 'one-run', { attemptCount: 1 });
        const oneRun = await task(goalRunId, oneRunStep, { attempt: 1, status: 'running' });
        await workerRun(oneRun);
        const twoRunsStep = await step(goalRunId, 'two-runs', { attemptCount: 1 });
        const twoRuns = await task(goalRunId, twoRunsStep, { attempt: 1, status: 'running' });
        await workerRun(twoRuns);
        await workerRun(twoRuns);
        // A nested child Task (no attempt number) keeps Task-internal retry: not counted.
        const child = await task(goalRunId, oneRunStep, { attempt: null, status: 'running' });
        await workerRun(child);
        await workerRun(child);

        const result = await check((client) => checkIG1(client, ALL));
        expect(flagged(result, 'runs', twoRuns)).toBe(true);
        expect(mentioned(result, oneRun)).toBe(false);
        expect(mentioned(result, child)).toBe(false);
      });

      it('counts the unique index going missing', async () => {
        const result = await checkRolledBack('drop index tasks_step_attempt_uidx', (client) =>
          checkIG1(client, ALL),
        );
        expect(
          result.sample.some((line) => line.startsWith('index tasks:tasks_step_attempt_uidx')),
        ).toBe(true);
        const intact = await check((client) => checkIG1(client, ALL));
        expect(intact.sample.some((line) => line.startsWith('index '))).toBe(false);
      });
    });

    describe('I-G2: only steps of the current plan revision advance', () => {
      it('counts a step dropped or redefined without being superseded, and a finished one redefined', async () => {
        const goalRunId = await goal({ currentRevision: 2 });
        await revision(goalRunId, 1, ['same', 'redefined', 'dropped', 'done']);
        await revision(goalRunId, 2, [
          'same',
          { key: 'redefined', note: 'v2' },
          { key: 'done', note: 'v2' },
        ]);
        const same = await step(goalRunId, 'same');
        const redefined = await step(goalRunId, 'redefined');
        const dropped = await step(goalRunId, 'dropped', { status: 'pending' });
        const done = await step(goalRunId, 'done', { status: 'succeeded' });

        const result = await check((client) => checkIG2(client, ALL));
        expect(result.invariant).toBe('I-G2');
        expect(mentioned(result, same)).toBe(false);
        expect(flagged(result, 'unfinished-not-in-plan', redefined)).toBe(true);
        expect(flagged(result, 'unfinished-not-in-plan', dropped)).toBe(true);
        expect(flagged(result, 'finished-redefined', done)).toBe(true);
      });

      it('counts a planned step with no live StepRun while the goal runs, not once it has ended', async () => {
        const running = await goal();
        await revision(running, 1, ['missing']);
        const ended = await goal({ status: 'failed' });
        await revision(ended, 1, ['missing']);

        const result = await check((client) => checkIG2(client, ALL));
        expect(flagged(result, 'planned-without-step', running)).toBe(true);
        expect(mentioned(result, ended)).toBe(false);
      });

      it('counts an attempt started outside its step’s live window, and an accepted revision past the current one', async () => {
        const goalRunId = await goal({ currentRevision: 2 });
        await revision(goalRunId, 1, ['x']);
        await revision(goalRunId, 2, ['x', 'y']);
        const ahead = await revision(goalRunId, 3, ['x', 'y', 'z']);
        const x = await step(goalRunId, 'x', { attemptCount: 1 });
        const y = await step(goalRunId, 'y', { introducedIn: 2, attemptCount: 1 });
        const inWindow = await task(goalRunId, x, { attempt: 1, planRevision: 2 });
        const before = await task(goalRunId, y, { attempt: 1, planRevision: 1 });

        const result = await check((client) => checkIG2(client, ALL));
        expect(mentioned(result, inWindow)).toBe(false);
        expect(flagged(result, 'task-outside-window', before)).toBe(true);
        expect(flagged(result, 'accepted-off-chain', ahead)).toBe(true);
      });

      it('counts an accepted revision the chain skips, and a revision in force that is not accepted (I-G3: the accepted revisions are one chain)', async () => {
        const forked = await goal({ currentRevision: 3 });
        await revision(forked, 1, ['x']);
        const skipped = await revision(forked, 2, ['x', 'y']);
        await revision(forked, 3, ['x', 'z'], 'accepted', 1);
        const unaccepted = await goal({ currentRevision: 2 });
        await revision(unaccepted, 1, ['x']);
        await revision(unaccepted, 2, ['x', 'y'], 'proposed');
        const healthy = await goal({ status: 'completed', currentRevision: 2 });
        const healthyRevisions = [
          await revision(healthy, 1, ['x']),
          await revision(healthy, 2, ['x', 'y']),
          await revision(healthy, 3, ['x', 'w'], 'rejected', 2),
          await revision(healthy, 4, ['w'], 'rejected', 1),
        ];

        const result = await check((client) => checkIG2(client, ALL));
        expect(flagged(result, 'accepted-off-chain', skipped)).toBe(true);
        expect(flagged(result, 'chain-not-accepted', unaccepted)).toBe(true);
        for (const id of [healthy, ...healthyRevisions]) expect(mentioned(result, id)).toBe(false);
      });

      it.each([
        ['goal_runs', 'goal_runs_status_guard'],
        ['plan_revisions', 'plan_revisions_guard'],
        ['plan_revisions', 'plan_revisions_adopted'],
        ['step_runs', 'step_runs_status_guard'],
        ['tasks', 'tasks_goal_step_immutable'],
      ])(
        'counts the guard %s.%s disabled, or switched to fire only under replica',
        async (table, trigger) => {
          for (const breach of [
            `alter table ${table} disable trigger ${trigger}`,
            `alter table ${table} enable replica trigger ${trigger}`,
          ]) {
            const result = await checkRolledBack(breach, (client) => checkIG2(client, ALL));
            expect(
              result.sample.some((line) => line.startsWith(`guards ${table}:${trigger} (`)),
              breach,
            ).toBe(true);
          }
          const intact = await check((client) => checkIG2(client, ALL));
          expect(intact.sample.some((line) => line.startsWith('guards '))).toBe(false);
        },
      );
    });

    describe('I-G5: a GoalRun’s outcome rests on its verification or on its requester’s word (S11 GO4a)', () => {
      it('counts a run achieved by check whose latest round did not pass whole on the current plan, with an observation the platform made', async () => {
        const byCheck = (fields: GoalFields = {}) =>
          goal({ status: 'completed', outcomeBasis: 'verified_by_check', ...fields });
        const healthy = await byCheck();
        await acceptance(healthy, 'up');
        await acceptance(healthy, 'report', { kind: 'requester_confirm' });
        // An earlier round that did not pass does not count: the latest decides.
        const retried = await byCheck();
        await acceptance(retried, 'up', { status: 'failed' });
        await acceptance(retried, 'up', { round: 2 });
        const noRound = await byCheck();
        const notPassed = await byCheck();
        await acceptance(notPassed, 'up');
        await acceptance(notPassed, 'up', { round: 2, status: 'failed' });
        await acceptance(notPassed, 'down', { round: 2 });
        const pending = await byCheck();
        await acceptance(pending, 'up');
        await acceptance(pending, 'down', { status: 'pending' });
        const offPlan = await byCheck({ currentRevision: 2 });
        await acceptance(offPlan, 'up', { planRevision: 1 });
        const confirmedOnly = await byCheck();
        await acceptance(confirmedOnly, 'report', { kind: 'requester_confirm' });
        const notAchieved = await byCheck({ outcome: 'not_achieved' });
        await acceptance(notAchieved, 'up');

        const result = await check((client) => checkIG5(client, ALL));
        expect(result.invariant).toBe('I-G5');
        expect(mentioned(result, healthy)).toBe(false);
        expect(mentioned(result, retried)).toBe(false);
        for (const [id, detail] of [
          [noRound, 'no acceptance round'],
          [notPassed, 'round 2: 1 not passed, 0 off the current plan, 2 observed by the platform'],
          [pending, 'round 1: 1 not passed, 0 off the current plan, 2 observed by the platform'],
          [offPlan, 'round 1: 0 not passed, 1 off the current plan, 1 observed by the platform'],
          [
            confirmedOnly,
            'round 1: 0 not passed, 0 off the current plan, 0 observed by the platform',
          ],
          [
            notAchieved,
            'outcome not_achieved, round 1: 0 not passed, 0 off the current plan, 1 observed by the platform',
          ],
        ] as const) {
          expect(result.sample, detail).toContain(
            `achieved-by-check ${workspaceId}:${id} (${detail})`,
          );
        }
      });

      it('counts an outcome on the requester’s word without their own approved Decision saying so', async () => {
        const onWord = async (
          rationale: Record<string, unknown> | null,
          fields: Parameters<typeof decision>[1] = {},
        ) => {
          const id = await goal({ status: 'completed', outcome: 'not_achieved' });
          if (rationale) {
            const decided = await decision(
              { decision: 'goal_outcome', goalRunId: id, outcome: 'not_achieved', ...rationale },
              fields,
            );
            await setOutcomeDecision(id, decided);
          }
          return id;
        };
        const healthy = await onWord({});
        const none = await onWord(null);
        const someoneElse = await onWord({}, { decidedBy: randomUUID() });
        const notApproved = await onWord({}, { status: 'proposed' });
        const otherOutcome = await onWord({ outcome: 'achieved' });
        const otherRun = await onWord({ goalRunId: randomUUID() });
        const otherDecision = await onWord({ decision: 'goal_revision' });

        const result = await check((client) => checkIG5(client, ALL));
        expect(mentioned(result, healthy)).toBe(false);
        for (const id of [none, someoneElse, notApproved, otherOutcome, otherRun, otherDecision]) {
          expect(flagged(result, 'requester-basis', id), id).toBe(true);
        }
        expect(
          result.sample.some(
            (line) =>
              line ===
              `requester-basis ${workspaceId}:${none} (not_achieved on the requester's word, decision none is not theirs saying so)`,
          ),
        ).toBe(true);
      });

      it('counts a passed check without its evidence: an Observation of that check that satisfied its predicate, or the requester’s own Decision for it', async () => {
        const verifying = () => goal({ status: 'verifying' });
        const healthy = await verifying();
        await acceptance(healthy, 'up');
        await acceptance(healthy, 'report', { kind: 'requester_confirm' });
        const cases: (readonly [string, string])[] = [];
        const breach = async (
          key: string,
          fields: (goalRunId: string) => Promise<AcceptanceFields>,
        ) => {
          const id = await verifying();
          await acceptance(id, key, await fields(id));
          cases.push([id, key]);
        };
        await breach('up', async (id) => ({
          observationId: await checkObservation(id, 1, 'other'),
        }));
        await breach('up', async (id) => ({
          observationId: await checkObservation(randomUUID(), 1, 'up'),
        }));
        await breach('up', async (id) => ({ observationId: await checkObservation(id, 2, 'up') }));
        await breach('up', async (id) => ({
          observationId: await checkObservation(id, 1, 'up', 'unsatisfied'),
        }));
        const confirmation =
          (rationale: Record<string, unknown>, fields: Parameters<typeof decision>[1] = {}) =>
          async (id: string) => ({
            kind: 'requester_confirm' as const,
            decisionId: await decision(
              {
                decision: 'goal_outcome',
                outcome: 'achieved',
                goalRunId: id,
                round: 1,
                checkKey: 'report',
                ...rationale,
              },
              fields,
            ),
          });
        await breach('report', confirmation({}, { decidedBy: randomUUID() }));
        await breach('report', confirmation({}, { status: 'rejected' }));
        await breach('report', confirmation({ outcome: 'not_achieved' }));
        await breach('report', confirmation({ round: 2 }));
        await breach('report', confirmation({ checkKey: 'other' }));
        await breach('report', confirmation({ goalRunId: randomUUID() }));

        const result = await check((client) => checkIG5(client, ALL));
        expect(mentioned(result, healthy)).toBe(false);
        for (const [id, key] of cases) {
          const kind = key === 'up' ? 'observe_predicate' : 'requester_confirm';
          expect(result.sample, `${id} ${key}`).toContain(
            `passed-without-evidence ${workspaceId}:${id} (round 1 check ${key} (${kind}) passed without its evidence)`,
          );
        }
      });

      it.each([
        ['goal_runs', 'goal_runs_status_guard'],
        ['goal_acceptance_checks', 'goal_acceptance_checks_guard'],
      ])(
        'counts the guard %s.%s disabled, or switched to fire only under replica',
        async (table, trigger) => {
          for (const breach of [
            `alter table ${table} disable trigger ${trigger}`,
            `alter table ${table} enable replica trigger ${trigger}`,
          ]) {
            const result = await checkRolledBack(breach, (client) => checkIG5(client, ALL));
            expect(
              result.sample.some((line) => line.startsWith(`guards ${table}:${trigger} (`)),
              breach,
            ).toBe(true);
          }
          const intact = await check((client) => checkIG5(client, ALL));
          expect(intact.sample.some((line) => line.startsWith('guards '))).toBe(false);
        },
      );
    });

    describe('I-G6: a GoalRun stays within its budget', () => {
      const grace = DEFAULT_GOAL_BUDGET_GRACE_MS;

      it('counts a running goal past its wall clock by more than the grace period', async () => {
        const over = await goal({ confirmedAgo: 7200, maxWallClockSeconds: 3600 });
        const within = await goal({ confirmedAgo: 3600 + 60, maxWallClockSeconds: 3600 });
        const paused = await goal({ confirmedAgo: 7200, maxWallClockSeconds: 3600 });
        await raw(
          "update goal_runs set status = 'paused', pause_reason = 'budget_exhausted' where workspace_id = $1 and id = $2",
          [workspaceId, paused],
        );

        const result = await check((client) => checkIG6(client, ALL, grace));
        expect(result.invariant).toBe('I-G6');
        expect(flagged(result, 'wall-clock', over)).toBe(true);
        expect(mentioned(result, within)).toBe(false);
        expect(mentioned(result, paused)).toBe(false);
      });

      it('counts tokens, steps or revisions over budget once nothing of the goal runs and the grace period passed', async () => {
        const withTasks = async (fields: GoalFields, tasks: readonly TaskFields[]) => {
          const goalRunId = await goal({ updatedAgo: 3600, ...fields });
          await revision(goalRunId, 1, ['s']);
          const s = await step(goalRunId, 's', { attemptCount: tasks.length });
          for (const [index, taskFields] of tasks.entries()) {
            await task(goalRunId, s, { attempt: index + 1, ...taskFields });
          }
          return goalRunId;
        };
        const tokens = await withTasks({ maxTokens: 100 }, [{ tokens: 500 }]);
        const steps = await withTasks({ maxSteps: 1 }, [{}, {}]);
        const revisions = await goal({ updatedAgo: 3600, maxRevisions: 0, currentRevision: 2 });
        await revision(revisions, 1, ['s']);
        await revision(revisions, 2, ['s']);
        await step(revisions, 's', { introducedIn: 2 });
        const stillRunning = await withTasks({ maxTokens: 100 }, [
          { tokens: 500, status: 'running' },
        ]);
        const justEnded = await withTasks({ maxTokens: 100 }, [{ tokens: 500, endedAgo: 60 }]);
        const underBudget = await withTasks({ maxTokens: 1000 }, [{ tokens: 500 }]);

        const result = await check((client) => checkIG6(client, ALL, grace));
        expect(flagged(result, 'usage', tokens)).toBe(true);
        expect(flagged(result, 'usage', steps)).toBe(true);
        expect(flagged(result, 'usage', revisions)).toBe(true);
        expect(mentioned(result, stillRunning)).toBe(false);
        expect(mentioned(result, justEnded)).toBe(false);
        expect(mentioned(result, underBudget)).toBe(false);
      });
    });

    describe('I-G9: only a live step of a live GoalRun raises actions, and only those run', () => {
      it('counts a request of a cancelled step or a cancelling goal left pending or queued', async () => {
        const goalRunId = await goal();
        await revision(goalRunId, 1, ['cancelled', 'live']);
        const cancelled = await step(goalRunId, 'cancelled', { status: 'cancelled' });
        const live = await step(goalRunId, 'live');
        const leftPending = await request({ status: 'pending_approval', stepRunId: cancelled });
        const withdrawn = await request({ status: 'withdrawn', stepRunId: cancelled });
        const ofLiveStep = await request({ status: 'auto_approved', stepRunId: live });

        const cancelling = await goal({ status: 'cancelling' });
        await revision(cancelling, 1, ['s']);
        const stepOfCancelling = await step(cancelling, 's');
        const leftQueued = await request({ status: 'auto_approved', stepRunId: stepOfCancelling });

        const result = await check((client) => checkIG9(client, ALL));
        expect(result.invariant).toBe('I-G9');
        expect(flagged(result, 'not-withdrawn', leftPending)).toBe(true);
        expect(flagged(result, 'not-withdrawn', leftQueued)).toBe(true);
        expect(mentioned(result, withdrawn)).toBe(false);
        expect(mentioned(result, ofLiveStep)).toBe(false);
      });

      it('counts a request that ran after its step was cancelled, or was raised after its step ended', async () => {
        const goalRunId = await goal();
        await revision(goalRunId, 1, ['cancelled', 'superseded']);
        const cancelled = await step(goalRunId, 'cancelled', {
          status: 'cancelled',
          endedAgo: 600,
        });
        const superseded = await step(goalRunId, 'superseded', {
          status: 'superseded',
          endedAgo: 600,
        });
        const ranAfter = await request({
          status: 'executed',
          stepRunId: cancelled,
          requestedAgo: 1200,
          executingAgo: 300,
        });
        const ranBefore = await request({
          status: 'executed',
          stepRunId: cancelled,
          requestedAgo: 1200,
          executingAgo: 900,
        });
        const raisedAfter = await request({
          status: 'denied',
          stepRunId: superseded,
          requestedAgo: 300,
        });

        const result = await check((client) => checkIG9(client, ALL));
        expect(flagged(result, 'ran-after-cancel', ranAfter)).toBe(true);
        expect(mentioned(result, ranBefore)).toBe(false);
        expect(flagged(result, 'raised-after-end', raisedAfter)).toBe(true);
      });

      it('counts a request of a superseded step left pending, or run after the step ended, unless the revision released it (S11 GO3b)', async () => {
        const goalRunId = await goal({ currentRevision: 2 });
        await revision(goalRunId, 1, ['a', 'b']);
        await revision(goalRunId, 2, ['b']);
        const superseded = await step(goalRunId, 'a', {
          status: 'superseded',
          supersededIn: 2,
          endedAgo: 600,
        });
        const releasedPending = await request({
          status: 'pending_approval',
          stepRunId: superseded,
        });
        const releasedRan = await request({
          status: 'executed',
          stepRunId: superseded,
          executingAgo: 300,
        });
        const leftQueued = await request({ status: 'auto_approved', stepRunId: superseded });
        const ranAfter = await request({
          status: 'executed',
          stepRunId: superseded,
          executingAgo: 300,
        });
        const ranBefore = await request({
          status: 'executed',
          stepRunId: superseded,
          executingAgo: 900,
        });
        await raw(
          `update plan_revisions set removals = $3::jsonb
            where workspace_id = $1 and goal_run_id = $2 and revision = 2`,
          [
            workspaceId,
            goalRunId,
            JSON.stringify({ a: { mode: 'let_finish', release: [releasedPending, releasedRan] } }),
          ],
        );

        const result = await check((client) => checkIG9(client, ALL));
        expect(flagged(result, 'not-withdrawn', leftQueued)).toBe(true);
        expect(flagged(result, 'ran-after-cancel', ranAfter)).toBe(true);
        expect(mentioned(result, releasedPending)).toBe(false);
        expect(mentioned(result, releasedRan)).toBe(false);
        expect(mentioned(result, ranBefore)).toBe(false);
      });

      it('counts a request whose step is not the one its Worker’s Task runs for', async () => {
        const goalRunId = await goal();
        await revision(goalRunId, 1, ['s']);
        const s = await step(goalRunId, 's', { attemptCount: 1 });
        const run = await workerRun(await task(goalRunId, s, { attempt: 1, status: 'running' }));
        const matching = await request({
          status: 'auto_approved',
          stepRunId: s,
          workerRunId: run,
        });
        const unrecorded = await request({
          status: 'auto_approved',
          stepRunId: null,
          workerRunId: run,
        });
        const other = await step(goalRunId, 'o', { attemptCount: 0, status: 'pending' });
        const wrongStep = await request({
          status: 'auto_approved',
          stepRunId: other,
          workerRunId: run,
        });
        const noWorker = await request({
          status: 'auto_approved',
          stepRunId: other,
          workerRunId: null,
        });
        const outside = await request({
          status: 'auto_approved',
          stepRunId: null,
          workerRunId: await workerRun(await task(goalRunId, s, { attempt: null })),
        });

        const result = await check((client) => checkIG9(client, ALL));
        expect(mentioned(result, matching)).toBe(false);
        expect(flagged(result, 'step-mismatch', unrecorded)).toBe(true);
        expect(flagged(result, 'step-mismatch', wrongStep)).toBe(true);
        expect(flagged(result, 'step-mismatch', noWorker)).toBe(true);
        // A nested child Task runs for its caller's step too: its requests must record it.
        expect(flagged(result, 'step-mismatch', outside)).toBe(true);
      });

      it.each([['action_requests_status_guard'], ['action_requests_step_run_immutable']])(
        'counts the guard %s disabled, or switched to fire only under replica',
        async (trigger) => {
          for (const breach of [
            `alter table action_requests disable trigger ${trigger}`,
            `alter table action_requests enable replica trigger ${trigger}`,
          ]) {
            const result = await checkRolledBack(breach, (client) => checkIG9(client, ALL));
            expect(
              result.sample.some((line) => line.startsWith(`guard action_requests:${trigger} (`)),
              breach,
            ).toBe(true);
          }
          const intact = await check((client) => checkIG9(client, ALL));
          expect(intact.sample.some((line) => line.startsWith('guard '))).toBe(false);
        },
      );
    });

    it('runs with every other invariant and is exported as a gauge per invariant', async () => {
      const results = await runInvariantChecks(pool);
      for (const id of ['I-G1', 'I-G2', 'I-G5', 'I-G6', 'I-G9']) {
        const result = results.find((candidate) => candidate.invariant === id);
        expect(result, id).toBeDefined();
        // This file left breaches of each behind.
        expect(result?.violations, id).toBeGreaterThan(0);
      }
      const metrics = renderInvariantMetricsPrometheus(results, new Date());
      for (const id of ['I-G1', 'I-G2', 'I-G5', 'I-G6', 'I-G9']) {
        expect(metrics).toMatch(
          new RegExp(`^nexttime_invariant_violations\\{invariant="${id}"\\} [1-9]\\d*$`, 'm'),
        );
      }
    });
  },
);
