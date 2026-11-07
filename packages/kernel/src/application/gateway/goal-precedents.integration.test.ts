import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  type EntryGoalPrecedentWire,
  GOAL_PRECEDENT_WINDOW_DAYS,
  type GoalPrecedentWire,
  GoalPrecedentWireSchema,
  type Role,
  listEnvelope,
} from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { precedentsOfGoal } from '../goal/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/goal-precedents.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) — S11 GO17a, a requester's precedents: `find_goal_precedents` on both channels, the
 * entry context's `precedents`, and what the goal planner's input is given (`precedentsOfGoal`).
 * What the plan asked (go17-default-plan.md): same kind by structure only — the Procedure revision
 * 1 was made from, then a Worker family of the plan in force at the end (F1); only the requester's
 * own goals, an owner's included (F2); a cancelled goal is none (F5); the polarity rules; the full
 * record, read as every goal read shows it. The goals are written by other modules' write paths
 * (propose, confirm, advance, accept), so they are inserted directly with the guards off.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const DAY_MS = 24 * 60 * 60 * 1000;
// Synthetic, Handle-shaped: never a real credential.
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

type Who = 'owner' | 'alice' | 'bob';

interface StepFixture {
  readonly key: string;
  readonly worker: string;
  readonly status?: 'succeeded' | 'failed';
}

interface GoalFixture {
  readonly requester: Who;
  readonly status?: 'completed' | 'cancelled';
  readonly outcome?: 'achieved' | 'not_achieved';
  readonly basis?: 'verified_by_check' | 'requester' | 'reviewer_assessed';
  readonly endedAt?: Date;
  readonly statement?: string;
  readonly procedure?: { readonly id: string; readonly version: number };
  /** Revision 1's steps — and the plan in force at the end unless `revised` is given. */
  readonly steps: readonly StepFixture[];
  /** An accepted revision 2 in force at the end: its steps replace revision 1's (`superseded`). */
  readonly revised?: readonly StepFixture[];
  /** The last verification round's checks, by key and status. */
  readonly checks?: readonly { readonly key: string; readonly status: 'passed' | 'failed' }[];
  /** The checks the requester overrode — an `achieved` on their word over them. */
  readonly overridden?: readonly string[];
}

