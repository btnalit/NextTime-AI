import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/grant-capability.test: review 2026-10-02 R-26 / maintainer decision D-14 —
 * `grant_capability` creates only the per-gate grant the console shows and revokes
 * (`resourceType: 'gatekeeper'` with a required `resourceId`). Two suites, same split as
 * `dispatch.test.ts`:
 *
 *   - Unit (no DB): a wildcard or non-gatekeeper grant is refused (400 `invalid_params`) by the
 *     registry's `paramsSchema` before any transaction opens.
 *   - Integration (DATABASE_URL, auto-skip otherwise): the refused shapes write no row, and a
 *     per-gate grant is still created, listed and revocable.
 *
 * Historical wildcard / `action_kind` rows keep being evaluated exactly as before (the read paths
 * are unchanged) — `governance/capability/grants.integration.test.ts` covers that matching.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function ownerCaller(workspaceId: string, principalId: string): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role: 'owner', displayName: null },
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

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('dispatchCapability should not touch the database for this call');
  },
};

/** Every shape `grant_capability` no longer creates: a wildcard gate grant, and an `action_kind`
 *  or other resource type with or without a resourceId. */
function refusedShapes(principalId: string): readonly Record<string, unknown>[] {
  return [
    { principalId, resourceType: 'gatekeeper' },
    { principalId, resourceType: 'container.restart' },
    { principalId, resourceType: 'container.restart', resourceId: randomUUID() },
    { principalId, resourceType: 'worker_definition', resourceId: randomUUID() },
  ];
}

describe('grant_capability — only per-gate grants (unit, no DB)', () => {
  it.each(refusedShapes(randomUUID()).map((params) => [JSON.stringify(params), params]))(
    'refuses %s with InvalidCapabilityParamsError (400) before any transaction',
    async (_label, params) => {
      await expect(
        dispatchCapability(
          { pool: neverConnectPool },
          ownerCaller(randomUUID(), randomUUID()),
          'grant_capability',
          params,
        ),
      ).rejects.toBeInstanceOf(InvalidCapabilityParamsError);
    },
  );
});

describe.runIf(DATABASE_URL !== undefined)(
  'grant_capability — only per-gate grants (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let operatorId: string;

    async function grantRowCount(): Promise<number> {
      const rows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ n: number }>(
          'select count(*)::int as n from capability_grants where workspace_id = $1 and principal_id = $2',
          [workspaceId, operatorId],
        ),
      );
      return rows.rows[0]?.n ?? 0;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      operatorId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'grant-capability-test-workspace',
          ]);
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5), ($1, $6, $3, $7, $8)',
            [workspaceId, ownerId, 'human', 'owner', 'owner', operatorId, 'operator', 'operator'],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a wildcard or non-gatekeeper grant is refused and writes no row', async () => {
      for (const params of refusedShapes(operatorId)) {
        await expect(
          dispatchCapability(
            { pool },
            ownerCaller(workspaceId, ownerId),
            'grant_capability',
            params,
          ),
        ).rejects.toBeInstanceOf(InvalidCapabilityParamsError);
      }
      expect(await grantRowCount()).toBe(0);
    });

    it('a per-gate grant is created, listed and revocable', async () => {
      const gatekeeperId = randomUUID();
      const owner = ownerCaller(workspaceId, ownerId);
      const granted = (await dispatchCapability({ pool }, owner, 'grant_capability', {
        principalId: operatorId,
        resourceType: 'gatekeeper',
        resourceId: gatekeeperId,
      })) as { id: string; resourceType: string; resourceId: string | null; status: string };
      expect(granted).toMatchObject({
        resourceType: 'gatekeeper',
        resourceId: gatekeeperId,
        status: 'active',
      });

      const listed = (await dispatchCapability({ pool }, owner, 'list_grants', {
        principalId: operatorId,
      })) as { items: { id: string }[] };
      expect(listed.items.map((item) => item.id)).toContain(granted.id);

      const revoked = (await dispatchCapability({ pool }, owner, 'revoke_capability', {
        grantId: granted.id,
      })) as { status: string };
      expect(revoked.status).toBe('revoked');
    });
  },
);
