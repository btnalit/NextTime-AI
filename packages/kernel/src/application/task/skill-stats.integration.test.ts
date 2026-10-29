import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { readSkillStats } from './skill-stats.js';

/**
 * application/task/skill-stats.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) tests for `get_skill_stats`'s read (S11 W1a E2-1). The records it counts are
 * written by other modules' write paths (spawn, goal advance, approvals), so the fixtures here are
 * inserted directly with the guards off — what is under test is how the read counts them.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const ENV_A = `v1:${'a'.repeat(64)}`;
const ENV_B = `v1:${'b'.repeat(64)}`;
const ENV_C = `v1:${'c'.repeat(64)}`;

/** 2026-10-01 at `hh:mm` UTC. */
const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00.000Z`);

describe.runIf(DATABASE_URL !== undefined)(
  'get_skill_stats read (S11 W1a E2-1, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let definitionId: string;

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

    const stats = (skillId: string) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        readSkillStats(client, workspaceId, skillId),
      );

    async function skillFamily(statuses: readonly string[]): Promise<string> {
      const id = randomUUID();
      for (const [index, status] of statuses.entries()) {
        await raw(
          `insert into skills (workspace_id, id, version, status, name, description, markdown,
             proposed_by)
           values ($1, $2, $3, $4, $5, 'd', '# m', $6)`,
          [workspaceId, id, index + 1, status, `skill-${id.slice(0, 8)}`, ownerId],
        );
      }
      return id;
    }

    interface TaskFixture {
      readonly status: string;
      readonly failureReason?: string;
      readonly failedAt?: Date;
      readonly turnId?: string;
      readonly goal?: { readonly goalRunId: string; readonly stepRunId: string };
      readonly outputRejected?: boolean;
      readonly agentOutcome?: { readonly outcome: string; readonly at: Date };
    }

    async function task(fixture: TaskFixture): Promise<string> {
      const id = randomUUID();
      const goal = fixture.goal;
      await raw(
        `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, failure_reason, failed_at, created_by_activity_id,
           goal_run_id, step_run_id, plan_revision, step_attempt, run_config_snapshot,
           output_schema, rejected_output, objective_outcome, outcome_given_by, outcome_given_at,
           outcome_revision)
         values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
           $18, $19)`,
        [
          workspaceId,
          id,
          fixture.status,
          ownerId,
          definitionId,
          fixture.failureReason ?? null,
          fixture.failedAt ?? null,
          fixture.turnId ?? null,
          goal?.goalRunId ?? null,
          goal?.stepRunId ?? null,
          goal ? 1 : null,
          goal ? 1 : null,
          goal ? '{}' : null,
          fixture.outputRejected ? '{}' : null,
          fixture.outputRejected ? '{}' : null,
          fixture.agentOutcome?.outcome ?? null,
          fixture.agentOutcome ? ownerId : null,
          fixture.agentOutcome?.at ?? null,
          fixture.agentOutcome ? 1 : null,
        ],
      );
      return id;
    }

    interface RunFixture {
      readonly taskId: string;
      readonly startedAt: Date;
      readonly environment: string | null;
      /** The Skill versions it loaded: `[skillId, version]`. */
      readonly loaded: readonly (readonly [string, number])[];
      readonly attempt?: number;
      readonly parentRunId?: string;
    }

    async function run(fixture: RunFixture): Promise<string> {
      const id = randomUUID();
      await raw(
        `insert into worker_runs (workspace_id, id, status, task_id, parent_worker_run_id,
           started_at, attempt, skills_recorded, run_spec, runtime_report, environment_digest)
         values ($1, $2, 'terminated', $3, $4, $5, $6, true, $7, $8, $9)`,
        [
          workspaceId,
          id,
          fixture.taskId,
          fixture.parentRunId ?? null,
          fixture.startedAt,
          fixture.attempt ?? 1,
          fixture.environment ? '{}' : null,
          fixture.environment ? '{}' : null,
          fixture.environment,
        ],
      );
      for (const [skillId, version] of fixture.loaded) {
        await raw(
          `insert into worker_run_skills (workspace_id, worker_run_id, skill_id, skill_version)
           values ($1, $2, $3, $4)`,
          [workspaceId, id, skillId, version],
        );
      }
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

    /** A GoalRun with one StepRun; `acceptance` makes the step declare a check. */
    async function goalStep(input: {
      readonly goalStatus: string;
      readonly goalOutcome?: { readonly outcome: string; readonly basis: string };
      readonly endedAt?: Date;
      readonly acceptance: boolean;
      readonly stepStatus: string;
      readonly failureCategory?: string;
      readonly stepEndedAt?: Date;
    }): Promise<{ goalRunId: string; stepRunId: string }> {
      const ended = ['completed', 'cancelled', 'failed'].includes(input.goalStatus);
      const [goal] = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, outcome, outcome_basis, on_behalf_of,
           statement, current_revision, confirmed_at, budget_max_tokens, budget_max_steps,
           budget_max_revisions, budget_max_wall_clock_seconds, ended_at)
         values ($1, $2, $3, $4, $5, 'a goal', 1, now(), 100000, 10, 5, 3600, $6) returning id`,
        [
          workspaceId,
          input.goalStatus,
          input.goalOutcome?.outcome ?? null,
          input.goalOutcome?.basis ?? null,
          ownerId,
          ended ? (input.endedAt ?? new Date()) : null,
        ],
      );
      const goalRunId = goal?.id as string;
      const step = input.acceptance
        ? { key: 's', acceptance: [{ key: 'c', kind: 'observe_predicate' }] }
        : { key: 's' };
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

    async function actionRequest(input: {
      readonly runId: string;
      readonly status: string;
      readonly requestedAt: Date;
      readonly failureKind?: string;
    }): Promise<void> {
      await raw(
        `insert into action_requests (workspace_id, status, gatekeeper_id, action_kind,
           blast_radius, policy_decision, approval_decision_id, on_behalf_of,
           parent_worker_run_id, actor_runtime, requested_at, failure_kind)
         values ($1, $2, $3, 'svc.restart', 'medium', $4, $5, $6, $7, 'worker', $8, $9)`,
        [
          workspaceId,
          input.status,
          randomUUID(),
          input.status === 'denied' ? 'deny' : 'require_approval',
          input.status === 'rejected' ? randomUUID() : null,
          ownerId,
          input.runId,
          input.requestedAt,
          input.failureKind ?? null,
        ],
      );
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
            'e2-1-skill-stats',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      definitionId = randomUUID();
      await raw(
        `insert into worker_definitions (workspace_id, id, version, kind, status, definition,
           proposed_by)
         values ($1, $2, 1, 'worker', 'published', '{"name":"fixer"}', $3)`,
        [workspaceId, definitionId, ownerId],
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('is null for a Skill the workspace does not have', async () => {
      expect(await stats(randomUUID())).toBeNull();
    });

    it('counts runs per version and environment, a Task under the version its last run loaded, each outcome subject once, and groups failed Tasks', async () => {
      const skillId = await skillFamily(['deprecated', 'published', 'draft']);
      const otherSkillId = await skillFamily(['published']);

      // v1: one completed Task in a Turn the requester marked achieved; its agent reported the same.
      const turnAchieved = await turn('achieved', at('10:30'));
      const t1 = await task({
        status: 'completed',
        turnId: turnAchieved,
        agentOutcome: { outcome: 'achieved', at: at('10:20') },
      });
      await run({ taskId: t1, startedAt: at('10:00'), environment: ENV_A, loaded: [[skillId, 1]] });

      // T2: requeued from v1 to v2 — it counts under v2. Its nested Task (same Turn) too; the Turn
      // was not achieved, and counts once.
      const turnMissed = await turn('not_achieved', at('12:00'));
      const t2 = await task({
        status: 'failed',
        failureReason: 'worker_failed',
        failedAt: at('11:50'),
        turnId: turnMissed,
      });
      const r2a = await run({
        taskId: t2,
        startedAt: at('11:00'),
        environment: ENV_A,
        loaded: [[skillId, 1]],
      });
      const r2b = await run({
        taskId: t2,
        startedAt: at('11:30'),
        attempt: 2,
        environment: ENV_A,
        loaded: [[skillId, 2]],
      });
      const t7 = await task({ status: 'running', turnId: turnMissed });
      const r7 = await run({
        taskId: t7,
        startedAt: at('11:40'),
        environment: ENV_A,
        loaded: [[skillId, 2]],
        parentRunId: r2b,
      });
      // What refused T2: the latest refused request its runs raised, the nested run's included.
      await actionRequest({ runId: r2a, status: 'rejected', requestedAt: at('11:05') });
      await actionRequest({ runId: r7, status: 'denied', requestedAt: at('11:45') });

      // T3: a goal step that declares a check and failed it — its output contract refused too.
      const failedCheck = await goalStep({
        goalStatus: 'failed',
        acceptance: true,
        stepStatus: 'failed',
        failureCategory: 'verification_failed',
        stepEndedAt: at('12:15'),
      });
      const t3 = await task({
        status: 'failed',
        failureReason: 'timeout',
        failedAt: at('12:10'),
        goal: failedCheck,
        outputRejected: true,
      });
      await run({ taskId: t3, startedAt: at('12:00'), environment: ENV_B, loaded: [[skillId, 2]] });

      // T4: a goal step with no check — the goal's outcome (the requester's word) stands for it.
      const achievedGoal = await goalStep({
        goalStatus: 'completed',
        goalOutcome: { outcome: 'achieved', basis: 'requester' },
        endedAt: at('13:30'),
        acceptance: false,
        stepStatus: 'succeeded',
        stepEndedAt: at('12:45'),
      });
      const t4 = await task({
        status: 'completed',
        goal: achievedGoal,
        agentOutcome: { outcome: 'not_achieved', at: at('12:40') },
      });
      await run({ taskId: t4, startedAt: at('12:30'), environment: ENV_B, loaded: [[skillId, 2]] });

      // T5: an unknown environment.
      const t5 = await task({ status: 'cancelled' });
      await run({ taskId: t5, startedAt: at('13:00'), environment: null, loaded: [[skillId, 2]] });

      // T9: its last run did not load this Skill (it loaded another): the run counts, the Task not.
      const t9 = await task({ status: 'completed' });
      await run({ taskId: t9, startedAt: at('09:00'), environment: ENV_A, loaded: [[skillId, 2]] });
      await run({
        taskId: t9,
        startedAt: at('09:30'),
        attempt: 2,
        environment: ENV_A,
        loaded: [[otherSkillId, 1]],
      });

      // T11, T12: the same failure twice; an outcome-unknown request is not a refusal.
      const t11 = await task({
        status: 'failed',
        failureReason: 'budget_exhausted',
        failedAt: at('12:42'),
      });
      await run({
        taskId: t11,
        startedAt: at('12:40'),
        environment: ENV_B,
        loaded: [[skillId, 2]],
      });
      const t12 = await task({
        status: 'failed',
        failureReason: 'budget_exhausted',
        failedAt: at('12:55'),
      });
      const r12 = await run({
        taskId: t12,
        startedAt: at('12:50'),
        environment: ENV_B,
        loaded: [[skillId, 2]],
      });
      await actionRequest({
        runId: r12,
        status: 'failed',
        requestedAt: at('12:52'),
        failureKind: 'outcome_unknown',
      });

      const result = await stats(skillId);
      expect(result).not.toBeNull();
      expect(result?.reviewStreak).toBe(3);
      expect(result?.versions.map((v) => [v.version, v.status])).toEqual([
        [3, 'draft'],
        [2, 'published'],
        [1, 'deprecated'],
      ]);
      const [v3, v2, v1] = result?.versions ?? [];

      expect(v3).toMatchObject({
        usage: {
          runs: 0,
          tasks: { completed: 0, failed: 0, cancelled: 0, inProgress: 0 },
          lastUsedAt: null,
        },
        outcomes: { primary: { total: 0, attainment: null }, proxy: { total: 0 } },
        reviewSuggested: false,
        segments: [],
      });

      expect(v1?.usage).toEqual({
        runs: 2,
        tasks: { completed: 1, failed: 0, cancelled: 0, inProgress: 0 },
        lastUsedAt: at('11:00').toISOString(),
      });
      expect(v1?.outcomes.primary).toEqual({
        achieved: 1,
        notAchieved: 0,
        total: 1,
        attainment: 1,
      });
      expect(v1?.outcomes.proxy).toMatchObject({ achieved: 1, notAchieved: 0 });

      expect(v2?.usage).toEqual({
        runs: 8,
        tasks: { completed: 1, failed: 4, cancelled: 1, inProgress: 1 },
        lastUsedAt: at('13:00').toISOString(),
      });
      // The Turn (requester, not achieved), the failed check, the goal (requester, achieved), and
      // T4's agent report apart, never in the rate.
      expect(v2?.outcomes.primary).toEqual({
        achieved: 1,
        notAchieved: 2,
        total: 3,
        attainment: 1 / 3,
      });
      expect(v2?.outcomes.proxy).toEqual({
        achieved: 0,
        notAchieved: 1,
        total: 1,
        attainment: 0,
      });
      expect(v2?.outcomes.byBasis).toEqual([
        { basis: 'verified_by_check', achieved: 0, notAchieved: 1 },
        { basis: 'requester', achieved: 1, notAchieved: 1 },
        { basis: 'reviewer_assessed', achieved: 0, notAchieved: 0 },
        { basis: 'agent_reported', achieved: 0, notAchieved: 1 },
      ]);
      expect(v2?.reviewSuggested).toBe(false);

      // Segments: most recently used first; the unknown environment is its own.
      expect(v2?.segments.map((s) => s.environmentDigest)).toEqual([null, ENV_B, ENV_A]);
      const [unknown, envB, envA] = v2?.segments ?? [];
      expect(unknown?.usage).toEqual({
        runs: 1,
        tasks: { completed: 0, failed: 0, cancelled: 1, inProgress: 0 },
        lastUsedAt: at('13:00').toISOString(),
      });
      expect(unknown?.outcomes.primary.total).toBe(0);
      expect(envB?.usage).toEqual({
        runs: 4,
        tasks: { completed: 1, failed: 3, cancelled: 0, inProgress: 0 },
        lastUsedAt: at('12:50').toISOString(),
      });
      expect(envB?.outcomes.primary).toMatchObject({ achieved: 1, notAchieved: 1 });
      expect(envB?.outcomes.proxy).toMatchObject({ achieved: 0, notAchieved: 1 });
      expect(envA?.usage).toEqual({
        runs: 3,
        tasks: { completed: 0, failed: 1, cancelled: 0, inProgress: 1 },
        lastUsedAt: at('11:40').toISOString(),
      });
      // T2 and its nested T7 share one Turn: one outcome.
      expect(envA?.outcomes.primary).toMatchObject({ achieved: 0, notAchieved: 1, total: 1 });

      expect(result?.failureGroups).toEqual([
        {
          skillVersion: 2,
          workerDefinition: { id: definitionId, version: 1, name: 'fixer' },
          category: 'limit_reached',
          refusal: 'none',
          tasks: 2,
          lastFailedAt: at('12:55').toISOString(),
        },
        {
          skillVersion: 2,
          workerDefinition: { id: definitionId, version: 1, name: 'fixer' },
          category: 'limit_reached',
          refusal: 'output_rejected',
          tasks: 1,
          lastFailedAt: at('12:10').toISOString(),
        },
        {
          skillVersion: 2,
          workerDefinition: { id: definitionId, version: 1, name: 'fixer' },
          category: 'worker_error',
          refusal: 'denied',
          tasks: 1,
          lastFailedAt: at('11:50').toISOString(),
        },
      ]);
      // Numbers only: no Turn, Task, goal or request id anywhere in the answer.
      const text = JSON.stringify(result);
      for (const id of [turnAchieved, turnMissed, t1, t2, t3, t4, t5, t7, t9, t11, t12]) {
        expect(text).not.toContain(id);
      }
      expect(text).not.toContain(failedCheck.goalRunId);
      expect(text).not.toContain(achievedGoal.goalRunId);
    });

    it('suggests a review per environment: the latest three primary outcomes there all not achieved', async () => {
      const skillId = await skillFamily(['published']);
      const outcomes: readonly [string, string, string][] = [
        // env A: newest three not achieved, an older one achieved → suggested.
        [ENV_A, 'achieved', '08:00'],
        [ENV_A, 'not_achieved', '09:00'],
        [ENV_A, 'not_achieved', '10:00'],
        [ENV_A, 'not_achieved', '11:00'],
        // env B: only two → not suggested.
        [ENV_B, 'not_achieved', '09:00'],
        [ENV_B, 'not_achieved', '10:00'],
      ];
      for (const [environment, outcome, time] of outcomes) {
        const turnId = await turn(outcome, at(time));
        const taskId = await task({ status: 'completed', turnId });
        await run({ taskId, startedAt: at(time), environment, loaded: [[skillId, 1]] });
      }
      // env C: three agent reports, not achieved — a proxy never suggests a review.
      for (const time of ['09:00', '10:00', '11:00']) {
        const taskId = await task({
          status: 'completed',
          agentOutcome: { outcome: 'not_achieved', at: at(time) },
        });
        await run({ taskId, startedAt: at(time), environment: ENV_C, loaded: [[skillId, 1]] });
      }

      const [v1] = (await stats(skillId))?.versions ?? [];
      const byEnvironment = new Map(v1?.segments.map((s) => [s.environmentDigest, s]));
      expect(byEnvironment.get(ENV_A)?.reviewSuggested).toBe(true);
      expect(byEnvironment.get(ENV_B)?.reviewSuggested).toBe(false);
      expect(byEnvironment.get(ENV_C)?.reviewSuggested).toBe(false);
      expect(byEnvironment.get(ENV_C)?.outcomes.proxy).toMatchObject({ notAchieved: 3 });
      expect(v1?.reviewSuggested).toBe(true);
      // The version's own rate mixes no environment's streak: 1 of 6 primary outcomes achieved.
      expect(v1?.outcomes.primary).toMatchObject({ achieved: 1, notAchieved: 5, total: 6 });
    });
  },
);
