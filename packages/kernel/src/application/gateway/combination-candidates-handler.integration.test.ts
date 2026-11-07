import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CombinationCandidatesWire,
  Role,
  WorkerDefinitionWire,
  WorkerSpec,
} from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  CombinationNotEligibleError,
  CombinationNotFoundError,
} from '../task/combination-candidates.js';
import { workerSpecDigest } from '../task/step-attempt.js';
import { WorkerDefinitionNotFoundError } from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/combination-candidates-handler.integration.test: DB-gated (real Postgres;
 * auto-skip without DATABASE_URL) — S11 GO16b, `get_combination_candidates` and
 * `propose_definition_from_combination` through dispatch: which combinations qualify (F1), who
 * reads a WorkerSpec's content (F7: a goal's requester and the owner), what proposing writes (F4:
 * the merged content as a new family's first draft; F5: the derivation, recorded once and never
 * changed) and what it refuses. The work the candidates are judged on is written by other
 * modules' write paths (goal advance, the step attempts), so those records are inserted directly
 * with the guards off.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const BASE = { systemPrompt: 'You fix services.', name: 'Fixer', capabilities: ['get_object'] };
const SPEC_GOOD: WorkerSpec = {
  instructions: 'Check the logs first.',
  capabilities: ['get_object', 'traverse'],
  tokenBudget: 5000,
};
const SPEC_FEW: WorkerSpec = { instructions: 'Only twice.' };
const SPEC_ONE_GOAL: WorkerSpec = { instructions: 'All in one goal.' };
const SPEC_RATE: WorkerSpec = { instructions: 'Three of four.' };
const SPEC_OLD: WorkerSpec = { instructions: 'Long ago.' };
const SPEC_UNREADABLE: WorkerSpec = { instructions: 'The plan says otherwise.' };
const SPEC_AGENT: WorkerSpec = { instructions: 'Only its own word.' };

const digest = (spec: WorkerSpec) => workerSpecDigest(spec) as string;

