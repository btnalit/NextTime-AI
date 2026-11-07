import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, WorkerDefinitionStatsWire, WorkerSpec } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { workerSpecDigest } from '../task/step-attempt.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/get-worker-definition-stats-handler.integration.test: DB-gated (real
 * Postgres; auto-skip without DATABASE_URL) — who may call `get_worker_definition_stats` (S11
 * GO16a, legacy 569: builder floor, human channel, as `get_skill_stats`), which versions it
 * lists, and whose goals' WorkerSpec digests the caller is given (the gateway's goal viewer: the
 * requester, and the owner every goal — review #493 on #1064). How it counts is
 * application/task/worker-definition-stats.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'get_worker_definition_stats capability (S11 GO16a, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    const principals: Record<'owner' | 'builder' | 'member', string> = {
      owner: randomUUID(),
      builder: randomUUID(),
      member: randomUUID(),
    };
    let definitionId: string;
    let draftOnlyId: string;

    function humanCaller(role: Role): ResolvedCaller {
      const principalId = principals[role as keyof typeof principals];
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

    /** The owner's agent, its Handle scoped to the capability — the channel still refuses it. */
    function ownerAgent(): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: principals.owner,
          scope: { capabilities: ['get_worker_definition_stats'], resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      definitionId = randomUUID();
      draftOnlyId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: principals.owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go16a-get-worker-definition-stats',
          ]);
          for (const [role, id] of Object.entries(principals)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $3)",
              [workspaceId, id, role],
            );
          }
          // v1 published, v2 the builder's draft (a WorkerDefinition draft is its proposer's
          // alone, and never runs); a second family that is only a draft.
          const insert = `insert into worker_definitions (workspace_id, id, version, kind, status,
              definition, proposed_by)
            values ($1, $2, $3, 'worker', $4, $5, $6)`;
          await client.query(insert, [
            workspaceId,
            definitionId,
            1,
            'published',
            '{"name":"fixer"}',
            principals.builder,
          ]);
          await client.query(insert, [
            workspaceId,
            definitionId,
            2,
            'draft',
            '{"name":"fixer, next"}',
            principals.builder,
          ]);
          await client.query(insert, [
            workspaceId,
            draftOnlyId,
            1,
            'draft',
            '{"name":"unpublished"}',
            principals.owner,
          ]);
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

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

    /** A completed Task of `familyId` v1 that ran as a step of `requester`'s goal with `spec`. */
    async function goalStepTask(familyId: string, requester: string, spec: WorkerSpec) {
      const [goal] = await raw<{ id: string }>(
        `insert into goal_runs (workspace_id, status, on_behalf_of, statement, current_revision,
           confirmed_at, budget_max_tokens, budget_max_steps, budget_max_revisions,
           budget_max_wall_clock_seconds)
         values ($1, 'running', $2, 'a goal', 1, now(), 100000, 10, 5, 3600) returning id`,
        [workspaceId, requester],
      );
      await raw(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan,
           proposed_by, decided_by, decided_at)
         values ($1, $2, 1, 'accepted', $3, $4, $4, now())`,
        [workspaceId, goal?.id, JSON.stringify({ steps: [{ key: 's', spec }] }), requester],
      );
      const [step] = await raw<{ id: string }>(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision,
           status, attempt_count, updated_at)
         values ($1, $2, 's', 1, 'running', 1, now()) returning id`,
        [workspaceId, goal?.id],
      );
      await raw(
        `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, goal_run_id, step_run_id, plan_revision, step_attempt,
           run_config_snapshot)
         values ($1, $2, 'completed', $3, $4, 1, $5, $6, 1, 1, $7)`,
        [
          workspaceId,
          randomUUID(),
          requester,
          familyId,
          goal?.id,
          step?.id,
          JSON.stringify({ v: 2, spec: { digest: workerSpecDigest(spec) } }),
        ],
      );
    }

    it('gives the builder the digest of a WorkerSpec that ran in their own goal, a label for one that ran only in the owner’s; the owner is given both', async () => {
      const familyId = randomUUID();
      await raw(
        `insert into worker_definitions (workspace_id, id, version, kind, status, definition,
           proposed_by)
         values ($1, $2, 1, 'worker', 'published', '{"name":"spec-visibility"}', $3)`,
        [workspaceId, familyId, principals.owner],
      );
      const own: WorkerSpec = { instructions: 'the builder’s own' };
      const owners: WorkerSpec = { model: 'model-x' };
      await goalStepTask(familyId, principals.builder, own);
      await goalStepTask(familyId, principals.owner, owners);
      const ownDigest = workerSpecDigest(own) as string;
      const ownersDigest = workerSpecDigest(owners) as string;

      const read = async (role: Role) => {
        const stats = (await dispatchCapability(
          { pool },
          humanCaller(role),
          'get_worker_definition_stats',
          { definitionId: familyId },
        )) as WorkerDefinitionStatsWire;
        return new Map(
          stats.versions[0]?.combinations.map((combination) => [
            combination.fields?.[0],
            [combination.specRef, combination.specDigest],
          ]),
        );
      };
      expect(await read('builder')).toEqual(
        new Map([
          ['instructions', [ownDigest.slice(0, 12), ownDigest]],
          ['model', ['#1', null]],
        ]),
      );
      expect(await read('owner')).toEqual(
        new Map([
          ['instructions', [ownDigest.slice(0, 12), ownDigest]],
          ['model', [ownersDigest.slice(0, 12), ownersDigest]],
        ]),
      );
    });

    it.each(['owner', 'builder'] as const)(
      '%s reads it: the published version, never a draft',
      async (role) => {
        const stats = (await dispatchCapability(
          { pool },
          humanCaller(role),
          'get_worker_definition_stats',
          { definitionId },
        )) as WorkerDefinitionStatsWire;
        expect(stats).toMatchObject({
          definitionId,
          name: 'fixer',
          reviewStreak: 3,
          versions: [
            {
              version: 1,
              status: 'published',
              usage: { runs: 0 },
              segments: [],
              combinations: [],
            },
          ],
          failureGroups: [],
        });
        expect(stats.versions).toHaveLength(1);
      },
    );

    it('is null for an unknown family, and for one that is only a draft — even its proposer’s', async () => {
      expect(
        await dispatchCapability({ pool }, humanCaller('builder'), 'get_worker_definition_stats', {
          definitionId: randomUUID(),
        }),
      ).toBeNull();
      expect(
        await dispatchCapability({ pool }, humanCaller('owner'), 'get_worker_definition_stats', {
          definitionId: draftOnlyId,
        }),
      ).toBeNull();
    });

    it('a member and an agent cannot read it', async () => {
      await expect(
        dispatchCapability({ pool }, humanCaller('member'), 'get_worker_definition_stats', {
          definitionId,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        dispatchCapability({ pool }, ownerAgent(), 'get_worker_definition_stats', {
          definitionId,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  },
);
