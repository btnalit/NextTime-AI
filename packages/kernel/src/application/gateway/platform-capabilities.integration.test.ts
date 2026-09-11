import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CreateUserResultWire,
  ListEnvelope,
  PlatformAuditRecordWire,
  PlatformOverviewWire,
  PlatformSettingsWire,
  UserMembershipWire,
  UserWire,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';
import { addPrincipal } from '../../cli/bootstrap.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { CONSOLE_SESSION_COOKIE, createPlatformAdmin, createUser } from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { updatePlatformSettings } from '../platform/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { withAdminClient } from './auth.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { PlatformAdminError } from './platform-handlers.js';
import type { PlatformErrorCode } from './platform-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/platform-capabilities.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL, the same `describe.runIf` pattern every other integration suite in this
 * package uses) coverage of the P-A1 `scope: 'platform'` capabilities — the user directory,
 * memberships, platform settings, the platform audit stream and the overview
 * (application/gateway/platform-handlers.ts; docs/platform-admin-design.md §5/§6.1/§6.6/§6.7).
 *
 * The bulk drives `dispatchCapability` with a `channel: 'platform'` caller (application/gateway/
 * caller.ts) — exactly the shape interfaces/http's `resolvePlatformCaller` hands it — because the
 * platform transaction, the platform audit row and the handlers themselves all live below that
 * seam, same as members-flow.integration.test.ts does for the workspace plane. The authorization
 * block instead goes through real HTTP (`app.inject` with an injected ephemeral Handle key pair
 * and a login cookie, exactly like interfaces/http/auth-routes.integration.test.ts): *who* may
 * reach a platform capability is decided in resolve-caller.ts, above dispatch, and that decision
 * is the point of those cases.
 *
 * **Isolation.** Unlike every other integration suite here, this file creates, migrates and drops
 * a private database of its own. The guards under test are database-*global* counts — the
 * `last_admin` rule (`assertAdminCanBeReduced`) refuses only when no other active administrator
 * exists anywhere, and the shared CI database always carries some from cli/bootstrap.test.ts and
 * interfaces/http/auth-routes.integration.test.ts; `platform_audit_query` and `platform_overview`
 * read the whole database for the same reason. The alternative (temporarily disabling other
 * files' administrators) would mutate state those files own, so a private database it is. It needs
 * nothing the shared one does not: CREATE DATABASE on the configured login (CI's `nexttime` is the
 * Postgres container's superuser) and the same `runMigrations` call — which
 * migrations/core/0001_identity.sql's own header already anticipates being run "against a
 * different database in the same Postgres cluster".
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const REPO_ROOT = path.resolve(KERNEL_ROOT, '..', '..');
const ONTOLOGY_DIR = path.join(REPO_ROOT, 'ontology');

const PASSWORD = 'correct horse battery staple';
const CSRF_HEADERS = { 'x-requested-with': 'nexttime', 'content-type': 'application/json' };

/** Creates and migrates a database of this file's own (see the module doc comment), plus the
 *  `drop` that ends the pool and removes it again. */
async function createIsolatedDatabase(): Promise<{
  readonly pool: Pool;
  readonly drop: () => Promise<void>;
}> {
  if (DATABASE_URL === undefined) throw new Error('createIsolatedDatabase needs DATABASE_URL');
  const cluster = createPool();
  // Hex only — nothing here can be quoted-identifier trickery, and it stays under Postgres's
  // 63-byte identifier limit.
  const name = `nexttime_platform_caps_${randomUUID().replace(/-/g, '')}`;
  try {
    await cluster.query(`create database "${name}"`);
  } catch (err) {
    // Never leave the cluster pool open behind a failure (an open pool keeps the worker alive).
    await cluster.end();
    throw err;
  }
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString() });
  return {
    pool,
    drop: async () => {
      await pool.end();
      // `with (force)` (Postgres 13+): never leave the database behind because a connection of
      // this file's own outlived the pool.
      await cluster.query(`drop database if exists "${name}" with (force)`);
      await cluster.end();
    },
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'P-A1 platform capabilities (integration, real Postgres)',
  () => {
    let pool: Pool;
    let dropDatabase: (() => Promise<void>) | undefined;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    /** The acting administrator: owner of `workspaceId`, the actor of every dispatched call. */
    let admin: UserRow;
    let adminLogin: string;
    /** A second administrator with no membership anywhere — the `workspace_required` case, and the
     *  administrator that steps aside so the `last_admin` guards can fire. */
    let secondAdmin: UserRow;
    let secondAdminLogin: string;
    let workspaceId: string;
    /** An ordinary workspace Principal's API key — a credential that must never reach the
     *  platform plane, whatever its role. */
    let workspaceApiKey: string;

    function appWithKeys() {
      return createServer({
        pool,
        loadHandlePublicKey: async () => publicKey,
        loadHandlePrivateKey: async () => privateKey,
      });
    }

    function setCookieHeader(headers: Record<string, unknown>): string {
      const raw = headers['set-cookie'];
      const first = Array.isArray(raw) ? raw[0] : raw;
      if (typeof first !== 'string') throw new Error('no Set-Cookie header');
      return first;
    }

    function cookieValue(setCookie: string): string {
      const match = new RegExp(`^${CONSOLE_SESSION_COOKIE}=([^;]*)`).exec(setCookie);
      if (!match?.[1]) throw new Error(`unexpected Set-Cookie: ${setCookie}`);
      return match[1];
    }

    async function loginAs(
      app: ReturnType<typeof createServer>,
      login: string,
      password: string,
    ): Promise<string> {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: CSRF_HEADERS,
        payload: { login, password },
      });
      if (response.statusCode !== 200) {
        throw new Error(`loginAs("${login}") failed: ${response.statusCode} ${response.body}`);
      }
      return cookieValue(setCookieHeader(response.headers));
    }

    /** The caller `resolvePlatformCaller` builds for an administrator's console session — no
     *  workspace, no Principal (application/gateway/caller.ts). */
    function platformCaller(user: UserRow): ResolvedCaller {
      return {
        channel: 'platform',
        user: {
          id: user.id,
          login: user.login,
          displayName: user.displayName,
          platformRole: 'admin',
          mustChangePassword: false,
          consoleSessionId: randomUUID(),
        },
      };
    }

    function callAs<T>(
      caller: ResolvedCaller,
      name: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      return dispatchCapability({ pool }, caller, name, params) as Promise<T>;
    }

    function callAsAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      return callAs<T>(platformCaller(admin), name, params);
    }

    /** `PlatformAdminError` carries the code interfaces/http maps to 404/409 — assert the code,
     *  not the message. */
    async function expectPlatformError(
      call: () => Promise<unknown>,
      code: PlatformErrorCode,
    ): Promise<void> {
      const thrown = await call().then(
        () => {
          throw new Error(`expected PlatformAdminError("${code}"), but the call resolved`);
        },
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(PlatformAdminError);
      expect((thrown as PlatformAdminError).code).toBe(code);
    }

    beforeAll(async () => {
      const isolated = await createIsolatedDatabase();
      pool = isolated.pool;
      dropDatabase = isolated.drop;
      await runMigrations(pool, MIGRATIONS_DIR);

      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;

      adminLogin = `plat-admin-${randomUUID().slice(0, 8)}`;
      admin = await createPlatformAdmin(pool, {
        login: adminLogin,
        displayName: 'Platform Admin',
        password: PASSWORD,
      });
      secondAdminLogin = `plat-admin2-${randomUUID().slice(0, 8)}`;
      secondAdmin = await createPlatformAdmin(pool, {
        login: secondAdminLogin,
        displayName: 'Second Admin',
        password: PASSWORD,
      });

      const created = await createWorkspaceWithOwner(pool, {
        name: 'platform-capabilities-test-workspace',
        owner: { userId: admin.id, displayName: 'Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      workspaceId = created.workspaceId;
      // `create_user` joins the platform default workspace when the call names none.
      await withAdminClient(pool, (client) =>
        updatePlatformSettings(client, { defaultWorkspaceId: workspaceId }, null),
      );

      const principal = await addPrincipal(pool, workspaceId, 'API Key Fixture');
      workspaceApiKey = principal.apiKey;
      // A fresh database plus the meta-ontology seeding of one workspace is well past Vitest's
      // 10s default hook timeout.
    }, 180_000);

    afterAll(async () => {
      await dropDatabase?.();
    }, 60_000);

    // ---- authorization ---------------------------------------------------------------------

    describe('authorization', () => {
      it('an API key (a workspace Principal) never reaches a platform capability — 403', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_users',
          headers: { ...CSRF_HEADERS, authorization: `Bearer ${workspaceApiKey}` },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      });

      it("a console session whose user is platform_role 'user' — 403", async () => {
        const login = `plain-user-${randomUUID().slice(0, 8)}`;
        await createUser(pool, { login, displayName: 'Plain User', password: PASSWORD });
        const app = appWithKeys();
        const cookie = await loginAs(app, login, PASSWORD);

        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_users',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
      });

      it('an administrator cookie reaches list_users with no X-Workspace-Id at all — 200', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, adminLogin, PASSWORD);

        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_users',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: {},
        });
        expect(response.statusCode).toBe(200);
        expect(Array.isArray(response.json().result.items)).toBe(true);
      });

      it('an administrator with no membership calling get_workspace — 403 workspace_required', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, secondAdminLogin, PASSWORD);

        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/get_workspace',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'workspace_required' } });
      });

      it('a platform caller is refused a workspace capability by dispatch itself', async () => {
        await expect(
          dispatchCapability({ pool }, platformCaller(admin), 'get_workspace', {}),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    // ---- users: create / list -----------------------------------------------------------------

    describe('create_user', () => {
      it('returns the temporary password once, forces a change, and joins the default workspace', async () => {
        const login = `created-${randomUUID().slice(0, 8)}`;
        const created = await callAsAdmin<CreateUserResultWire>('create_user', {
          login,
          displayName: 'Created User',
          password: PASSWORD,
        });

        expect(created.temporaryPassword).toBe(PASSWORD);
        expect(created.user.login).toBe(login);
        expect(created.user.platformRole).toBe('user');
        expect(created.user.hasPassword).toBe(true);
        expect(created.user.mustChangePassword).toBe(true);
        expect(created.user.memberships).toHaveLength(1);
        expect(created.user.memberships[0]?.workspaceId).toBe(workspaceId);
        expect(created.user.memberships[0]?.role).toBe('member');

        // The platform audit row (dispatch.ts's `scope: 'platform'` branch): no workspace, the
        // administrator as actor, and `redactedParamKeys` kept the password out of it.
        const audit = await withAdminClient(pool, (client) =>
          client.query<{
            workspace_id: string | null;
            actor_user_id: string;
            payload: { params?: { password?: string } };
          }>(
            `select workspace_id, actor_user_id, payload from audit_records
              where action = 'create_user' and resource_id = $1`,
            [created.user.id],
          ),
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]?.workspace_id).toBeNull();
        expect(audit.rows[0]?.actor_user_id).toBe(admin.id);
        expect(audit.rows[0]?.payload.params?.password).toBe('[redacted]');
        expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain(PASSWORD);
      });
    });

    describe('list_users', () => {
      const token = `page-${randomUUID().slice(0, 8)}`;
      const logins = [`${token}-1`, `${token}-2`, `${token}-3`];

      beforeAll(async () => {
        for (const login of logins) {
          // `workspaceId: null` — no membership needed here, and it keeps the default workspace
          // out of a pagination fixture.
          await callAsAdmin<CreateUserResultWire>('create_user', {
            login,
            displayName: `Paged ${login}`,
            password: PASSWORD,
            workspaceId: null,
          });
        }
      }, 30_000);

      it('pages with the cursor: 3 users, limit 2 → 2 + a cursor → 1 more', async () => {
        const first = await callAsAdmin<ListEnvelope<UserWire>>('list_users', {
          query: token,
          limit: 2,
        });
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).toBeDefined();

        const second = await callAsAdmin<ListEnvelope<UserWire>>('list_users', {
          query: token,
          limit: 2,
          cursor: first.nextCursor,
        });
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeUndefined();

        const paged = [...first.items, ...second.items].map((user) => user.login);
        expect([...paged].sort()).toEqual([...logins].sort());
      });

      it('filters on a case-insensitive substring of the login or display name', async () => {
        const exact = await callAsAdmin<ListEnvelope<UserWire>>('list_users', {
          query: `${token}-2`.toUpperCase(),
        });
        expect(exact.items).toHaveLength(1);
        expect(exact.items[0]?.login).toBe(`${token}-2`);

        const all = await callAsAdmin<ListEnvelope<UserWire>>('list_users', { query: token });
        expect(all.items.map((user) => user.login).sort()).toEqual([...logins].sort());
      });
    });

    // ---- users: status, password ---------------------------------------------------------------

    describe('set_user_status', () => {
      it('disabling revokes the console session and every workspace session of the user', async () => {
        const login = `disabled-${randomUUID().slice(0, 8)}`;
        const user = await createUser(pool, {
          login,
          displayName: 'To Be Disabled',
          password: PASSWORD,
        });
        await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });

        const app = appWithKeys();
        const cookie = await loginAs(app, login, PASSWORD);
        // A workspace capability call on that cookie is what mints the `sessions` row
        // (resolve-caller.ts → auth.ts's `createOrReuseWebSession`).
        const workspaceCall = await app.inject({
          method: 'POST',
          url: '/api/cap/get_workspace',
          headers: {
            ...CSRF_HEADERS,
            cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}`,
            'x-workspace-id': workspaceId,
          },
          payload: {},
        });
        expect(workspaceCall.statusCode).toBe(200);

        const disabled = await callAsAdmin<UserWire>('set_user_status', {
          userId: user.id,
          status: 'disabled',
        });
        expect(disabled.status).toBe('disabled');

        const me = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
        });
        expect(me.statusCode).toBe(401);

        const consoleSessions = await withAdminClient(pool, (client) =>
          client.query<{ revoked_at: Date | null }>(
            'select revoked_at from user_sessions where user_id = $1',
            [user.id],
          ),
        );
        expect(consoleSessions.rows.length).toBeGreaterThan(0);
        expect(consoleSessions.rows.every((row) => row.revoked_at !== null)).toBe(true);

        const workspaceSessions = await withAdminClient(pool, (client) =>
          client.query<{ status: string }>(
            `select s.status from sessions s
               join principals p on p.workspace_id = s.workspace_id and p.id = s.principal_id
              where p.user_id = $1`,
            [user.id],
          ),
        );
        expect(workspaceSessions.rows.length).toBeGreaterThan(0);
        expect(workspaceSessions.rows.every((row) => row.status === 'revoked')).toBe(true);
        // A password hash plus a verify (scrypt, ~1s together on a CI runner) on top of the
        // round-trips above — past Vitest's 5s default.
      }, 30_000);
    });

    describe('reset_user_password', () => {
      it('invalidates the old password and hands out a temporary one', async () => {
        const login = `reset-${randomUUID().slice(0, 8)}`;
        const user = await createUser(pool, {
          login,
          displayName: 'Reset Me',
          password: PASSWORD,
        });
        const app = appWithKeys();
        await loginAs(app, login, PASSWORD);

        const reset = await callAsAdmin<{ userId: string; temporaryPassword: string }>(
          'reset_user_password',
          { userId: user.id },
        );
        expect(reset.userId).toBe(user.id);
        expect(reset.temporaryPassword.length).toBeGreaterThan(0);
        expect(reset.temporaryPassword).not.toBe(PASSWORD);

        const withOld = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { login, password: PASSWORD },
        });
        expect(withOld.statusCode).toBe(401);

        const withNew = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { login, password: reset.temporaryPassword },
        });
        expect(withNew.statusCode).toBe(200);
        expect(withNew.json().result.user.mustChangePassword).toBe(true);
        // Two scrypt hashes and three verifies — past Vitest's 5s default on a CI runner.
      }, 30_000);
    });

    // ---- the last administrator -----------------------------------------------------------------

    describe('the last active administrator', () => {
      // `countOtherActiveAdmins` counts the whole database, so the second administrator steps
      // aside for these two cases and is restored right afterwards.
      beforeAll(async () => {
        await callAsAdmin<UserWire>('set_user_status', {
          userId: secondAdmin.id,
          status: 'disabled',
        });
      });

      afterAll(async () => {
        await callAsAdmin<UserWire>('set_user_status', {
          userId: secondAdmin.id,
          status: 'active',
        });
      });

      it('set_user_status: cannot be disabled — neither by itself nor by another administrator', async () => {
        await expectPlatformError(
          () => callAsAdmin('set_user_status', { userId: admin.id, status: 'disabled' }),
          'last_admin',
        );
        await expectPlatformError(
          () =>
            callAs(platformCaller(secondAdmin), 'set_user_status', {
              userId: admin.id,
              status: 'disabled',
            }),
          'last_admin',
        );
      });

      it('update_user: cannot be demoted, and NEXTTIME_PLATFORM_ADMINS refuses first', async () => {
        await expectPlatformError(
          () => callAsAdmin('update_user', { userId: admin.id, platformRole: 'user' }),
          'last_admin',
        );

        const previous = process.env.NEXTTIME_PLATFORM_ADMINS;
        process.env.NEXTTIME_PLATFORM_ADMINS = admin.login;
        try {
          await expectPlatformError(
            () => callAsAdmin('update_user', { userId: admin.id, platformRole: 'user' }),
            'protected_admin',
          );
        } finally {
          if (previous === undefined) {
            // biome-ignore lint/performance/noDelete: process.env coerces `= undefined` to the string "undefined" instead of unsetting the var; delete is the only way to make it actually absent.
            delete process.env.NEXTTIME_PLATFORM_ADMINS;
          } else {
            process.env.NEXTTIME_PLATFORM_ADMINS = previous;
          }
        }
      });
    });

    // ---- memberships -----------------------------------------------------------------------------

    describe('memberships', () => {
      it('add_membership: creates the membership once; a repeat → already_member', async () => {
        const user = await createUser(pool, {
          login: `member-${randomUUID().slice(0, 8)}`,
          displayName: 'Membership Fixture',
          password: PASSWORD,
        });

        const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        expect(membership.workspaceId).toBe(workspaceId);
        expect(membership.role).toBe('member');
        expect(membership.disabled).toBe(false);

        await expectPlatformError(
          () => callAsAdmin('add_membership', { userId: user.id, workspaceId, role: 'member' }),
          'already_member',
        );
      });

      it('set_membership_role: the workspace’s last owner cannot be demoted', async () => {
        await expectPlatformError(
          () =>
            callAsAdmin('set_membership_role', {
              userId: admin.id,
              workspaceId,
              role: 'member',
            }),
          'last_owner',
        );
      });

      it('remove_membership: disables the membership Principal; the last owner is refused', async () => {
        const user = await createUser(pool, {
          login: `removed-${randomUUID().slice(0, 8)}`,
          displayName: 'Removed Member',
          password: PASSWORD,
        });
        const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });

        const removed = await callAsAdmin<{ removed: boolean }>('remove_membership', {
          userId: user.id,
          workspaceId,
        });
        expect(removed.removed).toBe(true);

        const principal = await withAdminClient(pool, (client) =>
          client.query<{ disabled_at: Date | null }>(
            'select disabled_at from principals where workspace_id = $1 and id = $2',
            [workspaceId, membership.principalId],
          ),
        );
        expect(principal.rows[0]?.disabled_at).not.toBeNull();

        await expectPlatformError(
          () => callAsAdmin('remove_membership', { userId: admin.id, workspaceId }),
          'last_owner',
        );
      });
    });

    // ---- merge_user ------------------------------------------------------------------------------

    describe('merge_user', () => {
      it('re-points a passwordless user’s memberships at the target and deletes the source', async () => {
        const source = await createUser(pool, {
          login: `merge-src-${randomUUID().slice(0, 8)}`,
          displayName: 'Merge Source',
        });
        const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: source.id,
          workspaceId,
          role: 'member',
        });
        const target = await createUser(pool, {
          login: `merge-dst-${randomUUID().slice(0, 8)}`,
          displayName: 'Merge Target',
          password: PASSWORD,
        });

        const merged = await callAsAdmin<UserWire>('merge_user', {
          sourceUserId: source.id,
          targetUserId: target.id,
        });
        expect(merged.id).toBe(target.id);
        expect(merged.memberships.map((m) => m.principalId)).toContain(membership.principalId);

        const principal = await withAdminClient(pool, (client) =>
          client.query<{ user_id: string | null }>(
            'select user_id from principals where workspace_id = $1 and id = $2',
            [workspaceId, membership.principalId],
          ),
        );
        expect(principal.rows[0]?.user_id).toBe(target.id);

        const gone = await withAdminClient(pool, (client) =>
          client.query('select 1 from users where id = $1', [source.id]),
        );
        expect(gone.rowCount).toBe(0);
      });

      it('refuses a source that has a password — already_claimed', async () => {
        const source = await createUser(pool, {
          login: `merge-pw-${randomUUID().slice(0, 8)}`,
          displayName: 'Password Source',
          password: PASSWORD,
        });
        const target = await createUser(pool, {
          login: `merge-tgt-${randomUUID().slice(0, 8)}`,
          displayName: 'Merge Target Two',
          password: PASSWORD,
        });

        await expectPlatformError(
          () => callAsAdmin('merge_user', { sourceUserId: source.id, targetUserId: target.id }),
          'already_claimed',
        );
      });
    });

    // ---- platform settings -------------------------------------------------------------------------

    describe('platform settings', () => {
      it('get_platform_settings projects the compiled-in defaults over the stored document', async () => {
        const settings = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        expect(settings.siteName).toBe('NextTime AI');
        expect(settings.passwordMinLength).toBe(8);
        expect(settings.defaultPlatformRole).toBe('user');
        expect(settings.defaultWorkspaceId).toBe(workspaceId);
      });

      it('update_platform_settings bumps the version and archives the previous document', async () => {
        const before = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        expect(before.version).toBeGreaterThan(0);

        const announcement = `maintenance window ${randomUUID().slice(0, 8)}`;
        const after = await callAsAdmin<PlatformSettingsWire>('update_platform_settings', {
          announcement,
        });
        expect(after.announcement).toBe(announcement);
        expect(after.version).toBe(before.version + 1);
        expect(after.updatedAt).not.toBeNull();
        // An omitted key is left exactly as it was.
        expect(after.defaultWorkspaceId).toBe(workspaceId);

        const history = await withAdminClient(pool, (client) =>
          client.query('select version from platform_settings_history where version = $1', [
            before.version,
          ]),
        );
        expect(history.rowCount).toBe(1);
      });

      it('an unknown defaultWorkspaceId → workspace_not_found', async () => {
        await expectPlatformError(
          () => callAsAdmin('update_platform_settings', { defaultWorkspaceId: randomUUID() }),
          'workspace_not_found',
        );
      });
    });

    // ---- audit + overview ---------------------------------------------------------------------------

    describe('platform_audit_query', () => {
      it('is newest-first and filters by action', async () => {
        const recent = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
          'platform_audit_query',
          { limit: 50 },
        );
        expect(recent.items.length).toBeGreaterThan(0);
        const timestamps = recent.items.map((item) => Date.parse(item.createdAt));
        expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

        const filtered = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
          'platform_audit_query',
          { action: 'create_user' },
        );
        expect(filtered.items.length).toBeGreaterThan(0);
        expect(filtered.items.every((item) => item.action === 'create_user')).toBe(true);
        expect(filtered.items.every((item) => item.actorUserId === admin.id)).toBe(true);
        expect(filtered.items[0]?.actorLogin).toBe(admin.login);
      });
    });

    describe('platform_overview', () => {
      it('reports consistent counts, the five-item checklist and a done default workspace', async () => {
        const overview = await callAsAdmin<PlatformOverviewWire>('platform_overview');

        expect(overview.counts.users).toBeGreaterThanOrEqual(3);
        expect(overview.counts.activeUsers).toBeLessThanOrEqual(overview.counts.users);
        expect(overview.counts.workspaces).toBeGreaterThanOrEqual(1);
        expect(overview.counts.activeWorkspaces).toBeGreaterThanOrEqual(1);
        expect(overview.version.migrationsApplied).toBeGreaterThan(0);

        expect(overview.checklist).toHaveLength(5);
        const defaultWorkspace = overview.checklist.find((item) => item.key === 'defaultWorkspace');
        expect(defaultWorkspace?.done).toBe(true);

        expect(overview.health.map((service) => service.service)).toContain('postgres');
        expect(overview.recentAudit.length).toBeGreaterThan(0);
      });
    });
  },
);
