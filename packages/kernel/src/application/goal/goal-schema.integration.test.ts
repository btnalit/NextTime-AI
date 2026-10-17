import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  GOAL_RUN_EDGES,
  GOAL_RUN_STATUS_VALUES,
  PLAN_REVISION_EDGES,
  PLAN_REVISION_STATUS_VALUES,
  STEP_RUN_EDGES,
  STEP_RUN_STATUS_VALUES,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  getActionRequest,
  markActionRequestFailed,
  requestAction,
  startActionRequestExecution,
} from '../../governance/approval/index.js';
import { getGoalRun, listStepRuns, readStepActionEffect } from './index.js';

/**
 * application/goal — goal-schema.integration (S11 GO1, migrations/goal/0001, task/0007,
 * governance/0022): what the database refuses. Each state machine's edge set equals the shared
 * transition table pair by pair; illegal transitions, sub-states without their status or changed
 * without a transition, any change to a final row or to a row's identity, a revision accepted
 * against a stale base or beside another (I-G3, in one transaction or two concurrent ones), a step
 * created under a superseded revision (I-G2), a second Task for one attempt (I-G1) and a Task or
 * request claiming another goal's step are all refused by the database itself — written as
 * `nexttime_app`, the role every kernel write path uses, whatever the writer. The advancer splits a
 * step on its requests' `status` and `failure_kind` columns only.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'application/goal — goal_runs, plan_revisions, step_runs (S11 GO1, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    /** As `nexttime_app` under the workspace's RLS — the role every kernel write path uses. */
    const asApp = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    const sql = (text: string, params: readonly unknown[] = []) =>
      asApp((client) => client.query(text, [...params]));

    const BUDGET_COLUMNS =
      'budget_max_tokens, budget_max_steps, budget_max_revisions, budget_max_wall_clock_seconds';

    /** A `proposed` GoalRun with plan revision 1 (`steps`) proposed. */
    async function proposeGoal(steps: readonly string[] = ['A', 'B']): Promise<string> {
      const goal = await sql(
        `insert into goal_runs (workspace_id, on_behalf_of, statement, ${BUDGET_COLUMNS})
         values ($1, $2, 'ship the report', 100000, 10, 3, 3600) returning id`,
        [workspaceId, ownerId],
      );
      const goalRunId = goal.rows[0]?.id as string;
      await proposeRevision(goalRunId, 1, null, steps);
      return goalRunId;
    }

    async function proposeRevision(
      goalRunId: string,
      revision: number,
      basedOn: number | null,
      steps: readonly (string | Record<string, unknown>)[],
    ): Promise<void> {
      const plan = {
        steps: steps.map((step) => (typeof step === 'string' ? { key: step } : step)),
      };
      await sql(
        `insert into plan_revisions
           (workspace_id, goal_run_id, revision, based_on_revision, plan, proposed_by)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [workspaceId, goalRunId, revision, basedOn, JSON.stringify(plan), ownerId],
      );
    }

    const ACCEPT = `update plan_revisions set status = 'accepted', decided_by = $3, decided_at = now()
                    where workspace_id = $1 and goal_run_id = $2 and revision = $4`;
    const acceptIn = (client: PoolClient, goalRunId: string, revision: number) =>
      client.query(ACCEPT, [workspaceId, goalRunId, ownerId, revision]);
    /** Accepts a revision in a transaction of its own — refused at commit, since nothing adopts it. */
    const acceptRevision = (goalRunId: string, revision: number) =>
      asApp((client) => acceptIn(client, goalRunId, revision));

    const adoptIn = (client: PoolClient, goalRunId: string, revision: number, goalSet = '') =>
      client.query(
        `update goal_runs set current_revision = $3, updated_at = now()${goalSet ? `, ${goalSet}` : ''}
         where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId, revision],
      );
    /** A revision taking effect: accepted and made current in one transaction, with `goalSet`
     *  (more assignments to the GoalRun row) — the writes GO2 / GO5 make together. */
    const adopt = (goalRunId: string, revision: number, goalSet = '') =>
      asApp(async (client) => {
        await acceptIn(client, goalRunId, revision);
        await adoptIn(client, goalRunId, revision, goalSet);
      });

    const makeCurrent = (goalRunId: string, revision: number) =>
      sql(
        `update goal_runs set current_revision = $3, updated_at = now()
         where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId, revision],
      );

    /** Confirms a proposed GoalRun: accepts revision 1 and runs on it, then creates a `pending`
     *  StepRun per step — the writes the advancer makes (GO2). */
    async function confirmGoal(goalRunId: string, steps: readonly string[] = ['A', 'B']) {
      await adopt(goalRunId, 1, "status = 'running', confirmed_at = now()");
      for (const key of steps) await insertStep(goalRunId, key, 1);
    }

    async function insertStep(goalRunId: string, key: string, revision: number): Promise<string> {
      const result = await sql(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision)
         values ($1, $2, $3, $4) returning id`,
        [workspaceId, goalRunId, key, revision],
      );
      return result.rows[0]?.id as string;
    }

    async function runningGoal(steps: readonly string[] = ['A', 'B']): Promise<string> {
      const goalRunId = await proposeGoal(steps);
      await confirmGoal(goalRunId, steps);
      return goalRunId;
    }

    async function stepId(goalRunId: string, key: string): Promise<string> {
      const steps = await asApp((client) => listStepRuns(client, workspaceId, goalRunId));
      const step = steps.find(
        (candidate) => candidate.stepKey === key && candidate.status !== 'superseded',
      );
      if (!step) throw new Error(`no live step ${key}`);
      return step.id;
    }

    const setGoal = (goalRunId: string, set: string, params: readonly unknown[] = []) =>
      sql(`update goal_runs set ${set} where workspace_id = $1 and id = $2`, [
        workspaceId,
        goalRunId,
        ...params,
      ]);
    const setStep = (id: string, set: string, params: readonly unknown[] = []) =>
      sql(`update step_runs set ${set} where workspace_id = $1 and id = $2`, [
        workspaceId,
        id,
        ...params,
      ]);

    /** As the login role with the guards off — a row state the write path can no longer reach. */
    const raw = (text: string, params: readonly unknown[] = []) =>
      withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          return client.query(text, [...params]);
        },
        { skipRoleSwitch: true },
      );

    /** Two concurrent transactions: `first` runs its statements and holds its locks; `second` then
     *  starts, and once it waits on a lock, `first` runs `firstRest` and commits — so `second`
     *  carries on reading what `first` committed. Resolves to how `second` ended. */
    async function race(
      first: (client: PoolClient) => Promise<unknown>,
      firstRest: (client: PoolClient) => Promise<unknown>,
      second: (client: PoolClient) => Promise<unknown>,
    ): Promise<{ readonly error?: unknown }> {
      let held = () => {};
      const firstHolds = new Promise<void>((resolve) => {
        held = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstDone = asApp(async (client) => {
        await first(client);
        held();
        await released;
        await firstRest(client);
      });
      await Promise.race([firstHolds, firstDone]);
      let pid: number | undefined;
      let settled = false;
      const secondDone = asApp(async (client) => {
        pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
        return second(client);
      }).then(
        () => ({}),
        (error: unknown) => ({ error }),
      );
      void secondDone.then(() => {
        settled = true;
      });
      for (let tries = 0; !settled; tries += 1) {
        if (pid !== undefined) {
          const activity = await pool.query<{ wait_event_type: string | null }>(
            'select wait_event_type from pg_stat_activity where pid = $1',
            [pid],
          );
          if (activity.rows[0]?.wait_event_type === 'Lock') break;
        }
        if (tries > 400) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(settled, 'the second transaction waits for the first').toBe(false);
      release();
      await firstDone;
      return secondDone;
    }

    /** A Task row for a step (as the advancer or `invoke_worker` writes it). */
    const insertTask = (fields: {
      goalRunId?: string | null;
      stepRunId?: string | null;
      planRevision?: number | null;
      stepAttempt?: number | null;
      snapshot?: Record<string, unknown> | null;
    }) =>
      sql(
        `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, goal_run_id, step_run_id, plan_revision, step_attempt,
           run_config_snapshot)
         values ($1, 'queued', $2, $3, 1, $4, $5, $6, $7, $8::jsonb) returning id`,
        [
          workspaceId,
          ownerId,
          randomUUID(),
          fields.goalRunId ?? null,
          fields.stepRunId ?? null,
          fields.planRevision ?? null,
          fields.stepAttempt ?? null,
          fields.snapshot === undefined || fields.snapshot === null
            ? null
            : JSON.stringify(fields.snapshot),
        ],
      );

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
            'go1-goal-schema',
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

    describe('the database edge sets equal the shared transition tables', () => {
      it.each([
        ['goal_run_transition_allowed', GOAL_RUN_STATUS_VALUES, GOAL_RUN_EDGES],
        ['plan_revision_transition_allowed', PLAN_REVISION_STATUS_VALUES, PLAN_REVISION_EDGES],
        ['step_run_transition_allowed', STEP_RUN_STATUS_VALUES, STEP_RUN_EDGES],
      ] as const)('%s, every (from, to) pair', async (fn, statuses, edges) => {
        const result = await sql(
          `select f, t, ${fn}(f, t) as allowed
             from unnest($1::text[]) as f cross join unnest($1::text[]) as t`,
          [[...statuses]],
        );
        const legal = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));
        expect(result.rows).toHaveLength(statuses.length * statuses.length);
        for (const row of result.rows as { f: string; t: string; allowed: boolean }[]) {
          expect(row.allowed, `${row.f}->${row.t}`).toBe(legal.has(`${row.f}->${row.t}`));
        }
      });
    });

    describe('goal/0002 replaces the GoalRun guard with one more changeable column (S11 GO2)', () => {
      it('is goal/0001’s goal_runs_status_guard with next_tick_at listed, and nothing else changed', () => {
        const guardOf = (file: string) => {
          const text = readFileSync(path.join(MIGRATIONS_DIR, 'goal', file), 'utf8');
          const start = text.indexOf('create or replace function goal_runs_status_guard()');
          expect(start, file).toBeGreaterThanOrEqual(0);
          const end = text.indexOf('\n$$;', start);
          expect(end, file).toBeGreaterThan(start);
          return text.slice(start, end).replace(/\s+/g, ' ');
        };
        const before = guardOf('0001_goal_runs.sql');
        const after = guardOf('0002_goal_advancer.sql');
        expect(before).toContain("'ended_at'])");
        expect(after).toBe(before.replace("'ended_at'])", "'ended_at', 'next_tick_at'])"));
      });
    });

    describe('goal/0003 lets a step of a cancelling goal run only end (S11 GO3a)', () => {
      it('is goal/0001’s step_runs_status_guard with cancelling among the ending statuses, and nothing else changed', () => {
        const guardOf = (file: string) => {
          const text = readFileSync(path.join(MIGRATIONS_DIR, 'goal', file), 'utf8');
          const start = text.indexOf('create or replace function step_runs_status_guard()');
          expect(start, file).toBeGreaterThanOrEqual(0);
          const end = text.indexOf('\n$$;', start);
          expect(end, file).toBeGreaterThan(start);
          return text.slice(start, end).replace(/\s+/g, ' ');
        };
        const before = guardOf('0001_goal_runs.sql');
        const after = guardOf('0003_goal_cancelling.sql');
        const ending = "goal_status in ('completed', 'cancelled', 'failed') then";
        expect(before.split(ending)).toHaveLength(2);
        expect(after).toBe(
          before.replace(
            ending,
            "goal_status in ('cancelling', 'completed', 'cancelled', 'failed') then",
          ),
        );
      });
    });

    describe('goal/0004 records who paused, failed advances and what a revision removed (S11 GO3b)', () => {
      const guardOf = (file: string) => {
        const text = readFileSync(path.join(MIGRATIONS_DIR, 'goal', file), 'utf8');
        const start = text.indexOf('create or replace function goal_runs_status_guard()');
        expect(start, file).toBeGreaterThanOrEqual(0);
        const end = text.indexOf('\n$$;', start);
        expect(end, file).toBeGreaterThan(start);
        return text.slice(start, end).replace(/\s+/g, ' ');
      };

      it('is goal/0002’s goal_runs_status_guard with three more changeable columns and the hold rules, and nothing else changed', () => {
        const before = guardOf('0002_goal_advancer.sql');
        const after = guardOf('0004_goal_revision_hold.sql');
        const holdStart = after.indexOf('-- goal/0004:');
        const holdEnd = after.indexOf('if new.current_revision is distinct');
        expect(holdStart).toBeGreaterThan(
          after.indexOf('the pause reason is set by the transition'),
        );
        expect(holdEnd).toBeGreaterThan(holdStart);
        const hold = after.slice(holdStart, holdEnd);
        expect(hold).toContain('only to place an owner');
        expect(hold).toContain('it resumes only after an owner lifts the hold');
        expect(before).toContain("'ended_at', 'next_tick_at'])");
        expect(after.replace(hold, '')).toBe(
          before.replace(
            "'ended_at', 'next_tick_at'])",
            "'ended_at', 'next_tick_at', 'paused_by', 'paused_by_authority', 'advance_failures'])",
          ),
        );
      });

      it('names who paused only while paused, with an authority, and keeps the failure count non-negative', async () => {
        const goalRunId = await runningGoal();
        await expect(
          setGoal(goalRunId, "paused_by = $3, paused_by_authority = 'requester'", [ownerId]),
        ).rejects.toThrow(/goal_runs_paused_by/);
        await expect(
          setGoal(goalRunId, "status = 'paused', pause_reason = 'requested', paused_by = $3", [
            ownerId,
          ]),
        ).rejects.toThrow(/goal_runs_paused_by/);
        await expect(
          setGoal(
            goalRunId,
            "status = 'paused', pause_reason = 'requested', paused_by = $3, paused_by_authority = 'admin'",
            [ownerId],
          ),
        ).rejects.toThrow(/goal_runs_paused_by/);
        await expect(
          setGoal(
            goalRunId,
            "status = 'paused', pause_reason = 'requested', paused_by = $3, paused_by_authority = 'owner'",
            [randomUUID()],
          ),
        ).rejects.toThrow(/goal_runs_paused_by_fk/);
        await expect(setGoal(goalRunId, 'advance_failures = -1')).rejects.toThrow(
          /goal_runs_advance_failures/,
        );
        await setGoal(goalRunId, 'advance_failures = 3');
        await setGoal(goalRunId, 'advance_failures = 0');
      });

      it('a person’s pause stays theirs; an owner places a hold, only lifting it clears it, and a held run does not resume', async () => {
        const goalRunId = await runningGoal();
        await setGoal(
          goalRunId,
          "status = 'paused', pause_reason = 'requested', paused_by = $3, paused_by_authority = 'requester'",
          [ownerId],
        );
        // The requester's own pause: cleared only by leaving `paused`.
        await expect(
          setGoal(goalRunId, 'paused_by = null, paused_by_authority = null'),
        ).rejects.toThrow(
          /while paused, who paused changes only to place an owner's hold or to lift it \(requester -> advancer\)/,
        );
        await setGoal(goalRunId, "paused_by_authority = 'owner'");
        await expect(setGoal(goalRunId, "paused_by_authority = 'requester'")).rejects.toThrow(
          /\(owner -> requester\)/,
        );
        await expect(
          setGoal(
            goalRunId,
            "status = 'running', pause_reason = null, paused_by = null, paused_by_authority = null",
          ),
        ).rejects.toThrow(/a workspace owner holds this goal run/);
        await setGoal(goalRunId, 'paused_by = null, paused_by_authority = null');
        await expect(
          setGoal(goalRunId, "paused_by = $3, paused_by_authority = 'requester'", [ownerId]),
        ).rejects.toThrow(/\(advancer -> requester\)/);
        await setGoal(goalRunId, "status = 'running', pause_reason = null");
        // The advancer's pause names nobody; an owner may still place a hold on it.
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'needs_decision'");
        await setGoal(goalRunId, "paused_by = $3, paused_by_authority = 'owner'", [ownerId]);
        // Cancelling a held run is still a stop: leaving `paused` clears who paused.
        await setGoal(
          goalRunId,
          "status = 'cancelling', pause_reason = null, paused_by = null, paused_by_authority = null",
        );
      });

      it('a revision’s removals are an object, empty on revision 1, and never change', async () => {
        const goalRunId = await proposeGoal();
        await expect(
          sql(
            `insert into plan_revisions
               (workspace_id, goal_run_id, revision, based_on_revision, plan, proposed_by, removals)
             values ($1, $2, 2, 1, '{"steps":[{"key":"A"}]}'::jsonb, $3, '[]'::jsonb)`,
            [workspaceId, goalRunId, ownerId],
          ),
        ).rejects.toThrow(/plan_revisions_removals/);
        await expect(
          sql(
            `update plan_revisions set removals = '{"A":{"mode":"terminate"}}'::jsonb
             where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
            [workspaceId, goalRunId],
          ),
        ).rejects.toThrow(/a revision's content never changes \(removals\)/);
        await expect(
          raw(
            `update plan_revisions set removals = '{"A":{"mode":"terminate"}}'::jsonb
             where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
            [workspaceId, goalRunId],
          ),
        ).rejects.toThrow(/plan_revisions_removals/);
        await confirmGoal(goalRunId);
        await sql(
          `insert into plan_revisions
             (workspace_id, goal_run_id, revision, based_on_revision, plan, proposed_by, removals)
           values ($1, $2, 2, 1, '{"steps":[{"key":"B"}]}'::jsonb, $3,
                   '{"A":{"mode":"let_finish"}}'::jsonb)`,
          [workspaceId, goalRunId, ownerId],
        );
        await expect(
          sql(
            `update plan_revisions set removals = '{}'::jsonb
             where workspace_id = $1 and goal_run_id = $2 and revision = 2`,
            [workspaceId, goalRunId],
          ),
        ).rejects.toThrow(/a revision's content never changes \(removals\)/);
      });
    });

    describe('GoalRun', () => {
      it('walks proposed → running → paused → running → verifying → completed(achieved)', async () => {
        const goalRunId = await runningGoal();
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'requested'");
        await setGoal(goalRunId, "status = 'running', pause_reason = null");
        await setGoal(goalRunId, "status = 'verifying'");
        await setGoal(
          goalRunId,
          "status = 'completed', outcome = 'achieved', outcome_basis = 'verified_by_check', ended_at = now()",
        );
        const goal = await asApp((client) => getGoalRun(client, workspaceId, goalRunId));
        expect(goal).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
          currentRevision: 1,
          budget: { maxTokens: 100000, maxSteps: 10, maxRevisions: 3, maxWallClockSeconds: 3600 },
        });
      });

      it('is created proposed only', async () => {
        await expect(
          sql(
            `insert into goal_runs (workspace_id, status, on_behalf_of, statement, ${BUDGET_COLUMNS})
             values ($1, 'running', $2, 'x', 1, 1, 0, 1)`,
            [workspaceId, ownerId],
          ),
        ).rejects.toThrow(/created proposed/);
      });

      it('refuses illegal transitions: no completion without verification, nothing out of a terminal status', async () => {
        const goalRunId = await runningGoal();
        await expect(
          setGoal(
            goalRunId,
            "status = 'completed', outcome = 'achieved', outcome_basis = 'requester', ended_at = now()",
          ),
        ).rejects.toThrow(/illegal transition running -> completed/);
        await setGoal(goalRunId, "status = 'failed', ended_at = now()");
        await expect(setGoal(goalRunId, "status = 'running', ended_at = null")).rejects.toThrow(
          /illegal transition failed -> running/,
        );
      });

      it('cancels a confirmed run only through cancelling, and marks cleanup_pending only on cancelled', async () => {
        const goalRunId = await runningGoal();
        await expect(setGoal(goalRunId, "status = 'cancelled', ended_at = now()")).rejects.toThrow(
          /illegal transition running -> cancelled/,
        );
        await setGoal(goalRunId, "status = 'cancelling'");
        await expect(setGoal(goalRunId, 'cleanup_pending = true')).rejects.toThrow(
          /goal_runs_cleanup_pending/,
        );
        await setGoal(goalRunId, "status = 'cancelled', cleanup_pending = true, ended_at = now()");
      });

      it('rejects an unconfirmed goal straight to cancelled', async () => {
        const goalRunId = await proposeGoal();
        await setGoal(goalRunId, "status = 'cancelled', ended_at = now()");
        const goal = await asApp((client) => getGoalRun(client, workspaceId, goalRunId));
        expect(goal).toMatchObject({
          status: 'cancelled',
          currentRevision: null,
          confirmedAt: null,
        });
      });

      it('keeps every sub-state with its status (CHECKs)', async () => {
        const goalRunId = await runningGoal();
        await expect(setGoal(goalRunId, "status = 'paused'")).rejects.toThrow(
          /goal_runs_pause_reason/,
        );
        await expect(setGoal(goalRunId, "pause_reason = 'requested'")).rejects.toThrow(
          /goal_runs_pause_reason/,
        );
        await expect(
          setGoal(goalRunId, "outcome = 'achieved', outcome_basis = 'requester'"),
        ).rejects.toThrow(/goal_runs_outcome/);
        await setGoal(goalRunId, "status = 'verifying'");
        await expect(
          setGoal(goalRunId, "status = 'completed', outcome = 'achieved', ended_at = now()"),
        ).rejects.toThrow(/goal_runs_outcome/);
        await expect(
          setGoal(
            goalRunId,
            "status = 'completed', outcome = 'achieved', outcome_basis = 'verified_by_check'",
          ),
        ).rejects.toThrow(/goal_runs_ended/);
      });

      it('never rests an outcome on the agent’s own report (I-G5)', async () => {
        const goalRunId = await runningGoal();
        await setGoal(goalRunId, "status = 'verifying'");
        await expect(
          setGoal(
            goalRunId,
            "status = 'completed', outcome = 'achieved', outcome_basis = 'agent_reported', ended_at = now()",
          ),
        ).rejects.toThrow(/goal_runs_outcome_basis_check/);
      });

      it('confirms only onto an accepted revision, and the current revision never goes back or clears (I-G2)', async () => {
        const goalRunId = await proposeGoal();
        await expect(
          setGoal(goalRunId, "status = 'running', current_revision = 1, confirmed_at = now()"),
        ).rejects.toThrow(/revision 1 is not an accepted revision/);
        await confirmGoal(goalRunId);
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await adopt(goalRunId, 2);
        await expect(makeCurrent(goalRunId, 1)).rejects.toThrow(/never goes back/);
        await expect(
          setGoal(goalRunId, 'current_revision = null, confirmed_at = null'),
        ).rejects.toThrow(/never goes back/);
      });

      it('never changes its requester', async () => {
        const goalRunId = await proposeGoal();
        const other = randomUUID();
        await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'member', 'other')",
              [workspaceId, other],
            ),
          { skipRoleSwitch: true },
        );
        await expect(setGoal(goalRunId, 'on_behalf_of = $3', [other])).rejects.toThrow(
          /requester, the originating turn, the statement and created_at never change \(on_behalf_of\)/,
        );
      });

      it('starts at most one GoalRun per Turn', async () => {
        const turn = await sql(
          `insert into activities (workspace_id, kind, status, started_by)
           values ($1, 'agent_turn', 'completed', $2) returning id`,
          [workspaceId, ownerId],
        );
        const turnId = turn.rows[0]?.id as string;
        const insertForTurn = () =>
          sql(
            `insert into goal_runs (workspace_id, on_behalf_of, originated_in_turn_id, statement, ${BUDGET_COLUMNS})
             values ($1, $2, $3, 'x', 1, 1, 0, 1)`,
            [workspaceId, ownerId, turnId],
          );
        await insertForTurn();
        await expect(insertForTurn()).rejects.toThrow(/goal_runs_one_per_turn/);
      });
    });

    describe('PlanRevision', () => {
      it('is created proposed, with unique, well-formed step keys', async () => {
        const goalRunId = await proposeGoal();
        await expect(
          sql(
            `insert into plan_revisions (workspace_id, goal_run_id, revision, based_on_revision, status, plan, proposed_by)
             values ($1, $2, 2, 1, 'accepted', '{"steps":[]}', $3)`,
            [workspaceId, goalRunId, ownerId],
          ),
        ).rejects.toThrow(/created proposed/);
        await expect(proposeRevision(goalRunId, 2, 1, ['A', 'A'])).rejects.toThrow(
          /step keys are unique/,
        );
        await expect(proposeRevision(goalRunId, 2, 1, [{ name: 'no key' }])).rejects.toThrow(
          /every step is an object with a key/,
        );
        await expect(
          sql(
            `insert into plan_revisions (workspace_id, goal_run_id, revision, based_on_revision, plan, proposed_by)
             values ($1, $2, 2, 1, '{"steps":{}}', $3)`,
            [workspaceId, goalRunId, ownerId],
          ),
        ).rejects.toThrow(/plan_revisions_plan_shape/);
        await expect(proposeRevision(goalRunId, 2, null, ['A'])).rejects.toThrow(
          /plan_revisions_based_on/,
        );
      });

      it('never changes its content, and is decided once', async () => {
        const goalRunId = await runningGoal();
        const setRevision = (set: string) =>
          sql(
            `update plan_revisions set ${set} where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
            [workspaceId, goalRunId],
          );
        await expect(setRevision(`plan = '{"steps":[]}'`)).rejects.toThrow(/content never changes/);
        await expect(setRevision(`validation = '{"ok":true}'`)).rejects.toThrow(
          /validation is recorded before/,
        );
        await expect(setRevision("status = 'rejected'")).rejects.toThrow(
          /illegal transition accepted -> rejected/,
        );
        await expect(setRevision('decided_at = now()')).rejects.toThrow(/decided once/);
      });

      it('records validation while proposed', async () => {
        const goalRunId = await proposeGoal();
        await sql(
          `update plan_revisions set validation = '{"acyclic":true}'
           where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
          [workspaceId, goalRunId],
        );
      });

      it('is accepted only on top of the current revision: of two revisions of the same base, the second is refused (I-G3)', async () => {
        const goalRunId = await runningGoal();
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await proposeRevision(goalRunId, 3, 1, ['A', 'D']);
        await adopt(goalRunId, 2);
        await expect(adopt(goalRunId, 3)).rejects.toThrow(
          /revision 3 is based on 1, but the current revision is 2 \(I-G3\)/,
        );
      });
    });

    describe('StepRun', () => {
      it('walks pending → ready → running → waiting → running → succeeded', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setStep(a, "status = 'waiting', waiting_reason = 'approval'");
        await setStep(a, "status = 'running', waiting_reason = null");
        await setStep(a, "status = 'succeeded', ended_at = now()");
        const steps = await asApp((client) => listStepRuns(client, workspaceId, goalRunId));
        expect(steps.find((step) => step.id === a)).toMatchObject({
          status: 'succeeded',
          attemptCount: 1,
          introducedInRevision: 1,
        });
      });

      it('is created pending, only for a step of an accepted revision', async () => {
        const goalRunId = await runningGoal();
        await expect(
          sql(
            `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision, status)
             values ($1, $2, 'Z', 1, 'ready')`,
            [workspaceId, goalRunId],
          ),
        ).rejects.toThrow(/created pending/);
        await expect(insertStep(goalRunId, 'Z', 1)).rejects.toThrow(
          /step Z is not in accepted revision 1/,
        );
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'Z']);
        await expect(insertStep(goalRunId, 'Z', 2)).rejects.toThrow(
          /step Z is introduced in revision 2, but the current revision is 1 \(I-G2\)/,
        );
      });

      it('refuses illegal transitions and sub-states without their status', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await expect(setStep(a, "status = 'running'")).rejects.toThrow(
          /illegal transition pending -> running/,
        );
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await expect(setStep(a, "status = 'waiting'")).rejects.toThrow(/step_runs_waiting_reason/);
        await expect(setStep(a, "status = 'failed'")).rejects.toThrow(/step_runs_failure_category/);
        await setStep(a, "status = 'failed', failure_category = 'transient'");
        await setStep(a, "status = 'ready', failure_category = null");
        await expect(setStep(a, 'attempt_count = 0')).rejects.toThrow(
          /attempts are counted only when a step starts/,
        );
        await expect(setStep(a, "step_key = 'Q'")).rejects.toThrow(/identity never changes/);
      });

      it('keeps a succeeded step: it cannot be superseded', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setStep(a, "status = 'succeeded', ended_at = now()");
        await proposeRevision(goalRunId, 2, 1, ['B']);
        await adopt(goalRunId, 2);
        await expect(
          setStep(a, "status = 'superseded', superseded_in_revision = 2"),
        ).rejects.toThrow(/illegal transition succeeded -> superseded/);
      });

      it('a revision supersedes a step and may bring the key back as a new StepRun; two live steps never share a key', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await expect(insertStep(goalRunId, 'A', 1)).rejects.toThrow(/step_runs_one_live_per_key/);
        await proposeRevision(goalRunId, 2, 1, [{ key: 'A', note: 'redefined' }, 'B']);
        await expect(
          setStep(a, "status = 'superseded', superseded_in_revision = 2, ended_at = now()"),
        ).rejects.toThrow(/superseded by the current revision 1, not by 2 \(I-G2\)/);
        await adopt(goalRunId, 2);
        await expect(
          setStep(a, "status = 'superseded', superseded_in_revision = 1, ended_at = now()"),
        ).rejects.toThrow(/superseded by the current revision 2, not by 1 \(I-G2\)/);
        await setStep(a, "status = 'superseded', superseded_in_revision = 2, ended_at = now()");
        const again = await insertStep(goalRunId, 'A', 2);
        expect(again).not.toBe(a);
        expect(await stepId(goalRunId, 'A')).toBe(again);
      });
    });

    describe('GoalRun — what may change, and when', () => {
      /** A completed GoalRun with revision 2 still proposed. */
      async function completedGoal(): Promise<string> {
        const goalRunId = await runningGoal();
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await setGoal(goalRunId, "status = 'verifying'");
        await setGoal(
          goalRunId,
          "status = 'completed', outcome = 'achieved', outcome_basis = 'verified_by_check', ended_at = now()",
        );
        return goalRunId;
      }

      it.each([
        ["outcome = 'not_achieved', outcome_basis = 'requester'", 'outcome, outcome_basis'],
        ['budget_max_tokens = 1', 'budget_max_tokens'],
        ["confirmed_at = now() - interval '1 day'", 'confirmed_at'],
        ["ended_at = now() - interval '1 day'", 'ended_at'],
        ['current_revision = 2', 'current_revision'],
      ])(
        'a completed goal run is final: refuses %s (I-G5: the outcome is never rewritten)',
        async (set, columns) => {
          const goalRunId = await completedGoal();
          await expect(setGoal(goalRunId, set)).rejects.toThrow(
            new RegExp(`a completed goal run is final; ${columns} cannot change`),
          );
        },
      );

      it('a completed goal run takes no new revision and accepts none', async () => {
        const goalRunId = await completedGoal();
        await expect(proposeRevision(goalRunId, 3, 1, ['A'])).rejects.toThrow(
          /a completed goal run takes no new revision/,
        );
        await expect(adopt(goalRunId, 2)).rejects.toThrow(
          /a completed goal run accepts no revision \(I-G3\)/,
        );
        await setGoal(goalRunId, 'updated_at = now()');
      });

      it('a cancelled goal run only clears cleanup_pending', async () => {
        const goalRunId = await runningGoal();
        await setGoal(goalRunId, "status = 'cancelling'");
        await setGoal(goalRunId, "status = 'cancelled', cleanup_pending = true, ended_at = now()");
        await expect(setGoal(goalRunId, 'budget_max_steps = 99')).rejects.toThrow(
          /a cancelled goal run is final; budget_max_steps cannot change/,
        );
        await setGoal(goalRunId, 'cleanup_pending = false');
        await expect(setGoal(goalRunId, 'cleanup_pending = true')).rejects.toThrow(
          /cleanup_pending is set by the transition into cancelled/,
        );
      });

      it('never changes its statement: changing the goal is a revision a person proposes (§4.6)', async () => {
        const goalRunId = await proposeGoal();
        await expect(setGoal(goalRunId, "statement = 'another goal'")).rejects.toThrow(
          /never change \(statement\)/,
        );
      });

      it('keeps its pause reason while paused, and writes confirmed_at once', async () => {
        const goalRunId = await runningGoal();
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'requested'");
        await expect(setGoal(goalRunId, "pause_reason = 'needs_decision'")).rejects.toThrow(
          /the pause reason is set by the transition into paused/,
        );
        await expect(
          setGoal(goalRunId, "confirmed_at = now() - interval '1 hour'"),
        ).rejects.toThrow(/confirmed_at is written once/);
        await setGoal(goalRunId, "status = 'running', pause_reason = null");
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'needs_decision'");
      });

      it('changes its budget before confirmation, or with the revision that takes effect', async () => {
        const goalRunId = await proposeGoal();
        await setGoal(goalRunId, 'budget_max_tokens = 200000');
        await confirmGoal(goalRunId);
        await expect(setGoal(goalRunId, 'budget_max_tokens = 300000')).rejects.toThrow(
          /the budget changes before confirmation or with the revision that takes effect/,
        );
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await adopt(goalRunId, 2, 'budget_max_tokens = 300000');
        const goal = await asApp((client) => getGoalRun(client, workspaceId, goalRunId));
        expect(goal).toMatchObject({ currentRevision: 2, budget: { maxTokens: 300000 } });
      });

      it('takes a revision only while proposed, running or paused — not while verifying or winding down', async () => {
        const verifying = await runningGoal();
        await proposeRevision(verifying, 2, 1, ['A']);
        await setGoal(verifying, "status = 'verifying'");
        await expect(adopt(verifying, 2)).rejects.toThrow(
          /a verifying goal run accepts no revision \(I-G3\)/,
        );
        // Accepted with the guard off: the GoalRun still does not adopt it.
        await raw(
          `update plan_revisions set status = 'accepted', decided_by = $3, decided_at = now()
           where workspace_id = $1 and goal_run_id = $2 and revision = 2`,
          [workspaceId, verifying, ownerId],
        );
        await expect(makeCurrent(verifying, 2)).rejects.toThrow(
          /a revision takes effect only while the goal run is proposed, running or paused \(verifying -> verifying\)/,
        );
        const cancelling = await runningGoal();
        await setGoal(cancelling, "status = 'cancelling'");
        await expect(proposeRevision(cancelling, 2, 1, ['A'])).rejects.toThrow(
          /a cancelling goal run takes no new revision/,
        );
      });
    });

    describe('PlanRevision — the accepted revisions are one chain (I-G3)', () => {
      const revisionStatus = async (goalRunId: string, revision: number) =>
        (
          await sql(
            'select status from plan_revisions where workspace_id = $1 and goal_run_id = $2 and revision = $3',
            [workspaceId, goalRunId, revision],
          )
        ).rows[0]?.status;

      it('of two revisions on the same base accepted in one transaction, the second is refused', async () => {
        const goalRunId = await runningGoal();
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await proposeRevision(goalRunId, 3, 1, ['A', 'D']);
        await expect(
          asApp(async (client) => {
            await acceptIn(client, goalRunId, 2);
            await acceptIn(client, goalRunId, 3);
          }),
        ).rejects.toThrow(
          /revision 2 is accepted but not yet current, so revision 3 cannot be accepted beside it \(I-G3\)/,
        );
        await expect(
          asApp(async (client) => {
            await acceptIn(client, goalRunId, 2);
            await adoptIn(client, goalRunId, 2);
            await acceptIn(client, goalRunId, 3);
          }),
        ).rejects.toThrow(/revision 3 is based on 1, but the current revision is 2 \(I-G3\)/);
        // Both rolled back. Once one of the two takes effect, the one it skipped never can.
        await adopt(goalRunId, 3);
        await expect(adopt(goalRunId, 2)).rejects.toThrow(
          /revision 2 is based on 1, but the current revision is 3 \(I-G3\)/,
        );
        expect(await revisionStatus(goalRunId, 2)).toBe('proposed');
      });

      it('of two revisions on the same base accepted concurrently, the second waits for the first and is refused', async () => {
        const goalRunId = await runningGoal();
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await proposeRevision(goalRunId, 3, 1, ['A', 'D']);
        const second = await race(
          (client) => acceptIn(client, goalRunId, 2),
          (client) => adoptIn(client, goalRunId, 2),
          async (client) => {
            await acceptIn(client, goalRunId, 3);
            await adoptIn(client, goalRunId, 3);
          },
        );
        expect(String(second.error)).toMatch(
          /revision 3 is based on 1, but the current revision is 2 \(I-G3\)/,
        );
        expect(await asApp((client) => getGoalRun(client, workspaceId, goalRunId))).toMatchObject({
          currentRevision: 2,
        });
        expect(await revisionStatus(goalRunId, 3)).toBe('proposed');
      });

      it('takes effect in the transaction that accepts it, or the acceptance is refused at commit', async () => {
        const goalRunId = await runningGoal();
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await expect(acceptRevision(goalRunId, 2)).rejects.toThrow(
          /revision 2 was accepted, but its goal run did not adopt it in the same transaction \(I-G3\)/,
        );
        expect(await revisionStatus(goalRunId, 2)).toBe('proposed');
      });

      it('is adopted only as the next link of the chain', async () => {
        const goalRunId = await runningGoal();
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await proposeRevision(goalRunId, 3, 1, ['A', 'D']);
        await adopt(goalRunId, 2);
        // Revision 3 accepted with the guard off, as a bug or a hand edit would.
        await raw(
          `update plan_revisions set status = 'accepted', decided_by = $3, decided_at = now()
           where workspace_id = $1 and goal_run_id = $2 and revision = 3`,
          [workspaceId, goalRunId, ownerId],
        );
        await expect(makeCurrent(goalRunId, 3)).rejects.toThrow(
          /revision 3 is based on 1, not on the current revision 2 \(I-G3\)/,
        );
      });
    });

    describe('StepRun — what may change, and when', () => {
      it.each([
        ['attempt_count = 7', 'attempt_count'],
        ["ended_at = now() - interval '1 day'", 'ended_at'],
      ])('a skipped step run is final: refuses %s', async (set, column) => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'skipped', ended_at = now()");
        await expect(setStep(a, set)).rejects.toThrow(
          new RegExp(`a skipped step run is final; ${column} cannot change`),
        );
      });

      it('keeps its waiting reason while waiting and its failure category while failed', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setStep(a, "status = 'waiting', waiting_reason = 'approval'");
        await expect(setStep(a, "waiting_reason = 'reconcile'")).rejects.toThrow(
          /the waiting reason is set by the transition into waiting/,
        );
        await setStep(
          a,
          "status = 'failed', waiting_reason = null, failure_category = 'transient'",
        );
        await expect(setStep(a, "failure_category = 'action_refused'")).rejects.toThrow(
          /the failure category is set by the transition into failed/,
        );
      });

      it('counts one attempt at each start (ready -> running), and at no other time (I-G1)', async () => {
        const goalRunId = await proposeGoal(['A', 'B']);
        await confirmGoal(goalRunId, ['A']);
        await expect(
          sql(
            `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision, attempt_count)
             values ($1, $2, 'B', 1, 1)`,
            [workspaceId, goalRunId],
          ),
        ).rejects.toThrow(/created with no attempts, not 1 \(I-G1\)/);
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'ready'");
        await expect(setStep(a, "status = 'running'")).rejects.toThrow(
          /each start \(ready -> running\) is one new attempt, not 0 -> 0 \(I-G1\)/,
        );
        await expect(setStep(a, "status = 'running', attempt_count = 2")).rejects.toThrow(
          /one new attempt, not 0 -> 2/,
        );
        await setStep(a, "status = 'running', attempt_count = 1");
        await expect(setStep(a, 'attempt_count = 2')).rejects.toThrow(
          /attempts are counted only when a step starts \(ready -> running\), not 1 -> 2/,
        );
        await setStep(a, "status = 'failed', failure_category = 'transient'");
        await setStep(a, "status = 'ready', failure_category = null");
        await setStep(a, "status = 'running', attempt_count = 2");
      });

      it('takes on new work only under a live goal run: ready while running or paused, an attempt only while running', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'authority_lost'");
        await setStep(a, "status = 'ready'");
        await expect(setStep(a, "status = 'running', attempt_count = 1")).rejects.toThrow(
          /an attempt starts only while its goal run is running, not paused/,
        );
        await setGoal(goalRunId, "status = 'running', pause_reason = null");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setGoal(goalRunId, "status = 'verifying'");
        await setStep(a, "status = 'failed', failure_category = 'transient'");
        await expect(setStep(a, "status = 'ready', failure_category = null")).rejects.toThrow(
          /a step becomes ready only while its goal run is running or paused, not verifying/,
        );
      });

      it('a step of a cancelling goal run only ends: a waiting step never resumes (goal/0003)', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        const b = await stepId(goalRunId, 'B');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setStep(a, "status = 'waiting', waiting_reason = 'approval'");
        await setGoal(goalRunId, "status = 'cancelling'");
        await expect(setStep(a, "status = 'running', waiting_reason = null")).rejects.toThrow(
          /a step of a cancelling goal run only ends/,
        );
        await expect(setStep(b, "status = 'ready'")).rejects.toThrow(
          /a step becomes ready only while its goal run is running or paused, not cancelling/,
        );
        await setStep(a, "status = 'cancelled', waiting_reason = null, ended_at = now()");
        await setStep(b, "status = 'cancelled', ended_at = now()");
      });

      it('a step of a cancelled goal run only ends', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        const b = await stepId(goalRunId, 'B');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setGoal(goalRunId, "status = 'cancelling'");
        await setGoal(goalRunId, "status = 'cancelled', cleanup_pending = true, ended_at = now()");
        await expect(setStep(a, "status = 'waiting', waiting_reason = 'approval'")).rejects.toThrow(
          /a step of a cancelled goal run only ends/,
        );
        await expect(setStep(b, "status = 'ready'")).rejects.toThrow(
          /a step becomes ready only while its goal run is running or paused, not cancelled/,
        );
        await setStep(a, "status = 'cancelled', ended_at = now()");
        await setStep(b, "status = 'cancelled', ended_at = now()");
      });

      it('is never created under a superseded revision, nor under a goal run that is not running or paused (I-G2)', async () => {
        const goalRunId = await proposeGoal(['A', 'B']);
        await expect(insertStep(goalRunId, 'A', 1)).rejects.toThrow(
          /a proposed goal run takes no new step/,
        );
        await confirmGoal(goalRunId, ['A']);
        await proposeRevision(goalRunId, 2, 1, ['A', 'C']);
        // In one transaction: revision 2 takes effect, then a step of revision 1 is refused.
        await expect(
          asApp(async (client) => {
            await acceptIn(client, goalRunId, 2);
            await adoptIn(client, goalRunId, 2);
            await client.query(
              `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision)
               values ($1, $2, 'B', 1)`,
              [workspaceId, goalRunId],
            );
          }),
        ).rejects.toThrow(
          /step B is introduced in revision 1, but the current revision is 2 \(I-G2\)/,
        );
        await setGoal(goalRunId, "status = 'failed', ended_at = now()");
        await expect(insertStep(goalRunId, 'B', 1)).rejects.toThrow(
          /a failed goal run takes no new step/,
        );
      });

      it('a step of the old revision, raced against the revision that supersedes it, waits for it and is refused (I-G2)', async () => {
        const goalRunId = await proposeGoal(['A', 'B']);
        await confirmGoal(goalRunId, ['A']);
        await proposeRevision(goalRunId, 2, 1, ['A', 'C']);
        const second = await race(
          async (client) => {
            await acceptIn(client, goalRunId, 2);
            await adoptIn(client, goalRunId, 2);
          },
          async () => undefined,
          (client) =>
            client.query(
              `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision)
               values ($1, $2, 'B', 1)`,
              [workspaceId, goalRunId],
            ),
        );
        expect(String(second.error)).toMatch(
          /step B is introduced in revision 1, but the current revision is 2 \(I-G2\)/,
        );
      });
    });

    describe('Tasks of a step (task/0007)', () => {
      it('names the goal, the step and the revision together, or none of them', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        await expect(insertTask({ goalRunId, stepRunId: a })).rejects.toThrow(
          /tasks_goal_step_ref/,
        );
        await insertTask({ goalRunId, stepRunId: a, planRevision: 1 });
      });

      it('holds one Task per attempt (I-G1); nested child Tasks take no attempt number', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        const snapshot = { definition: { id: randomUUID(), version: 1 } };
        await expect(
          insertTask({ goalRunId, stepRunId: a, planRevision: 1, stepAttempt: 1 }),
        ).rejects.toThrow(/tasks_step_attempt/);
        await insertTask({ goalRunId, stepRunId: a, planRevision: 1, stepAttempt: 1, snapshot });
        await expect(
          insertTask({ goalRunId, stepRunId: a, planRevision: 1, stepAttempt: 1, snapshot }),
        ).rejects.toThrow(/tasks_step_attempt_uidx/);
        await insertTask({ goalRunId, stepRunId: a, planRevision: 1, stepAttempt: 2, snapshot });
        await insertTask({ goalRunId, stepRunId: a, planRevision: 1 });
        await insertTask({ goalRunId, stepRunId: a, planRevision: 1 });
      });

      it("cannot claim another goal's step or revision, and its goal step never changes", async () => {
        const goalRunId = await runningGoal();
        const otherGoal = await runningGoal();
        const otherStep = await stepId(otherGoal, 'A');
        await expect(
          insertTask({ goalRunId, stepRunId: otherStep, planRevision: 1 }),
        ).rejects.toThrow(/tasks_step_run_fkey/);
        await expect(
          insertTask({ goalRunId, stepRunId: await stepId(goalRunId, 'A'), planRevision: 9 }),
        ).rejects.toThrow(/tasks_plan_revision_fkey/);
        const task = await insertTask({
          goalRunId,
          stepRunId: await stepId(goalRunId, 'A'),
          planRevision: 1,
        });
        await expect(
          sql('update tasks set step_run_id = $3 where workspace_id = $1 and id = $2', [
            workspaceId,
            task.rows[0]?.id,
            await stepId(goalRunId, 'B'),
          ]),
        ).rejects.toThrow(/never change/);
      });
    });

    describe('ActionRequests of a step (governance/0022) and how the advancer splits on them', () => {
      let gatekeeperId: string;
      const scope = (): CapabilityScope => ({
        capabilities: ['request_action'],
        resources: { gatekeeper: [gatekeeperId] },
      });

      beforeAll(async () => {
        gatekeeperId = randomUUID();
        await sql(
          "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
          [workspaceId, gatekeeperId],
        );
      });

      /** A low-blast request of `stepRunId`, auto-approved and started, then failed with
       *  `failureKind` — and a reason that names a different kind on purpose. */
      async function failedRequest(
        stepRunId: string,
        failureKind: 'not_delivered' | 'refused' | 'outcome_unknown',
        misleadingReason: string,
      ): Promise<string> {
        const row = await asApp((client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: `test.go1.step.${failureKind}`,
            blastRadius: 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scope(),
            stepRunId,
          }),
        );
        expect(row.stepRunId).toBe(stepRunId);
        await asApp((client) => startActionRequestExecution(client, workspaceId, row.id));
        await asApp((client) =>
          markActionRequestFailed(client, workspaceId, row.id, {
            failureKind,
            reason: misleadingReason,
          }),
        );
        return row.id;
      }

      it.each([
        [
          'not_delivered',
          'target_refused: the target said no',
          { kind: 'fail', failureCategory: 'transient' },
        ],
        [
          'refused',
          'gate_unreachable: connection refused',
          { kind: 'fail', failureCategory: 'action_refused' },
        ],
        [
          'outcome_unknown',
          'gate_unreachable: connection refused',
          { kind: 'wait', waitingReason: 'reconcile' },
        ],
      ] as const)(
        'a %s failure splits the step by its column, whatever the reason text says (%s)',
        async (failureKind, misleadingReason, effect) => {
          const goalRunId = await runningGoal();
          const a = await stepId(goalRunId, 'A');
          const id = await failedRequest(a, failureKind, misleadingReason);
          const row = await asApp((client) => getActionRequest(client, workspaceId, id));
          expect(row).toMatchObject({ status: 'failed', failureKind, stepRunId: a });
          expect(await asApp((client) => readStepActionEffect(client, workspaceId, a))).toEqual(
            effect,
          );
        },
      );

      it('a step with no requests is clear, and a request outside the goal is not counted', async () => {
        const goalRunId = await runningGoal();
        const b = await stepId(goalRunId, 'B');
        await asApp((client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: 'test.go1.outside',
            blastRadius: 'medium',
            operationAutoApprovable: false,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: scope(),
          }),
        );
        expect(await asApp((client) => readStepActionEffect(client, workspaceId, b))).toEqual({
          kind: 'clear',
        });
      });

      it('records the step once: it never changes, and must be a step of this workspace', async () => {
        const goalRunId = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        const id = await failedRequest(a, 'refused', 'refused');
        await expect(
          sql('update action_requests set step_run_id = null where workspace_id = $1 and id = $2', [
            workspaceId,
            id,
          ]),
        ).rejects.toThrow(/the step a request was raised in never changes/);
        await expect(
          asApp((client) =>
            requestAction(client, workspaceId, {
              gatekeeperId,
              actionKind: 'test.go1.nostep',
              blastRadius: 'medium',
              operationAutoApprovable: false,
              awaitDecision: false,
              onBehalfOf: ownerId,
              actorRuntime: 'pi',
              requesterScope: scope(),
              stepRunId: randomUUID(),
            }),
          ),
        ).rejects.toThrow(/action_requests_step_run_fkey/);
      });
    });
  },
);
