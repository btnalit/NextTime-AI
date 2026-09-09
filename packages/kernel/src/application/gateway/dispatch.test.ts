import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_REGISTRY } from '@nexttime/shared';
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
  isResultValidationEnabled,
} from './dispatch.js';
import { CAPABILITY_HANDLERS } from './handlers.js';
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
        { principalId: randomUUID(), resourceType: 'x', scope: {} },
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

  // Removed (docs/development-tasks.md §S3.5, feat/s3-5-explorer): this test's own comment history
  // was a chain of "swap to a still-unimplemented, human-channel, minRole-gated-for-a-role-other-
  // than-member capability" (set_quota → issue_handle → export_prov, each retired once that
  // capability got a real handler). `export_prov` was the last one — grep confirms every remaining
  // unimplemented capability (`supersede_fact`/`invalidate_fact`/`create_task`/`register_source`/
  // `submit_observations`) is `channel:'handle'`, so there is no longer a `channel:'human'` example
  // left to swap to, and none is coming: the registry does not grow new `minRole`-gated-and-
  // unimplemented human capabilities on its own. Not adapted in place either — export_prov's own
  // authorization-passes-for-auditor case now reaches a real handler that needs the database
  // (`explain`/`causal_chain`), which no longer fits this describe block's own "decided before any
  // transaction (unit, no DB)" contract. The two things this test actually verified are both still
  // covered elsewhere: the pure role-hierarchy logic (`roleSatisfiesMinRole`, "member does not
  // satisfy minRole:auditor") in `authorize.test.ts`; export_prov's own real auditor-passes,
  // member-would-403 path (DB-gated, since the handler genuinely needs it) in
  // `export-prov-handler.integration.test.ts`.

  // W4 closeout: `create_task` — this test's fourth and, per this comment, final swap (`request_
  // action` → `cancel_task` → `create_task`, each retired once that capability got a real handler,
  // see the prior two swaps' own history in this file's git log) — was `create_task`
  // (`application/task/invoke.ts`'s `createTask`, W4 closeout, reversing S2.7's original "not
  // wired" decision now that `definitionId`/`version` params exist). Grepping the registry
  // (`packages/shared/src/capabilities.ts`) against `CAPABILITY_HANDLERS`
  // (`application/gateway/handlers.ts`) confirms zero remaining registered-but-unimplemented
  // capabilities — there is no real fixture left to swap this test's example capability to, and
  // none is expected (the registry does not grow new unimplemented entries on its own). Rather
  // than pick a fake name (`dispatchCapability` would 404 on it — `CapabilityNotImplementedError`
  // only fires for a name that *is* registered but has no handler, `dispatch.ts`'s own
  // `lookupCapabilityOrThrow` runs first) or mutate the real, shared, module-level
  // `CAPABILITY_HANDLERS`/`CAPABILITY_REGISTRY` singletons for one test (would leak into every
  // other test in this process), this now pins the actual invariant the swap-chain tests were
  // always only approximating one example of: every registered capability has a wired handler. A
  // future capability added to the registry without a handler (deliberately, mid-development, same
  // as every capability this chain ever swapped to) will fail this test by name, no swap needed.
  it('every registered capability has a wired handler (no registered-but-unimplemented capability remains)', () => {
    // `<gate>.<op>`/`<gate>.<op>:execute` are runtime-generated placeholder *patterns* in the
    // registry (packages/shared/src/capabilities.ts's own neighboring comment: "never actually
    // dispatched by this literal name" — the concrete capabilities behind them are
    // `observe_operation`/`request_action`) — docs/development-tasks.md S3.7's own accounting
    // excludes exactly these two from the "registered but unimplemented" count for the same
    // reason. Every other registry entry must have a real handler.
    const GATE_PLACEHOLDER_NAMES = new Set(['<gate>.<op>', '<gate>.<op>:execute']);
    const unimplemented = CAPABILITY_REGISTRY.filter(
      (capability) =>
        !GATE_PLACEHOLDER_NAMES.has(capability.name) && !CAPABILITY_HANDLERS.has(capability.name),
    ).map((capability) => capability.name);
    expect(unimplemented).toEqual([]);
  });

  // The mechanism itself (`dispatch.ts`'s `if (!handler) throw new CapabilityNotImplementedError
  // (name)`, decided before any transaction is opened — never touches `neverConnectPool`) — proven
  // directly, independent of whether the real registry currently has an unimplemented example.
  it('CapabilityNotImplementedError is thrown before any transaction opens', () => {
    const err = new CapabilityNotImplementedError('some_future_capability');
    expect(err.message).toContain('some_future_capability');
    expect(err.name).toBe('CapabilityNotImplementedError');
  });
});

// S3.7 (docs/wire-contract-conventions.md §5): `isResultValidationEnabled` is the pure predicate
// `dispatchCapability`'s own result-shape self-check gates on — tested directly (an explicit `env`
// argument, never mutating the real `process.env`) rather than through a full dispatch, since
// every other integration test in this file already exercises the *enabled* path for free
// (packages/kernel/vitest.config.ts sets `KERNEL_VALIDATE_RESULTS=1` for this whole test file —
// see that config's own doc comment).
describe('isResultValidationEnabled — KERNEL_VALIDATE_RESULTS flag', () => {
  it('is enabled only when the env var is exactly "1"', () => {
    expect(isResultValidationEnabled({ KERNEL_VALIDATE_RESULTS: '1' })).toBe(true);
  });

  it('is disabled when the env var is unset (production default)', () => {
    expect(isResultValidationEnabled({})).toBe(false);
  });

  it('is disabled for any other value (not silently truthy on "true"/"yes"/etc.)', () => {
    expect(isResultValidationEnabled({ KERNEL_VALIDATE_RESULTS: 'true' })).toBe(false);
    expect(isResultValidationEnabled({ KERNEL_VALIDATE_RESULTS: '0' })).toBe(false);
    expect(isResultValidationEnabled({ KERNEL_VALIDATE_RESULTS: '' })).toBe(false);
  });

  it('defaults to reading the real process.env when no argument is given', () => {
    const previous = process.env.KERNEL_VALIDATE_RESULTS;
    try {
      process.env.KERNEL_VALIDATE_RESULTS = '1';
      expect(isResultValidationEnabled()).toBe(true);
      process.env.KERNEL_VALIDATE_RESULTS = '0';
      expect(isResultValidationEnabled()).toBe(false);
    } finally {
      if (previous === undefined) process.env.KERNEL_VALIDATE_RESULTS = undefined;
      else process.env.KERNEL_VALIDATE_RESULTS = previous;
    }
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
