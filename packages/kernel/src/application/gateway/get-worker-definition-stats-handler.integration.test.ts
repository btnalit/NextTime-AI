import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, WorkerDefinitionStatsWire } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/get-worker-definition-stats-handler.integration.test: DB-gated (real
 * Postgres; auto-skip without DATABASE_URL) — who may call `get_worker_definition_stats` (S11
 * GO16a, legacy 569: builder floor, human channel, as `get_skill_stats`) and which versions it
 * lists. How it counts is application/task/worker-definition-stats.integration.test.ts.
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
