import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WorkerSpec, taskFailureCategory } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { workerSpecDigest } from './step-attempt.js';
import { type CanReadGoal, readWorkerDefinitionStats } from './worker-definition-stats.js';

/**
 * application/task/worker-definition-stats.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) tests for `get_worker_definition_stats`'s read (S11 GO16a, legacy 569). The
 * records it counts are written by other modules' write paths (spawn, goal advance, approvals), so
 * the fixtures here are inserted directly with the guards off — what is under test is how the read
 * counts them. The outcome and refusal rules it shares with `get_skill_stats` are tested in depth
 * in skill-stats.integration.test.ts; here, that they apply per version, segment and combination,
 * and that a WorkerSpec's digest goes only to a caller who can read a goal it ran in.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const ENV_A = `v1:${'a'.repeat(64)}`;
const ENV_B = `v1:${'b'.repeat(64)}`;

/** 2026-10-01 at `hh:mm` UTC. */
const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00.000Z`);

const SPEC_A: WorkerSpec = { instructions: 'triage before restarting', skills: ['restart-web'] };
const SPEC_B: WorkerSpec = { model: 'model-b' };
const SPEC_C: WorkerSpec = { tokenBudget: 4000 };

/** Who reads every goal: the workspace owner, as the gateway's goal viewer has it. */
const READS_EVERY_GOAL = () => true;

describe.runIf(DATABASE_URL !== undefined)(
  'get_worker_definition_stats read (S11 GO16a, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    /** A write with the guards off — fixtures this read does not own the write paths of. */
    const raw = async <T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> =>
      withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          return (await client.query(sql, [...params])).rows as T[];
        },
        { skipRoleSwitch: true },
      );

    const stats = (definitionId: string, canReadGoal: CanReadGoal = READS_EVERY_GOAL) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        readWorkerDefinitionStats(client, workspaceId, definitionId, { canReadGoal }),
      );

    /** A family whose version `i + 1` has `versions[i]`'s status and name. */
    async function family(
      versions: readonly { readonly status: string; readonly name?: string }[],
    ): Promise<string> {
      const id = randomUUID();
      for (const [index, version] of versions.entries()) {
        await raw(
          `insert into worker_definitions (workspace_id, id, version, kind, status, definition,
             proposed_by)
           values ($1, $2, $3, 'worker', $4, $5, $6)`,
          [
            workspaceId,
            id,
            index + 1,
            version.status,
            JSON.stringify(version.name !== undefined ? { name: version.name } : {}),
            ownerId,
          ],
        );
      }
      return id;
    }

    interface GoalStep {
      readonly goalRunId: string;
      readonly stepRunId: string;
    }

    /**
     * A GoalRun with one StepRun whose plan entry sets `spec` (the content stored in the plan;
     * absent: the entry sets none); `acceptance` makes the step declare a check.
     */
    async function goalStep(input: {
      readonly spec?: WorkerSpec | Record<string, unknown>;
      readonly acceptance: boolean;
      readonly stepStatus: string;
      readonly failureCategory?: string;
      readonly stepEndedAt?: Date;
      readonly goalOutcome?: { readonly outcome: string; readonly basis: string };
      readonly endedAt?: Date;
      /** The goal's requester; the owner when not given. */
      readonly requester?: string;
    }): Promise<GoalStep> {
      const [goal] = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, outcome, outcome_basis, on_behalf_of,
           statement, current_revision, confirmed_at, budget_max_tokens, budget_max_steps,
           budget_max_revisions, budget_max_wall_clock_seconds, ended_at)
         values ($1, $2, $3, $4, $5, 'a goal', 1, now(), 100000, 10, 5, 3600, $6) returning id`,
        [
          workspaceId,
          input.goalOutcome ? 'completed' : 'running',
          input.goalOutcome?.outcome ?? null,
          input.goalOutcome?.basis ?? null,
          input.requester ?? ownerId,
          input.goalOutcome ? (input.endedAt ?? new Date()) : null,
        ],
      );
      const goalRunId = goal?.id as string;
      const step = {
        key: 's',
        ...(input.spec !== undefined ? { spec: input.spec } : {}),
        ...(input.acceptance ? { acceptance: [{ key: 'c', kind: 'observe_predicate' }] } : {}),
      };
      await raw(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan,
           proposed_by, decided_by, decided_at)
         values ($1, $2, 1, 'accepted', $3, $4, $4, now())`,
        [workspaceId, goalRunId, JSON.stringify({ steps: [step] }), ownerId],
      );
      const [stepRun] = await raw<{ id: string }>(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision,
           status, failure_category, attempt_count, ended_at, updated_at)
         values ($1, $2, 's', 1, $3, $4, 1, $5, $6) returning id`,
        [
          workspaceId,
          goalRunId,
          input.stepStatus,
          input.failureCategory ?? null,
          input.stepStatus === 'succeeded' ? (input.stepEndedAt ?? new Date()) : null,
          input.stepEndedAt ?? new Date(),
        ],
      );
      return { goalRunId, stepRunId: stepRun?.id as string };
    }

    interface TaskFixture {
      readonly definitionId: string;
      readonly version: number;
      readonly status: string;
      readonly failureReason?: string;
      readonly failedAt?: Date;
      readonly turnId?: string;
      /** A goal step's first attempt, admitted with the WorkerSpec of digest `specDigest`
       *  (`null`: the step sets none). */
      readonly attempt?: { readonly step: GoalStep; readonly specDigest: string | null };
      readonly outputRejected?: boolean;
      readonly agentOutcome?: { readonly outcome: string; readonly at: Date };
      readonly purpose?: 'evaluation';
    }

    async function task(fixture: TaskFixture): Promise<string> {
      const id = randomUUID();
      const attempt = fixture.attempt;
      await raw(
        `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, failure_reason, failed_at, created_by_activity_id,
           goal_run_id, step_run_id, plan_revision, step_attempt, run_config_snapshot,
           output_schema, rejected_output, objective_outcome, outcome_given_by, outcome_given_at,
           outcome_revision, purpose, observe_scope)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19, $20, $21, $22::uuid[])`,
        [
          workspaceId,
          id,
          fixture.status,
          ownerId,
          fixture.definitionId,
          fixture.version,
          fixture.failureReason ?? null,
          fixture.failedAt ?? null,
          fixture.turnId ?? null,
          attempt?.step.goalRunId ?? null,
          attempt?.step.stepRunId ?? null,
          attempt ? 1 : null,
          attempt ? 1 : null,
          attempt
            ? JSON.stringify({
                v: 2,
                spec: attempt.specDigest === null ? null : { digest: attempt.specDigest },
              })
            : null,
          fixture.outputRejected ? '{}' : null,
          fixture.outputRejected ? '{}' : null,
          fixture.agentOutcome?.outcome ?? null,
          fixture.agentOutcome ? ownerId : null,
          fixture.agentOutcome?.at ?? null,
          fixture.agentOutcome ? 1 : null,
          fixture.purpose ?? null,
          // An evaluation Task names its fixture gates (migrations/task/0011).
          fixture.purpose ? [] : null,
        ],
      );
      return id;
    }

    /** A goal planner's Task (`purpose` planning, task/0012): a round's, under revision 1. */
    async function planningTask(definitionId: string, step: GoalStep): Promise<string> {
      const id = randomUUID();
      await raw(
        `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, goal_run_id, plan_revision, planning_round_id,
           output_schema, purpose, observe_scope)
         values ($1, $2, 'completed', $3, $4, 2, $5, 1, $6, '{}', 'planning', '{}'::uuid[])`,
        [workspaceId, id, ownerId, definitionId, step.goalRunId, randomUUID()],
      );
      return id;
    }

    async function run(input: {
      readonly taskId: string;
      readonly startedAt: Date;
      readonly environment: string | null;
      readonly attempt?: number;
    }): Promise<string> {
      const id = randomUUID();
      await raw(
        `insert into worker_runs (workspace_id, id, status, task_id, started_at, attempt,
           skills_recorded, run_spec, runtime_report, environment_digest)
         values ($1, $2, 'terminated', $3, $4, $5, true, $6, $7, $8)`,
        [
          workspaceId,
          id,
          input.taskId,
          input.startedAt,
          input.attempt ?? 1,
          input.environment ? '{}' : null,
          input.environment ? '{}' : null,
          input.environment,
        ],
      );
      return id;
    }

    async function turn(outcome: string, givenAt: Date): Promise<string> {
      const id = randomUUID();
      await raw(
        `insert into turn_outcomes (workspace_id, turn_id, outcome, given_by, given_at)
         values ($1, $2, $3, $4, $5)`,
        [workspaceId, id, outcome, ownerId, givenAt],
      );
      return id;
    }

    async function rejectedRequest(runId: string, requestedAt: Date): Promise<void> {
      await raw(
        `insert into action_requests (workspace_id, status, gatekeeper_id, action_kind,
           blast_radius, policy_decision, approval_decision_id, on_behalf_of,
           parent_worker_run_id, actor_runtime, requested_at)
         values ($1, 'rejected', $2, 'svc.restart', 'medium', 'require_approval', $3, $4, $5,
           'worker', $6)`,
        [workspaceId, randomUUID(), randomUUID(), ownerId, runId, requestedAt],
      );
    }

    /** A tally whose primary tier is `achieved` of `total`, proxy `proxyAchieved` of the same. */
    const tally = (achieved: number, total: number, proxyAchieved = 0) => ({
      primary: {
        achieved,
        notAchieved: total - achieved,
        total,
        attainment: total === 0 ? null : achieved / total,
      },
      proxy: {
        achieved: proxyAchieved,
        notAchieved: 0,
        total: proxyAchieved,
        attainment: proxyAchieved === 0 ? null : 1,
      },
    });

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
            'go16a-worker-definition-stats',
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

    it('is null for a family the workspace does not have, or has only as a draft', async () => {
      expect(await stats(randomUUID())).toBeNull();
      expect(await stats(await family([{ status: 'draft', name: 'unpublished' }]))).toBeNull();
    });

    it('counts each Task under its own version, runs per environment, each WorkerSpec digest as one combination, and groups failed Tasks by combination', async () => {
      const definitionId = await family([
        { status: 'deprecated', name: 'fixer' },
        { status: 'published', name: 'fixer, second' },
        { status: 'draft', name: 'fixer, next' },
      ]);
      const otherId = await family([{ status: 'published', name: 'other' }]);
      const digestA = workerSpecDigest(SPEC_A) as string;
      const digestB = workerSpecDigest(SPEC_B) as string;

      // v2, as it is — T1: completed in a Turn the requester marked achieved; its agent said so too.
      const t1 = await task({
        definitionId,
        version: 2,
        status: 'completed',
        turnId: await turn('achieved', at('10:30')),
        agentOutcome: { outcome: 'achieved', at: at('10:20') },
      });
      await run({ taskId: t1, startedAt: at('10:00'), environment: ENV_A });

      // T2: failed after a crash retry that moved it to another environment — the first run counts
      // in ENV_A, the Task and its second run in ENV_B; a rejected request refused it.
      const t2 = await task({
        definitionId,
        version: 2,
        status: 'failed',
        failureReason: 'worker_failed',
        failedAt: at('11:50'),
        turnId: await turn('not_achieved', at('12:00')),
      });
      const r2 = await run({ taskId: t2, startedAt: at('11:00'), environment: ENV_A });
      await run({ taskId: t2, startedAt: at('11:30'), attempt: 2, environment: ENV_B });
      await rejectedRequest(r2, at('11:05'));

      // T7: queued, no run yet — in the version and its combination, in no environment.
      await task({ definitionId, version: 2, status: 'queued' });
      // T12: a goal step that sets no WorkerSpec runs the definition as it is. It failed before any
      // run, as T5 below fails (same category, same refusal) — a group of its own.
      await task({
        definitionId,
        version: 2,
        status: 'failed',
        failureReason: 'timeout',
        failedAt: at('13:10'),
        outputRejected: true,
        attempt: {
          step: await goalStep({ acceptance: false, stepStatus: 'running' }),
          specDigest: null,
        },
      });

      // v2 with WorkerSpec A, in three goals: one combination, whichever goal it came from.
      const checked = await goalStep({
        spec: SPEC_A,
        acceptance: true,
        stepStatus: 'succeeded',
        stepEndedAt: at('12:20'),
      });
      const t3 = await task({
        definitionId,
        version: 2,
        status: 'completed',
        attempt: { step: checked, specDigest: digestA },
      });
      await run({ taskId: t3, startedAt: at('12:00'), environment: ENV_B });

      const goalJudged = await goalStep({
        spec: SPEC_A,
        acceptance: false,
        stepStatus: 'succeeded',
        goalOutcome: { outcome: 'achieved', basis: 'requester' },
        endedAt: at('13:30'),
      });
      const t4 = await task({
        definitionId,
        version: 2,
        status: 'completed',
        attempt: { step: goalJudged, specDigest: digestA },
      });
      await run({ taskId: t4, startedAt: at('12:30'), environment: ENV_B });

      const failedCheck = await goalStep({
        spec: SPEC_A,
        acceptance: true,
        stepStatus: 'failed',
        failureCategory: 'verification_failed',
        stepEndedAt: at('12:55'),
      });
      const t5 = await task({
        definitionId,
        version: 2,
        status: 'failed',
        failureReason: 'timeout',
        failedAt: at('12:50'),
        outputRejected: true,
        attempt: { step: failedCheck, specDigest: digestA },
      });
      await run({ taskId: t5, startedAt: at('12:45'), environment: ENV_B });

      // T6: WorkerSpec B, but its plan entry no longer digests to the snapshot's: no field names.
      const drifted = await goalStep({
        spec: { model: 'model-c' },
        acceptance: false,
        stepStatus: 'running',
      });
      const t6 = await task({
        definitionId,
        version: 2,
        status: 'completed',
        attempt: { step: drifted, specDigest: digestB },
      });
      await run({ taskId: t6, startedAt: at('13:00'), environment: null });

      // Not ordinary work: an evaluation's Task and the goal planner's.
      const evaluation = await task({
        definitionId,
        version: 2,
        status: 'failed',
        failureReason: 'worker_failed',
        failedAt: at('14:00'),
        purpose: 'evaluation',
      });
      await run({ taskId: evaluation, startedAt: at('14:00'), environment: ENV_A });
      const planning = await planningTask(definitionId, drifted);
      await run({ taskId: planning, startedAt: at('14:10'), environment: ENV_A });

      // v1: one failed Task. Another family's Task counts nowhere here.
      const t10 = await task({
        definitionId,
        version: 1,
        status: 'failed',
        failureReason: 'budget_exhausted',
        failedAt: at('09:00'),
      });
      await run({ taskId: t10, startedAt: at('08:50'), environment: ENV_A });
      const elsewhere = await task({ definitionId: otherId, version: 1, status: 'completed' });
      await run({ taskId: elsewhere, startedAt: at('15:00'), environment: ENV_A });

      const result = await stats(definitionId);
      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.definitionId).toBe(definitionId);
      // The latest listed version's name: the draft v3 is not listed.
      expect(result.name).toBe('fixer, second');
      expect(result.versions.map((version) => [version.version, version.status])).toEqual([
        [2, 'published'],
        [1, 'deprecated'],
      ]);

      const [v2, v1] = result.versions;
      // Runs: T1 1, T2 2, T3–T6 1 each. Tasks: T7 in progress. Primary outcomes: T1's and T2's
      // Turns, T3's and T5's step checks, T4's goal — each once; T1's agent report beside them.
      expect(v2).toMatchObject({
        usage: {
          runs: 7,
          tasks: { completed: 4, failed: 3, cancelled: 0, inProgress: 1 },
          lastUsedAt: at('13:00').toISOString(),
        },
        outcomes: tally(3, 5, 1),
        reviewSuggested: false,
      });
      expect(
        v2?.segments.map((segment) => ({
          environmentDigest: segment.environmentDigest,
          usage: segment.usage,
          outcomes: { primary: segment.outcomes.primary, proxy: segment.outcomes.proxy },
        })),
      ).toEqual([
        {
          environmentDigest: null,
          usage: {
            runs: 1,
            tasks: { completed: 1, failed: 0, cancelled: 0, inProgress: 0 },
            lastUsedAt: at('13:00').toISOString(),
          },
          outcomes: tally(0, 0),
        },
        {
          environmentDigest: ENV_B,
          usage: {
            runs: 4,
            tasks: { completed: 2, failed: 2, cancelled: 0, inProgress: 0 },
            lastUsedAt: at('12:45').toISOString(),
          },
          outcomes: tally(2, 4),
        },
        {
          environmentDigest: ENV_A,
          usage: {
            runs: 2,
            tasks: { completed: 1, failed: 0, cancelled: 0, inProgress: 0 },
            lastUsedAt: at('11:00').toISOString(),
          },
          outcomes: tally(1, 1, 1),
        },
      ]);
      expect(
        v2?.combinations.map((combination) => ({
          specRef: combination.specRef,
          specDigest: combination.specDigest,
          fields: combination.fields,
          usage: combination.usage,
          outcomes: { primary: combination.outcomes.primary, proxy: combination.outcomes.proxy },
        })),
      ).toEqual([
        {
          specRef: digestB.slice(0, 12),
          specDigest: digestB,
          fields: null,
          usage: {
            runs: 1,
            tasks: { completed: 1, failed: 0, cancelled: 0, inProgress: 0 },
            lastUsedAt: at('13:00').toISOString(),
          },
          outcomes: tally(0, 0),
        },
        {
          specRef: digestA.slice(0, 12),
          specDigest: digestA,
          fields: ['instructions', 'skills'],
          usage: {
            runs: 3,
            tasks: { completed: 2, failed: 1, cancelled: 0, inProgress: 0 },
            lastUsedAt: at('12:45').toISOString(),
          },
          outcomes: tally(2, 3),
        },
        {
          specRef: null,
          specDigest: null,
          fields: [],
          usage: {
            runs: 3,
            tasks: { completed: 1, failed: 2, cancelled: 0, inProgress: 1 },
            lastUsedAt: at('11:30').toISOString(),
          },
          outcomes: tally(1, 2, 1),
        },
      ]);

      expect(v1).toMatchObject({
        usage: {
          runs: 1,
          tasks: { completed: 0, failed: 1, cancelled: 0, inProgress: 0 },
          lastUsedAt: at('08:50').toISOString(),
        },
        segments: [{ environmentDigest: ENV_A }],
        combinations: [{ specRef: null, specDigest: null, fields: [] }],
      });

      expect(result.failureGroups).toEqual([
        {
          definitionVersion: 2,
          specRef: null,
          specDigest: null,
          category: taskFailureCategory('timeout'),
          refusal: 'output_rejected',
          tasks: 1,
          lastFailedAt: at('13:10').toISOString(),
        },
        {
          definitionVersion: 2,
          specRef: digestA.slice(0, 12),
          specDigest: digestA,
          category: taskFailureCategory('timeout'),
          refusal: 'output_rejected',
          tasks: 1,
          lastFailedAt: at('12:50').toISOString(),
        },
        {
          definitionVersion: 2,
          specRef: null,
          specDigest: null,
          category: taskFailureCategory('worker_failed'),
          refusal: 'rejected',
          tasks: 1,
          lastFailedAt: at('11:50').toISOString(),
        },
        {
          definitionVersion: 1,
          specRef: null,
          specDigest: null,
          category: taskFailureCategory('budget_exhausted'),
          refusal: 'none',
          tasks: 1,
          lastFailedAt: at('09:00').toISOString(),
        },
      ]);
    });

    it('suggests a review on a combination whose latest outcomes all missed, and on its version, though its environment had a success since', async () => {
      const definitionId = await family([{ status: 'published', name: 'reviewer' }]);
      const digest = workerSpecDigest(SPEC_B) as string;
      for (const minute of ['10', '11', '12']) {
        const step = await goalStep({
          spec: SPEC_B,
          acceptance: true,
          stepStatus: 'failed',
          failureCategory: 'verification_failed',
          stepEndedAt: at(`10:${minute}`),
        });
        const id = await task({
          definitionId,
          version: 1,
          status: 'completed',
          attempt: { step, specDigest: digest },
        });
        await run({ taskId: id, startedAt: at(`10:0${minute.slice(1)}`), environment: ENV_A });
      }
      // The definition as it is, in the same environment, achieved after those.
      const asIs = await task({
        definitionId,
        version: 1,
        status: 'completed',
        turnId: await turn('achieved', at('10:30')),
      });
      await run({ taskId: asIs, startedAt: at('10:20'), environment: ENV_A });

      const result = await stats(definitionId);
      const version = result?.versions[0];
      expect(version?.segments.map((segment) => segment.reviewSuggested)).toEqual([false]);
      expect(
        version?.combinations.map((combination) => [
          combination.specDigest,
          combination.fields,
          combination.reviewSuggested,
        ]),
      ).toEqual([
        [null, [], false],
        [digest, ['model'], true],
      ]);
      expect(version?.reviewSuggested).toBe(true);
    });

    it('gives a WorkerSpec’s digest only to a caller who can read a goal it ran in; any other gets a label numbered in the response, the same across versions and failure groups', async () => {
      const reader = randomUUID();
      const someoneElse = randomUUID();
      const canReadGoal: CanReadGoal = (goal) => goal.onBehalfOf === reader;
      const definitionId = await family([{ status: 'deprecated' }, { status: 'published' }]);
      const digestA = workerSpecDigest(SPEC_A) as string;
      const digestB = workerSpecDigest(SPEC_B) as string;
      const digestC = workerSpecDigest(SPEC_C) as string;
      const ran = async (input: {
        readonly version: number;
        readonly spec: WorkerSpec;
        readonly requester: string;
        readonly startedAt: Date;
        readonly failed?: boolean;
      }) => {
        const step = await goalStep({
          spec: input.spec,
          acceptance: false,
          stepStatus: 'running',
          requester: input.requester,
        });
        const id = await task({
          definitionId,
          version: input.version,
          status: input.failed ? 'failed' : 'completed',
          ...(input.failed ? { failureReason: 'worker_failed', failedAt: input.startedAt } : {}),
          attempt: { step, specDigest: workerSpecDigest(input.spec) },
        });
        await run({ taskId: id, startedAt: input.startedAt, environment: ENV_A });
      };
      // v2: A in a goal the reader can read and in one they cannot — readable, so its digest
      // is given. C, then B, in goals they cannot read; B failed. v1: B again.
      await ran({ version: 2, spec: SPEC_A, requester: someoneElse, startedAt: at('10:00') });
      await ran({ version: 2, spec: SPEC_A, requester: reader, startedAt: at('10:10') });
      await ran({ version: 2, spec: SPEC_C, requester: someoneElse, startedAt: at('10:20') });
      await ran({
        version: 2,
        spec: SPEC_B,
        requester: someoneElse,
        startedAt: at('10:05'),
        failed: true,
      });
      await ran({ version: 1, spec: SPEC_B, requester: someoneElse, startedAt: at('09:00') });

      const labels = (result: Awaited<ReturnType<typeof stats>>) => ({
        versions: result?.versions.map((version) =>
          version.combinations.map((combination) => [
            combination.specRef,
            combination.specDigest,
            combination.fields,
          ]),
        ),
        failureGroups: result?.failureGroups.map((group) => [
          group.definitionVersion,
          group.specRef,
          group.specDigest,
        ]),
      });
      // Most recently used first: C, A, B in v2.
      expect(labels(await stats(definitionId, canReadGoal))).toEqual({
        versions: [
          [
            ['#1', null, ['tokenBudget']],
            [digestA.slice(0, 12), digestA, ['instructions', 'skills']],
            ['#2', null, ['model']],
          ],
          [['#2', null, ['model']]],
        ],
        failureGroups: [[2, '#2', null]],
      });
      // The owner reads every goal; a caller who reads none of them is given no digest at all.
      expect(labels(await stats(definitionId))).toEqual({
        versions: [
          [
            [digestC.slice(0, 12), digestC, ['tokenBudget']],
            [digestA.slice(0, 12), digestA, ['instructions', 'skills']],
            [digestB.slice(0, 12), digestB, ['model']],
          ],
          [[digestB.slice(0, 12), digestB, ['model']]],
        ],
        failureGroups: [[2, digestB.slice(0, 12), digestB]],
      });
      expect(labels(await stats(definitionId, () => false))).toEqual({
        versions: [
          [
            ['#1', null, ['tokenBudget']],
            ['#2', null, ['instructions', 'skills']],
            ['#3', null, ['model']],
          ],
          [['#3', null, ['model']]],
        ],
        failureGroups: [[2, '#3', null]],
      });
    });
  },
);