describe.runIf(DATABASE_URL !== undefined)(
  'goal precedents (S11 GO17a, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    const principals: Record<Who, string> = {
      owner: randomUUID(),
      alice: randomUUID(),
      bob: randomUUID(),
    };
    const roles: Record<Who, Role> = { owner: 'owner', alice: 'member', bob: 'member' };
    const workerA = randomUUID();
    const workerB = randomUUID();
    const workerC = randomUUID();
    const procedureId = randomUUID();
    const goals: Record<string, string> = {};

    function human(who: Who): ResolvedCaller {
      const principalId = principals[who];
      return {
        channel: 'human',
        principal: {
          workspaceId,
          id: principalId,
          kind: 'human',
          role: roles[who],
          displayName: null,
        },
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

    function agentOf(who: Who, capabilities: readonly string[]): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      const scope: CapabilityScope = { capabilities: [...capabilities], resources: {} };
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: principals[who],
          scope,
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    const call = (caller: ResolvedCaller, name: string, params: unknown) =>
      dispatchCapability({ pool }, caller, name, params);

    async function precedents(caller: ResolvedCaller, params: Record<string, unknown> = {}) {
      const result = await call(caller, 'find_goal_precedents', params);
      return listEnvelope(GoalPrecedentWireSchema).parse(result).items;
    }
    const ids = (items: readonly { goalRunId: string }[]) => items.map((item) => item.goalRunId);

    async function refusal(promise: Promise<unknown>) {
      try {
        await promise;
      } catch (err) {
        return mapCapabilityError(err);
      }
      throw new Error('expected a refusal');
    }

    /** A write with the guards off — fixtures whose write paths this capability does not own. */
    const raw = async <T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> =>
      withWorkspace(
        pool,
        { workspaceId, principalId: principals.owner },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          return (await client.query(sql, [...params])).rows as T[];
        },
        { skipRoleSwitch: true },
      );

    const planOf = (steps: readonly StepFixture[]) => ({
      steps: steps.map((step) => ({
        key: step.key,
        worker: { definitionId: step.worker, version: 1 },
        input: { step: step.key, password: FAKE },
      })),
    });

    async function goal(name: string, input: GoalFixture): Promise<string> {
      const status = input.status ?? 'completed';
      const endedAt = input.endedAt ?? daysAgo(1);
      const outcome = status === 'completed' ? (input.outcome ?? 'achieved') : null;
      const basis = outcome ? (input.basis ?? 'verified_by_check') : null;
      const requester = principals[input.requester];
      let decisionId: string | null = null;
      if (input.overridden) {
        const [row] = await raw<{ id: string }>(
          `insert into decisions (workspace_id, status, activity_id, rationale, decided_by, decided_at)
           values ($1, 'approved', $2, $3::jsonb, $4, now()) returning id`,
          [
            workspaceId,
            randomUUID(),
            JSON.stringify({
              decision: 'goal_outcome',
              outcome,
              overriddenChecks: input.overridden.map((checkKey) => ({
                checkKey,
                kind: 'observe_predicate',
                round: 1,
                status: 'failed',
                observationId: null,
                factId: null,
                lastError: null,
              })),
            }),
            requester,
          ],
        );
        decisionId = row?.id ?? null;
      }
      const revision = input.revised ? 2 : 1;
      const [row] = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, outcome, outcome_basis, outcome_decision_id,
           on_behalf_of, statement, current_revision, confirmed_at, budget_max_tokens,
           budget_max_steps, budget_max_revisions, budget_max_wall_clock_seconds, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 100000, 10, 5, 3600, $9) returning id`,
        [
          workspaceId,
          status,
          outcome,
          basis,
          decisionId,
          requester,
          input.statement ?? `goal ${name}`,
          revision,
          endedAt,
        ],
      );
      const goalRunId = row?.id as string;
      await raw(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan, proposed_by,
           decided_by, decided_at, source_procedure_id, source_procedure_version)
         values ($1, $2, 1, 'accepted', $3, $4, $4, now(), $5, $6)`,
        [
          workspaceId,
          goalRunId,
          JSON.stringify(planOf(input.steps)),
          requester,
          input.procedure?.id ?? null,
          input.procedure?.version ?? null,
        ],
      );
      if (input.revised) {
        await raw(
          `insert into plan_revisions (workspace_id, goal_run_id, revision, based_on_revision,
             status, plan, proposed_by, decided_by, decided_at)
           values ($1, $2, 2, 1, 'accepted', $3, $4, $4, now())`,
          [workspaceId, goalRunId, JSON.stringify(planOf(input.revised)), requester],
        );
      }
      const stepRow = (step: StepFixture, introduced: number, superseded: number | null) =>
        raw(
          `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision,
             status, attempt_count, failure_category, superseded_in_revision, ended_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            workspaceId,
            goalRunId,
            step.key,
            introduced,
            superseded !== null ? 'superseded' : (step.status ?? 'succeeded'),
            step.status === 'failed' ? 2 : 1,
            superseded === null && step.status === 'failed' ? 'transient' : null,
            superseded,
            superseded !== null || step.status !== 'failed' ? endedAt : null,
            endedAt,
          ],
        );
      for (const step of input.steps) await stepRow(step, 1, input.revised ? 2 : null);
      for (const step of input.revised ?? []) await stepRow(step, 2, null);
      for (const check of input.checks ?? []) {
        await raw(
          `insert into goal_acceptance_checks (workspace_id, goal_run_id, round, check_key,
             plan_revision, kind, observation_check, status, attempts, first_attempt_at,
             observation_id, settled_at)
           values ($1, $2, 1, $3, $4, 'observe_predicate', $5::jsonb, $6, 1, now(), $7, now())`,
          [
            workspaceId,
            goalRunId,
            check.key,
            revision,
            JSON.stringify({
              operation: 'svc.status',
              expect: { path: 'state', op: 'eq', value: 'up' },
            }),
            check.status,
            randomUUID(),
          ],
        );
      }
      goals[name] = goalRunId;
      return goalRunId;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: principals.owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go17a-goal-precedents',
          ]);
          for (const [who, id] of Object.entries(principals)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
              [workspaceId, id, roles[who as Who], who],
            );
          }
        },
        { skipRoleSwitch: true },
      );

      // alice's goals, newest first by name number within each kind.
      await goal('fromProcedure', {
        requester: 'alice',
        endedAt: daysAgo(5),
        procedure: { id: procedureId, version: 2 },
        steps: [{ key: 'renew', worker: workerC }],
        checks: [{ key: 'up', status: 'passed' }],
      });
      await goal('revisedToA', {
        requester: 'alice',
        endedAt: daysAgo(3),
        outcome: 'not_achieved',
        basis: 'requester',
        steps: [{ key: 'renew', worker: workerB, status: 'failed' }],
        revised: [{ key: 'renew2', worker: workerA, status: 'failed' }],
        checks: [{ key: 'up', status: 'failed' }],
      });
      await goal('overridden', {
        requester: 'alice',
        endedAt: daysAgo(2),
        basis: 'requester',
        steps: [{ key: 'renew', worker: workerA }],
        checks: [{ key: 'up', status: 'failed' }],
        overridden: ['up'],
      });
      await goal('onWord', {
        requester: 'alice',
        endedAt: daysAgo(1),
        basis: 'requester',
        statement: `rotate the key, the old one is API_KEY=${FAKE}`,
        steps: [{ key: 'renew', worker: workerA }],
      });
      // None of these is a precedent of anyone's.
      await goal('cancelled', {
        requester: 'alice',
        status: 'cancelled',
        steps: [{ key: 'renew', worker: workerA }],
      });
      await goal('tooOld', {
        requester: 'alice',
        endedAt: daysAgo(GOAL_PRECEDENT_WINDOW_DAYS + 1),
        steps: [{ key: 'renew', worker: workerA }],
      });
      // Another requester's goals: of the same kind, never alice's precedents — nor the owner's.
      await goal('bobs', {
        requester: 'bob',
        endedAt: daysAgo(1),
        procedure: { id: procedureId, version: 2 },
        steps: [{ key: 'renew', worker: workerA }],
      });
      await goal('owners', {
        requester: 'owner',
        endedAt: daysAgo(4),
        steps: [{ key: 'renew', worker: workerA }],
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('same kind by structure: the Procedure first, then a Worker family of the plan in force at the end, newest first', async () => {
      const items = await precedents(agentOf('alice', ['find_goal_precedents']), {
        procedureId,
        workerDefinitionIds: [workerA],
        limit: 10,
      });
      expect(ids(items)).toEqual([
        goals.fromProcedure,
        goals.onWord,
        goals.overridden,
        goals.revisedToA,
      ]);
      expect(items.map((item) => item.match)).toEqual(['procedure', 'worker', 'worker', 'worker']);
      // Revision 1's Worker is gone from the plan in force at the end: no match on it.
      expect(
        ids(
          await precedents(agentOf('alice', ['find_goal_precedents']), {
            workerDefinitionIds: [workerB.toUpperCase()],
          }),
        ),
      ).toEqual([]);
      // At most three unless asked for more.
      expect(
        ids(
          await precedents(agentOf('alice', ['find_goal_precedents']), {
            procedureId,
            workerDefinitionIds: [workerA],
          }),
        ),
      ).toEqual(ids(items).slice(0, 3));
      // Nothing asked: the most recent ones.
      const recent = await precedents(agentOf('alice', ['find_goal_precedents']), { limit: 2 });
      expect(ids(recent)).toEqual([goals.onWord, goals.overridden]);
      expect(recent.map((item) => item.match)).toEqual(['recent', 'recent']);
    });

    it('polarity: checked, overridden, not achieved, said', async () => {
      const items = await precedents(human('alice'), { limit: 10 });
      const polarity = Object.fromEntries(items.map((item) => [item.goalRunId, item.polarity]));
      expect(polarity).toEqual({
        [goals.fromProcedure as string]: 'positive',
        [goals.revisedToA as string]: 'negative',
        [goals.overridden as string]: 'negative',
        [goals.onWord as string]: 'unverified',
      });
    });

    it('the full record: the plan in force at the end read redacted, live steps, the last round, the overridden checks, where the first plan came from', async () => {
      const items = await precedents(human('alice'), { limit: 10 });
      const byId = new Map(items.map((item) => [item.goalRunId, item]));
      const revised = byId.get(goals.revisedToA as string) as GoalPrecedentWire;
      expect(revised).toMatchObject({
        outcome: 'not_achieved',
        outcomeBasis: 'requester',
        fromProcedure: null,
        revision: 2,
        revisions: 1,
        steps: [{ key: 'renew2', status: 'failed', attempts: 2, failureCategory: 'transient' }],
        acceptance: { round: 1, checks: [{ checkKey: 'up', status: 'failed' }] },
        overriddenChecks: [],
      });
      expect(revised.plan.steps.map((step) => step.key)).toEqual(['renew2']);
      expect(revised.plan.steps[0]?.input).toEqual({ step: 'renew2', password: '[redacted]' });
      expect(byId.get(goals.fromProcedure as string)).toMatchObject({
        fromProcedure: { procedureId, version: 2 },
        revision: 1,
        revisions: 0,
      });
      expect(byId.get(goals.overridden as string)?.overriddenChecks).toMatchObject([
        { checkKey: 'up', status: 'failed' },
      ]);
      const onWord = byId.get(goals.onWord as string) as GoalPrecedentWire;
      expect(onWord.statement).toBe('rotate the key, the old one is API_KEY=[redacted]');
      expect(onWord.acceptance).toBeNull();
    });

    it("only the requester's own goals — an owner's too — and never a cancelled or too old one", async () => {
      const alices = ids(await precedents(human('alice'), { limit: 10 }));
      for (const name of ['cancelled', 'tooOld', 'bobs', 'owners']) {
        expect(alices).not.toContain(goals[name]);
      }
      // The owner reads every goal in the console, but its precedents are its own goals alone.
      expect(
        ids(await precedents(human('owner'), { procedureId, workerDefinitionIds: [workerA] })),
      ).toEqual([goals.owners]);
      expect(ids(await precedents(agentOf('owner', ['find_goal_precedents']), {}))).toEqual([
        goals.owners,
      ]);
      expect(ids(await precedents(human('bob'), { procedureId }))).toEqual([goals.bobs]);
    });

    it('the entry context lists the most recently ended ones as references', async () => {
      const result = (await call(
        agentOf('alice', ['get_entry_context']),
        'get_entry_context',
        {},
      )) as {
        precedents: EntryGoalPrecedentWire[];
      };
      expect(result.precedents.map((item) => item.id)).toEqual([
        goals.onWord,
        goals.overridden,
        goals.revisedToA,
      ]);
      expect(result.precedents.map((item) => item.polarity)).toEqual([
        'unverified',
        'negative',
        'negative',
      ]);
      expect(result.precedents[0]?.statement).toBe(
        'rotate the key, the old one is API_KEY=[redacted]',
      );
      expect(Object.keys(result.precedents[0] ?? {}).sort()).toEqual(
        [
          'endedAt',
          'fromProcedure',
          'id',
          'outcome',
          'outcomeBasis',
          'polarity',
          'statement',
        ].sort(),
      );
      const bobs = (await call(agentOf('bob', ['get_entry_context']), 'get_entry_context', {})) as {
        precedents: EntryGoalPrecedentWire[];
      };
      expect(bobs.precedents.map((item) => item.id)).toEqual([goals.bobs]);
    });

    it("a goal being planned: its revision 1's Procedure, its plan's Workers, never itself", async () => {
      const planned = await goal('planned', {
        requester: 'alice',
        procedure: { id: procedureId, version: 3 },
        steps: [{ key: 'renew', worker: workerA }],
      });
      await raw(
        `update goal_runs set status = 'paused', pause_reason = 'needs_decision', outcome = null,
                outcome_basis = null, ended_at = null
          where workspace_id = $1 and id = $2`,
        [workspaceId, planned],
      );
      const found = await withWorkspace(
        pool,
        { workspaceId, principalId: principals.alice },
        (client) =>
          precedentsOfGoal(
            client,
            workspaceId,
            { id: planned, onBehalfOf: principals.alice },
            {
              steps: [{ key: 'renew', worker: { definitionId: workerA, version: 1 } }],
            },
            3,
          ),
      );
      expect(ids(found)).toEqual([goals.fromProcedure, goals.onWord, goals.overridden]);
      // Ended, it is still never its own precedent.
      await raw(
        `update goal_runs set status = 'completed', pause_reason = null, outcome = 'achieved',
                outcome_basis = 'verified_by_check', ended_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, planned],
      );
      const again = await withWorkspace(
        pool,
        { workspaceId, principalId: principals.alice },
        (client) =>
          precedentsOfGoal(
            client,
            workspaceId,
            { id: planned, onBehalfOf: principals.alice },
            { steps: [{ key: 'renew', worker: { definitionId: workerA, version: 1 } }] },
            10,
          ),
      );
      expect(ids(again)).not.toContain(planned);
      expect(ids(again)[0]).toBe(goals.fromProcedure);
    });

    it('refuses params outside its limits', async () => {
      for (const params of [
        { limit: 11 },
        { limit: 0 },
        { workerDefinitionIds: [] },
        { workerDefinitionIds: ['not-an-id'] },
        { procedureId: 'not-an-id' },
        { workerDefinitionIds: Array.from({ length: 21 }, () => randomUUID()) },
        { extra: true },
      ]) {
        expect((await refusal(call(human('alice'), 'find_goal_precedents', params))).status).toBe(
          400,
        );
      }
    });
  },
);
