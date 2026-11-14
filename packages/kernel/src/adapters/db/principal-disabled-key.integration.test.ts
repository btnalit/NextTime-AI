import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { createPool, withWorkspace } from './pool.js';

/**
 * adapters/db/principal-disabled-key.integration.test (legacy 738, core 0059): a disabled
 * Principal holds no API key, as the database keeps it whatever the code does — the write that
 * disables one clears its key, any other write that would leave a disabled Principal with a key is
 * refused, and the migration clears the keys earlier disables left, one audit record each.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION_0059 = path.join(MIGRATIONS_DIR, 'core', '0059_disabled_principal_no_api_key.sql');
const CONSTRAINT = 'principals_disabled_no_api_key';

const newKeyHash = () => randomBytes(32).toString('hex');

describe.runIf(DATABASE_URL !== undefined)(
  'adapters/db — a disabled Principal holds no API key (integration, real Postgres)',
  () => {
    let pool: Pool;
    const workspaceId = randomUUID();
    const ownerId = randomUUID();

    const asApp = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    const asSuperuser = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    /** A service Principal with a key, written past RLS. */
    async function serviceWithKey(label: string): Promise<{ id: string; hash: string }> {
      const id = randomUUID();
      const hash = newKeyHash();
      await asSuperuser((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
           values ($1, $2, 'service', 'member', $3, $4)`,
          [workspaceId, id, label, hash],
        ),
      );
      return { id, hash };
    }

    async function rowOf(id: string) {
      const result = await asSuperuser((client) =>
        client.query<{ api_key_hash: string | null; disabled: boolean }>(
          `select api_key_hash, disabled_at is not null as disabled from principals
            where workspace_id = $1 and id = $2`,
          [workspaceId, id],
        ),
      );
      return result.rows[0];
    }

    async function refusal(write: () => Promise<unknown>) {
      const err = await write().then(
        () => undefined,
        (caught: unknown) => caught as { code?: string; constraint?: string },
      );
      expect(err, 'the write should have been refused').toBeDefined();
      return { code: err?.code, constraint: err?.constraint };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      await asSuperuser(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'disabled-principal-key',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'Key Owner')`,
          [workspaceId, ownerId],
        );
      });
    });

    afterAll(async () => {
      await pool?.end();
    });

    it('the write that disables a Principal clears its key, even one that sets disabled_at only', async () => {
      const service = await serviceWithKey('Disabled by a bare write');
      const written = await asApp((client) =>
        client.query<{ api_key_hash: string | null }>(
          `update principals set disabled_at = now() where workspace_id = $1 and id = $2
           returning api_key_hash`,
          [workspaceId, service.id],
        ),
      );
      expect(written.rows).toEqual([{ api_key_hash: null }]);
      expect(await rowOf(service.id)).toEqual({ api_key_hash: null, disabled: true });
    });

    it('a write that would leave a disabled Principal with a key is refused, never silently dropped', async () => {
      const service = await serviceWithKey('Disabled, then given a key');
      await asApp((client) =>
        client.query(
          'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
          [workspaceId, service.id],
        ),
      );
      // The previous release's `rotate_api_key` on a disabled service account.
      expect(
        await refusal(() =>
          asApp((client) =>
            client.query(
              'update principals set api_key_hash = $3 where workspace_id = $1 and id = $2',
              [workspaceId, service.id, newKeyHash()],
            ),
          ),
        ),
      ).toEqual({ code: '23514', constraint: CONSTRAINT });
      // Naming disabled_at again does not count as disabling: the key is refused, not cleared.
      expect(
        await refusal(() =>
          asApp((client) =>
            client.query(
              `update principals set disabled_at = coalesce(disabled_at, now()), api_key_hash = $3
                where workspace_id = $1 and id = $2`,
              [workspaceId, service.id, newKeyHash()],
            ),
          ),
        ),
      ).toEqual({ code: '23514', constraint: CONSTRAINT });
      // Nor does disabling a Principal set a new key in the same statement (#1210 review): only
      // the key the row already held is cleared; a new one is refused, not dropped.
      const active = await serviceWithKey('Disabled with a new key');
      expect(
        await refusal(() =>
          asApp((client) =>
            client.query(
              `update principals set disabled_at = now(), api_key_hash = $3
                where workspace_id = $1 and id = $2`,
              [workspaceId, active.id, newKeyHash()],
            ),
          ),
        ),
      ).toEqual({ code: '23514', constraint: CONSTRAINT });
      expect(await rowOf(active.id)).toEqual({ api_key_hash: active.hash, disabled: false });
      // Nor is a Principal inserted disabled with a key.
      expect(
        await refusal(() =>
          asSuperuser((client) =>
            client.query(
              `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash, disabled_at)
               values ($1, $2, 'service', 'member', 'Born disabled', $3, now())`,
              [workspaceId, randomUUID(), newKeyHash()],
            ),
          ),
        ),
      ).toEqual({ code: '23514', constraint: CONSTRAINT });
      expect(await rowOf(service.id)).toEqual({ api_key_hash: null, disabled: true });
    });

    it('an active Principal keeps its key through other writes', async () => {
      const service = await serviceWithKey('Still active');
      await asApp((client) =>
        client.query(
          `update principals set role = 'builder', disabled_at = null
            where workspace_id = $1 and id = $2`,
          [workspaceId, service.id],
        ),
      );
      expect(await rowOf(service.id)).toEqual({ api_key_hash: service.hash, disabled: false });
    });

    it('the migration clears the key an earlier disable left, with one audit record per Principal, and a second run changes nothing', async () => {
      const migration = readFileSync(MIGRATION_0059, 'utf8');
      const left = await serviceWithKey('Left with a key');
      const active = await serviceWithKey('Active with a key');
      const disabledNoKey = await serviceWithKey('Disabled without a key');
      await asApp((client) =>
        client.query(
          'update principals set disabled_at = now() where workspace_id = $1 and id = any($2::uuid[])',
          [workspaceId, [left.id, disabledNoKey.id]],
        ),
      );
      // A disabled Principal with a key, as a release before 0059 left one: the constraint is
      // dropped for the length of this transaction (its lock keeps every other writer of
      // `principals` out until the migration has put it back), the key is written back without
      // naming `disabled_at` (so the trigger stays out of it), and the whole migration runs.
      await asSuperuser(async (client) => {
        await client.query(`alter table principals drop constraint ${CONSTRAINT}`);
        await client.query(
          'update principals set api_key_hash = $3 where workspace_id = $1 and id = $2',
          [workspaceId, left.id, left.hash],
        );
        await client.query(migration);
      });

      expect(await rowOf(left.id)).toEqual({ api_key_hash: null, disabled: true });
      expect(await rowOf(active.id)).toEqual({ api_key_hash: active.hash, disabled: false });
      expect(await rowOf(disabledNoKey.id)).toEqual({ api_key_hash: null, disabled: true });
      const audits = () =>
        asSuperuser((client) =>
          client.query<{
            actor: string;
            resource_type: string;
            resource_id: string;
            payload: unknown;
          }>(
            `select actor_principal_id as actor, resource_type, resource_id, payload from audit_records
              where workspace_id = $1 and action = 'principal.disabled_api_key_cleared'`,
            [workspaceId],
          ),
        );
      const first = await audits();
      expect(first.rows).toEqual([
        {
          actor: left.id,
          resource_type: 'principal',
          resource_id: left.id,
          payload: {
            by: 'migration core/0059_disabled_principal_no_api_key',
            reason: expect.stringContaining('could not sign in'),
          },
        },
      ]);
      const constraints = await asSuperuser((client) =>
        client.query<{ conname: string }>(
          `select conname from pg_constraint
            where conrelid = 'principals'::regclass and conname = $1 and convalidated`,
          [CONSTRAINT],
        ),
      );
      expect(constraints.rows).toHaveLength(1);

      await asSuperuser((client) => client.query(migration));
      expect((await audits()).rows).toHaveLength(1);
      expect(await rowOf(active.id)).toEqual({ api_key_hash: active.hash, disabled: false });
    });
  },
);
