import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/fact-handlers.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) proof that `supersede_fact`/`invalidate_fact` are wired end-to-end through
 * `dispatchCapability` (docs/development-tasks.md S3.3 — the two "thin wrapper" capabilities not
 * already covered by `application/gateway/handlers.test.ts`'s own `assert_fact` I16 coverage or
 * `interfaces/http/capability-route.test.ts`'s own `assert_fact` HTTP round-trip).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function handleCaller(
  workspaceId: string,
  obo: string,
  capabilities: readonly string[],
): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope: { capabilities: [...capabilities], resources: {} },
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

const graphStore = new SqlGraphStore();

describe.runIf(DATABASE_URL !== undefined)(
  'fact-handlers (integration, real Postgres, dispatchCapability)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let memberId: string;

    async function makeObject(objectType: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: memberId }, async (client) => {
        const object = await graphStore.upsertObject(client, workspaceId, {
          objectType,
          properties: {},
        });
        return object.id;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = randomUUID();
      memberId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: memberId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'fact-handlers-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, memberId, 'human', 'member', 'member'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('supersede_fact replaces content, keeps identity, and marks the prior Fact superseded', async () => {
      const sourceObjectId = await makeObject('test.fact-handlers-source');
      const targetObjectId = await makeObject('test.fact-handlers-target');
      const caller = handleCaller(workspaceId, memberId, ['assert_fact', 'supersede_fact']);

      const original = (await dispatchCapability({ pool }, caller, 'assert_fact', {
        sourceObjectId,
        targetObjectId,
        linkType: 'has_note',
        properties: { note: 'v1' },
      })) as { id: string; supersedesId: string | null };
      expect(original.supersedesId).toBeNull();

      const superseded = (await dispatchCapability({ pool }, caller, 'supersede_fact', {
        factId: original.id,
        sourceObjectId,
        targetObjectId,
        linkType: 'has_note',
        properties: { note: 'v2' },
      })) as {
        id: string;
        supersedesId: string | null;
        properties: Record<string, unknown>;
        linkType: string;
      };
      expect(superseded.supersedesId).toBe(original.id);
      expect(superseded.properties).toEqual({ note: 'v2' });

      await withWorkspace(pool, { workspaceId, principalId: memberId }, async (client) => {
        const row = await client.query<{ superseded_at: Date | null }>(
          'select superseded_at from links where workspace_id = $1 and id = $2',
          [workspaceId, original.id],
        );
        expect(row.rows[0]?.superseded_at).not.toBeNull();
      });
    });

    it('supersede_fact rejects a replacement whose (linkType, sourceObjectId, targetObjectId) does not match the Fact it supersedes (I5)', async () => {
      const sourceObjectId = await makeObject('test.fact-handlers-source');
      const targetObjectId = await makeObject('test.fact-handlers-target');
      const otherTargetObjectId = await makeObject('test.fact-handlers-other-target');
      const caller = handleCaller(workspaceId, memberId, ['assert_fact', 'supersede_fact']);

      const original = (await dispatchCapability({ pool }, caller, 'assert_fact', {
        sourceObjectId,
        targetObjectId,
        linkType: 'has_note',
        properties: { note: 'v1' },
      })) as { id: string };

      await expect(
        dispatchCapability({ pool }, caller, 'supersede_fact', {
          factId: original.id,
          sourceObjectId,
          targetObjectId: otherTargetObjectId, // mismatched identity
          linkType: 'has_note',
          properties: { note: 'v2' },
        }),
      ).rejects.toMatchObject({ name: 'SupersedeIdentityMismatchError' });
    });

    it('invalidate_fact marks a Fact invalidated with the given reason', async () => {
      const sourceObjectId = await makeObject('test.fact-handlers-source');
      const targetObjectId = await makeObject('test.fact-handlers-target');
      const caller = handleCaller(workspaceId, memberId, ['assert_fact', 'invalidate_fact']);

      const fact = (await dispatchCapability({ pool }, caller, 'assert_fact', {
        sourceObjectId,
        targetObjectId,
        linkType: 'has_note',
        properties: { note: 'v1' },
      })) as { id: string };

      const invalidated = (await dispatchCapability({ pool }, caller, 'invalidate_fact', {
        factId: fact.id,
        reason: 'no longer true',
      })) as { id: string; invalidatedAt: string | null; invalidationReason: string | null };

      expect(invalidated.invalidatedAt).not.toBeNull();
      expect(invalidated.invalidationReason).toBe('no longer true');
    });
  },
);
