import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  CONSOLE_SESSION_COOKIE,
  createUser,
  ensureSetupToken,
  findUserByLogin,
  setUserPassword,
} from '../../application/identity/index.js';
import { addPrincipal, createWorkspace } from '../../cli/bootstrap.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';

/**
 * interfaces/http/auth-routes.integration.test: the console login surface (S4.1) exercised as
 * real HTTP via `app.inject` — same convention as interfaces/explorer-contract's own integration
 * suite. DB-gated (`describe.runIf(DATABASE_URL !== undefined)`), auto-skipped locally.
 *
 * The DB is shared across test files in CI (no per-file schema reset), so every login/display
 * name used here gets a random suffix. The platform-setup flow is a genuine singleton
 * (`platform_setup`/`countActivePlatformAdmins` are process-wide, not workspace-scoped) and its
 * own describe block below needs a real admin-free platform to exercise "fresh DB" behavior —
 * `cli/bootstrap.test.ts`'s `createPlatformAdmin` tests already put a real active admin in this
 * same shared DB, and `vitest.config.ts` forces `fileParallelism: false` whenever `DATABASE_URL`
 * is set, so DB-gated files run strictly sequentially in a file-name order that puts
 * `cli/bootstrap.test.ts` before this file. The `platform setup` describe's own `beforeAll`/
 * `afterAll` below temporarily disables every currently-active admin (never deletes) so its tests
 * see a genuinely uninitialized platform, then restores exactly what it disabled.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const CSRF_HEADERS = { 'x-requested-with': 'nexttime', 'content-type': 'application/json' };

describe.runIf(DATABASE_URL !== undefined)(
  'auth-routes — integration (real Postgres, HTTP via app.inject)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let tmpDir: string;

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

    /** `createWorkspace`/`addPrincipal` (cli/bootstrap.ts) already wire `ensureUserForHumanPrincipal`
     *  — every Principal they create is linked to a passwordless user (its derived login, returned
     *  as `ownerLogin`/`login`) — so a console-authenticated member fixture only needs a password. */
    async function setPasswordForLogin(
      login: string,
      password: string,
      mustChangePassword = false,
    ): Promise<string> {
      const user = await findUserByLogin(pool, login);
      if (!user) throw new Error(`fixture: no user for login "${login}"`);
      await setUserPassword(pool, user.id, password, { mustChangePassword });
      return user.id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexttime-setup-'));
    });

    afterAll(async () => {
      await pool.end();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // ---- platform setup (countActivePlatformAdmins is process-wide — see this describe's own
    // beforeAll/afterAll, which makes its "no admin yet" precondition true by construction) -------

    describe('platform setup', () => {
      const adminLogin = `setup-admin-${randomUUID().slice(0, 8)}`;
      const adminPassword = 'correct horse battery staple';
      let firstTokenFile: string;
      let firstToken: string;
      let disabledAdminIds: string[] = [];

      beforeAll(async () => {
        // See this file's own module doc comment: make the "no admin yet" precondition true by
        // construction rather than assuming it, since `cli/bootstrap.test.ts` may already have
        // created real active admins in this shared DB by the time this describe runs. Disable
        // (never delete) so `afterAll` below can restore exactly what was active before.
        disabledAdminIds = await withWorkspace(
          pool,
          { workspaceId: randomUUID(), principalId: randomUUID() },
          async (client) => {
            const result = await client.query<{ id: string }>(
              `update users set status = 'disabled'
                 where platform_role = 'admin' and status = 'active'
               returning id`,
            );
            return result.rows.map((row) => row.id);
          },
          { skipRoleSwitch: true },
        );
        await withWorkspace(
          pool,
          { workspaceId: randomUUID(), principalId: randomUUID() },
          async (client) => {
            await client.query('delete from platform_setup');
          },
          { skipRoleSwitch: true },
        );
      });

      afterAll(async () => {
        if (disabledAdminIds.length === 0) return;
        await withWorkspace(
          pool,
          { workspaceId: randomUUID(), principalId: randomUUID() },
          async (client) => {
            await client.query("update users set status = 'active' where id = any($1::uuid[])", [
              disabledAdminIds,
            ]);
          },
          { skipRoleSwitch: true },
        );
      });

      it('GET /api/platform/setup-state → initialized:false, tokenAvailable:false on a fresh DB with no admin and no token', async () => {
        const app = appWithKeys();
        const response = await app.inject({ method: 'GET', url: '/api/platform/setup-state' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          ok: true,
          result: { initialized: false, tokenAvailable: false },
        });
      });

      it('ensureSetupToken writes a 0600 token file and setup-state reports tokenAvailable:true', async () => {
        firstTokenFile = path.join(tmpDir, 'token-1');
        const written = await ensureSetupToken(pool, { tokenFile: firstTokenFile });
        expect(written).toBe(firstTokenFile);
        // One open handle for both the mode check and the read (no check-then-use on the path).
        const handle = await open(firstTokenFile, 'r');
        try {
          const stats = await handle.stat();
          expect(stats.mode & 0o777).toBe(0o600);
          firstToken = (await handle.readFile('utf8')).trim();
        } finally {
          await handle.close();
        }
        expect(firstToken.length).toBeGreaterThan(0);

        const app = appWithKeys();
        const response = await app.inject({ method: 'GET', url: '/api/platform/setup-state' });
        expect(response.json()).toEqual({
          ok: true,
          result: { initialized: false, tokenAvailable: true },
        });
      });

      it('POST /api/platform/setup without X-Requested-With → 403 csrf_header_required', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/platform/setup',
          headers: { 'content-type': 'application/json' },
          payload: {
            token: firstToken,
            login: adminLogin,
            displayName: 'Admin',
            password: adminPassword,
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          ok: false,
          error: { code: 'csrf_header_required' },
        });
      });

      it('a wrong token → 401 invalid_token (failed_count increments)', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/platform/setup',
          headers: CSRF_HEADERS,
          payload: {
            token: 'not-the-token',
            login: adminLogin,
            displayName: 'Admin',
            password: adminPassword,
          },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
      });

      it('four more wrong tokens exhaust it; even the right token then → 403 token_exhausted', async () => {
        const app = appWithKeys();
        // One failure already recorded by the previous test; four more reach SETUP_TOKEN_MAX_FAILURES (5).
        for (let i = 0; i < 4; i++) {
          const response = await app.inject({
            method: 'POST',
            url: '/api/platform/setup',
            headers: CSRF_HEADERS,
            payload: {
              token: 'still-not-the-token',
              login: adminLogin,
              displayName: 'Admin',
              password: adminPassword,
            },
          });
          expect(response.statusCode).toBe(401);
        }
        const response = await app.inject({
          method: 'POST',
          url: '/api/platform/setup',
          headers: CSRF_HEADERS,
          payload: {
            token: firstToken,
            login: adminLogin,
            displayName: 'Admin',
            password: adminPassword,
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'token_exhausted' } });
      });

      it('a fresh token + correct fields → 200, Set-Cookie, admin user, empty memberships', async () => {
        const freshTokenFile = path.join(tmpDir, 'token-2');
        await ensureSetupToken(pool, { tokenFile: freshTokenFile });
        const freshToken = (await readFile(freshTokenFile, 'utf8')).trim();

        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/platform/setup',
          headers: CSRF_HEADERS,
          payload: {
            token: freshToken,
            login: adminLogin,
            displayName: 'Admin',
            password: adminPassword,
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['set-cookie']).toBeTruthy();
        const body = response.json();
        expect(body.ok).toBe(true);
        expect(body.result.user.platformRole).toBe('admin');
        expect(body.result.memberships).toEqual([]);
      });

      it('setup-state now reports initialized:true', async () => {
        const app = appWithKeys();
        const response = await app.inject({ method: 'GET', url: '/api/platform/setup-state' });
        expect(response.json()).toEqual({
          ok: true,
          result: { initialized: true, tokenAvailable: false },
        });
      });

      it('a second setup attempt → 409 already_initialized', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/platform/setup',
          headers: CSRF_HEADERS,
          payload: {
            token: 'irrelevant-once-an-admin-exists',
            login: `second-admin-${randomUUID().slice(0, 8)}`,
            displayName: 'Second',
            password: adminPassword,
          },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          ok: false,
          error: { code: 'already_initialized' },
        });
      });
    });

    // ---- POST /api/auth/login -------------------------------------------------------------------

    describe('POST /api/auth/login', () => {
      const login = `login-test-${randomUUID().slice(0, 8)}`;
      const password = 'correct horse battery staple';
      let userId: string;

      beforeAll(async () => {
        const user = await createUser(pool, { login, displayName: 'Login Test', password });
        userId = user.id;
      });

      it('a bad password → 401 bad_credentials', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { login, password: 'wrong-password' },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'bad_credentials' } });
      });

      it('5 bad passwords lock the account; even the right password then → 423 locked', async () => {
        const app = appWithKeys();
        for (let i = 0; i < 4; i++) {
          const response = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            headers: CSRF_HEADERS,
            payload: { login, password: 'still-wrong' },
          });
          expect(response.statusCode).toBe(401);
        }
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { login, password },
        });
        expect(response.statusCode).toBe(423);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'locked' } });
      });

      it('setUserPassword resets the lock; a good login now succeeds with a cookie', async () => {
        await setUserPassword(pool, userId, password, { mustChangePassword: false });
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { login, password },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['set-cookie']).toBeTruthy();
      });

      it('GET /api/auth/me with the cookie → user + memberships; without a cookie → 401', async () => {
        const app = appWithKeys();
        const token = await loginAs(app, login, password);
        const me = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${token}` },
        });
        expect(me.statusCode).toBe(200);
        expect(me.json().result.user.login).toBe(login);
        expect(me.json().result.memberships).toEqual([]);

        const noCookie = await app.inject({ method: 'GET', url: '/api/auth/me' });
        expect(noCookie.statusCode).toBe(401);
      });
    });

    // ---- /api/cap/* through the console-session channel ------------------------------------------

    describe('/api/cap/list_chats through the console-session channel', () => {
      const password = 'correct horse battery staple';
      let workspaceId: string;
      let ownerApiKey: string;
      let memberLogin: string;
      let adminOnlyLogin: string;

      beforeAll(async () => {
        const created = await createWorkspace(pool, `auth-routes-cap-ws-${randomUUID()}`, 'Owner');
        workspaceId = created.workspaceId;
        ownerApiKey = created.apiKey;

        // `createWorkspace` already links the owner Principal to a passwordless user (its own
        // derived `ownerLogin`) — only a password is needed to make it a console member.
        memberLogin = created.ownerLogin;
        await setPasswordForLogin(memberLogin, password);

        adminOnlyLogin = `admin-only-${randomUUID().slice(0, 8)}`;
        await createUser(pool, {
          login: adminOnlyLogin,
          displayName: 'Admin Only',
          password,
          platformRole: 'admin',
        });
      });

      it('a platform admin with no memberships anywhere → 403 workspace_required', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, adminOnlyLogin, password);
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_chats',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'workspace_required' } });
      });

      it('naming a workspace the caller has no membership in → 403 forbidden (generic)', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, adminOnlyLogin, password);
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_chats',
          headers: {
            ...CSRF_HEADERS,
            cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}`,
            'x-workspace-id': workspaceId,
          },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      });

      it('a workspace member with X-Workspace-Id → 200', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, memberLogin, password);
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_chats',
          headers: {
            ...CSRF_HEADERS,
            cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}`,
            'x-workspace-id': workspaceId,
          },
          payload: {},
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().ok).toBe(true);
      });

      it('the same call without X-Requested-With → 403 csrf_header_required', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, memberLogin, password);
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_chats',
          headers: {
            'content-type': 'application/json',
            cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}`,
            'x-workspace-id': workspaceId,
          },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          ok: false,
          error: { code: 'csrf_header_required' },
        });
      });

      it('an API key Bearer header with no cookie still works (API key path untouched)', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_chats',
          headers: { authorization: `Bearer ${ownerApiKey}`, 'content-type': 'application/json' },
          payload: {},
        });
        expect(response.statusCode).toBe(200);
      });
    });

    // ---- must_change_password gate ----------------------------------------------------------------

    describe('must_change_password', () => {
      const tempPassword = 'temporary-password-1';
      const newPassword = 'correct horse battery staple 2';
      let workspaceId: string;
      let login: string;

      beforeAll(async () => {
        const created = await createWorkspace(pool, `auth-routes-mcp-ws-${randomUUID()}`, 'Owner');
        workspaceId = created.workspaceId;
        const added = await addPrincipal(pool, workspaceId, 'Temp User', 'member');
        // `addPrincipal` already links this Principal to a passwordless user (its own derived
        // `login`) — set a temporary password with `mustChangePassword: true`.
        login = added.login;
        await setPasswordForLogin(login, tempPassword, true);
      });

      it('login succeeds even though mustChangePassword is set → 200', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { login, password: tempPassword },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().result.user.mustChangePassword).toBe(true);
      });

      it('/api/cap/list_chats → 403 password_change_required', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, login, tempPassword);
        const response = await app.inject({
          method: 'POST',
          url: '/api/cap/list_chats',
          headers: {
            ...CSRF_HEADERS,
            cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}`,
            'x-workspace-id': workspaceId,
          },
          payload: {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          ok: false,
          error: { code: 'password_change_required' },
        });
      });

      it('GET /api/auth/me still works (200)', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, login, tempPassword);
        const response = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
        });
        expect(response.statusCode).toBe(200);
      });

      it('POST /api/auth/password with the wrong current password → 401', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, login, tempPassword);
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: { currentPassword: 'not-the-current-password', newPassword },
        });
        expect(response.statusCode).toBe(401);
      });

      it('POST /api/auth/password with the right current password + new → 200, mustChangePassword false; then list_chats → 200', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, login, tempPassword);
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: { currentPassword: tempPassword, newPassword },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().result.user.mustChangePassword).toBe(false);

        const listChats = await app.inject({
          method: 'POST',
          url: '/api/cap/list_chats',
          headers: {
            ...CSRF_HEADERS,
            cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}`,
            'x-workspace-id': workspaceId,
          },
          payload: {},
        });
        expect(listChats.statusCode).toBe(200);
      });
    });

    // ---- PATCH /api/auth/me --------------------------------------------------------------------

    describe('PATCH /api/auth/me', () => {
      const login = `patch-test-${randomUUID().slice(0, 8)}`;
      const password = 'correct horse battery staple';

      beforeAll(async () => {
        await createUser(pool, { login, displayName: 'Old Name', password });
      });

      it('updates displayName → 200', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, login, password);
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/auth/me',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: { displayName: 'New Name' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().result.user.displayName).toBe('New Name');
      });

      it('an empty displayName → 400', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, login, password);
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/auth/me',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          payload: { displayName: '' },
        });
        expect(response.statusCode).toBe(400);
      });
    });

    // ---- POST /api/auth/logout -------------------------------------------------------------------

    describe('POST /api/auth/logout', () => {
      const login = `logout-test-${randomUUID().slice(0, 8)}`;
      const password = 'correct horse battery staple';

      beforeAll(async () => {
        await createUser(pool, { login, displayName: 'Logout Test', password });
      });

      it('clears the cookie (Max-Age=0) and revokes it server-side — the old cookie then 401s', async () => {
        const app = appWithKeys();
        const cookie = await loginAs(app, login, password);

        const logoutResponse = await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { ...CSRF_HEADERS, cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
          // CSRF_HEADERS declares a JSON content type; Fastify rejects an empty JSON body (400).
          payload: {},
        });
        expect(logoutResponse.statusCode).toBe(200);
        const setCookie = setCookieHeader(logoutResponse.headers);
        expect(setCookie).toMatch(/Max-Age=0/);

        const me = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
        });
        expect(me.statusCode).toBe(401);
      });
    });

    // ---- a disabled user --------------------------------------------------------------------------

    describe('a disabled user', () => {
      const login = `disabled-test-${randomUUID().slice(0, 8)}`;
      const password = 'correct horse battery staple';
      let userId: string;
      let cookie: string;

      beforeAll(async () => {
        const user = await createUser(pool, { login, displayName: 'Disabled Test', password });
        userId = user.id;
        const app = appWithKeys();
        cookie = await loginAs(app, login, password);
        await withWorkspace(
          pool,
          { workspaceId: randomUUID(), principalId: randomUUID() },
          async (client) => {
            await client.query("update users set status = 'disabled' where id = $1", [userId]);
          },
          { skipRoleSwitch: true },
        );
      });

      it('an existing cookie now 401s', async () => {
        const app = appWithKeys();
        const me = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
        });
        expect(me.statusCode).toBe(401);
      });

      it('a fresh login attempt → 403 disabled', async () => {
        const app = appWithKeys();
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: CSRF_HEADERS,
          payload: { login, password },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: 'disabled' } });
      });
    });
  },
);