describe.runIf(DATABASE_URL !== undefined)(
  'combination candidates (S11 GO16b, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    const principals: Record<'owner' | 'alice' | 'bob' | 'carol', string> = {
      owner: randomUUID(),
      alice: randomUUID(),
      bob: randomUUID(),
      carol: randomUUID(),
    };
    const roles: Record<keyof typeof principals, Role> = {
      owner: 'owner',
      alice: 'builder',
      bob: 'builder',
      carol: 'member',
    };
    let familyId: string;
    const goodGoals: string[] = [];

    function human(who: keyof typeof principals): ResolvedCaller {
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

    function agentOf(who: keyof typeof principals, capability: string): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: principals[who],
          scope: { capabilities: [capability], resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    const call = (caller: ResolvedCaller, name: string, params: unknown) =>
      dispatchCapability({ pool }, caller, name, params);
    const candidates = async (who: keyof typeof principals) =>
      (await call(human(who), 'get_combination_candidates', {
        definitionId: familyId,
      })) as CombinationCandidatesWire;

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

    /** This workspace's derivations: `raw` skips row security, and other files share the database. */
    const derivationsHere = () =>
      raw('select 1 from worker_definition_derivations where workspace_id = $1', [workspaceId]);

    /**
     * A finished GoalRun for `requester` whose plan has one step per `steps` entry (`s0`, `s1`, …),
     * each run once by a completed Task of `version` admitted with `spec` (the plan entry stores
     * `planSpec` when given — a digest that no longer reads as it). `acceptance` makes each step
     * declare a check it passed (`verified_by_check`); otherwise the goal's `outcome` judges them.
     */
    async function goal(input: {
      readonly requester: keyof typeof principals;
      readonly version: number;
      readonly spec: WorkerSpec;
      readonly planSpec?: WorkerSpec;
      readonly steps?: number;
      readonly acceptance?: boolean;
      readonly outcome?: { readonly outcome: string; readonly basis: string };
      readonly endedAt?: Date;
      readonly agentOutcome?: string;
    }): Promise<string> {
      const endedAt = input.endedAt ?? daysAgo(1);
      const [row] = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, outcome, outcome_basis, on_behalf_of,
           statement, current_revision, confirmed_at, budget_max_tokens, budget_max_steps,
           budget_max_revisions, budget_max_wall_clock_seconds, ended_at)
         values ($1, $2, $3, $4, $5, 'a goal', 1, $6, 100000, 10, 5, 3600, $7) returning id`,
        [
          workspaceId,
          input.outcome ? 'completed' : 'running',
          input.outcome?.outcome ?? null,
          input.outcome?.basis ?? null,
          principals[input.requester],
          endedAt,
          input.outcome ? endedAt : null,
        ],
      );
      const goalRunId = row?.id as string;
      const steps = input.steps ?? 1;
      const plan = {
        steps: Array.from({ length: steps }, (_, index) => ({
          key: `s${index}`,
          worker: { definitionId: familyId, version: input.version },
          spec: input.planSpec ?? input.spec,
          ...(input.acceptance ? { acceptance: [{ key: 'c', kind: 'observe_predicate' }] } : {}),
        })),
      };
      await raw(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan,
           proposed_by, decided_by, decided_at)
         values ($1, $2, 1, 'accepted', $3, $4, $4, now())`,
        [workspaceId, goalRunId, JSON.stringify(plan), principals[input.requester]],
      );
      for (let index = 0; index < steps; index += 1) {
        const [stepRun] = await raw<{ id: string }>(
          `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision,
             status, attempt_count, ended_at, updated_at)
           values ($1, $2, $3, 1, 'succeeded', 1, $4, $4) returning id`,
          [workspaceId, goalRunId, `s${index}`, endedAt],
        );
        await raw(
          `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
             worker_definition_version, completed_at, goal_run_id, step_run_id, plan_revision,
             step_attempt, run_config_snapshot, objective_outcome, outcome_given_by,
             outcome_given_at, outcome_revision, created_at)
           values ($1, $2, 'completed', $3, $4, $5, $6, $7, $8, 1, 1, $9, $10, $11, $12, $13, $14)`,
          [
            workspaceId,
            randomUUID(),
            principals[input.requester],
            familyId,
            input.version,
            endedAt,
            goalRunId,
            stepRun?.id,
            JSON.stringify({ v: 2, spec: { digest: digest(input.spec) } }),
            input.agentOutcome ?? null,
            input.agentOutcome ? principals[input.requester] : null,
            input.agentOutcome ? endedAt : null,
            input.agentOutcome ? 1 : null,
            new Date(endedAt.getTime() - 60_000),
          ],
        );
      }
      return goalRunId;
    }

    const achieved = { outcome: 'achieved', basis: 'requester' };
    const notAchieved = { outcome: 'not_achieved', basis: 'requester' };

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      familyId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: principals.owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go16b-combination-candidates',
          ]);
          for (const [who, id] of Object.entries(principals)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
              [workspaceId, id, roles[who as keyof typeof principals], who],
            );
          }
          // v1 deprecated, v2 published — the base a combination of v2 merges with.
          const insert = `insert into worker_definitions (workspace_id, id, version, kind, status,
              definition, proposed_by, origin)
            values ($1, $2, $3, 'worker', $4, $5, $6, 'human')`;
          await client.query(insert, [
            workspaceId,
            familyId,
            1,
            'deprecated',
            JSON.stringify({ ...BASE, systemPrompt: 'You fixed services.' }),
            principals.owner,
          ]);
          await client.query(insert, [
            workspaceId,
            familyId,
            2,
            'published',
            JSON.stringify(BASE),
            principals.owner,
          ]);
        },
        { skipRoleSwitch: true },
      );

      // Qualifies: three goals (two Alice's, one the owner's), each achieved by the requester's
      // word. One Task's agent said it was not achieved — the executor's word does not count.
      goodGoals.push(
        await goal({ requester: 'alice', version: 2, spec: SPEC_GOOD, outcome: achieved }),
        await goal({
          requester: 'alice',
          version: 2,
          spec: SPEC_GOOD,
          outcome: achieved,
          agentOutcome: 'not_achieved',
        }),
        await goal({ requester: 'owner', version: 2, spec: SPEC_GOOD, outcome: achieved }),
      );
      // Too few achieved: two.
      for (let i = 0; i < 2; i += 1) {
        await goal({ requester: 'alice', version: 2, spec: SPEC_FEW, outcome: achieved });
      }
      // Too few goals: three platform-checked steps, all of one goal.
      await goal({
        requester: 'alice',
        version: 2,
        spec: SPEC_ONE_GOAL,
        steps: 3,
        acceptance: true,
        outcome: achieved,
      });
      // Rate too low: three of four.
      for (let i = 0; i < 3; i += 1) {
        await goal({ requester: 'alice', version: 2, spec: SPEC_RATE, outcome: achieved });
      }
      await goal({ requester: 'alice', version: 2, spec: SPEC_RATE, outcome: notAchieved });
      // Outside the window: ended 100 days ago.
      for (let i = 0; i < 3; i += 1) {
        await goal({
          requester: 'alice',
          version: 2,
          spec: SPEC_OLD,
          outcome: achieved,
          endedAt: daysAgo(100),
        });
      }
      // Its plan entries no longer digest to what the attempts ran with: not guessed.
      for (let i = 0; i < 3; i += 1) {
        await goal({
          requester: 'alice',
          version: 2,
          spec: SPEC_UNREADABLE,
          planSpec: { instructions: 'Something else.' },
          outcome: achieved,
        });
      }
      // Only the executor's own word (proxy): the goals have no outcome.
      for (let i = 0; i < 3; i += 1) {
        await goal({ requester: 'alice', version: 2, spec: SPEC_AGENT, agentOutcome: 'achieved' });
      }
      // On the deprecated v1: would qualify but for its base.
      for (let i = 0; i < 3; i += 1) {
        await goal({ requester: 'alice', version: 1, spec: SPEC_GOOD, outcome: achieved });
      }
    });

    afterAll(async () => {
      await pool.end();
    });

    const goodEvidence = { achieved: 3, notAchieved: 0, goals: 3, rate: 1, windowDays: 90 };
    const mergedGood = {
      systemPrompt: 'You fix services.\n\nCheck the logs first.',
      capabilities: ['get_object', 'traverse'],
    };

    it.each(['owner', 'alice'] as const)(
      '%s, who can read a goal it ran in, sees the one combination that qualifies, with its content',
      async (who) => {
        expect(await candidates(who)).toEqual({
          definitionId: familyId,
          thresholds: { windowDays: 90, minAchieved: 3, minGoals: 2, minRate: 0.8 },
          candidates: [
            {
              definitionId: familyId,
              version: 2,
              specRef: digest(SPEC_GOOD).slice(0, 12),
              specDigest: digest(SPEC_GOOD),
              fields: ['instructions', 'capabilities', 'tokenBudget'],
              evidence: goodEvidence,
              spec: SPEC_GOOD,
              definition: mergedGood,
              derivedAs: [],
            },
          ],
        });
      },
    );

    it('a builder who can read none of its goals sees its numbers, field names and a label numbered in the response — not what it says, nor its digest', async () => {
      const read = await candidates('bob');
      expect(read.candidates).toEqual([
        expect.objectContaining({
          specRef: '#1',
          specDigest: null,
          fields: ['instructions', 'capabilities', 'tokenBudget'],
          evidence: goodEvidence,
          spec: null,
          definition: null,
        }),
      ]);
    });

    it('is null for an unknown family; a member and an agent cannot call either capability', async () => {
      expect(
        await call(human('alice'), 'get_combination_candidates', { definitionId: randomUUID() }),
      ).toBeNull();
      await expect(
        call(human('carol'), 'get_combination_candidates', { definitionId: familyId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const propose = {
        definitionId: familyId,
        version: 2,
        specDigest: digest(SPEC_GOOD),
        name: 'Fixer · logs',
      };
      await expect(
        call(human('carol'), 'propose_definition_from_combination', propose),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        call(agentOf('alice', 'get_combination_candidates'), 'get_combination_candidates', {
          definitionId: familyId,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        call(
          agentOf('alice', 'propose_definition_from_combination'),
          'propose_definition_from_combination',
          propose,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a combination that does not qualify now, saying why, and writes nothing', async () => {
      const refusal = async (version: number, spec: WorkerSpec) => {
        try {
          await call(human('alice'), 'propose_definition_from_combination', {
            definitionId: familyId,
            version,
            specDigest: digest(spec),
            name: 'refused',
          });
        } catch (err) {
          expect(err).toBeInstanceOf(CombinationNotEligibleError);
          return (err as CombinationNotEligibleError).details;
        }
        throw new Error('expected a refusal');
      };
      expect(await refusal(2, SPEC_FEW)).toEqual({
        shortfalls: ['too_few_achieved'],
        evidence: { achieved: 2, notAchieved: 0, goals: 2, rate: 1, windowDays: 90 },
      });
      expect(await refusal(2, SPEC_ONE_GOAL)).toEqual({
        shortfalls: ['too_few_goals'],
        evidence: { achieved: 3, notAchieved: 0, goals: 1, rate: 1, windowDays: 90 },
      });
      expect(await refusal(2, SPEC_RATE)).toEqual({
        shortfalls: ['rate_too_low'],
        evidence: { achieved: 3, notAchieved: 1, goals: 3, rate: 0.75, windowDays: 90 },
      });
      expect((await refusal(2, SPEC_OLD)).shortfalls).toEqual([
        'too_few_achieved',
        'too_few_goals',
        'rate_too_low',
      ]);
      expect((await refusal(2, SPEC_AGENT)).evidence).toEqual({
        achieved: 0,
        notAchieved: 0,
        goals: 0,
        rate: null,
        windowDays: 90,
      });
      expect((await refusal(1, SPEC_GOOD)).shortfalls).toEqual(['base_not_published']);
      await expect(
        call(human('alice'), 'propose_definition_from_combination', {
          definitionId: familyId,
          version: 9,
          specDigest: digest(SPEC_GOOD),
          name: 'refused',
        }),
      ).rejects.toBeInstanceOf(WorkerDefinitionNotFoundError);
      // Qualifies by its numbers, but no plan entry reads as its digest: not found, not guessed.
      await expect(
        call(human('alice'), 'propose_definition_from_combination', {
          definitionId: familyId,
          version: 2,
          specDigest: digest(SPEC_UNREADABLE),
          name: 'refused',
        }),
      ).rejects.toBeInstanceOf(CombinationNotFoundError);
      expect(await derivationsHere()).toEqual([]);
    });

    it('a builder who can read none of its goals cannot propose it: not found, nothing written', async () => {
      await expect(
        call(human('bob'), 'propose_definition_from_combination', {
          definitionId: familyId,
          version: 2,
          specDigest: digest(SPEC_GOOD),
          name: 'Fixer · logs',
        }),
      ).rejects.toBeInstanceOf(CombinationNotFoundError);
      expect(await derivationsHere()).toEqual([]);
    });

    it('proposes it as a new family’s first draft — the merged content, the derivation recorded, the source goal in the audit — and the draft is then published as any other', async () => {
      const draft = (await call(human('alice'), 'propose_definition_from_combination', {
        definitionId: familyId,
        version: 2,
        specDigest: digest(SPEC_GOOD),
        name: '  Fixer · logs first  ',
      })) as WorkerDefinitionWire;
      expect(draft).toMatchObject({
        version: 1,
        kind: 'worker',
        status: 'draft',
        proposedBy: principals.alice,
        origin: 'human',
        definition: { ...mergedGood, name: 'Fixer · logs first' },
        derivedFrom: { definitionId: familyId, version: 2, evidence: goodEvidence },
      });
      // Every reader of the family sees where it came from — never the digest, which covers the
      // step-only fields the definition does not carry.
      expect(draft.derivedFrom).not.toHaveProperty('specDigest');
      expect(draft.id).not.toBe(familyId);
      expect(draft.definition).not.toHaveProperty('tokenBudget');
      expect(Date.parse(draft.derivedFrom?.derivedAt ?? '')).not.toBeNaN();

      // The content came from a goal Alice can read — hers, never the owner's.
      const [audit] = await raw<{ payload: Record<string, unknown>; actor: string }>(
        `select payload, actor_principal_id as actor from audit_records
          where workspace_id = $1 and action = 'propose_definition_from_combination'
            and resource_id = $2`,
        [workspaceId, draft.id],
      );
      expect(audit?.actor).toBe(principals.alice);
      expect(audit?.payload).toMatchObject({
        derivedFrom: { definitionId: familyId, version: 2, specDigest: digest(SPEC_GOOD) },
        evidence: goodEvidence,
        source: { planRevision: 1, stepKey: 's0' },
      });
      expect(goodGoals.slice(0, 2)).toContain(
        (audit?.payload.source as { goalRunId: string }).goalRunId,
      );

      // Every read of the family names where it came from; the draft is Alice's alone (I16).
      const got = (await call(human('alice'), 'get_worker_definition', {
        definitionId: draft.id,
        version: 1,
      })) as WorkerDefinitionWire;
      expect(got.derivedFrom).toEqual(draft.derivedFrom);
      expect((await candidates('alice')).candidates[0]?.derivedAs).toEqual([draft.id]);
      expect((await candidates('bob')).candidates[0]?.derivedAs).toEqual([]);

      const published = (await call(human('alice'), 'publish_worker_definition', {
        definitionId: draft.id,
        version: 1,
      })) as WorkerDefinitionWire;
      expect(published).toMatchObject({ status: 'published', derivedFrom: draft.derivedFrom });
      expect((await candidates('bob')).candidates[0]?.derivedAs).toEqual([draft.id]);

      // Every call proposes another family.
      const again = (await call(human('owner'), 'propose_definition_from_combination', {
        definitionId: familyId,
        version: 2,
        specDigest: digest(SPEC_GOOD),
        name: 'Fixer · again',
      })) as WorkerDefinitionWire;
      expect(again.id).not.toBe(draft.id);
      expect((await candidates('owner')).candidates[0]?.derivedAs).toEqual([again.id, draft.id]);
    });

    it('a derivation is written once and never changed: the guard and the grants hold it', async () => {
      const [row] = await raw<{ definition_id: string }>(
        'select definition_id from worker_definition_derivations where workspace_id = $1 limit 1',
        [workspaceId],
      );
      const asApp = (sql: string, params: readonly unknown[]) =>
        withWorkspace(pool, { workspaceId, principalId: principals.owner }, (client) =>
          client.query(sql, [...params]),
        );
      await expect(
        asApp('update worker_definition_derivations set spec_digest = $1', ['f'.repeat(64)]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asApp('delete from worker_definition_derivations where definition_id = $1', [
          row?.definition_id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });

      // The guard: a base that is not a published worker-kind version, a family that is not its
      // deriver's fresh version 1 draft.
      const insert = (definitionId: string, baseVersion: number, derivedBy: string) =>
        asApp(
          `insert into worker_definition_derivations (workspace_id, definition_id,
             base_definition_id, base_version, spec_digest, evidence, derived_by)
           values ($1, $2, $3, $4, $5, '{}', $6)`,
          [workspaceId, definitionId, familyId, baseVersion, 'a'.repeat(64), derivedBy],
        );
      const fresh = randomUUID();
      await raw(
        `insert into worker_definitions (workspace_id, id, version, kind, status, definition,
           proposed_by, origin)
         values ($1, $2, 1, 'worker', 'draft', '{"systemPrompt":"x"}', $3, 'human')`,
        [workspaceId, fresh, principals.alice],
      );
      await expect(insert(fresh, 1, principals.alice)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(fresh, 2, principals.bob)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(row?.definition_id as string, 2, principals.alice)).rejects.toThrow();
      await expect(insert(fresh, 2, principals.alice)).resolves.toBeDefined();
    });
  },
);
