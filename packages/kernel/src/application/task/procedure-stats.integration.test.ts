import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { readProcedureOutcomeHints, readProcedureStats } from './procedure-stats.js';

/**
 * application/task/procedure-stats.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) tests for `get_procedure_stats`'s read and `find_procedures`' outcome hint (S11
 * W1a E2-2). The records they count are written by other modules' write paths (goal proposal and
 * advance, spawn, `record_procedure_followed`), so the fixtures here are inserted directly with
 * the guards off — what is under test is how the read counts them.
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
  'get_procedure_stats read (S11 W1a E2-2, integration, real Postgres)',
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

    const stats = (procedureId: string) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        readProcedureStats(client, workspaceId, procedureId),
      );

    async function procedureFamily(statuses: readonly string[]): Promise<string> {
      const id = randomUUID();
      for (const [index, status] of statuses.entries()) {
        await raw(
          `insert into procedures (workspace_id, id, version, status, name, description, steps,
             proposed_by)
           values ($1, $2, $3, $4, $5, 'd', '[]', $6)`,
          [workspaceId, id, index + 1, status, `procedure-${id.slice(0, 8)}`, ownerId],
        );
      }
      return id;
    }

    interface GoalFixture {
      /** `[procedureId, version]` it was made from; absent: a plan written out. */
      readonly from?: readonly [string, number];
      readonly status: string;
      readonly outcome?: { readonly outcome: string; readonly basis: string };
      readonly createdAt: Date;
      readonly endedAt?: Date;
      /** Default: confirmed unless `proposed`. */
      readonly confirmed?: boolean;
    }

    async function goal(fixture: GoalFixture): Promise<string> {
      const confirmed = fixture.confirmed ?? fixture.status !== 'proposed';
      const ended = ['completed', 'cancelled', 'failed'].includes(fixture.status);
      const [row] = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, outcome, outcome_basis, on_behalf_of,
           statement, current_revision, confirmed_at, budget_max_tokens, budget_max_steps,
           budget_max_revisions, budget_max_wall_clock_seconds, created_at, ended_at)
         values ($1, $2, $3, $4, $5, 'a goal', $6, $7, 100000, 10, 5, 3600, $8, $9)
         returning id`,
        [
          workspaceId,
          fixture.status,
          fixture.outcome?.outcome ?? null,
          fixture.outcome?.basis ?? null,
          ownerId,
          confirmed ? 1 : null,
          confirmed ? fixture.createdAt : null,
          fixture.createdAt,
          ended ? (fixture.endedAt ?? fixture.createdAt) : null,
        ],
      );
      const goalRunId = row?.id as string;
      const revisionStatus = confirmed ? 'accepted' : ended ? 'rejected' : 'proposed';
      await raw(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan,
           proposed_by, decided_by, decided_at, source_procedure_id, source_procedure_version)
         values ($1, $2, 1, $3, '{"steps":[]}', $4, $5, $6, $7, $8)`,
        [
          workspaceId,
          goalRunId,
          revisionStatus,
          ownerId,
          revisionStatus === 'proposed' ? null : ownerId,
          revisionStatus === 'proposed' ? null : fixture.createdAt,
          fixture.from?.[0] ?? null,
          fixture.from?.[1] ?? null,
        ],
      );
      return goalRunId;
    }

    async function step(input: {
      readonly goalRunId: string;
      readonly key: string;
      readonly status: string;
      readonly introducedIn?: number;
      readonly failureCategory?: string;
      /** Attempts started (default 1); the current one is the last. */
      readonly attemptCount?: number;
    }): Promise<string> {
      const [row] = await raw<{ id: string }>(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision,
           superseded_in_revision, status, failure_category, attempt_count, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          workspaceId,
          input.goalRunId,
          input.key,
          input.introducedIn ?? 1,
          input.status === 'superseded' ? 2 : null,
          input.status,
          input.failureCategory ?? null,
          input.attemptCount ?? 1,
          ['succeeded', 'superseded', 'cancelled', 'skipped'].includes(input.status)
            ? new Date()
            : null,
        ],
      );
      return row?.id as string;
    }

    /** A Task of `stepRunId`'s attempt `attempt` (`null`: nested in one), with its runs. */
    async function ranTask(input: {
      readonly goalRunId: string;
      readonly stepRunId: string;
      readonly attempt: number | null;
      /** One run per entry, oldest first: `[startedAt, environment]`. */
      readonly runs: readonly (readonly [Date, string | null])[];
      readonly parentRunId?: string;
    }): Promise<string> {
      const taskId = randomUUID();
      await raw(
        `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, goal_run_id, step_run_id, plan_revision, step_attempt,
           run_config_snapshot)
         values ($1, $2, 'completed', $3, $4, 1, $5, $6, 1, $7, $8)`,
        [
          workspaceId,
          taskId,
          ownerId,
          definitionId,
          input.goalRunId,
          input.stepRunId,
          input.attempt,
          input.attempt !== null ? '{}' : null,
        ],
      );
      let lastRunId = '';
      for (const [index, [startedAt, environment]] of input.runs.entries()) {
        lastRunId = randomUUID();
        await raw(
          `insert into worker_runs (workspace_id, id, status, task_id, parent_worker_run_id,
             started_at, attempt, skills_recorded, run_spec, runtime_report, environment_digest)
           values ($1, $2, 'terminated', $3, $4, $5, $6, true, $7, $8, $9)`,
          [
            workspaceId,
            lastRunId,
            taskId,
            input.parentRunId ?? null,
            startedAt,
            index + 1,
            environment ? '{}' : null,
            environment ? '{}' : null,
            environment,
          ],
        );
      }
      return lastRunId;
    }

    /** One step transition record, as `moveStepRun` writes it. */
    async function stepRecord(
      stepRunId: string,
      event: string,
      createdAt: Date,
      failureCategory?: string,
    ): Promise<void> {
      await raw(
        `insert into audit_records (workspace_id, actor_principal_id, action, resource_type,
           resource_id, payload, created_at)
         values ($1, $2, $3, 'step_run', $4, $5, $6)`,
        [
          workspaceId,
          ownerId,
          `step_run.${event}`,
          stepRunId,
          JSON.stringify(failureCategory ? { failureCategory } : {}),
          createdAt,
        ],
      );
    }

    async function acceptanceCheck(goalRunId: string, round: number, status: string) {
      await raw(
        `insert into goal_acceptance_checks (workspace_id, goal_run_id, round, check_key,
           plan_revision, kind, observation_check, status, observation_id, settled_at)
         values ($1, $2, $3, 'c', 1, 'observe_predicate', '{}', $4, $5, $6)`,
        [
          workspaceId,
          goalRunId,
          round,
          status,
          status === 'pending' ? null : randomUUID(),
          status === 'pending' ? null : new Date(),
        ],
      );
    }

    async function claim(
      procedureId: string,
      version: number,
      claimedAt: Date,
      outcome?: string,
    ): Promise<void> {
      const turnId = randomUUID();
      await raw(
        `insert into turn_procedure_claims (workspace_id, turn_id, procedure_id,
           procedure_version, claimed_by, claimed_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, turnId, procedureId, version, ownerId, claimedAt],
      );
      if (outcome) {
        await raw(
          `insert into turn_outcomes (workspace_id, turn_id, outcome, given_by)
           values ($1, $2, $3, $4)`,
          [workspaceId, turnId, outcome, ownerId],
        );
      }
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
            'e2-2-procedure-stats',
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

    it('is null for a Procedure the workspace does not have', async () => {
      expect(await stats(randomUUID())).toBeNull();
    });

    it('counts the goals made from each version, their outcomes once each, the claimed Turns apart, segments by the set of environments, and groups the goals not achieved', async () => {
      const procedureId = await procedureFamily(['deprecated', 'published', 'draft']);
      const otherId = await procedureFamily(['published']);
      const ids: string[] = [];
      const remember = (id: string) => {
        ids.push(id);
        return id;
      };

      // ---- v1: one achieved by check, one the requester ended not achieved after s1 failed.
      const gA = remember(
        await goal({
          from: [procedureId, 1],
          status: 'completed',
          outcome: { outcome: 'achieved', basis: 'verified_by_check' },
          createdAt: at('09:00'),
          endedAt: at('09:30'),
        }),
      );
      const gAs = remember(await step({ goalRunId: gA, key: 's1', status: 'succeeded' }));
      await ranTask({ goalRunId: gA, stepRunId: gAs, attempt: 1, runs: [[at('09:05'), ENV_A]] });
      const gB = remember(
        await goal({
          from: [procedureId, 1],
          status: 'completed',
          outcome: { outcome: 'not_achieved', basis: 'requester' },
          createdAt: at('09:40'),
          endedAt: at('10:00'),
        }),
      );
      const gBs = remember(
        await step({
          goalRunId: gB,
          key: 's1',
          status: 'failed',
          failureCategory: 'contract_violation',
        }),
      );
      await ranTask({ goalRunId: gB, stepRunId: gBs, attempt: 1, runs: [[at('09:45'), ENV_A]] });

      // ---- v2.
      // gC: achieved (requester). Its environments are {A, B}: step s1's current attempt (2) ran
      // in A — attempt 1 ran in C and was replaced; step s2's attempt ran in B and its nested Task
      // in A; a Task whose crash retry moved from C to B counts its last run; a superseded step's
      // Task ran in C and does not count.
      const gC = remember(
        await goal({
          from: [procedureId, 2],
          status: 'completed',
          outcome: { outcome: 'achieved', basis: 'requester' },
          createdAt: at('10:00'),
          endedAt: at('10:50'),
        }),
      );
      const gCs1 = remember(
        await step({ goalRunId: gC, key: 's1', status: 'succeeded', attemptCount: 2 }),
      );
      await ranTask({ goalRunId: gC, stepRunId: gCs1, attempt: 1, runs: [[at('10:01'), ENV_C]] });
      await ranTask({ goalRunId: gC, stepRunId: gCs1, attempt: 2, runs: [[at('10:10'), ENV_A]] });
      const gCs2 = remember(await step({ goalRunId: gC, key: 's2', status: 'succeeded' }));
      const gCs2Run = await ranTask({
        goalRunId: gC,
        stepRunId: gCs2,
        attempt: 1,
        runs: [
          [at('10:20'), ENV_C],
          [at('10:25'), ENV_B],
        ],
      });
      await ranTask({
        goalRunId: gC,
        stepRunId: gCs2,
        attempt: null,
        runs: [[at('10:30'), ENV_A]],
        parentRunId: gCs2Run,
      });
      const gCold = remember(await step({ goalRunId: gC, key: 'old', status: 'superseded' }));
      await ranTask({ goalRunId: gC, stepRunId: gCold, attempt: 1, runs: [[at('10:02'), ENV_C]] });

      // gD: achieved by an independent review — a proxy outcome; also {A, B}.
      const gD = remember(
        await goal({
          from: [procedureId, 2],
          status: 'completed',
          outcome: { outcome: 'achieved', basis: 'reviewer_assessed' },
          createdAt: at('11:00'),
          endedAt: at('11:30'),
        }),
      );
      const gDs = remember(await step({ goalRunId: gD, key: 's1', status: 'succeeded' }));
      const gDRun = await ranTask({
        goalRunId: gD,
        stepRunId: gDs,
        attempt: 1,
        runs: [[at('11:01'), ENV_B]],
      });
      await ranTask({
        goalRunId: gD,
        stepRunId: gDs,
        attempt: null,
        runs: [[at('11:02'), ENV_A]],
        parentRunId: gDRun,
      });

      // gE running in {A}; gF still proposed; gG rejected at proposal (cancelled, never
      // confirmed): neither has run, so neither is in a segment, and gG is not a failure.
      const gE = remember(
        await goal({ from: [procedureId, 2], status: 'running', createdAt: at('12:00') }),
      );
      const gEs = remember(await step({ goalRunId: gE, key: 's1', status: 'running' }));
      await ranTask({ goalRunId: gE, stepRunId: gEs, attempt: 1, runs: [[at('12:01'), ENV_A]] });
      remember(await goal({ from: [procedureId, 2], status: 'proposed', createdAt: at('12:10') }));
      remember(
        await goal({
          from: [procedureId, 2],
          status: 'cancelled',
          confirmed: false,
          createdAt: at('12:20'),
          endedAt: at('12:25'),
        }),
      );

      // gH: cancelled after confirming, in {B}. s2 failed (transient) and was then cancelled with
      // the goal — its row no longer says how, its records do; s1 failed, was retried, and was
      // cancelled while ready — not a failed step.
      const gH = remember(
        await goal({
          from: [procedureId, 2],
          status: 'cancelled',
          createdAt: at('13:00'),
          endedAt: at('13:40'),
        }),
      );
      const gHs1 = remember(
        await step({ goalRunId: gH, key: 's1', status: 'cancelled', attemptCount: 1 }),
      );
      await stepRecord(gHs1, 'start', at('13:01'));
      await stepRecord(gHs1, 'fail', at('13:05'), 'outcome_unknown');
      await stepRecord(gHs1, 'retry', at('13:10'));
      await stepRecord(gHs1, 'cancel', at('13:40'));
      await ranTask({ goalRunId: gH, stepRunId: gHs1, attempt: 1, runs: [[at('13:02'), ENV_B]] });
      const gHs2 = remember(await step({ goalRunId: gH, key: 's2', status: 'cancelled' }));
      await stepRecord(gHs2, 'start', at('13:11'));
      await stepRecord(gHs2, 'fail', at('13:20'), 'transient');
      await stepRecord(gHs2, 'cancel', at('13:40'));
      await ranTask({ goalRunId: gH, stepRunId: gHs2, attempt: 1, runs: [[at('13:12'), ENV_B]] });

      // gI, gJ, gK: three goals in {A} the requester ended not achieved — the segment's latest
      // three primary outcomes, so it suggests a review.
      //   gI: s1 failed (outcome_unknown), and a step a revision added failed (action_refused) —
      //   its key is the requester's text and is not shown;
      //   gJ: no step failed; its latest acceptance round has a failed check;
      //   gK: no step failed; only an earlier round failed — the requester ended it.
      const gI = remember(
        await goal({
          from: [procedureId, 2],
          status: 'completed',
          outcome: { outcome: 'not_achieved', basis: 'requester' },
          createdAt: at('14:00'),
          endedAt: at('14:30'),
        }),
      );
      const gIs1 = remember(
        await step({
          goalRunId: gI,
          key: 's1',
          status: 'failed',
          failureCategory: 'outcome_unknown',
        }),
      );
      await ranTask({ goalRunId: gI, stepRunId: gIs1, attempt: 1, runs: [[at('14:01'), ENV_A]] });
      remember(
        await step({
          goalRunId: gI,
          key: 'fix-by-hand',
          introducedIn: 2,
          status: 'failed',
          failureCategory: 'action_refused',
        }),
      );
      const gJ = remember(
        await goal({
          from: [procedureId, 2],
          status: 'completed',
          outcome: { outcome: 'not_achieved', basis: 'requester' },
          createdAt: at('15:00'),
          endedAt: at('15:30'),
        }),
      );
      const gJs = remember(await step({ goalRunId: gJ, key: 's1', status: 'succeeded' }));
      await ranTask({ goalRunId: gJ, stepRunId: gJs, attempt: 1, runs: [[at('15:01'), ENV_A]] });
      await acceptanceCheck(gJ, 1, 'passed');
      await acceptanceCheck(gJ, 2, 'failed');
      const gK = remember(
        await goal({
          from: [procedureId, 2],
          status: 'completed',
          outcome: { outcome: 'not_achieved', basis: 'requester' },
          createdAt: at('16:00'),
          endedAt: at('16:30'),
        }),
      );
      const gKs = remember(await step({ goalRunId: gK, key: 's1', status: 'succeeded' }));
      await ranTask({ goalRunId: gK, stepRunId: gKs, attempt: 1, runs: [[at('16:01'), ENV_A]] });
      await acceptanceCheck(gK, 1, 'failed');
      await acceptanceCheck(gK, 2, 'passed');

      // gL: achieved (requester) with a run of unknown environment — its own segment, ended last;
      // it does not break {A}'s streak.
      const gL = remember(
        await goal({
          from: [procedureId, 2],
          status: 'completed',
          outcome: { outcome: 'achieved', basis: 'requester' },
          createdAt: at('17:00'),
          endedAt: at('17:30'),
        }),
      );
      const gLs = remember(await step({ goalRunId: gL, key: 's1', status: 'succeeded' }));
      const gLRun = await ranTask({
        goalRunId: gL,
        stepRunId: gLs,
        attempt: 1,
        runs: [[at('17:01'), ENV_A]],
      });
      await ranTask({
        goalRunId: gL,
        stepRunId: gLs,
        attempt: null,
        runs: [[at('17:02'), null]],
        parentRunId: gLRun,
      });

      // gM: s1 failed (outcome_unknown) before any Task ran — the same group as gI's s1.
      const gM = remember(
        await goal({
          from: [procedureId, 2],
          status: 'completed',
          outcome: { outcome: 'not_achieved', basis: 'requester' },
          createdAt: at('18:00'),
          endedAt: at('18:30'),
        }),
      );
      remember(
        await step({
          goalRunId: gM,
          key: 's1',
          status: 'failed',
          failureCategory: 'outcome_unknown',
        }),
      );

      // Not counted: a goal of another Procedure, a goal with a written plan.
      const other = await goal({
        from: [otherId, 1],
        status: 'completed',
        outcome: { outcome: 'not_achieved', basis: 'requester' },
        createdAt: at('19:00'),
        endedAt: at('19:10'),
      });
      await step({ goalRunId: other, key: 's1', status: 'failed', failureCategory: 'transient' });
      await goal({
        status: 'completed',
        outcome: { outcome: 'not_achieved', basis: 'requester' },
        createdAt: at('19:20'),
        endedAt: at('19:30'),
      });

      // Claims: three Turns on v2 (one achieved, one not, one with no outcome); one on the other
      // Procedure.
      await claim(procedureId, 2, at('08:00'), 'achieved');
      await claim(procedureId, 2, at('08:10'), 'not_achieved');
      await claim(procedureId, 2, at('08:20'));
      await claim(otherId, 1, at('08:30'), 'achieved');

      const result = await stats(procedureId);
      if (!result) throw new Error('expected statistics');
      expect(result).toMatchObject({
        procedureId,
        name: `procedure-${procedureId.slice(0, 8)}`,
        reviewStreak: 3,
      });
      expect(result.versions.map((v) => [v.version, v.status])).toEqual([
        [3, 'draft'],
        [2, 'published'],
        [1, 'deprecated'],
      ]);
      const [v3, v2, v1] = result.versions;

      expect(v3).toMatchObject({
        usage: { goals: 0, lastUsedAt: null },
        outcomes: { primary: { total: 0, attainment: null } },
        claims: { turns: 0, achieved: 0, notAchieved: 0, lastClaimedAt: null },
        reviewSuggested: false,
        segments: [],
      });

      expect(v1?.usage).toEqual({
        goals: 2,
        byStatus: { proposed: 0, inProgress: 0, completed: 2, cancelled: 0, failed: 0 },
        lastUsedAt: at('09:40').toISOString(),
      });
      expect(v1?.outcomes.primary).toEqual({
        achieved: 1,
        notAchieved: 1,
        total: 2,
        attainment: 0.5,
      });
      expect(v1?.segments.map((s) => s.environmentDigests)).toEqual([[ENV_A]]);
      expect(v1?.reviewSuggested).toBe(false);

      expect(v2?.usage).toEqual({
        goals: 11,
        byStatus: { proposed: 1, inProgress: 1, completed: 7, cancelled: 2, failed: 0 },
        lastUsedAt: at('18:00').toISOString(),
      });
      // Primary: gC, gL achieved; gI, gJ, gK, gM not. The review is a proxy.
      expect(v2?.outcomes.primary).toEqual({
        achieved: 2,
        notAchieved: 4,
        total: 6,
        attainment: 2 / 6,
      });
      expect(v2?.outcomes.proxy).toMatchObject({ achieved: 1, notAchieved: 0, total: 1 });
      expect(v2?.outcomes.byBasis).toEqual([
        { basis: 'verified_by_check', achieved: 0, notAchieved: 0 },
        { basis: 'requester', achieved: 2, notAchieved: 4 },
        { basis: 'reviewer_assessed', achieved: 1, notAchieved: 0 },
        { basis: 'agent_reported', achieved: 0, notAchieved: 0 },
      ]);
      // Claimed Turns: apart, never in the rate.
      expect(v2?.claims).toEqual({
        turns: 3,
        achieved: 1,
        notAchieved: 1,
        lastClaimedAt: at('08:20').toISOString(),
      });
      expect(v2?.reviewSuggested).toBe(true);

      // Segments, most recently used first: unknown (gL), {A} (gE, gI, gJ, gK), {B} (gH),
      // {A, B} (gC, gD). gF, gG and gM never ran.
      expect(v2?.segments.map((s) => s.environmentDigests)).toEqual([
        null,
        [ENV_A],
        [ENV_B],
        [ENV_A, ENV_B],
      ]);
      const [unknown, onlyA, onlyB, both] = v2?.segments ?? [];
      expect(unknown).toMatchObject({
        usage: { goals: 1, byStatus: { completed: 1 } },
        outcomes: { primary: { achieved: 1, total: 1 } },
        reviewSuggested: false,
      });
      expect(onlyA).toMatchObject({
        usage: { goals: 4, byStatus: { inProgress: 1, completed: 3 } },
        outcomes: { primary: { achieved: 0, notAchieved: 3, total: 3 } },
        reviewSuggested: true,
      });
      expect(onlyB).toMatchObject({
        usage: { goals: 1, byStatus: { cancelled: 1 } },
        outcomes: { primary: { total: 0 } },
        reviewSuggested: false,
      });
      expect(both).toMatchObject({
        usage: { goals: 2, byStatus: { completed: 2 } },
        outcomes: { primary: { achieved: 1, total: 1 }, proxy: { achieved: 1, total: 1 } },
        reviewSuggested: false,
      });

      // The goals not achieved: largest groups first, then the most recent.
      expect(result.failureGroups).toEqual([
        {
          procedureVersion: 2,
          place: 'procedure_step',
          stepKey: 's1',
          category: 'outcome_unknown',
          goals: 2,
          lastEndedAt: at('18:30').toISOString(),
        },
        {
          procedureVersion: 2,
          place: 'requester',
          stepKey: null,
          category: null,
          goals: 1,
          lastEndedAt: at('16:30').toISOString(),
        },
        {
          procedureVersion: 2,
          place: 'acceptance_check',
          stepKey: null,
          category: null,
          goals: 1,
          lastEndedAt: at('15:30').toISOString(),
        },
        {
          procedureVersion: 2,
          place: 'revised_step',
          stepKey: null,
          category: 'action_refused',
          goals: 1,
          lastEndedAt: at('14:30').toISOString(),
        },
        {
          procedureVersion: 2,
          place: 'procedure_step',
          stepKey: 's2',
          category: 'transient',
          goals: 1,
          lastEndedAt: at('13:40').toISOString(),
        },
        {
          procedureVersion: 1,
          place: 'procedure_step',
          stepKey: 's1',
          category: 'contract_violation',
          goals: 1,
          lastEndedAt: at('10:00').toISOString(),
        },
      ]);

      // Numbers only: no goal or step id, and not the revision's own step key.
      const sent = JSON.stringify(result);
      for (const id of ids) expect(sent).not.toContain(id);
      expect(sent).not.toContain('fix-by-hand');

      // find_procedures' hint is the version's primary count.
      const hints = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        readProcedureOutcomeHints(client, workspaceId, [
          { procedureId, version: 3 },
          { procedureId, version: 2 },
          { procedureId, version: 1 },
          { procedureId: otherId, version: 1 },
        ]),
      );
      expect(Object.fromEntries(hints)).toEqual({
        [`${procedureId}@3`]: { achieved: 0, total: 0 },
        [`${procedureId}@2`]: { achieved: 2, total: 6 },
        [`${procedureId}@1`]: { achieved: 1, total: 2 },
        [`${otherId}@1`]: { achieved: 0, total: 1 },
      });
      for (const version of result.versions) {
        expect(hints.get(`${procedureId}@${version.version}`)).toEqual({
          achieved: version.outcomes.primary.achieved,
          total: version.outcomes.primary.total,
        });
      }
    });
  },
);
