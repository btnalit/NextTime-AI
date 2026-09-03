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

  it('member calling set_quota → ForbiddenError (403)', async () => {
    // set_quota (governance group, human channel, minRole:'owner') is wired (S2.7) — this test
    // still proves role-gating alone 403s a `member` *before* dispatch ever reaches the handler
    // (authorizeCapabilityCall runs first, independent of whether a handler exists) — `1` is a
    // structurally valid `value` (set_quota's own paramsSchema is `{key: string, value:
    // unknown}`), so a 403 here can only come from the role check, not from later per-key
    // validation the handler itself would perform.
    await expect(
      dispatchCapability({ pool: neverConnectPool }, humanCaller({ role: 'member' }), 'set_quota', {
        key: 'x',
        value: 1,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('owner calling issue_handle passes authorization (the 403 above is role-specific)', async () => {
    // issue_handle (governance group, human channel, minRole:'owner') has no wired handler yet
    // (S1.9 registered it; no task has implemented it) — CapabilityNotImplementedError (not
    // ForbiddenError) proves authorization itself passed for `owner`, unlike `set_quota` for
    // `member` above. (Prior to S2.7, this test used `set_quota` for the same purpose — it now has
    // a real handler, so a still-unimplemented owner-only capability is needed here instead.)
    await expect(
      dispatchCapability(
        { pool: neverConnectPool },
        humanCaller({ role: 'owner' }),
        'issue_handle',
        {
          sessionId: randomUUID(),
          scope: {},
        },
      ),
    ).rejects.toThrow(CapabilityNotImplementedError);
  });

  it('a registry capability with no wired handler → CapabilityNotImplementedError (501)', async () => {
    // `create_task` (task group, handle channel) has no wired handler — S2.7's own deliberate
    // decision (see application/gateway/handlers.ts's neighboring doc comment on
    // `setQuotaHandler`: create_task's paramsSchema carries no definitionId/version, and
    // tasks.worker_definition_id/.worker_definition_version are NOT NULL, so there is no way to
    // build a well-formed Task from this capability's own params alone).
    //
    // History of this test's example capability (kept for context, since this is now the third
    // swap): `request_action` was the example through S2.3 (unresolvable without a Gatekeeper
    // manifest, S2.4); S2.4 itself pre-emptively swapped to `cancel_task` in anticipation of S2.7
    // owning it — but S2.7 (this PR) wired `cancel_task` too (a thin, low-cost wrapper over the
    // `terminateTask` service function it already needed elsewhere), so a third swap was needed.
    await expect(
      dispatchCapability(
        { pool: neverConnectPool },
        humanCaller({ role: 'member' }),
        'create_task',
        {
          input: {},
        },
      ),
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
