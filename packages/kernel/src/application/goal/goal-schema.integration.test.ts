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
import { registerSource, startActivity } from '../../substrate/epistemic/index.js';
import { IMPLICIT_CONFIRM_KEY, getGoalRun, listStepRuns, readStepActionEffect } from './index.js';

/**
 * application/goal — goal-schema.integration (S11 GO1, migrations/goal/0001, task/0007,
 * governance/0022): what the database refuses. Each state machine's edge set equals the shared
 * transition table pair by pair; illegal transitions, sub-states without their status or changed
 * without a transition, any change to a final row or to a row's identity, a revision accepted
 * against a stale base or beside another (I-G3, in one transaction or two concurrent ones), a step
 * created under a superseded revision (I-G2), a second Task for one attempt (I-G1) and a Task or
 * request claiming another goal's step are all refused by the database itself — written as
 * `nexttime_app`, the role every kernel write path uses, whatever the writer. The advancer splits a
 * step on its requests' `status` and `failure_kind` columns only. GO4a (goal/0005): an outcome
 * rests on a passed verification round or on the requester's own Decision (I-G5), and an acceptance
 * check settles once, on its own evidence, in the current round of a verifying run.
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

    const STATEMENT = 'ship the report';
    const OBSERVE = {
      gatekeeperId: randomUUID(),
      operation: 'svc.status',
      params: { name: 'web' },
      expect: { path: 'state', op: 'eq', value: 'running' },
    };
    const CONFIRM_PROMPT = 'Is the report out?';
    type DeclaredCheck = Readonly<Record<string, unknown>>;
    const observeCheck = (key: string): DeclaredCheck => ({
      kind: 'observe_predicate',
      key,
      check: OBSERVE,
    });
    const confirmCheck = (key: string): DeclaredCheck => ({
      kind: 'requester_confirm',
      key,
      prompt: CONFIRM_PROMPT,
    });
    /** The goal's acceptance checks a test plan declares unless it says otherwise: `up`, the one
     *  `passRound` passes (goal/0007 binds a goal's checks to its plan). */
    const DECLARED: readonly DeclaredCheck[] = [observeCheck('up')];

    /** A `proposed` GoalRun with plan revision 1 (`steps`, declaring `acceptance`) proposed. */
    async function proposeGoal(
      steps: readonly string[] = ['A', 'B'],
      acceptance: readonly DeclaredCheck[] = DECLARED,
    ): Promise<string> {
      const goal = await sql(
        `insert into goal_runs (workspace_id, on_behalf_of, statement, ${BUDGET_COLUMNS})
         values ($1, $2, $3, 100000, 10, 3, 3600) returning id`,
        [workspaceId, ownerId, STATEMENT],
      );
      const goalRunId = goal.rows[0]?.id as string;
      await proposeRevision(goalRunId, 1, null, steps, acceptance);
      return goalRunId;
    }

    async function proposeRevision(
      goalRunId: string,
      revision: number,
      basedOn: number | null,
      steps: readonly (string | Record<string, unknown>)[],
      acceptance: readonly DeclaredCheck[] = DECLARED,
    ): Promise<void> {
      const plan = {
        steps: steps.map((step) => (typeof step === 'string' ? { key: step } : step)),
        ...(acceptance.length > 0 ? { acceptance } : {}),
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

    async function runningGoal(
      steps: readonly string[] = ['A', 'B'],
      acceptance: readonly DeclaredCheck[] = DECLARED,
    ): Promise<string> {
      const goalRunId = await proposeGoal(steps, acceptance);
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

    /** An Activity and a Source of the workspace, for the Observations and Decisions below. */
    let evidenceRefs: { readonly activityId: string; readonly sourceId: string } | undefined;
    async function refs() {
      evidenceRefs ??= await asApp(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.go4a.evidence',
          principalId: ownerId,
        });
        const source = await registerSource(client, workspaceId, {
          kind: 'test.go4a.evidence',
          ownerPrincipalId: ownerId,
          visibility: 'workspace',
        });
        return { activityId: activity.id, sourceId: source.id };
      });
      return evidenceRefs;
    }

    /** A pending acceptance check of `round` (GO4a) — what `openAcceptanceRound` inserts for a
     *  check the plan declares (`observeCheck`, `confirmCheck`; under the implicit key, the
     *  requester's confirmation of the goal's statement). */
    const insertCheck = (
      goalRunId: string,
      round: number,
      key: string,
      kind: 'observe_predicate' | 'requester_confirm' = 'observe_predicate',
      revision = 1,
    ) =>
      sql(
        `insert into goal_acceptance_checks
           (workspace_id, goal_run_id, round, check_key, plan_revision, kind, observation_check,
            prompt)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          workspaceId,
          goalRunId,
          round,
          key,
          revision,
          kind,
          kind === 'observe_predicate' ? JSON.stringify(OBSERVE) : null,
          kind !== 'requester_confirm'
            ? null
            : key === IMPLICIT_CONFIRM_KEY
              ? STATEMENT
              : CONFIRM_PROMPT,
        ],
      );
    const setCheck = (
      goalRunId: string,
      round: number,
      key: string,
      set: string,
      params: readonly unknown[] = [],
    ) =>
      sql(
        `update goal_acceptance_checks set ${set}
          where workspace_id = $1 and goal_run_id = $2 and round = $3 and check_key = $4`,
        [workspaceId, goalRunId, round, key, ...params],
      );
    /** An Observation the platform made for acceptance check `checkKey` of `round` — the content
     *  `acceptance-check.ts` records (`content` overrides it). */
    async function acceptanceObservation(
      goalRunId: string,
      round: number,
      checkKey: string,
      content: Record<string, unknown> = {},
    ): Promise<string> {
      const { activityId, sourceId } = await refs();
      const result = await sql(
        `insert into observations (workspace_id, source_id, activity_id, content)
         values ($1, $2, $3, $4::jsonb) returning id`,
        [
          workspaceId,
          sourceId,
          activityId,
          JSON.stringify({
            purpose: 'acceptance_check',
            goalRunId,
            round,
            checkKey,
            gatekeeperId: OBSERVE.gatekeeperId,
            operation: OBSERVE.operation,
            expect: OBSERVE.expect,
            outcome: 'satisfied',
            ...content,
          }),
        ],
      );
      return result.rows[0]?.id as string;
    }
    /** Passes an observation on an Observation of it that satisfied its predicate. */
    async function passObservation(goalRunId: string, round: number, key: string) {
      const observationId = await acceptanceObservation(goalRunId, round, key);
      await setCheck(
        goalRunId,
        round,
        key,
        "status = 'passed', observation_id = $5, attempts = 1, first_attempt_at = now(), settled_at = now()",
        [observationId],
      );
    }
    /** Round `round` of a verifying run: its observations (`up` by default), passed — what
     *  verification leaves before it achieves the run by check (GO4a). */
    async function passRound(
      goalRunId: string,
      round = 1,
      revision = 1,
      keys: readonly string[] = ['up'],
    ) {
      for (const key of keys) {
        await insertCheck(goalRunId, round, key, 'observe_predicate', revision);
        await passObservation(goalRunId, round, key);
      }
    }
    /** A Decision decided by `decidedBy` (the requester by default), `approved` unless `status`
     *  says otherwise — what `acceptance.ts` writes for the requester's word. */
    async function decision(
      rationale: Record<string, unknown>,
      decidedBy = ownerId,
      status = 'approved',
    ): Promise<string> {
      const { activityId } = await refs();
      const result = await sql(
        `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by,
           decided_at)
         values ($1, $2, $3, 'a goal outcome', $4::jsonb, $5, now()) returning id`,
        [workspaceId, status, activityId, JSON.stringify(rationale), decidedBy],
      );
      return result.rows[0]?.id as string;
    }

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
        await passRound(goalRunId);
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
        await passRound(goalRunId);
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

    describe('goal/0005: what an outcome rests on, and the acceptance checks (S11 GO4a, I-G5)', () => {
      const guardOf = (file: string) => {
        const text = readFileSync(path.join(MIGRATIONS_DIR, 'goal', file), 'utf8');
        const start = text.indexOf('create or replace function goal_runs_status_guard()');
        expect(start, file).toBeGreaterThanOrEqual(0);
        const end = text.indexOf('\n$$;', start);
        expect(end, file).toBeGreaterThan(start);
        return text.slice(start, end).replace(/\s+/g, ' ');
      };

      it('is goal/0004’s goal_runs_status_guard with outcome_decision_id changeable and the outcome rules before the end, and nothing else changed', () => {
        const before = guardOf('0004_goal_revision_hold.sql');
        const after = guardOf('0005_goal_acceptance.sql');
        const rulesStart = after.indexOf('-- goal/0005:');
        const rulesEnd = after.lastIndexOf('return new;');
        expect(rulesStart).toBeGreaterThan(after.indexOf('the budget changes before confirmation'));
        expect(rulesEnd).toBeGreaterThan(rulesStart);
        const rules = after.slice(rulesStart, rulesEnd);
        expect(rules).toContain('achieved by check needs every acceptance check');
        expect(rules).toContain('rests on their own decision saying so');
        expect(before).toContain("'advance_failures'])");
        expect(before).toContain('new_base int;');
        expect(after.replace(rules, '')).toBe(
          before
            .replace("'advance_failures'])", "'advance_failures', 'outcome_decision_id'])")
            .replace('new_base int;', 'new_base int; latest_round int;'),
        );
      });

      const byCheck = (goalRunId: string, extra = '', params: readonly unknown[] = []) =>
        setGoal(
          goalRunId,
          `status = 'completed', outcome = 'achieved', outcome_basis = 'verified_by_check', ended_at = now()${extra}`,
          params,
        );
      const NOT_BY_CHECK =
        /achieved by check needs every acceptance check of the latest round passed on the current plan, at least one of them observed by the platform \(I-G5\)/;
      const onWord = (goalRunId: string, decisionId: string | null, outcome = 'achieved') =>
        setGoal(
          goalRunId,
          `status = 'completed', pause_reason = null, outcome = $3, outcome_basis = 'requester', outcome_decision_id = $4, ended_at = now()`,
          [outcome, decisionId],
        );
      const NOT_ON_WORD =
        /an outcome on the requester's word rests on their own decision saying so \(I-G5\)/;

      it('achieves a run by check only out of verifying, with no person’s decision, once every check of its latest round passed — one of them an observation', async () => {
        const goalRunId = await runningGoal(
          ['A', 'B'],
          [observeCheck('up'), observeCheck('healthy')],
        );
        await setGoal(goalRunId, "status = 'verifying'");
        await expect(byCheck(goalRunId)).rejects.toThrow(NOT_BY_CHECK);
        await insertCheck(goalRunId, 1, 'up');
        await insertCheck(goalRunId, 1, 'healthy');
        await passObservation(goalRunId, 1, 'up');
        await expect(byCheck(goalRunId)).rejects.toThrow(NOT_BY_CHECK);
        await setCheck(
          goalRunId,
          1,
          'healthy',
          "status = 'failed', observation_id = $5, attempts = 1, first_attempt_at = now(), settled_at = now()",
          [await acceptanceObservation(goalRunId, 1, 'healthy', { outcome: 'unsatisfied' })],
        );
        await expect(byCheck(goalRunId)).rejects.toThrow(NOT_BY_CHECK);

        // A newer round all passed: the failed round is history.
        await passRound(goalRunId, 2, 1, ['up', 'healthy']);
        const word = await decision({
          decision: 'goal_outcome',
          goalRunId,
          outcome: 'achieved',
        });
        await expect(byCheck(goalRunId, ', outcome_decision_id = $3', [word])).rejects.toThrow(
          /only verification achieves a goal by check/,
        );
        await expect(
          setGoal(
            goalRunId,
            "status = 'completed', outcome = 'not_achieved', outcome_basis = 'verified_by_check', ended_at = now()",
          ),
        ).rejects.toThrow(/only verification achieves a goal by check/);
        await byCheck(goalRunId);
        expect(await asApp((client) => getGoalRun(client, workspaceId, goalRunId))).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
          outcomeDecisionId: null,
        });

        // Out of paused, a passed round is no basis: the run is not verifying.
        const paused = await runningGoal();
        await setGoal(paused, "status = 'verifying'");
        await passRound(paused);
        await setGoal(paused, "status = 'paused', pause_reason = 'requested'");
        await expect(byCheck(paused)).rejects.toThrow(/only verification achieves a goal by check/);
      });

      it('a round with only the requester’s confirmation passed does not achieve a run by check; their decision does, on their word', async () => {
        // A plan that declares no check: the round is the requester's confirmation of the goal.
        const goalRunId = await runningGoal(['A', 'B'], []);
        await setGoal(goalRunId, "status = 'verifying'");
        await insertCheck(goalRunId, 1, IMPLICIT_CONFIRM_KEY, 'requester_confirm');
        const word = await decision({
          decision: 'goal_outcome',
          goalRunId,
          outcome: 'achieved',
          round: 1,
          checkKey: 'requester_confirm',
        });
        await setCheck(
          goalRunId,
          1,
          'requester_confirm',
          "status = 'passed', decision_id = $5, settled_at = now()",
          [word],
        );
        await expect(byCheck(goalRunId)).rejects.toThrow(NOT_BY_CHECK);
        await onWord(goalRunId, word);
        expect(await asApp((client) => getGoalRun(client, workspaceId, goalRunId))).toMatchObject({
          outcome: 'achieved',
          outcomeBasis: 'requester',
          outcomeDecisionId: word,
        });
      });

      it('a round passed on an earlier plan does not achieve the run once a revision took effect', async () => {
        const goalRunId = await runningGoal();
        await setGoal(goalRunId, "status = 'verifying'");
        await passRound(goalRunId);
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'needs_decision'");
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await adopt(goalRunId, 2);
        await setGoal(goalRunId, "status = 'running', pause_reason = null");
        await setGoal(goalRunId, "status = 'verifying'");
        await expect(byCheck(goalRunId)).rejects.toThrow(NOT_BY_CHECK);
        await passRound(goalRunId, 2, 2);
        await byCheck(goalRunId);
      });

      it('an outcome on the requester’s word rests on their own approved decision naming this run and that outcome — never an agent’s, another run’s or another outcome’s', async () => {
        const agentId = randomUUID();
        await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'agent', 'member', 'entry agent')",
              [workspaceId, agentId],
            ),
          { skipRoleSwitch: true },
        );
        const goalRunId = await runningGoal();
        const other = await runningGoal();
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'needs_decision'");
        const said = (extra: Record<string, unknown> = {}) => ({
          decision: 'goal_outcome',
          goalRunId,
          outcome: 'not_achieved',
          ...extra,
        });
        await expect(onWord(goalRunId, null, 'not_achieved')).rejects.toThrow(NOT_ON_WORD);
        for (const refused of [
          await decision(said(), agentId),
          await decision(said({ goalRunId: other })),
          await decision(said({ outcome: 'achieved' })),
          await decision(said({ decision: 'reconcile_finding' })),
          await decision(said(), ownerId, 'proposed'),
        ]) {
          await expect(onWord(goalRunId, refused, 'not_achieved')).rejects.toThrow(NOT_ON_WORD);
        }
        await expect(
          setGoal(goalRunId, 'outcome_decision_id = $3', [await decision(said())]),
        ).rejects.toThrow(/the outcome decision is written with the outcome, once/);
        await expect(
          setGoal(
            goalRunId,
            "status = 'completed', outcome = 'achieved', outcome_basis = 'reviewer_assessed', ended_at = now()",
          ),
        ).rejects.toThrow(/a reviewer_assessed outcome is not recorded yet/);
        const word = await decision(said());
        await onWord(goalRunId, word, 'not_achieved');
        expect(await asApp((client) => getGoalRun(client, workspaceId, goalRunId))).toMatchObject({
          status: 'completed',
          outcome: 'not_achieved',
          outcomeBasis: 'requester',
          outcomeDecisionId: word,
        });
        await expect(setGoal(goalRunId, 'outcome_decision_id = null')).rejects.toThrow(
          /a completed goal run is final; outcome_decision_id cannot change/,
        );
      });

      it('an acceptance check is created pending and untried, while its run verifies on the plan it names, never into an older round', async () => {
        const goalRunId = await runningGoal();
        await expect(insertCheck(goalRunId, 1, 'up')).rejects.toThrow(
          /a round is opened while its goal run is verifying, on the plan in force/,
        );
        await proposeRevision(goalRunId, 2, 1, ['A']);
        await setGoal(goalRunId, "status = 'verifying'");
        await expect(insertCheck(goalRunId, 1, 'up', 'observe_predicate', 2)).rejects.toThrow(
          /a round is opened while its goal run is verifying, on the plan in force/,
        );
        await expect(
          sql(
            `insert into goal_acceptance_checks
               (workspace_id, goal_run_id, round, check_key, plan_revision, kind,
                observation_check, status, settled_at)
             values ($1, $2, 1, 'up', 1, 'observe_predicate', $3::jsonb, 'passed', now())`,
            [workspaceId, goalRunId, JSON.stringify(OBSERVE)],
          ),
        ).rejects.toThrow(/a check is created pending and untried/);
        await insertCheck(goalRunId, 2, 'up');
        await expect(insertCheck(goalRunId, 1, 'up')).rejects.toThrow(
          /no check is added to a round older than round 2/,
        );
        // A confirmation carries a prompt and no predicate; an observation the reverse (the CHECK
        // holds with the guards off too).
        await expect(
          raw(
            `insert into goal_acceptance_checks
               (workspace_id, goal_run_id, round, check_key, plan_revision, kind, observation_check)
             values ($1, $2, 2, 'ok', 1, 'requester_confirm', $3::jsonb)`,
            [workspaceId, goalRunId, JSON.stringify(OBSERVE)],
          ),
        ).rejects.toThrow(/goal_acceptance_checks_shape/);
        await expect(setCheck(goalRunId, 2, 'up', "check_key = 'down'")).rejects.toThrow(
          /what a check verifies, and for which round, never changes/,
        );
        await expect(
          setCheck(goalRunId, 2, 'up', 'observation_check = $5::jsonb', [
            JSON.stringify({ ...OBSERVE, operation: 'svc.other' }),
          ]),
        ).rejects.toThrow(/what a check verifies, and for which round, never changes/);
      });

      it('an observation passes only on an Observation of that very check that satisfied its predicate; a settled check never changes', async () => {
        const goalRunId = await runningGoal(
          ['A', 'B'],
          [observeCheck('up'), observeCheck('healthy')],
        );
        await setGoal(goalRunId, "status = 'verifying'");
        await insertCheck(goalRunId, 1, 'up');
        await insertCheck(goalRunId, 1, 'healthy');
        const passOn = (observationId: string) =>
          setCheck(
            goalRunId,
            1,
            'up',
            "status = 'passed', observation_id = $5, attempts = 1, first_attempt_at = now(), settled_at = now()",
            [observationId],
          );
        const NOT_PASSED = /an observation passes only on an Observation of this check/;
        for (const content of [
          { outcome: 'unsatisfied' },
          { checkKey: 'healthy' },
          { round: 2 },
          { goalRunId: randomUUID() },
          { purpose: 'reconcile_check' },
          // goal/0011: a predicate's check is judged on its predicate, never on a gate's absence.
          { expect: undefined },
          { absent: { status: 404 } },
        ]) {
          await expect(
            passOn(await acceptanceObservation(goalRunId, 1, 'up', content)),
          ).rejects.toThrow(NOT_PASSED);
        }
        await expect(
          setCheck(goalRunId, 1, 'up', "status = 'passed', settled_at = now()"),
        ).rejects.toThrow(NOT_PASSED);
        await expect(
          setCheck(goalRunId, 1, 'healthy', "status = 'failed', settled_at = now()"),
        ).rejects.toThrow(/goal_acceptance_checks_evidence/);
        const evidence = await acceptanceObservation(goalRunId, 1, 'up');
        await passOn(evidence);
        await expect(
          setCheck(goalRunId, 1, 'up', "status = 'failed', settled_at = now()"),
        ).rejects.toThrow(/a settled check is not changed/);

        await setCheck(
          goalRunId,
          1,
          'healthy',
          "attempts = 2, first_attempt_at = now(), next_attempt_at = now() + interval '1 minute'",
        );
        await expect(setCheck(goalRunId, 1, 'healthy', 'attempts = 1')).rejects.toThrow(
          /attempts only grow/,
        );
        await expect(
          setCheck(goalRunId, 1, 'healthy', "first_attempt_at = now() - interval '1 hour'"),
        ).rejects.toThrow(/when the first attempt was made never changes/);
        await expect(
          setCheck(goalRunId, 1, 'healthy', 'decision_id = $5', [
            await decision({ decision: 'goal_outcome', goalRunId, outcome: 'achieved' }),
          ]),
        ).rejects.toThrow(/the requester's decision is written as the confirmation passes/);
      });

      it('a confirmation passes only on the requester’s own decision for that round and check', async () => {
        const agentId = randomUUID();
        await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'agent', 'member', 'entry agent')",
              [workspaceId, agentId],
            ),
          { skipRoleSwitch: true },
        );
        const goalRunId = await runningGoal(['A', 'B'], [confirmCheck('ok')]);
        await setGoal(goalRunId, "status = 'verifying'");
        await insertCheck(goalRunId, 1, 'ok', 'requester_confirm');
        const confirmed = (extra: Record<string, unknown> = {}) => ({
          decision: 'goal_outcome',
          goalRunId,
          outcome: 'achieved',
          round: 1,
          checkKey: 'ok',
          ...extra,
        });
        const passOn = (decisionId: string) =>
          setCheck(goalRunId, 1, 'ok', "status = 'passed', decision_id = $5, settled_at = now()", [
            decisionId,
          ]);
        const NOT_CONFIRMED =
          /a confirmation passes only on the requester's own decision for this check/;
        for (const refused of [
          await decision(confirmed(), agentId),
          await decision(confirmed({ round: 2 })),
          await decision(confirmed({ checkKey: 'other' })),
          await decision(confirmed({ outcome: 'not_achieved' })),
          await decision(confirmed({ goalRunId: randomUUID() })),
          await decision(confirmed(), ownerId, 'proposed'),
        ]) {
          await expect(passOn(refused)).rejects.toThrow(NOT_CONFIRMED);
        }
        await expect(
          setCheck(goalRunId, 1, 'ok', "status = 'failed', settled_at = now()"),
        ).rejects.toThrow(/goal_acceptance_checks_evidence/);
        await passOn(await decision(confirmed()));
      });

      it('a check settles only in the current round of a verifying run, and is superseded only once the run left verifying or a newer round began', async () => {
        const goalRunId = await runningGoal(
          ['A', 'B'],
          [observeCheck('up'), observeCheck('healthy')],
        );
        await setGoal(goalRunId, "status = 'verifying'");
        await insertCheck(goalRunId, 1, 'up');
        await insertCheck(goalRunId, 1, 'healthy');
        await expect(
          setCheck(goalRunId, 1, 'up', "status = 'superseded', settled_at = now()"),
        ).rejects.toThrow(
          /a check of the current round is superseded only once its goal run left verifying/,
        );
        await insertCheck(goalRunId, 2, 'up');
        const evidence = await acceptanceObservation(goalRunId, 1, 'up');
        await expect(
          setCheck(
            goalRunId,
            1,
            'up',
            "status = 'passed', observation_id = $5, attempts = 1, first_attempt_at = now(), settled_at = now()",
            [evidence],
          ),
        ).rejects.toThrow(/a check settles only in the current round of a verifying goal run/);
        await setCheck(goalRunId, 1, 'up', "status = 'superseded', settled_at = now()");

        // The run left verifying: nothing of the current round settles; it is superseded.
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'requested'");
        await expect(
          setCheck(
            goalRunId,
            2,
            'up',
            "status = 'unavailable', last_error = 'x', settled_at = now()",
          ),
        ).rejects.toThrow(/a check settles only in the current round of a verifying goal run/);
        await setCheck(goalRunId, 2, 'up', "status = 'superseded', settled_at = now()");
        await setCheck(goalRunId, 1, 'healthy', "status = 'superseded', settled_at = now()");
      });
    });

    describe('goal/0006: a step’s own acceptance checks (S11 GO4b)', () => {
      const STEP_CHECK = { kind: 'observe_predicate', key: 'up', check: OBSERVE };
      const STEP_CHECK_2 = {
        kind: 'observe_predicate',
        key: 'healthy',
        check: { ...OBSERVE, operation: 'svc.health' },
      };

      /** A running GoalRun whose step A declares two acceptance checks and B none, with A's
       *  attempt 1 under way. */
      async function runningWithAcceptance(): Promise<{ goalRunId: string; a: string; b: string }> {
        const goal = await sql(
          `insert into goal_runs (workspace_id, on_behalf_of, statement, ${BUDGET_COLUMNS})
           values ($1, $2, 'ship the report', 100000, 10, 3, 3600) returning id`,
          [workspaceId, ownerId],
        );
        const goalRunId = goal.rows[0]?.id as string;
        await proposeRevision(goalRunId, 1, null, [
          { key: 'A', acceptance: [STEP_CHECK, STEP_CHECK_2] },
          'B',
        ]);
        await confirmGoal(goalRunId, ['A', 'B']);
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        return { goalRunId, a, b: await stepId(goalRunId, 'B') };
      }
      const awaitAcceptance = (step: string) =>
        setStep(step, "status = 'waiting', waiting_reason = 'acceptance'");

      const insertStepCheck = (
        goalRunId: string,
        step: string,
        round: number,
        declared: {
          readonly key: string;
          readonly kind: string;
          readonly check: unknown;
        } = STEP_CHECK,
        extra: { readonly attempt?: number; readonly revision?: number } = {},
      ) =>
        sql(
          `insert into step_acceptance_checks
             (workspace_id, goal_run_id, step_run_id, step_attempt, round, check_key,
              plan_revision, kind, observation_check)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            workspaceId,
            goalRunId,
            step,
            extra.attempt ?? 1,
            round,
            declared.key,
            extra.revision ?? 1,
            declared.kind,
            JSON.stringify(declared.check),
          ],
        );
      const setStepCheck = (
        step: string,
        round: number,
        key: string,
        set: string,
        params: readonly unknown[] = [],
      ) =>
        sql(
          `update step_acceptance_checks set ${set}
            where workspace_id = $1 and step_run_id = $2 and round = $3 and check_key = $4`,
          [workspaceId, step, round, key, ...params],
        );
      /** An Observation the platform made for check `checkKey` of the step's `round` — the content
       *  `acceptance-check.ts` records for a step's check (`content` overrides it). */
      async function stepObservation(
        goalRunId: string,
        step: string,
        round: number,
        checkKey: string,
        content: Record<string, unknown> = {},
      ): Promise<string> {
        const { activityId, sourceId } = await refs();
        const result = await sql(
          `insert into observations (workspace_id, source_id, activity_id, content)
           values ($1, $2, $3, $4::jsonb) returning id`,
          [
            workspaceId,
            sourceId,
            activityId,
            JSON.stringify({
              purpose: 'step_acceptance_check',
              goalRunId,
              stepRunId: step,
              stepAttempt: 1,
              round,
              checkKey,
              gatekeeperId: OBSERVE.gatekeeperId,
              operation: OBSERVE.operation,
              expect: OBSERVE.expect,
              outcome: 'satisfied',
              ...content,
            }),
          ],
        );
        return result.rows[0]?.id as string;
      }
      const PASS =
        "status = 'passed', observation_id = $5, attempts = 1, first_attempt_at = now(), settled_at = now()";
      async function passStepCheck(goalRunId: string, step: string, round: number, key: string) {
        await setStepCheck(step, round, key, PASS, [
          await stepObservation(goalRunId, step, round, key),
        ]);
      }

      it('a step waits on its acceptance, or on a check that could not be made; no other new reason', async () => {
        const { a } = await runningWithAcceptance();
        await awaitAcceptance(a);
        await expect(setStep(a, "waiting_reason = 'acceptance_unavailable'")).rejects.toThrow(
          /the waiting reason is set by the transition into waiting/,
        );
        await setStep(a, "status = 'running', waiting_reason = null");
        await setStep(a, "status = 'waiting', waiting_reason = 'acceptance_unavailable'");
        await setStep(a, "status = 'running', waiting_reason = null");
        await expect(
          setStep(a, "status = 'waiting', waiting_reason = 'verifying'"),
        ).rejects.toThrow(/step_runs_waiting_reason_values/);
      });

      it('a check is created pending and untried, while its step waits on its acceptance at that attempt in a running run, as declared, never into an older round', async () => {
        const { goalRunId, a, b } = await runningWithAcceptance();
        const NOT_OPEN =
          /a round is opened while its step waits on its acceptance, at its current attempt, in a running goal run/;
        // Still working, or waiting on something else.
        await expect(insertStepCheck(goalRunId, a, 1)).rejects.toThrow(NOT_OPEN);
        await setStep(a, "status = 'waiting', waiting_reason = 'approval'");
        await expect(insertStepCheck(goalRunId, a, 1)).rejects.toThrow(NOT_OPEN);
        await setStep(a, "status = 'running', waiting_reason = null");
        await awaitAcceptance(a);
        // Another attempt's, or under a run that is not running.
        await expect(insertStepCheck(goalRunId, a, 1, STEP_CHECK, { attempt: 2 })).rejects.toThrow(
          NOT_OPEN,
        );
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'requested'");
        await expect(insertStepCheck(goalRunId, a, 1)).rejects.toThrow(NOT_OPEN);
        await setGoal(goalRunId, "status = 'running', pause_reason = null");
        // Only what the step's plan entry declares, as it declares it.
        const AS_DECLARED = /a check is one of its step's declared acceptance checks, as declared/;
        await expect(
          insertStepCheck(goalRunId, a, 1, { ...STEP_CHECK, key: 'other' }),
        ).rejects.toThrow(AS_DECLARED);
        await expect(
          insertStepCheck(goalRunId, a, 1, {
            ...STEP_CHECK,
            check: { ...OBSERVE, params: { name: 'db' } },
          }),
        ).rejects.toThrow(AS_DECLARED);
        await setStep(b, "status = 'ready'");
        await setStep(b, "status = 'running', attempt_count = 1");
        await awaitAcceptance(b);
        await expect(insertStepCheck(goalRunId, b, 1)).rejects.toThrow(AS_DECLARED);
        await expect(
          sql(
            `insert into step_acceptance_checks
               (workspace_id, goal_run_id, step_run_id, step_attempt, round, check_key,
                plan_revision, kind, observation_check, status, settled_at)
             values ($1, $2, $3, 1, 1, 'up', 1, 'observe_predicate', $4::jsonb, 'passed', now())`,
            [workspaceId, goalRunId, a, JSON.stringify(OBSERVE)],
          ),
        ).rejects.toThrow(/a check is created pending and untried/);

        await insertStepCheck(goalRunId, a, 1);
        await insertStepCheck(goalRunId, a, 2);
        await expect(insertStepCheck(goalRunId, a, 1, STEP_CHECK_2)).rejects.toThrow(
          /no check is added to a round older than round 2/,
        );
        const IMMUTABLE = /what a check verifies, and for which round, never changes/;
        await expect(setStepCheck(a, 2, 'up', "check_key = 'down'")).rejects.toThrow(IMMUTABLE);
        await expect(setStepCheck(a, 2, 'up', 'step_attempt = 2')).rejects.toThrow(IMMUTABLE);
        await expect(
          setStepCheck(a, 2, 'up', 'observation_check = $5::jsonb', [
            JSON.stringify({ ...OBSERVE, operation: 'svc.other' }),
          ]),
        ).rejects.toThrow(IMMUTABLE);
      });

      it('passes only on an Observation of that very check of that step that satisfied its predicate; a settled check never changes', async () => {
        const { goalRunId, a } = await runningWithAcceptance();
        await awaitAcceptance(a);
        await insertStepCheck(goalRunId, a, 1);
        await insertStepCheck(goalRunId, a, 1, STEP_CHECK_2);
        const passOn = (observationId: string) => setStepCheck(a, 1, 'up', PASS, [observationId]);
        const NOT_PASSED =
          /a check passes only on an Observation of this check that satisfied its predicate/;
        for (const content of [
          { outcome: 'unsatisfied' },
          { checkKey: 'healthy' },
          { round: 2 },
          { stepRunId: randomUUID() },
          { goalRunId: randomUUID() },
          // The goal's own acceptance check is another check.
          { purpose: 'acceptance_check' },
          // goal/0011: a predicate's check is judged on its predicate, never on a gate's absence.
          { expect: undefined },
          { absent: { exitCode: 4 } },
        ]) {
          await expect(
            passOn(await stepObservation(goalRunId, a, 1, 'up', content)),
          ).rejects.toThrow(NOT_PASSED);
        }
        await expect(
          setStepCheck(a, 1, 'up', "status = 'passed', settled_at = now()"),
        ).rejects.toThrow(NOT_PASSED);
        await expect(
          setStepCheck(a, 1, 'healthy', "status = 'failed', settled_at = now()"),
        ).rejects.toThrow(/step_acceptance_checks_evidence/);
        await passOn(await stepObservation(goalRunId, a, 1, 'up'));
        await expect(
          setStepCheck(a, 1, 'up', "status = 'failed', settled_at = now()"),
        ).rejects.toThrow(/a settled check is not changed/);
        await setStepCheck(
          a,
          1,
          'healthy',
          "attempts = 2, first_attempt_at = now(), next_attempt_at = now() + interval '1 minute'",
        );
        await expect(setStepCheck(a, 1, 'healthy', 'attempts = 1')).rejects.toThrow(
          /attempts only grow/,
        );
        await expect(
          setStepCheck(a, 1, 'healthy', "first_attempt_at = now() - interval '1 hour'"),
        ).rejects.toThrow(/when the first attempt was made never changes/);
      });

      it('settles only in the latest round of a step still waiting on it in a running run; superseded only once its round ended', async () => {
        const { goalRunId, a } = await runningWithAcceptance();
        await awaitAcceptance(a);
        await insertStepCheck(goalRunId, a, 1);
        await insertStepCheck(goalRunId, a, 1, STEP_CHECK_2);
        const ENDED_ONLY = /a check of the current round is superseded only once its round ended/;
        const SETTLES_ONLY =
          /a check settles only in the current round of a step waiting on its acceptance/;
        await expect(
          setStepCheck(a, 1, 'up', "status = 'superseded', settled_at = now()"),
        ).rejects.toThrow(ENDED_ONLY);
        // A newer round: the older one settles no more, and may be superseded.
        await insertStepCheck(goalRunId, a, 2);
        await expect(
          setStepCheck(a, 1, 'up', PASS, [await stepObservation(goalRunId, a, 1, 'up')]),
        ).rejects.toThrow(SETTLES_ONLY);
        await setStepCheck(a, 1, 'up', "status = 'superseded', settled_at = now()");
        await setStepCheck(a, 1, 'healthy', "status = 'superseded', settled_at = now()");

        // The run paused: nothing of the round settles; it is superseded.
        await setGoal(goalRunId, "status = 'paused', pause_reason = 'requested'");
        await expect(
          setStepCheck(a, 2, 'up', "status = 'unavailable', last_error = 'x', settled_at = now()"),
        ).rejects.toThrow(SETTLES_ONLY);
        await setGoal(goalRunId, "status = 'running', pause_reason = null");
        // The step stopped waiting on it: likewise.
        await setStep(a, "status = 'running', waiting_reason = null");
        await expect(
          setStepCheck(a, 2, 'up', "status = 'unavailable', last_error = 'x', settled_at = now()"),
        ).rejects.toThrow(SETTLES_ONLY);
        await setStepCheck(a, 2, 'up', "status = 'superseded', settled_at = now()");
      });

      it('a step that declares checks succeeds only out of waiting on them, every one passed in its latest round for its current attempt; one that declares none as before', async () => {
        const { goalRunId, a, b } = await runningWithAcceptance();
        const UNVERIFIED_MOVE =
          /a step with acceptance checks succeeds only once they are made — out of waiting on its acceptance/;
        const UNPASSED =
          /a step with acceptance checks succeeds only with every one of them passed in its latest round, for its current attempt/;
        const succeed = (step: string) =>
          setStep(step, "status = 'succeeded', waiting_reason = null, ended_at = now()");
        // On its Worker's word, or out of another wait: never.
        await expect(succeed(a)).rejects.toThrow(UNVERIFIED_MOVE);
        await setStep(a, "status = 'waiting', waiting_reason = 'approval'");
        await expect(succeed(a)).rejects.toThrow(UNVERIFIED_MOVE);
        await setStep(a, "status = 'running', waiting_reason = null");
        await awaitAcceptance(a);
        // No round; a round with one declared check missing; one not yet passed.
        await expect(succeed(a)).rejects.toThrow(UNPASSED);
        await insertStepCheck(goalRunId, a, 1);
        await passStepCheck(goalRunId, a, 1, 'up');
        await expect(succeed(a)).rejects.toThrow(UNPASSED);
        await insertStepCheck(goalRunId, a, 1, STEP_CHECK_2);
        await expect(succeed(a)).rejects.toThrow(UNPASSED);
        // A newer round opened: round 1 passing is not enough.
        await passStepCheck(goalRunId, a, 1, 'healthy');
        await insertStepCheck(goalRunId, a, 2);
        await insertStepCheck(goalRunId, a, 2, STEP_CHECK_2);
        await expect(succeed(a)).rejects.toThrow(UNPASSED);
        await passStepCheck(goalRunId, a, 2, 'up');
        await passStepCheck(goalRunId, a, 2, 'healthy');
        await succeed(a);

        // B declares none: it succeeds out of running, as before GO4b.
        await setStep(b, "status = 'ready'");
        await setStep(b, "status = 'running', attempt_count = 1");
        await succeed(b);
      });

      it('a passed round of an earlier attempt does not let a later attempt succeed', async () => {
        const { goalRunId, a } = await runningWithAcceptance();
        await awaitAcceptance(a);
        await insertStepCheck(goalRunId, a, 1);
        await insertStepCheck(goalRunId, a, 1, STEP_CHECK_2);
        await passStepCheck(goalRunId, a, 1, 'up');
        await passStepCheck(goalRunId, a, 1, 'healthy');
        // A person retried the step after all (a failed attempt 1, say): attempt 2's work is done.
        await setStep(
          a,
          "status = 'failed', waiting_reason = null, failure_category = 'transient'",
        );
        await setStep(a, "status = 'ready', failure_category = null");
        await setStep(a, "status = 'running', attempt_count = 2");
        await awaitAcceptance(a);
        await expect(
          setStep(a, "status = 'succeeded', waiting_reason = null, ended_at = now()"),
        ).rejects.toThrow(
          /a step with acceptance checks succeeds only with every one of them passed in its latest round, for its current attempt/,
        );
      });
    });

    describe('goal/0007: acceptance checks judged on a Fact of the graph (S11 GO4c)', () => {
      /** The guard's body, its comments dropped and its whitespace collapsed. */
      const guardOf = (file: string) => {
        const text = readFileSync(path.join(MIGRATIONS_DIR, 'goal', file), 'utf8');
        const start = text.indexOf('create or replace function goal_runs_status_guard()');
        expect(start, file).toBeGreaterThanOrEqual(0);
        const end = text.indexOf('\n$$;', start);
        expect(end, file).toBeGreaterThan(start);
        return text
          .slice(start, end)
          .replace(/--[^\n]*/g, '')
          .replace(/\s+/g, ' ');
      };

      it('is goal/0005’s goal_runs_status_guard, comments aside, with a Fact the platform judged counting as a check it made and every check the plan declares needed — and nothing else changed', () => {
        const OBSERVED_ONLY = "c.kind = 'observe_predicate') then";
        const VARIABLES = 'latest_round int; begin';
        const BY_CHECK_RULE = "observed by the platform (I-G5)'; end if;";
        const DECLARED_RULE =
          "declared := goal_declared_acceptance(new.workspace_id, new.id, new.current_revision); if declared is null or exists ( select 1 from jsonb_array_elements(declared) d where not exists ( select 1 from goal_acceptance_checks c where c.workspace_id = new.workspace_id and c.goal_run_id = new.id and c.round = latest_round and c.check_key = d ->> 'key')) then raise exception 'goal_runs: achieved by check needs a check of the latest round for every acceptance check the current plan declares (I-G5)'; end if;";
        const before = guardOf('0005_goal_acceptance.sql');
        for (const anchor of [OBSERVED_ONLY, VARIABLES, BY_CHECK_RULE]) {
          expect(before.split(anchor), anchor).toHaveLength(2);
        }
        expect(guardOf('0007_fact_acceptance.sql')).toBe(
          before
            .replace(OBSERVED_ONLY, "c.kind in ('observe_predicate', 'fact_predicate')) then")
            .replace(VARIABLES, 'latest_round int; declared jsonb; begin')
            .replace(BY_CHECK_RULE, `${BY_CHECK_RULE} ${DECLARED_RULE}`),
        );
      });

      const LINK = 'test.go4c.runs_on';
      const HOST = 'test.go4c.Host';
      let serviceId: string;
      let gatekeeperId: string;
      let webId: string;
      let hostId: string;
      let otherHostId: string;
      /** The service's Sources — a gate's, a collector's, a private one — and the requester's own. */
      let gateSource: string;
      let collectorSource: string;
      let privateSource: string;
      let ownSource: string;
      /** The check: web runs on host web-1 — one end named by id, the other by ObjectType and
       *  identity. */
      let FACT: { readonly linkType: string; readonly source: unknown; readonly target: unknown };

      /** As the service that owns the collector and gate Sources. */
      const asService = <T>(fn: (client: PoolClient) => Promise<T>) =>
        withWorkspace(pool, { workspaceId, principalId: serviceId }, fn);

      beforeAll(async () => {
        serviceId = randomUUID();
        await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          (client) =>
            client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'service', 'member', 'collector')",
              [workspaceId, serviceId],
            ),
          { skipRoleSwitch: true },
        );
        const object = async (type: string, identity: Record<string, unknown>) =>
          (
            await sql(
              'insert into objects (workspace_id, object_type, identity_key) values ($1, $2, $3::jsonb) returning id',
              [workspaceId, type, JSON.stringify(identity)],
            )
          ).rows[0]?.id as string;
        gatekeeperId = await object('platform.Gatekeeper', { name: 'go4c-gate' });
        webId = await object('test.go4c.Service', { name: 'web' });
        hostId = await object(HOST, { name: 'web-1' });
        otherHostId = await object(HOST, { name: 'web-2' });
        FACT = {
          linkType: LINK,
          source: { objectId: webId },
          target: { objectType: HOST, identity: { name: 'web-1' } },
        };
        const source = (kind: string, owner: string, visibility: 'workspace' | 'private') =>
          withWorkspace(pool, { workspaceId, principalId: owner }, async (client) => {
            const row = await registerSource(client, workspaceId, {
              kind,
              ownerPrincipalId: owner,
              visibility,
            });
            return row.id;
          });
        gateSource = await source('gatekeeper', serviceId, 'workspace');
        collectorSource = await source('test.go4c.collector', serviceId, 'workspace');
        privateSource = await source('test.go4c.collector', serviceId, 'private');
        ownSource = await source('test.go4c.collector', ownerId, 'workspace');
      });

      interface Seen {
        /** The Activity's kind, and what it records. */
        readonly activity: string;
        readonly metadata?: Record<string, unknown>;
        /** The Source the Observation is of — the collector's by default. */
        readonly source?: string;
        /** The Fact's epistemic status — `observed` by default. */
        readonly status?: string;
        readonly linkType?: string;
        readonly target?: string;
        readonly properties?: Record<string, unknown>;
        /** SQL for the Fact's validity — `now()` and open by default. */
        readonly validFrom?: string;
        readonly validUntil?: string;
      }
      const SUBMITTED: Seen = { activity: 'ingest.submit_observations' };

      /** An Observation as `seen` says: an Activity of its kind and record, and the Observation of
       *  its Source on it. */
      const observation = (client: PoolClient, seen: Seen) =>
        startActivity(client, workspaceId, {
          kind: seen.activity,
          principalId: serviceId,
          metadata: seen.metadata ?? {},
        }).then(async (activity) => {
          const row = await client.query<{ id: string }>(
            `insert into observations (workspace_id, source_id, activity_id, content)
             values ($1, $2, $3, '{}'::jsonb) returning id`,
            [workspaceId, seen.source ?? collectorSource, activity.id],
          );
          return { activityId: activity.id, observationId: row.rows[0]?.id as string };
        });
      /** A Fact web → host (as `seen` says) resting on an Observation recorded as `seen` says. */
      const fact = (seen: Seen = SUBMITTED) =>
        asService(async (client) => {
          const { activityId, observationId } = await observation(client, seen);
          const row = await client.query<{ id: string }>(
            `insert into links (workspace_id, link_type, source_object_id, target_object_id,
               properties, valid_from, valid_until, epistemic_status, activity_id, asserted_by,
               observation_id)
             values ($1, $2, $3, $4, $5::jsonb, ${seen.validFrom ?? 'now()'},
               ${seen.validUntil ?? 'null'}, $6, $7, $8, $9)
             returning id`,
            [
              workspaceId,
              seen.linkType ?? LINK,
              webId,
              seen.target ?? hostId,
              JSON.stringify(seen.properties ?? {}),
              seen.status ?? 'observed',
              activityId,
              serviceId,
              observationId,
            ],
          );
          return row.rows[0]?.id as string;
        });
      /** The Fact confirmed again, by an Observation recorded as `seen` says. */
      const confirm = (factId: string, seen: Seen = SUBMITTED) =>
        asService(async (client) => {
          const { observationId } = await observation(client, seen);
          await client.query(
            `update links set last_observation_id = $3, last_observed_at = now()
              where workspace_id = $1 and id = $2`,
            [workspaceId, factId, observationId],
          );
        });
      const now = async () => (await sql('select now() as at')).rows[0]?.at as Date;
      const admissible = async (goalRunId: string, factId: string, since: Date, check = FACT) =>
        (
          await sql('select goal_fact_admissible($1, $2, $3, $4::jsonb, $5) as ok', [
            workspaceId,
            goalRunId,
            factId,
            JSON.stringify(check),
            since,
          ])
        ).rows[0]?.ok as boolean;
      const observedBy = (taskId: unknown): Seen => ({
        activity: 'gatekeeper_observe',
        source: gateSource,
        metadata: { triggeredByTaskId: taskId },
      });
      const appliedFor = (actionRequestId: unknown): Seen => ({
        activity: 'gatekeeper_apply',
        source: gateSource,
        metadata: { actionRequestId },
      });
      let requests = 0;
      /** An ActionRequest on the gate, raised in `stepRunId` or by `parentWorkerRunId` if given. */
      const request = async (
        raised: { readonly stepRunId?: string; readonly parentWorkerRunId?: string } = {},
      ) => {
        requests += 1;
        const row = await asApp((client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind: `test.go4c.apply.${requests}`,
            blastRadius: 'medium',
            operationAutoApprovable: false,
            awaitDecision: false,
            onBehalfOf: ownerId,
            actorRuntime: 'pi',
            requesterScope: {
              capabilities: ['request_action'],
              resources: { gatekeeper: [gatekeeperId] },
            },
            ...raised,
          }),
        );
        return row.id;
      };
      const workerRun = async (taskId: string) =>
        (
          await sql(
            `insert into worker_runs (workspace_id, status, task_id) values ($1, 'running', $2)
             returning id`,
            [workspaceId, taskId],
          )
        ).rows[0]?.id as string;

      it('takes a Fact as evidence only if it is the Link named, active, observed, last confirmed since the round opened through a Source the requester does not own — by a collector, or a gate this goal did not drive', async () => {
        const goalRunId = await runningGoal();
        const otherGoal = await runningGoal();
        const a = await stepId(goalRunId, 'A');
        const otherA = await stepId(otherGoal, 'A');
        const task = async (fields: Parameters<typeof insertTask>[0]) =>
          (await insertTask(fields)).rows[0]?.id as string;
        const ownTask = await task({ goalRunId, stepRunId: a, planRevision: 1 });
        const otherTask = await task({ goalRunId: otherGoal, stepRunId: otherA, planRevision: 1 });
        const looseTask = await task({});
        const ownRequest = await request({ stepRunId: a });
        const ownWorkerRequest = await request({ parentWorkerRunId: await workerRun(ownTask) });
        const otherRequest = await request({ stepRunId: otherA });
        const otherWorkerRequest = await request({
          parentWorkerRunId: await workerRun(otherTask),
        });
        const looseRequest = await request();
        const since = await now();

        for (const seen of [
          SUBMITTED,
          // A gate's observe no Worker called, or a Worker of another goal's Task or of none.
          observedBy(null),
          observedBy(otherTask),
          observedBy(looseTask),
          // A gate's apply of a request raised outside this goal.
          appliedFor(looseRequest),
          appliedFor(otherRequest),
          appliedFor(otherWorkerRequest),
        ]) {
          expect(await admissible(goalRunId, await fact(seen), since), JSON.stringify(seen)).toBe(
            true,
          );
        }
        for (const seen of [
          // What a Worker acting for the requester could submit: the requester's own Source.
          { ...SUBMITTED, source: ownSource },
          // A submission is not a gate's, and a gate's Activity is on the gate's Source.
          { ...SUBMITTED, source: gateSource },
          { ...observedBy(null), source: collectorSource },
          { ...appliedFor(looseRequest), source: collectorSource },
          // A Source the requester cannot see.
          { ...SUBMITTED, source: privateSource },
          // This goal's own doing: its Task's Worker called the observe, or the apply is its own.
          observedBy(ownTask),
          appliedFor(ownRequest),
          appliedFor(ownWorkerRequest),
          // Nothing recorded (before this release), or nothing that names a known Task or request:
          // never read as "not this goal's".
          { activity: 'gatekeeper_observe', source: gateSource },
          { activity: 'gatekeeper_apply', source: gateSource },
          observedBy('not-a-task'),
          observedBy(randomUUID()),
          observedBy(7),
          appliedFor('not-a-request'),
          appliedFor(randomUUID()),
          // Any other Activity.
          { activity: 'agent_turn' },
          // Asserted by a person or inferred by an agent, not observed.
          { ...SUBMITTED, status: 'asserted' },
          { ...SUBMITTED, status: 'inferred' },
          // Not valid now.
          { ...SUBMITTED, validFrom: "now() + interval '1 day'" },
          {
            ...SUBMITTED,
            validFrom: "now() - interval '2 days'",
            validUntil: "now() - interval '1 day'",
          },
          // Another Link: of another type, or to another Object.
          { ...SUBMITTED, linkType: 'test.go4c.depends_on' },
          { ...SUBMITTED, target: otherHostId },
        ] satisfies Seen[]) {
          expect(await admissible(goalRunId, await fact(seen), since), JSON.stringify(seen)).toBe(
            false,
          );
        }

        // Superseded or invalidated: no longer evidence.
        const superseded = await fact();
        const invalidated = await fact();
        expect(await admissible(goalRunId, superseded, since)).toBe(true);
        await sql('update links set superseded_at = now() where workspace_id = $1 and id = $2', [
          workspaceId,
          superseded,
        ]);
        await sql('update links set invalidated_at = now() where workspace_id = $1 and id = $2', [
          workspaceId,
          invalidated,
        ]);
        expect(await admissible(goalRunId, superseded, since)).toBe(false);
        expect(await admissible(goalRunId, invalidated, since)).toBe(false);

        // The confirmation that counts is the latest: before the round opened, none; confirmed
        // since, it is; confirmed since by the requester's own Source, it is not.
        const early = await fact();
        const later = await now();
        expect(await admissible(goalRunId, early, later)).toBe(false);
        await confirm(early);
        expect(await admissible(goalRunId, early, later)).toBe(true);
        await confirm(early, { ...SUBMITTED, source: ownSource });
        expect(await admissible(goalRunId, early, later)).toBe(false);

        // The check names the Link: an id in capitals names the same Object; another goal run's
        // check, or an unknown run, is judged on its own terms.
        const evidence = await fact();
        expect(
          await admissible(goalRunId, evidence, since, {
            ...FACT,
            source: { objectId: webId.toUpperCase() },
          }),
        ).toBe(true);
        expect(
          await admissible(goalRunId, evidence, since, {
            ...FACT,
            target: { objectType: HOST, identity: { name: 'web-2' } },
          }),
        ).toBe(false);
        expect(await admissible(randomUUID(), evidence, since)).toBe(false);
        const otherOwn = await fact(observedBy(otherTask));
        expect(await admissible(otherGoal, otherOwn, since)).toBe(false);
        expect(await admissible(goalRunId, otherOwn, since)).toBe(true);
      });

      /** A fact check of the goal's plan: web runs on host web-1 (`FACT`), under `key`. */
      const factCheck = (key: string): DeclaredCheck => ({
        kind: 'fact_predicate',
        key,
        fact: FACT,
      });
      const insertFactCheck = (goalRunId: string, round: number, key: string, check = FACT) =>
        sql(
          `insert into goal_acceptance_checks
             (workspace_id, goal_run_id, round, check_key, plan_revision, kind, fact_check)
           values ($1, $2, $3, $4, 1, 'fact_predicate', $5::jsonb)`,
          [workspaceId, goalRunId, round, key, JSON.stringify(check)],
        );
      const SETTLED_ON =
        'fact_id = $5, attempts = 1, first_attempt_at = now(), settled_at = now(), status =';
      const NOT_PASSED =
        /a fact check passes only on a Fact that may serve as its evidence — the one it names, observed since its round opened, not by this goal's own doing/;
      const NOT_FAILED = /a fact check fails only on a Fact it saw of the Link it names/;

      it('a fact check carries its Fact selector and nothing else, is created with no Fact, and what it names never changes', async () => {
        const goalRunId = await runningGoal(['A', 'B'], [factCheck('runs')]);
        await setGoal(goalRunId, "status = 'verifying'");
        // The CHECKs, with the guards off: the guard refuses a row its plan does not declare first.
        const insert = (columns: string, values: string, params: readonly unknown[]) =>
          raw(
            `insert into goal_acceptance_checks
               (workspace_id, goal_run_id, round, check_key, plan_revision, kind, ${columns})
             values ($1, $2, 1, 'x', 1, ${values})`,
            [workspaceId, goalRunId, ...params],
          );
        const SHAPE = /goal_acceptance_checks_shape/;
        await expect(
          insert('fact_check, observation_check', "'fact_predicate', $3::jsonb, $4::jsonb", [
            JSON.stringify(FACT),
            JSON.stringify(OBSERVE),
          ]),
        ).rejects.toThrow(SHAPE);
        await expect(insert('prompt', "'fact_predicate', 'Is it up?'", [])).rejects.toThrow(SHAPE);
        await expect(
          insert('fact_check, prompt', "'requester_confirm', $3::jsonb, 'Is it up?'", [
            JSON.stringify(FACT),
          ]),
        ).rejects.toThrow(SHAPE);
        await expect(
          insert('observation_check, fact_check', "'observe_predicate', $3::jsonb, $4::jsonb", [
            JSON.stringify(OBSERVE),
            JSON.stringify(FACT),
          ]),
        ).rejects.toThrow(SHAPE);
        await expect(
          sql(
            `insert into goal_acceptance_checks
               (workspace_id, goal_run_id, round, check_key, plan_revision, kind, fact_check,
                fact_id)
             values ($1, $2, 1, 'runs', 1, 'fact_predicate', $3::jsonb, $4)`,
            [workspaceId, goalRunId, JSON.stringify(FACT), await fact()],
          ),
        ).rejects.toThrow(/a check is created pending and untried/);

        await insertFactCheck(goalRunId, 1, 'runs');
        await expect(
          setCheck(goalRunId, 1, 'runs', 'fact_check = $5::jsonb', [
            JSON.stringify({ ...FACT, linkType: 'test.go4c.depends_on' }),
          ]),
        ).rejects.toThrow(/what a check verifies, and for which round, never changes/);
        // Saw nothing it may rest on: unavailable, with no Fact — never failed without one.
        await expect(
          setCheck(goalRunId, 1, 'runs', "status = 'failed', settled_at = now()"),
        ).rejects.toThrow(NOT_FAILED);
        await setCheck(
          goalRunId,
          1,
          'runs',
          "status = 'unavailable', last_error = 'fact_not_observed', attempts = 5, first_attempt_at = now(), settled_at = now()",
        );
      });

      it('a fact check passes only on a Fact that may serve as its evidence for its round, and fails only on a Fact of the Link it names', async () => {
        const goalRunId = await runningGoal(['A', 'B'], [factCheck('runs'), factCheck('held')]);
        await setGoal(goalRunId, "status = 'verifying'");
        const early = await fact();
        await insertFactCheck(goalRunId, 1, 'runs');
        await insertFactCheck(goalRunId, 1, 'held');
        const settle = (key: string, status: string, factId: string | null) =>
          setCheck(goalRunId, 1, key, `${SETTLED_ON} '${status}'`, [factId]);

        await expect(settle('runs', 'passed', null)).rejects.toThrow(NOT_PASSED);
        for (const refused of [
          early,
          await fact({ ...SUBMITTED, source: ownSource }),
          await fact({ ...SUBMITTED, linkType: 'test.go4c.depends_on' }),
          await fact({ ...SUBMITTED, status: 'inferred' }),
        ]) {
          await expect(settle('runs', 'passed', refused)).rejects.toThrow(NOT_PASSED);
        }
        await expect(
          settle('held', 'failed', await fact({ ...SUBMITTED, target: otherHostId })),
        ).rejects.toThrow(NOT_FAILED);
        // Failing on what was seen of the Link named, whoever saw it, stops the run achieving by
        // check; it is never evidence that it is.
        await settle('held', 'failed', await fact({ ...SUBMITTED, source: ownSource }));
        // Confirmed since the round opened, by a collector: evidence.
        await confirm(early);
        await settle('runs', 'passed', early);
        await expect(
          setCheck(goalRunId, 1, 'runs', "status = 'failed', settled_at = now()"),
        ).rejects.toThrow(/a settled check is not changed/);
      });

      const byCheck = (goalRunId: string) =>
        setGoal(
          goalRunId,
          "status = 'completed', outcome = 'achieved', outcome_basis = 'verified_by_check', ended_at = now()",
        );

      it('achieves a run by check on a round whose only check the platform made is a Fact (I-G5)', async () => {
        const goalRunId = await runningGoal(['A', 'B'], [factCheck('runs'), confirmCheck('ok')]);
        await setGoal(goalRunId, "status = 'verifying'");
        await insertFactCheck(goalRunId, 1, 'runs');
        await insertCheck(goalRunId, 1, 'ok', 'requester_confirm');
        await setCheck(goalRunId, 1, 'runs', `${SETTLED_ON} 'passed'`, [await fact()]);
        await setCheck(
          goalRunId,
          1,
          'ok',
          "status = 'passed', decision_id = $5, settled_at = now()",
          [
            await decision({
              decision: 'goal_outcome',
              goalRunId,
              outcome: 'achieved',
              round: 1,
              checkKey: 'ok',
            }),
          ],
        );
        await byCheck(goalRunId);
        expect(await asApp((client) => getGoalRun(client, workspaceId, goalRunId))).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
        });
      });

      it('a goal’s check is one its plan declares, as declared — with none declared, only the requester’s confirmation of the goal (review #493 on GO4c)', async () => {
        const NOT_DECLARED =
          /a check is one of the acceptance checks its plan declares, as declared — with none declared, the requester's confirmation of the goal/;
        const insert = (
          goalRunId: string,
          key: string,
          kind: string,
          fields: { check?: unknown; fact?: unknown; prompt?: string } = {},
        ) =>
          sql(
            `insert into goal_acceptance_checks
               (workspace_id, goal_run_id, round, check_key, plan_revision, kind, observation_check,
                fact_check, prompt)
             values ($1, $2, 1, $3, 1, $4, $5::jsonb, $6::jsonb, $7)`,
            [
              workspaceId,
              goalRunId,
              key,
              kind,
              fields.check === undefined ? null : JSON.stringify(fields.check),
              fields.fact === undefined ? null : JSON.stringify(fields.fact),
              fields.prompt ?? null,
            ],
          );

        const declared = await runningGoal(
          ['A', 'B'],
          [observeCheck('up'), factCheck('runs'), confirmCheck('ok')],
        );
        await setGoal(declared, "status = 'verifying'");
        for (const [key, kind, fields] of [
          ['down', 'observe_predicate', { check: OBSERVE }],
          ['up', 'observe_predicate', { check: { ...OBSERVE, operation: 'svc.other' } }],
          ['up', 'fact_predicate', { fact: FACT }],
          ['runs', 'fact_predicate', { fact: { ...FACT, linkType: 'test.go4c.depends_on' } }],
          ['ok', 'requester_confirm', { prompt: 'Is it up?' }],
          [IMPLICIT_CONFIRM_KEY, 'requester_confirm', { prompt: STATEMENT }],
        ] as const) {
          await expect(insert(declared, key, kind, fields), `${key} ${kind}`).rejects.toThrow(
            NOT_DECLARED,
          );
        }
        await insert(declared, 'up', 'observe_predicate', { check: OBSERVE });
        await insert(declared, 'runs', 'fact_predicate', { fact: FACT });
        await insert(declared, 'ok', 'requester_confirm', { prompt: CONFIRM_PROMPT });

        const none = await runningGoal(['A', 'B'], []);
        await setGoal(none, "status = 'verifying'");
        for (const [key, kind, fields] of [
          ['up', 'observe_predicate', { check: OBSERVE }],
          [IMPLICIT_CONFIRM_KEY, 'requester_confirm', { prompt: CONFIRM_PROMPT }],
          ['ok', 'requester_confirm', { prompt: STATEMENT }],
        ] as const) {
          await expect(insert(none, key, kind, fields), `${key} ${kind}`).rejects.toThrow(
            NOT_DECLARED,
          );
        }
        await insert(none, IMPLICIT_CONFIRM_KEY, 'requester_confirm', { prompt: STATEMENT });
      });

      it('achieves a run by check only with a check of its latest round for every one the plan in force declares (review #493 on GO4c)', async () => {
        const NOT_EVERY_DECLARED =
          /achieved by check needs a check of the latest round for every acceptance check the current plan declares/;
        const goalRunId = await runningGoal(['A', 'B'], [observeCheck('up'), factCheck('runs')]);
        await setGoal(goalRunId, "status = 'verifying'");
        await passRound(goalRunId);
        await expect(byCheck(goalRunId)).rejects.toThrow(NOT_EVERY_DECLARED);
        // A later round with the other check alone does not make up for it either.
        await insertFactCheck(goalRunId, 2, 'runs');
        await setCheck(goalRunId, 2, 'runs', `${SETTLED_ON} 'passed'`, [await fact()]);
        await expect(byCheck(goalRunId)).rejects.toThrow(NOT_EVERY_DECLARED);
        await passRound(goalRunId, 2);
        await byCheck(goalRunId);
      });

      it('a step’s fact check is one it declares, as declared, and passes or fails as the goal’s does', async () => {
        const goal = await sql(
          `insert into goal_runs (workspace_id, on_behalf_of, statement, ${BUDGET_COLUMNS})
           values ($1, $2, 'ship the report', 100000, 10, 3, 3600) returning id`,
          [workspaceId, ownerId],
        );
        const goalRunId = goal.rows[0]?.id as string;
        const STEP_FACT = { kind: 'fact_predicate', key: 'runs', fact: FACT };
        await proposeRevision(goalRunId, 1, null, [{ key: 'A', acceptance: [STEP_FACT] }, 'B']);
        await confirmGoal(goalRunId, ['A', 'B']);
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setStep(a, "status = 'waiting', waiting_reason = 'acceptance'");
        const insert = (declared: { readonly kind: string; readonly fact: unknown }) =>
          sql(
            `insert into step_acceptance_checks
               (workspace_id, goal_run_id, step_run_id, step_attempt, round, check_key,
                plan_revision, kind, fact_check)
             values ($1, $2, $3, 1, 1, 'runs', 1, $4, $5::jsonb)`,
            [workspaceId, goalRunId, a, declared.kind, JSON.stringify(declared.fact)],
          );
        const AS_DECLARED = /a check is one of its step's declared acceptance checks, as declared/;
        await expect(
          insert({ ...STEP_FACT, fact: { ...FACT, linkType: 'test.go4c.depends_on' } }),
        ).rejects.toThrow(AS_DECLARED);
        await expect(insert({ ...STEP_FACT, kind: 'observe_predicate' })).rejects.toThrow(
          /step_acceptance_checks_shape|declared acceptance checks/,
        );
        await expect(
          sql(
            `insert into step_acceptance_checks
               (workspace_id, goal_run_id, step_run_id, step_attempt, round, check_key,
                plan_revision, kind, fact_check, observation_check)
             values ($1, $2, $3, 1, 1, 'runs', 1, 'fact_predicate', $4::jsonb, $5::jsonb)`,
            [workspaceId, goalRunId, a, JSON.stringify(FACT), JSON.stringify(OBSERVE)],
          ),
        ).rejects.toThrow(/step_acceptance_checks_shape/);
        await insert(STEP_FACT);

        const settleStep = (status: string, factId: string | null) =>
          sql(
            `update step_acceptance_checks
                set fact_id = $4, attempts = 1, first_attempt_at = now(), settled_at = now(),
                    status = $5
              where workspace_id = $1 and step_run_id = $2 and round = 1 and check_key = $3`,
            [workspaceId, a, 'runs', factId, status],
          );
        await expect(
          settleStep('passed', await fact({ ...SUBMITTED, source: ownSource })),
        ).rejects.toThrow(
          /a fact check passes only on a Fact that may serve as its evidence — the one it names, observed since its round opened, not by this goal's own doing/,
        );
        await expect(
          settleStep('failed', await fact({ ...SUBMITTED, linkType: 'test.go4c.depends_on' })),
        ).rejects.toThrow(/a fact check fails only on a Fact it saw of the Link it names/);
        await settleStep('passed', await fact());
        await setStep(a, "status = 'succeeded', waiting_reason = null, ended_at = now()");
      });

      it('core/0046: an Activity’s kind, and the Task or request it records as its trigger, never change', async () => {
        const activity = async (metadata: Record<string, unknown>) =>
          (
            await asService((client) =>
              startActivity(client, workspaceId, {
                kind: 'gatekeeper_observe',
                principalId: serviceId,
                metadata,
              }),
            )
          ).id;
        const update = (id: string, set: string, params: readonly unknown[] = []) =>
          sql(`update activities set ${set} where workspace_id = $1 and id = $2`, [
            workspaceId,
            id,
            ...params,
          ]);
        const RECORDED =
          /the Task or ActionRequest an Activity records as its trigger is written when it starts and never changes/;
        const byNoWorker = await activity({ triggeredByTaskId: null });
        const unrecorded = await activity({});
        const applied = await activity({ actionRequestId: randomUUID() });

        await expect(update(byNoWorker, "kind = 'ingest.submit_observations'")).rejects.toThrow(
          /an Activity's kind never changes/,
        );
        await expect(
          update(byNoWorker, "metadata = metadata - 'triggeredByTaskId'"),
        ).rejects.toThrow(RECORDED);
        await expect(
          update(byNoWorker, 'metadata = metadata || $3::jsonb', [
            JSON.stringify({ triggeredByTaskId: randomUUID() }),
          ]),
        ).rejects.toThrow(RECORDED);
        for (const key of ['triggeredByTaskId', 'actionRequestId']) {
          await expect(
            update(unrecorded, 'metadata = metadata || $3::jsonb', [
              JSON.stringify({ [key]: null }),
            ]),
          ).rejects.toThrow(RECORDED);
        }
        await expect(
          update(applied, 'metadata = metadata || $3::jsonb', [
            JSON.stringify({ actionRequestId: randomUUID() }),
          ]),
        ).rejects.toThrow(RECORDED);
        await expect(update(applied, "metadata = '{}'::jsonb")).rejects.toThrow(RECORDED);
        // Everything else is written as before: a report, a note, the end.
        await update(byNoWorker, 'metadata = metadata || $3::jsonb', [
          JSON.stringify({ note: 'x', triggeredByTaskId: null }),
        ]);
        await update(unrecorded, 'metadata = metadata || $3::jsonb', [
          JSON.stringify({ note: 'x' }),
        ]);
        await update(applied, "status = 'completed', ended_at = now()");
      });
    });

    describe('goal/0011: acceptance checks met by the gate confirming something is not there (S11 「门确认不存在」 B)', () => {
      /** The guard's body, its comments dropped and its whitespace collapsed. */
      const guardOf = (file: string) => {
        const text = readFileSync(path.join(MIGRATIONS_DIR, 'goal', file), 'utf8');
        const start = text.indexOf('create or replace function goal_runs_status_guard()');
        expect(start, file).toBeGreaterThanOrEqual(0);
        const end = text.indexOf('\n$$;', start);
        expect(end, file).toBeGreaterThan(start);
        return text
          .slice(start, end)
          .replace(/--[^\n]*/g, '')
          .replace(/\s+/g, ' ');
      };

      it('is goal/0007’s goal_runs_status_guard, comments aside, with an absence the platform observed counting as a check it made — and nothing else changed', () => {
        const MADE = "c.kind in ('observe_predicate', 'fact_predicate')) then";
        const before = guardOf('0007_fact_acceptance.sql');
        expect(before.split(MADE), MADE).toHaveLength(2);
        expect(guardOf('0011_absence_acceptance.sql')).toBe(
          before.replace(
            MADE,
            "c.kind in ('observe_predicate', 'observe_absent', 'fact_predicate')) then",
          ),
        );
      });

      /** The call an absence check makes: no predicate (nothing in a result can say "not there"). */
      const ABSENT = {
        gatekeeperId: OBSERVE.gatekeeperId,
        operation: 'svc.get',
        params: { name: 'web' },
      };
      const absentCheck = (key: string): DeclaredCheck => ({
        kind: 'observe_absent',
        key,
        check: ABSENT,
      });
      /** Who confirmed the published version's answers, as `platform-observation.ts` records it. */
      const REVIEW = { reviewedBy: randomUUID(), reviewedAt: new Date().toISOString() };
      /** The content `acceptance-check.ts` records for an absence check the gate confirmed: the
       *  call, its `absent`, no predicate, and the version's confirmation. */
      const CONFIRMED = {
        operation: ABSENT.operation,
        expect: undefined,
        absent: { status: 404 },
        absentAnswersReview: REVIEW,
      };
      const SETTLED = 'attempts = 1, first_attempt_at = now(), settled_at = now()';

      const insertAbsent = (
        goalRunId: string,
        round: number,
        key: string,
        check: unknown = ABSENT,
        kind = 'observe_absent',
      ) =>
        sql(
          `insert into goal_acceptance_checks
             (workspace_id, goal_run_id, round, check_key, plan_revision, kind, observation_check)
           values ($1, $2, $3, $4, 1, $5, $6::jsonb)`,
          [workspaceId, goalRunId, round, key, kind, JSON.stringify(check)],
        );

      /** Content variants that never pass an absence check: each misses what it rests on. */
      const NOT_EVIDENCE = (purpose: Record<string, unknown>) => [
        { ...CONFIRMED, ...purpose, outcome: 'unsatisfied' },
        { ...CONFIRMED, ...purpose, absent: undefined },
        { ...CONFIRMED, ...purpose, expect: OBSERVE.expect },
        { ...CONFIRMED, ...purpose, gatekeeperId: randomUUID() },
        { ...CONFIRMED, ...purpose, operation: 'svc.other' },
        { ...CONFIRMED, ...purpose, absentAnswersReview: undefined },
        { ...CONFIRMED, ...purpose, absentAnswersReview: 'confirmed' },
        { ...CONFIRMED, ...purpose, absentAnswersReview: { reviewedAt: REVIEW.reviewedAt } },
        { ...CONFIRMED, ...purpose, absentAnswersReview: { reviewedBy: REVIEW.reviewedBy } },
        { ...CONFIRMED, ...purpose, absentAnswersReview: { ...REVIEW, reviewedBy: '' } },
        { ...CONFIRMED, ...purpose, absentAnswersReview: { ...REVIEW, reviewedAt: 1 } },
        { ...CONFIRMED, ...purpose, checkKey: 'up' },
        { ...CONFIRMED, ...purpose, round: 2 },
      ];

      it('an absence check carries its call and no predicate, and an observation’s carries one; neither a Fact nor a prompt', async () => {
        const SHAPE = /goal_acceptance_checks_shape/;
        const { expect: _predicate, ...noPredicate } = OBSERVE;
        // A plan written straight to the table may declare what its schema refuses; the guard
        // matches such a row to its declaration, and the CHECK still refuses it.
        const goalRunId = await runningGoal(
          ['A', 'B'],
          [
            observeCheck('up'),
            absentCheck('gone'),
            { kind: 'observe_absent', key: 'judged', check: OBSERVE },
            { kind: 'observe_predicate', key: 'unjudged', check: noPredicate },
          ],
        );
        await setGoal(goalRunId, "status = 'verifying'");
        await expect(insertAbsent(goalRunId, 1, 'judged', OBSERVE)).rejects.toThrow(SHAPE);
        await expect(
          insertAbsent(goalRunId, 1, 'unjudged', noPredicate, 'observe_predicate'),
        ).rejects.toThrow(SHAPE);
        await expect(
          sql(
            `insert into goal_acceptance_checks
               (workspace_id, goal_run_id, round, check_key, plan_revision, kind, observation_check,
                prompt)
             values ($1, $2, 1, 'gone', 1, 'observe_absent', $3::jsonb, 'Is it gone?')`,
            [workspaceId, goalRunId, JSON.stringify(ABSENT)],
          ),
        ).rejects.toThrow(SHAPE);
        // The declaration binds the call: another Operation, or the same call as a predicate's, is
        // not the check the plan declares.
        const NOT_DECLARED = /a check is one of the acceptance checks its plan declares/;
        await expect(
          insertAbsent(goalRunId, 1, 'gone', { ...ABSENT, operation: 'svc.other' }),
        ).rejects.toThrow(NOT_DECLARED);
        await expect(insertAbsent(goalRunId, 1, 'up', ABSENT)).rejects.toThrow(NOT_DECLARED);
        await insertAbsent(goalRunId, 1, 'gone');
        await insertCheck(goalRunId, 1, 'up');
      });

      it('passes only on an Observation of that very check in which the gate confirmed absence of the call it names, under a version a person confirmed', async () => {
        const goalRunId = await runningGoal(['A', 'B'], [absentCheck('gone'), observeCheck('up')]);
        await setGoal(goalRunId, "status = 'verifying'");
        await insertAbsent(goalRunId, 1, 'gone');
        await insertCheck(goalRunId, 1, 'up');
        const passOn = (observationId: string) =>
          setCheck(goalRunId, 1, 'gone', `status = 'passed', observation_id = $5, ${SETTLED}`, [
            observationId,
          ]);
        const NOT_PASSED =
          /an absence check passes only on an Observation of this check in which the gate confirmed the thing is not there, under an Operation version whose answers a person confirmed/;
        for (const content of [
          ...NOT_EVIDENCE({}),
          { ...CONFIRMED, purpose: 'step_acceptance_check' },
          { ...CONFIRMED, goalRunId: randomUUID() },
        ]) {
          await expect(
            passOn(await acceptanceObservation(goalRunId, 1, 'gone', content)),
            JSON.stringify(content),
          ).rejects.toThrow(NOT_PASSED);
        }
        await expect(
          setCheck(goalRunId, 1, 'gone', `status = 'passed', ${SETTLED}`),
        ).rejects.toThrow(NOT_PASSED);
        // The thing still there: the check fails on the Observation that saw it.
        const stillThere = await acceptanceObservation(goalRunId, 1, 'gone', {
          ...CONFIRMED,
          absent: undefined,
          outcome: 'unsatisfied',
        });
        await passOn(await acceptanceObservation(goalRunId, 1, 'gone', CONFIRMED));
        await expect(
          setCheck(goalRunId, 1, 'gone', `status = 'failed', observation_id = $5`, [stillThere]),
        ).rejects.toThrow(/a settled check is not changed/);
        // A predicate's check never passes on an absence, as before.
        await expect(
          setCheck(goalRunId, 1, 'up', `status = 'passed', observation_id = $5, ${SETTLED}`, [
            await acceptanceObservation(goalRunId, 1, 'up', { ...CONFIRMED, checkKey: 'up' }),
          ]),
        ).rejects.toThrow(
          /an observation passes only on an Observation of this check that satisfied its predicate/,
        );
      });

      it('achieves a run by check on a round whose only check the platform made is an absence the gate confirmed (I-G5)', async () => {
        const goalRunId = await runningGoal(['A', 'B'], [absentCheck('gone'), confirmCheck('ok')]);
        await setGoal(goalRunId, "status = 'verifying'");
        await insertAbsent(goalRunId, 1, 'gone');
        await insertCheck(goalRunId, 1, 'ok', 'requester_confirm');
        await setCheck(goalRunId, 1, 'gone', `status = 'passed', observation_id = $5, ${SETTLED}`, [
          await acceptanceObservation(goalRunId, 1, 'gone', CONFIRMED),
        ]);
        const byCheck = () =>
          setGoal(
            goalRunId,
            "status = 'completed', outcome = 'achieved', outcome_basis = 'verified_by_check', ended_at = now()",
          );
        await expect(byCheck()).rejects.toThrow(/achieved by check needs every acceptance check/);
        await setCheck(
          goalRunId,
          1,
          'ok',
          "status = 'passed', decision_id = $5, settled_at = now()",
          [
            await decision({
              decision: 'goal_outcome',
              outcome: 'achieved',
              goalRunId,
              round: 1,
              checkKey: 'ok',
            }),
          ],
        );
        await byCheck();
        expect(await asApp((client) => getGoalRun(client, workspaceId, goalRunId))).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
        });
      });

      it('a step’s absence check is one it declares, as declared, and passes only as the goal’s does', async () => {
        const STEP_ABSENT = { kind: 'observe_absent', key: 'gone', check: ABSENT };
        const goal = await sql(
          `insert into goal_runs (workspace_id, on_behalf_of, statement, ${BUDGET_COLUMNS})
           values ($1, $2, 'remove the web service', 100000, 10, 3, 3600) returning id`,
          [workspaceId, ownerId],
        );
        const goalRunId = goal.rows[0]?.id as string;
        // `judged` is what the plan's schema refuses (an absence check with a predicate), written
        // straight to the table: the guard matches it to its declaration, the CHECK refuses it.
        await proposeRevision(goalRunId, 1, null, [
          {
            key: 'A',
            acceptance: [STEP_ABSENT, { kind: 'observe_absent', key: 'judged', check: OBSERVE }],
          },
          'B',
        ]);
        await confirmGoal(goalRunId, ['A', 'B']);
        const a = await stepId(goalRunId, 'A');
        await setStep(a, "status = 'ready'");
        await setStep(a, "status = 'running', attempt_count = 1");
        await setStep(a, "status = 'waiting', waiting_reason = 'acceptance'");

        const insertStepAbsent = (check: unknown, key = 'gone') =>
          sql(
            `insert into step_acceptance_checks
               (workspace_id, goal_run_id, step_run_id, step_attempt, round, check_key,
                plan_revision, kind, observation_check)
             values ($1, $2, $3, 1, 1, $4, 1, 'observe_absent', $5::jsonb)`,
            [workspaceId, goalRunId, a, key, JSON.stringify(check)],
          );
        await expect(insertStepAbsent(OBSERVE, 'judged')).rejects.toThrow(
          /step_acceptance_checks_shape/,
        );
        await expect(insertStepAbsent({ ...ABSENT, operation: 'svc.other' })).rejects.toThrow(
          /a check is one of its step's declared acceptance checks, as declared/,
        );
        await insertStepAbsent(ABSENT);

        const stepObservation = async (content: Record<string, unknown>) => {
          const { activityId, sourceId } = await refs();
          const result = await sql(
            `insert into observations (workspace_id, source_id, activity_id, content)
             values ($1, $2, $3, $4::jsonb) returning id`,
            [
              workspaceId,
              sourceId,
              activityId,
              JSON.stringify({
                purpose: 'step_acceptance_check',
                goalRunId,
                stepRunId: a,
                stepAttempt: 1,
                round: 1,
                checkKey: 'gone',
                gatekeeperId: ABSENT.gatekeeperId,
                outcome: 'satisfied',
                ...content,
              }),
            ],
          );
          return result.rows[0]?.id as string;
        };
        const passOn = (observationId: string) =>
          sql(
            `update step_acceptance_checks
                set status = 'passed', observation_id = $3, ${SETTLED}
              where workspace_id = $1 and step_run_id = $2 and check_key = 'gone'`,
            [workspaceId, a, observationId],
          );
        const NOT_PASSED =
          /step_acceptance_checks: an absence check passes only on an Observation of this check in which the gate confirmed the thing is not there, under an Operation version whose answers a person confirmed/;
        for (const content of [
          ...NOT_EVIDENCE({}),
          { ...CONFIRMED, purpose: 'acceptance_check' },
          { ...CONFIRMED, stepRunId: randomUUID() },
        ]) {
          await expect(
            passOn(await stepObservation(content)),
            JSON.stringify(content),
          ).rejects.toThrow(NOT_PASSED);
        }
        await passOn(await stepObservation(CONFIRMED));
      });
    });

    describe('GoalRun — what may change, and when', () => {
      /** A completed GoalRun with revision 2 still proposed. */
      async function completedGoal(): Promise<string> {
        const goalRunId = await runningGoal();
        await proposeRevision(goalRunId, 2, 1, ['A', 'B', 'C']);
        await setGoal(goalRunId, "status = 'verifying'");
        await passRound(goalRunId);
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
