import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, SkillStatsWire } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/get-skill-stats-handler.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) — who may call `get_skill_stats` (S11 W1a E2-1, fork 7 = a: builder floor,
 * human channel). How it counts is application/task/skill-stats.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'get_skill_stats capability (S11 W1a E2-1, integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    const principals: Record<'owner' | 'builder' | 'member', string> = {
      owner: randomUUID(),
      builder: randomUUID(),
      member: randomUUID(),
    };
    let skillId: string;

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
          scope: { capabilities: ['get_skill_stats'], resources: {} },
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
      skillId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: principals.owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'e2-1-get-skill-stats',
          ]);
          for (const [role, id] of Object.entries(principals)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $3)",
              [workspaceId, id, role],
            );
          }
          await client.query(
            `insert into skills (workspace_id, id, version, status, name, description, markdown,
               proposed_by, published_by, published_at)
             values ($1, $2, 1, 'published', 'restart-web', 'd', '# m', $3, $3, now())`,
            [workspaceId, skillId, principals.builder],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it.each(['owner', 'builder'] as const)('%s reads it', async (role) => {
      const stats = (await dispatchCapability({ pool }, humanCaller(role), 'get_skill_stats', {
        skillId,
      })) as SkillStatsWire;
      expect(stats).toMatchObject({
        skillId,
        name: 'restart-web',
        reviewStreak: 3,
        versions: [{ version: 1, status: 'published', usage: { runs: 0 }, segments: [] }],
        failureGroups: [],
      });
    });

    it('is null for an unknown Skill', async () => {
      expect(
        await dispatchCapability({ pool }, humanCaller('builder'), 'get_skill_stats', {
          skillId: randomUUID(),
        }),
      ).toBeNull();
    });

    it('a member and an agent cannot read it', async () => {
      await expect(
        dispatchCapability({ pool }, humanCaller('member'), 'get_skill_stats', { skillId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        dispatchCapability({ pool }, ownerAgent(), 'get_skill_stats', { skillId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  },
);
