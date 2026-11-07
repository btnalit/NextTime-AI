import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  GoalDetailWireSchema,
  GoalPrecedentWireSchema,
  PlanRevisionWireSchema,
  type ProcedureStep,
  ProposeGoalResultWireSchema,
  type Role,
  listEnvelope,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import {
  procedureDraftDigest,
  proposeProcedure,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/goal-cited-precedents.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) — S11 GO17b (go17-default-plan.md F4 A): a revision records the precedents
 * its plan was written from. `propose_goal`'s `precedents` are checked before anything is written
 * (each a completed goal of the requester, cited once), stored on revision 1
 * (`plan_revisions.cited_precedents`, migration goal/0018) and in the propose audit, and read back
 * on `get_goal` and `get_goal_revision` with each goal's statement, outcome and polarity. The
 * database holds the same rule for any writer, and the column never changes. The goal planner's
 * citations are `goal-planner.integration.test.ts`'s.
 *
 * Precedents are completed goals, written by other modules' paths (confirm, advance, accept): a
 * proposed goal is moved to `completed` with the guards off, or inserted so.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 };
// Synthetic, Handle-shaped: never a real credential.
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe.runIf(DATABASE_URL !== undefined)(
  'cited precedents (S11 GO17b, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let aliceId: string;
    let bobId: string;
    let worker: { definitionId: string; version: number };
    let savedProposedCap: string | undefined;

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });
    const as = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);
    /** A write with the guards off — fixtures whose write paths this wave does not own. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });
    /** As the kernel writes: the guards on. */
    const guarded = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => (await client.query(sql, [...params])).rows as T[]);

    function human(principalId: string, role: Role): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
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
    function entryAgent(obo: string, role: Role = 'member'): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      const scope: CapabilityScope = entryScope({}, { role });
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo,
          scope,
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    const call = (caller: ResolvedCaller, name: string, params: Record<string, unknown>) =>
      dispatchCapability({ pool }, caller, name, params);

    async function refusal(promise: Promise<unknown>) {
      try {
        await promise;
      } catch (err) {
        return mapCapabilityError(err);
      }
      throw new Error('expected a refusal');
    }

    const planOf = (key: string) => ({
      steps: [{ key, worker, input: { step: key } }],
    });
    const proposal = (statement: string, extra: Record<string, unknown> = {}) => ({
      statement,
      plan: planOf('only'),
      budget: BUDGET,
      ...extra,
    });

    async function propose(caller: ResolvedCaller, params: Record<string, unknown>) {
      const result = ProposeGoalResultWireSchema.parse(await call(caller, 'propose_goal', params));
      await raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        result.goalRunId,
      ]);
      return result;
    }

    /** A proposed goal moved to where a goal that ran ends: completed, with `outcome`. */
    async function complete(
      goalRunId: string,
      outcome: 'achieved' | 'not_achieved' = 'achieved',
      basis: 'verified_by_check' | 'requester' | 'reviewer_assessed' = 'verified_by_check',
    ) {
      await raw(
        `update goal_runs set status = 'completed', outcome = $3, outcome_basis = $4,
                current_revision = 1, confirmed_at = now(), ended_at = now(), next_tick_at = null
          where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId, outcome, basis],
      );
      await raw(
        `update plan_revisions set status = 'accepted', decided_by = proposed_by, decided_at = now()
          where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
        [workspaceId, goalRunId],
      );
    }

    /** A completed goal of `requester`, proposed and ended — a precedent of theirs. */
    async function precedent(
      requester: string,
      statement: string,
      outcome?: 'achieved' | 'not_achieved',
      basis?: 'verified_by_check' | 'requester' | 'reviewer_assessed',
    ) {
      const proposed = await propose(entryAgent(requester), proposal(statement));
      await complete(proposed.goalRunId, outcome, basis);
      return proposed.goalRunId;
    }

    const goalCount = async () => {
      const [row] = await raw<{ count: number }>(
        'select count(*)::int as count from goal_runs where workspace_id = $1',
        [workspaceId],
      );
      return row?.count ?? 0;
    };

    async function problemsOf(params: Record<string, unknown>): Promise<string[]> {
      const mapped = await refusal(call(entryAgent(aliceId), 'propose_goal', params));
      expect(mapped).toMatchObject({ status: 400, code: 'invalid_params' });
      return (mapped.details as { problems: string[] }).problems;
    }

    beforeAll(async () => {
      savedProposedCap = process.env.GOAL_MAX_PROPOSED_PER_REQUESTER;
      process.env.GOAL_MAX_PROPOSED_PER_REQUESTER = '1000';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      aliceId = randomUUID();
      bobId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go17b-cited-precedents',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'alice'),
                    ($1, $4, 'human', 'member', 'bob')`,
            [workspaceId, ownerId, aliceId, bobId],
          );
        },
        { skipRoleSwitch: true },
      );
      const proposed = await as(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          origin: 'human',
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
      if (savedProposedCap === undefined)
        Reflect.deleteProperty(process.env, 'GOAL_MAX_PROPOSED_PER_REQUESTER');
      else process.env.GOAL_MAX_PROPOSED_PER_REQUESTER = savedProposedCap;
    });

    it('two goals from the same Procedure: the second cites the first, and every read of its revision points at it', async () => {
      const steps: ProcedureStep[] = [
        { kind: 'worker', ...worker, key: 'renew', input: { site: 'main' } } as ProcedureStep,
      ];
      const draft = await as(ownerId, (client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          origin: 'human',
          name: `renew-${randomUUID().slice(0, 8)}`,
          description: 'Renew the certificates of a site.',
          steps,
        }),
      );
      await call(human(ownerId, 'owner'), 'publish_procedure', {
        procedureId: draft.id,
        version: draft.version,
        draftDigest: procedureDraftDigest(draft),
        credentialsReviewed: true,
      });
      const agent = entryAgent(aliceId);
      const first = await propose(agent, {
        statement: 'renew the main site',
        fromProcedure: { procedureId: draft.id },
        budget: BUDGET,
      });
      await complete(first.goalRunId);

      // The entry agent finds it as a precedent of the same Procedure, then cites it.
      const found = listEnvelope(GoalPrecedentWireSchema).parse(
        await call(agent, 'find_goal_precedents', { procedureId: draft.id }),
      ).items;
      expect(found.map((item) => [item.goalRunId, item.match])).toEqual([
        [first.goalRunId, 'procedure'],
      ]);
      const second = await propose(agent, {
        statement: 'renew the main site again',
        fromProcedure: { procedureId: draft.id },
        budget: BUDGET,
        precedents: [first.goalRunId],
      });
      const cited = [
        {
          goalRunId: first.goalRunId,
          statement: 'renew the main site',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
          polarity: 'positive',
        },
      ];
      const revision = PlanRevisionWireSchema.parse(
        await call(agent, 'get_goal_revision', { goalRunId: second.goalRunId, revision: 1 }),
      );
      expect(revision.citedPrecedents).toEqual(cited);
      expect(revision.fromProcedure?.procedureId).toBe(draft.id);
      // The person reads it on the goal's page.
      const detail = GoalDetailWireSchema.parse(
        await call(human(aliceId, 'member'), 'get_goal', { goalRunId: second.goalRunId }),
      );
      expect(detail.planRevision.citedPrecedents).toEqual(cited);
      expect(detail.revisions[0]?.citedPrecedents).toEqual(cited);
      // ...and the owner, who reads every goal there, the same.
      expect(
        GoalDetailWireSchema.parse(
          await call(human(ownerId, 'owner'), 'get_goal', { goalRunId: second.goalRunId }),
        ).revisions[0]?.citedPrecedents,
      ).toEqual(cited);
      // The first cites nothing.
      expect(
        PlanRevisionWireSchema.parse(
          await call(agent, 'get_goal_revision', { goalRunId: first.goalRunId, revision: 1 }),
        ).citedPrecedents,
      ).toEqual([]);
      // Stored on the revision, and in the propose audit.
      const [row] = await raw<{ cited_precedents: string[] }>(
        `select cited_precedents from plan_revisions
          where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
        [workspaceId, second.goalRunId],
      );
      expect(row?.cited_precedents).toEqual([first.goalRunId]);
      const [audit] = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and resource_type = 'goal_run' and resource_id = $2
            and action = 'goal_run.propose'`,
        [workspaceId, second.goalRunId],
      );
      expect(audit?.payload).toMatchObject({ citedPrecedents: [first.goalRunId] });
    });

    it('reads each cited goal as it ended, in the order cited: statement shown as every read shows it, outcome and polarity', async () => {
      const failed = await precedent(aliceId, 'rotate the key', 'not_achieved', 'requester');
      const onWord = await precedent(aliceId, 'rotate the key on my word', 'achieved', 'requester');
      // A credential in a statement is refused at propose: this one was written before that rule.
      await raw('update goal_runs set statement = $3 where workspace_id = $1 and id = $2', [
        workspaceId,
        onWord,
        `rotate the key, the old one is API_KEY=${FAKE}`,
      ]);
      const reviewed = await precedent(
        aliceId,
        'review the rotation',
        'achieved',
        'reviewer_assessed',
      );
      const proposed = await propose(
        entryAgent(aliceId),
        proposal('rotate the key once more', { precedents: [reviewed, failed, onWord] }),
      );
      const revision = PlanRevisionWireSchema.parse(
        await call(human(aliceId, 'member'), 'get_goal_revision', {
          goalRunId: proposed.goalRunId,
          revision: 1,
        }),
      );
      expect(
        revision.citedPrecedents.map((item) => [item.goalRunId, item.outcome, item.polarity]),
      ).toEqual([
        [reviewed, 'achieved', 'unverified'],
        [failed, 'not_achieved', 'negative'],
        [onWord, 'achieved', 'unverified'],
      ]);
      expect(revision.citedPrecedents[2]?.statement).toBe(
        'rotate the key, the old one is API_KEY=[redacted]',
      );
    });

    it('refuses what is not a completed goal of the requester, or is cited twice — with the place, nothing written', async () => {
      const own = await precedent(aliceId, 'tidy the release notes');
      const bobs = await precedent(bobId, 'tidy the release notes');
      const stillProposed = (await propose(entryAgent(aliceId), proposal('a goal not yet run')))
        .goalRunId;
      const cancelled = (await propose(entryAgent(aliceId), proposal('a goal turned down')))
        .goalRunId;
      await raw(
        `update goal_runs set status = 'cancelled', ended_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, cancelled],
      );
      const before = await goalCount();
      const unknown = randomUUID();
      const problems = await problemsOf(
        proposal('tidy them again', {
          precedents: [own, own, bobs, stillProposed, cancelled, unknown],
        }),
      );
      expect(problems).toEqual([
        `precedents.1: ${own} is cited a second time — cite each goal once`,
        ...[
          [2, bobs],
          [3, stillProposed],
          [4, cancelled],
          [5, unknown],
        ].map(
          ([index, id]) =>
            `precedents.${index}: ${id} is not a completed goal of the requester — find_goal_precedents lists theirs`,
        ),
      ]);
      expect(await goalCount()).toBe(before);
      // An owner's agent cites only the owner's own goals too.
      expect(
        (
          await refusal(
            call(
              entryAgent(ownerId, 'owner'),
              'propose_goal',
              proposal('x', { precedents: [own] }),
            ),
          )
        ).status,
      ).toBe(400);
      // The params' own limits.
      for (const precedents of [
        [],
        ['not-an-id'],
        Array.from({ length: 11 }, () => randomUUID()),
      ]) {
        expect(
          (await refusal(call(entryAgent(aliceId), 'propose_goal', proposal('y', { precedents }))))
            .status,
        ).toBe(400);
      }
      expect(await goalCount()).toBe(before);
    });

    it('a citation is not part of what makes two proposals the same', async () => {
      const own = await precedent(aliceId, 'archive the old tickets');
      const agent = entryAgent(aliceId);
      const key = `k-${randomUUID()}`;
      const keyed = await propose(agent, proposal('archive them', { idempotencyKey: key }));
      const again = await propose(
        agent,
        proposal('archive them', { idempotencyKey: key, precedents: [own] }),
      );
      expect(again).toMatchObject({ goalRunId: keyed.goalRunId, changed: false });
      const [row] = await raw<{ cited_precedents: string[] | null }>(
        `select cited_precedents from plan_revisions
          where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
        [workspaceId, keyed.goalRunId],
      );
      expect(row?.cited_precedents).toBeNull();
    });

    it('the database holds the same rule for any writer, and a citation never changes', async () => {
      const own = await precedent(aliceId, 'clean the build cache');
      const bobs = await precedent(bobId, 'clean the build cache');
      const fresh = (await propose(entryAgent(aliceId), proposal('a goal to revise'))).goalRunId;
      const insert = (cited: unknown) =>
        guarded(
          `insert into plan_revisions (workspace_id, goal_run_id, revision, based_on_revision, plan,
             proposed_by, cited_precedents)
           values ($1, $2, 2, 1, $3::jsonb, $4, $5::uuid[])`,
          [workspaceId, fresh, JSON.stringify(planOf('again')), aliceId, cited],
        );
      await expect(insert([fresh])).rejects.toThrow(/plan_revisions_cited_precedents_shape/);
      await expect(insert([])).rejects.toThrow(/plan_revisions_cited_precedents_shape/);
      await expect(insert([own, null])).rejects.toThrow(/plan_revisions_cited_precedents_shape/);
      await expect(insert(Array.from({ length: 11 }, () => randomUUID()))).rejects.toThrow(
        /plan_revisions_cited_precedents_shape/,
      );
      await expect(insert([own, own])).rejects.toThrow(/cites each precedent once/);
      await expect(insert([bobs])).rejects.toThrow(/not a completed goal of the same requester/);
      await expect(insert([randomUUID()])).rejects.toThrow(
        /not a completed goal of the same requester/,
      );
      // The requester's own goal that has not ended, or ended cancelled, is no precedent either
      // (#493 on #1087: the trigger's `status = 'completed'` had no test of its own).
      const stillProposed = (await propose(entryAgent(aliceId), proposal('a goal not yet run')))
        .goalRunId;
      const cancelled = (await propose(entryAgent(aliceId), proposal('a goal turned down')))
        .goalRunId;
      await raw(
        `update goal_runs set status = 'cancelled', ended_at = now()
          where workspace_id = $1 and id = $2`,
        [workspaceId, cancelled],
      );
      for (const notEnded of [stillProposed, cancelled]) {
        await expect(insert([notEnded])).rejects.toThrow(
          /not a completed goal of the same requester/,
        );
      }
      // Written once, never changed: not by an update, not to nothing.
      await raw(
        `update plan_revisions set cited_precedents = $3::uuid[]
          where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
        [workspaceId, fresh, [own]],
      );
      for (const next of [null, [own, bobs]]) {
        await expect(
          guarded(
            `update plan_revisions set cited_precedents = $3::uuid[]
              where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
            [workspaceId, fresh, next],
          ),
        ).rejects.toThrow(/content never changes \(cited_precedents\)/);
      }
    });
  },
);
