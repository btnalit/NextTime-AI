import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcedureStatsWire, Role } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { proposeProcedure, publishProcedure } from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/get-procedure-stats-handler.integration.test: DB-gated (real Postgres;
 * auto-skip without DATABASE_URL) — who may call `get_procedure_stats` (S11 W1a E2-2: builder
 * floor, human channel, as `get_skill_stats`), and `find_procedures` carrying each result's outcome
 * hint to every caller (fork 4 = a). How they count is
 * application/task/procedure-stats.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'get_procedure_stats and the find_procedures hint (S11 W1a E2-2, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    const principals: Record<'owner' | 'builder' | 'member', string> = {
      owner: randomUUID(),
      builder: randomUUID(),
      member: randomUUID(),
    };
    let procedureId: string;
    /** One keyword token, so `find_procedures` matches this Procedure only. */
    const need = `hintcheck${randomUUID().replace(/-/g, '')}`;

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

    /** The owner's agent, its Handle scoped to `capability`. */
    function ownerAgent(capability: string): ResolvedCaller {
      const now = Math.floor(Date.now() / 1000);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: principals.owner,
          scope: { capabilities: [capability], resources: {} },
          jti: randomUUID(),
          iat: now,
          exp: now + 600,
        },
      };
    }

    /** A goal made from `procedureId@1` that ended with `outcome` on `basis`. */
    async function endedGoal(outcome: string, basis: string): Promise<void> {
      await withWorkspace(
        pool,
        { workspaceId, principalId: principals.owner },
        async (client) => {
          await client.query('set local session_replication_role = replica');
          const goal = await client.query<{ id: string }>(
            `insert into goal_runs (workspace_id, status, outcome, outcome_basis, on_behalf_of,
               statement, current_revision, confirmed_at, budget_max_tokens, budget_max_steps,
               budget_max_revisions, budget_max_wall_clock_seconds, ended_at)
             values ($1, 'completed', $2, $3, $4, 'a goal', 1, now(), 100000, 10, 5, 3600, now())
             returning id`,
            [workspaceId, outcome, basis, principals.owner],
          );
          await client.query(
            `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan,
               proposed_by, decided_by, decided_at, source_procedure_id, source_procedure_version)
             values ($1, $2, 1, 'accepted', '{"steps":[]}', $3, $3, now(), $4, 1)`,
            [workspaceId, goal.rows[0]?.id, principals.owner, procedureId],
          );
        },
        { skipRoleSwitch: true },
      );
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
            'e2-2-get-procedure-stats',
          ]);
          for (const [role, id] of Object.entries(principals)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $3)",
              [workspaceId, id, role],
            );
          }
        },
        { skipRoleSwitch: true },
      );
      // An approval-only Procedure: every caller can carry it out, so find_procedures lists it.
      procedureId = await withWorkspace(
        pool,
        { workspaceId, principalId: principals.owner },
        async (client) => {
          const draft = await proposeProcedure(client, workspaceId, principals.owner, {
            name: need,
            description: 'Asks a person before anything else.',
            steps: [{ kind: 'approval', description: 'A person agrees to go ahead.' }],
          });
          await publishProcedure(client, workspaceId, principals.owner, draft.id);
          return draft.id;
        },
      );
      await endedGoal('achieved', 'requester');
      await endedGoal('not_achieved', 'requester');
      await endedGoal('achieved', 'reviewer_assessed');
    });

    afterAll(async () => {
      await pool.end();
    });

    it.each(['owner', 'builder'] as const)('%s reads get_procedure_stats', async (role) => {
      const stats = (await dispatchCapability({ pool }, humanCaller(role), 'get_procedure_stats', {
        procedureId,
      })) as ProcedureStatsWire;
      expect(stats).toMatchObject({
        procedureId,
        name: need,
        reviewStreak: 3,
        versions: [
          {
            version: 1,
            status: 'published',
            usage: { goals: 3, byStatus: { completed: 3 } },
            outcomes: { primary: { achieved: 1, notAchieved: 1, total: 2 } },
          },
        ],
        failureGroups: [{ procedureVersion: 1, place: 'requester', goals: 1 }],
      });
    });

    it('get_procedure_stats is null for an unknown Procedure', async () => {
      expect(
        await dispatchCapability({ pool }, humanCaller('builder'), 'get_procedure_stats', {
          procedureId: randomUUID(),
        }),
      ).toBeNull();
    });

    it('a member and an agent cannot read get_procedure_stats', async () => {
      await expect(
        dispatchCapability({ pool }, humanCaller('member'), 'get_procedure_stats', {
          procedureId,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        dispatchCapability({ pool }, ownerAgent('get_procedure_stats'), 'get_procedure_stats', {
          procedureId,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('find_procedures carries the version’s primary outcomes to a member and to an agent', async () => {
      for (const caller of [humanCaller('member'), ownerAgent('find_procedures')]) {
        const found = (await dispatchCapability({ pool }, caller, 'find_procedures', {
          need,
        })) as { items: { procedureId: string; version: number; outcomes: unknown }[] };
        expect(found.items).toEqual([
          expect.objectContaining({
            procedureId,
            version: 1,
            outcomes: { achieved: 1, total: 2 },
          }),
        ]);
      }
    });
  },
);
