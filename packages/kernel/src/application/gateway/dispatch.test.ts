import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { queryAudit, writeAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { ForbiddenError } from './authorize.js';
import {
  CapabilityNotFoundError,
  CapabilityNotImplementedError,
  dispatchCapability,
} from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/dispatch.test: two suites, matching the pattern established elsewhere in
 * this package (e.g. governance/capability/handles.test.ts):
 *
 *   - Unit (no DB): every error path that is decided before a transaction is opened (unknown
 *     capability → 404; forbidden → 403, incl. "member 调 grant_capability" S1.3 acceptance;
 *     unimplemented → 501) — proven to never touch the database via a `pool` whose `connect()`
 *     throws.
 *   - Integration (DATABASE_URL, auto-skip otherwise): a real `get_object` call end-to-end, and
 *     the S1.3 acceptance criterion "audit 写失败整体回滚" — a forced `audit_records` insert
 *     failure inside the same transaction as a prior write rolls the write back too.
 */

const DATABASE_URL = process.env.DATABASE_URL;

function humanCaller(overrides: {
  workspaceId?: string;
  principalId?: string;
  role?: 'owner' | 'builder' | 'operator' | 'member' | 'auditor';
}): ResolvedCaller {
  const workspaceId = overrides.workspaceId ?? randomUUID();
  const principalId = overrides.principalId ?? randomUUID();
  return {
    channel: 'human',
    principal: {
      workspaceId,
      id: principalId,
      kind: 'human',
      role: overrides.role ?? 'member',
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

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('dispatchCapability should not touch the database for this call');
  },
};

describe('dispatchCapability — decided before any transaction (unit, no DB)', () => {
  it('unknown capability name → CapabilityNotFoundError (404)', async () => {
    await expect(
      dispatchCapability({ pool: neverConnectPool }, humanCaller({}), 'no_such_capability', {}),
    ).rejects.toThrow(CapabilityNotFoundError);
  });

  it('member calling grant_capability → ForbiddenError (403) — S1.3 acceptance', async () => {
    await expect(
      dispatchCapability(
        { pool: neverConnectPool },
        humanCaller({ role: 'member' }),
        'grant_capability',
        { principalId: randomUUID(), capability: 'x', scope: {} },
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('owner calling grant_capability passes authorization (the 403 above is role-specific)', async () => {
    // grant_capability has no S1.3 handler, so this still ends in 501 — but CapabilityNotImplementedError
    // (not ForbiddenError) proves authorization itself passed for `owner`, unlike for `member` above.
    await expect(
      dispatchCapability(
        { pool: neverConnectPool },
        humanCaller({ role: 'owner' }),
        'grant_capability',
        { principalId: randomUUID(), capability: 'x', scope: {} },
      ),
    ).rejects.toThrow(CapabilityNotImplementedError);
  });

  it('a registry capability with no wired handler → CapabilityNotImplementedError (501)', async () => {
    // `approve` (governance group, human channel, minRole:'operator') has no S1.3 handler.
    await expect(
      dispatchCapability({ pool: neverConnectPool }, humanCaller({ role: 'operator' }), 'approve', {
        actionRequestId: randomUUID(),
      }),
    ).rejects.toThrow(CapabilityNotImplementedError);
  });
});

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'dispatchCapability — integration (real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(opts: {
      kind: string;
      role: string;
      displayName: string;
    }): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            'insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, $3, $4, $5)',
            [workspaceId, id, opts.kind, opts.role, opts.displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('dispatch-test-workspace');
      ownerId = await adminInsertPrincipal({ kind: 'human', role: 'owner', displayName: 'owner' });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('get_object dispatches through the real handler and writes one audit record', async () => {
      const store = new SqlGraphStore();
      const objectId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const object = await store.upsertObject(client, workspaceId, {
            objectType: 'test.thing',
            properties: { name: 'A' },
          });
          return object.id;
        },
      );

      const caller = humanCaller({ workspaceId, principalId: ownerId, role: 'owner' });
      const result = (await dispatchCapability({ pool }, caller, 'get_object', {
        objectId,
      })) as { id: string } | null;

      expect(result?.id).toBe(objectId);

      const audit = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, { action: 'get_object', resourceId: objectId }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorPrincipalId).toBe(ownerId);
    });

    it('audit 写失败整体回滚: a forced audit-insert failure rolls back a prior write in the same transaction', async () => {
      const store = new SqlGraphStore();

      // A principal id that satisfies RLS (real workspace) but has no row in `principals` — the
      // audit_records FK on actor_principal_id will reject it, forcing writeAudit to throw.
      const nonExistentPrincipalId = randomUUID();

      let objectIdAttempted = '';
      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.run',
            principalId: ownerId,
          });
          const object = await store.upsertObject(client, workspaceId, {
            objectType: 'test.rollback-thing',
            properties: {},
          });
          objectIdAttempted = object.id;
          await writeAudit(client, {
            workspaceId,
            actorPrincipalId: nonExistentPrincipalId, // forces the FK violation
            action: 'test.forced_failure',
            resourceType: 'object',
            resourceId: object.id,
            payload: { activityId: activity.id },
          });
        }),
      ).rejects.toThrow();

      expect(objectIdAttempted).not.toBe('');

      const survived = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query('select id from objects where id = $1', [
            objectIdAttempted,
          ]);
          return result.rows;
        },
      );
      expect(survived).toHaveLength(0);
    });
  },
);
