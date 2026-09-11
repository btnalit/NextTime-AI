import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../../application/identity/index.js';
import { runMigrations } from './migrate.js';
import { withPlatform } from './platform-context.js';
import { createPool, withWorkspace } from './pool.js';

/**
 * adapters/db/platform-rls.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL, same `describe.runIf` pattern every other integration suite in this package
 * uses) proof that migration 0021's row-level-security policies on `users` behave exactly as
 * `platform-context.ts`'s own module doc comment claims: a plain workspace transaction (role
 * `nexttime_app`, no `app.platform` GUC) sees only the users who are members of *its* workspace,
 * can never INSERT into `users`, and can never SELECT `password_hash`; a platform transaction
 * (`withPlatform`, `app.platform = on`) sees and writes every row. `lookup_user_by_login`
 * (security definer) is the one deliberate hole in the workspace-scoped SELECT policy — the
 * `add_member` capability's own lookup path.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'migration 0021 — users/user_sessions RLS (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerPrincipalId: string;
    let memberUserId: string;
    let memberLogin: string;
    let outsiderUserId: string;
    let outsiderLogin: string;

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

    /** Links `userId` into `workspaceId` as a `kind='human'` Principal — the raw-insert shape
     *  every other integration suite's own `adminInsertPrincipal` uses (bootstrap-level trust,
     *  the same reasoning `cli/bootstrap.ts`'s `addPrincipal` doc comment gives). */
    async function adminInsertMemberPrincipal(
      ws: string,
      userId: string,
      displayName: string,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, user_id)
             values ($1, $2, 'human', 'member', $3, $4)`,
            [ws, id, displayName, userId],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('platform-rls-test-workspace');
      // An owner Principal so `app.principal_id` names something real inside the workspace
      // transactions below — not load-bearing for the `users` policies themselves (they key off
      // `app_workspace()`/`app_platform()` only), just consistent with every other suite's own
      // fixtures.
      ownerPrincipalId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerPrincipalId },
        (client) =>
          client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'RLS Test Owner')`,
            [workspaceId, ownerPrincipalId],
          ),
        { skipRoleSwitch: true },
      );

      memberLogin = `rls-member-${randomUUID().slice(0, 8)}`;
      const member = await createUser(pool, {
        login: memberLogin,
        displayName: 'RLS Member',
        password: 'correct horse battery staple',
      });
      memberUserId = member.id;
      await adminInsertMemberPrincipal(workspaceId, memberUserId, 'RLS Member');

      // A platform user who holds no membership anywhere — must never be visible through the
      // workspace-scoped SELECT policy, but must resolve through `lookup_user_by_login`.
      outsiderLogin = `rls-outsider-${randomUUID().slice(0, 8)}`;
      const outsider = await createUser(pool, {
        login: outsiderLogin,
        displayName: 'RLS Outsider',
        password: 'correct horse battery staple',
      });
      outsiderUserId = outsider.id;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a workspace transaction (nexttime_app, no platform GUC) sees only members of its own workspace', async () => {
      const ids = await withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, async (client) => {
        const result = await client.query<{ id: string }>('select id from users');
        return result.rows.map((row) => row.id);
      });
      expect(ids).toContain(memberUserId);
      expect(ids).not.toContain(outsiderUserId);
    });

    it('a workspace transaction cannot INSERT into users (no INSERT policy applies)', async () => {
      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, (client) =>
          client.query('insert into users (login, display_name) values ($1, $2)', [
            `rls-insert-fail-${randomUUID().slice(0, 8)}`,
            'Should Not Insert',
          ]),
        ),
      ).rejects.toThrow();
    });

    it('a workspace transaction cannot SELECT password_hash (no column grant)', async () => {
      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, (client) =>
          client.query('select password_hash from users limit 1'),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('a platform transaction sees every user, across every workspace', async () => {
      const ids = await withPlatform(pool, { userId: memberUserId }, async (client) => {
        const result = await client.query<{ id: string }>('select id from users');
        return result.rows.map((row) => row.id);
      });
      expect(ids).toContain(memberUserId);
      expect(ids).toContain(outsiderUserId);
    });

    it('a platform transaction can INSERT into users', async () => {
      const login = `rls-platform-insert-${randomUUID().slice(0, 8)}`;
      const insertedId = await withPlatform(pool, { userId: memberUserId }, async (client) => {
        const result = await client.query<{ id: string }>(
          'insert into users (login, display_name) values ($1, $2) returning id',
          [login, 'Platform Insert'],
        );
        return result.rows[0]?.id;
      });
      expect(insertedId).toBeTruthy();
    });

    it('lookup_user_by_login resolves a non-member from inside a workspace transaction', async () => {
      const row = await withWorkspace(pool, { workspaceId, principalId: ownerPrincipalId }, async (client) => {
        const result = await client.query<{ id: string; display_name: string; status: string }>(
          'select id, display_name, status from lookup_user_by_login($1)',
          [outsiderLogin],
        );
        return result.rows[0];
      });
      expect(row?.id).toBe(outsiderUserId);
      expect(row?.status).toBe('active');
    });
  },
);
