import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CreateUserResultWire,
  ListEnvelope,
  PlatformAuditRecordWire,
  PlatformDraftResidueWire,
  PlatformOverviewWire,
  PlatformSettingsWire,
  Role,
  UserMembershipWire,
  UserWire,
} from '@nexttime/shared';
import { capabilityHasSideEffects, getCapability } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { addPrincipal } from '../../cli/bootstrap.js';
import { HANDLE_SIGNING_ALG, issueHandle } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { runWithActingContext } from '../../substrate/audit/acting-context.js';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  CONSOLE_SESSION_COOKIE,
  createPlatformAdmin,
  createUser,
  findUserByLogin,
} from '../identity/index.js';
import type { UserRow } from '../identity/index.js';
import { updatePlatformSettings } from '../platform/index.js';
import { proposeWorkerDefinition } from '../worker/definitions.js';
import { proposeProcedure } from '../worker/procedures.js';
import { proposeSkill } from '../worker/skills.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  generateApiKey,
  hashApiKey,
  lookupPrincipalByApiKeyHash,
  withAdminClient,
} from './auth.js';
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
/** Polls `pg_stat_activity` until no backend is connected to `name` (bounded to ~1s). `pool.end()`
 *  resolves once pg-pool has *scheduled* each idle client's `end()`, not once the sockets are
 *  closed, so without this wait the `drop database … with (force)` below can terminate a backend
 *  of this file's own mid-shutdown; the resulting FATAL 57P01 then surfaces on the pool's 'error'
 *  event (CI run 35079054627 on main). Falls through to the caller's `with (force)` if a
 *  connection really did outlive the pool. */
async function waitForNoConnections(cluster: Pool, name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await cluster.query<{ n: string }>(
      'select count(*)::text as n from pg_stat_activity where datname = $1',
      [name],
    );
    if (rows[0]?.n === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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
      await waitForNoConnections(cluster, name);
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
    ): Promise<PlatformAdminError> {
      const thrown = await call().then(
        () => {
          throw new Error(`expected PlatformAdminError("${code}"), but the call resolved`);
        },
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(PlatformAdminError);
      expect((thrown as PlatformAdminError).code).toBe(code);
      return thrown as PlatformAdminError;
    }

    /** R-12: a Handle minted under a fresh session of `kind` on `principalId`'s behalf — the
     *  `capability_handles` row is what revocation must reach (Handle verification never reads
     *  `sessions.status`). An entry session is opened `starting`, as agent-host-runtime.ts does. */
    async function issueSessionHandle(
      ws: string,
      principalId: string,
      role: Role,
      kind: 'entry' | 'mcp_session' | 'worker_run',
      capabilities: readonly string[] = ['search'],
    ): Promise<{ readonly sessionId: string; readonly jti: string }> {
      return withAdminClient(pool, async (client) => {
        const session = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $2, $4) returning id`,
          [ws, principalId, kind, kind === 'entry' ? 'starting' : 'active'],
        );
        const sessionId = session.rows[0]?.id;
        if (!sessionId) throw new Error('issueSessionHandle: no session row');
        const issued = await issueHandle(client, {
          sessionId,
          scope: { capabilities: [...capabilities], resources: {} },
          ttlSeconds: 3600,
          privateKey,
          basis: { kind: 'role', role, credential: null },
        });
        return { sessionId, jti: issued.jti };
      });
    }

    async function handleRevoked(jti: string): Promise<boolean> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ revoked_at: Date | null }>(
          'select revoked_at from capability_handles where jti = $1',
          [jti],
        ),
      );
      const row = result.rows[0];
      return row !== undefined && row.revoked_at !== null;
    }

    async function sessionStatus(sessionId: string): Promise<string | undefined> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ status: string }>('select status from sessions where id = $1', [sessionId]),
      );
      return result.rows[0]?.status;
    }

    /** Gives a membership Principal an API key the way the operator CLI does (a key a person
     *  still holds from before D-25) and returns the plaintext. */
    async function giveLegacyApiKey(ws: string, principalId: string): Promise<string> {
      const apiKey = generateApiKey();
      await withAdminClient(pool, (client) =>
        client.query(
          'update principals set api_key_hash = $3 where workspace_id = $1 and id = $2',
          [ws, principalId, hashApiKey(apiKey)],
        ),
      );
      return apiKey;
    }

    async function apiKeyWorks(apiKey: string): Promise<boolean> {
      return (await lookupPrincipalByApiKeyHash(pool, hashApiKey(apiKey))) !== null;
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

        // Reviewer finding (P-A1): disabling must close every channel, not only the cookie — an
        // API key held by one of the user's membership Principals stops authenticating too.
        const apiKey = generateApiKey();
        await withAdminClient(pool, (client) =>
          client.query(
            `update principals set api_key_hash = $2 where user_id = $1 and kind = 'human'`,
            [user.id, hashApiKey(apiKey)],
          ),
        );
        const viaApiKey = await app.inject({
          method: 'POST',
          url: '/api/cap/get_workspace',
          headers: { authorization: `Bearer ${apiKey}` },
          payload: {},
        });
        expect(viaApiKey.statusCode).toBe(401);
        // A password hash plus a verify (scrypt, ~1s together on a CI runner) on top of the
        // round-trips above — past Vitest's 5s default.
      }, 30_000);

      it('R-12 (D-25): disabling revokes every Handle of the user’s memberships, the entry session’s included, and clears their API keys for good', async () => {
        const user = await createUser(pool, {
          login: `disabled-keys-${randomUUID().slice(0, 8)}`,
          displayName: 'Disabled Key Holder',
        });
        const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        const apiKey = await giveLegacyApiKey(workspaceId, membership.principalId);
        const entry = await issueSessionHandle(
          workspaceId,
          membership.principalId,
          'member',
          'entry',
        );
        const mcp = await issueSessionHandle(
          workspaceId,
          membership.principalId,
          'member',
          'mcp_session',
        );

        await callAsAdmin<UserWire>('set_user_status', { userId: user.id, status: 'disabled' });

        expect(await handleRevoked(entry.jti)).toBe(true);
        expect(await handleRevoked(mcp.jti)).toBe(true);
        // `starting` (an entry session never advances) is revoked like `active`.
        expect(await sessionStatus(entry.sessionId)).toBe('revoked');
        expect(await sessionStatus(mcp.sessionId)).toBe('revoked');

        // Re-enabling the user does not bring the key back.
        await callAsAdmin<UserWire>('set_user_status', { userId: user.id, status: 'active' });
        expect(await apiKeyWorks(apiKey)).toBe(false);
      });

      it('refuses disabling a workspace’s last human owner (R-06: last_owner); allowed once a second human owner exists', async () => {
        const ws = randomUUID();
        await withAdminClient(pool, (client) =>
          client.query('insert into workspaces (id, name) values ($1, $2)', [
            ws,
            `sole-owner-${ws.slice(0, 8)}`,
          ]),
        );
        const owner = await createUser(pool, {
          login: `sole-owner-${randomUUID().slice(0, 8)}`,
          displayName: 'Sole Owner',
        });
        await callAsAdmin('add_membership', { userId: owner.id, workspaceId: ws, role: 'owner' });

        await expectPlatformError(
          () => callAsAdmin('set_user_status', { userId: owner.id, status: 'disabled' }),
          'last_owner',
        );
        // Nothing changed under the refusal.
        const row = await withAdminClient(pool, (client) =>
          client.query<{ status: string }>('select status from users where id = $1', [owner.id]),
        );
        expect(row.rows[0]?.status).toBe('active');

        const second = await createUser(pool, {
          login: `second-owner-${randomUUID().slice(0, 8)}`,
          displayName: 'Second Owner',
        });
        await callAsAdmin('add_membership', { userId: second.id, workspaceId: ws, role: 'owner' });
        const disabled = await callAsAdmin<UserWire>('set_user_status', {
          userId: owner.id,
          status: 'disabled',
        });
        expect(disabled.status).toBe('disabled');
      });
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

      it('R-12 (D-25): revokes every Handle of the user’s memberships — entry, mcp_session, worker_run — and clears a CLI-issued API key; another member’s are untouched', async () => {
        // The operator CLI still gives a person an API key (the acceptance suites rely on it).
        const holder = await addPrincipal(pool, workspaceId, 'CLI Key Holder', 'member');
        const bystander = await addPrincipal(pool, workspaceId, 'CLI Bystander', 'member');
        expect(await apiKeyWorks(holder.apiKey)).toBe(true);
        const user = await findUserByLogin(pool, holder.login);
        if (!user) throw new Error('addPrincipal linked no user');
        const held = [
          await issueSessionHandle(workspaceId, holder.principalId, 'member', 'entry'),
          await issueSessionHandle(workspaceId, holder.principalId, 'member', 'mcp_session'),
          await issueSessionHandle(workspaceId, holder.principalId, 'member', 'worker_run'),
        ];
        const bystanderHandle = await issueSessionHandle(
          workspaceId,
          bystander.principalId,
          'member',
          'mcp_session',
        );

        await callAsAdmin('reset_user_password', { userId: user.id });

        for (const handle of held) {
          expect(await handleRevoked(handle.jti)).toBe(true);
          expect(await sessionStatus(handle.sessionId)).toBe('revoked');
        }
        expect(await apiKeyWorks(holder.apiKey)).toBe(false);
        expect(await handleRevoked(bystanderHandle.jti)).toBe(false);
        expect(await sessionStatus(bystanderHandle.sessionId)).toBe('active');
        expect(await apiKeyWorks(bystander.apiKey)).toBe(true);
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

      it('set_user_status: cannot be disabled — neither by itself (self_disable, C10) nor by another administrator (last_admin)', async () => {
        // S6 C10: disabling *yourself* is its own refusal, whatever the administrator count.
        await expectPlatformError(
          () => callAsAdmin('set_user_status', { userId: admin.id, status: 'disabled' }),
          'self_disable',
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

      it('add_membership: a removed membership does not count — adding the user back makes a new one, and the removed one stops belonging to them (legacy 725)', async () => {
        const login = `readd-${randomUUID().slice(0, 8)}`;
        const user = await createUser(pool, {
          login,
          displayName: 'Re-add Fixture',
          password: PASSWORD,
        });
        const first = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        await callAsAdmin('remove_membership', { userId: user.id, workspaceId });

        const again = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'builder',
        });
        expect(again).toMatchObject({ workspaceId, role: 'builder', disabled: false });
        expect(again.principalId).not.toBe(first.principalId);

        // The removed one stays removed, its row kept, no longer the user's: removal is final.
        const rows = await withAdminClient(pool, (client) =>
          client.query<{ id: string; user_id: string | null; disabled: boolean }>(
            `select id, user_id, disabled_at is not null as disabled
               from principals where workspace_id = $1 and id = any($2::uuid[])`,
            [workspaceId, [first.principalId, again.principalId]],
          ),
        );
        expect(rows.rows.find((row) => row.id === first.principalId)).toMatchObject({
          user_id: null,
          disabled: true,
        });
        expect(rows.rows.find((row) => row.id === again.principalId)).toMatchObject({
          user_id: user.id,
          disabled: false,
        });
        const listed = await callAsAdmin<{ items: UserMembershipWire[] }>('list_user_memberships', {
          userId: user.id,
        });
        expect(listed.items.map((m) => m.principalId)).toEqual([again.principalId]);

        // The add_membership row names the one it replaced: whose, where.
        const audit = await withAdminClient(pool, (client) =>
          client.query<{ payload: Record<string, unknown>; name: string }>(
            `select a.payload, w.name from audit_records a, workspaces w
              where a.action = 'add_membership' and a.resource_id = $1 and w.id = $2`,
            [again.principalId, workspaceId],
          ),
        );
        expect(audit.rows[0]?.payload.detachedPrincipals).toEqual([
          {
            workspaceId,
            principalId: first.principalId,
            userId: user.id,
            login,
            workspaceName: audit.rows[0]?.name,
          },
        ]);
        const firstAudit = await withAdminClient(pool, (client) =>
          client.query<{ payload: Record<string, unknown> }>(
            `select payload from audit_records where action = 'add_membership' and resource_id = $1`,
            [first.principalId],
          ),
        );
        expect(firstAudit.rows[0]?.payload).not.toHaveProperty('detachedPrincipals');

        // The new one is active: the same call again is a duplicate.
        await expectPlatformError(
          () => callAsAdmin('add_membership', { userId: user.id, workspaceId, role: 'member' }),
          'already_member',
        );
      });

      // Legacy 725 (#493 on #1189): every path that gives a user a membership holds the user's
      // authority lock, so two of them never race to the `(workspace_id, user_id)` unique index.
      it('add_membership waits for the user’s lock: a membership given to the user meanwhile makes it already_member, not a unique-index 500', async () => {
        const user = await createUser(pool, {
          login: `readd-race-${randomUUID().slice(0, 8)}`,
          displayName: 'Re-add Race Fixture',
          password: PASSWORD,
        });
        let go!: () => void;
        const going = new Promise<void>((resolve) => {
          go = resolve;
        });
        let locked!: () => void;
        const holding = new Promise<void>((resolve) => {
          locked = resolve;
        });
        // Another membership change for the user (as `merge_user` or binding a key would be),
        // holding the user's lock, that gives the user a membership in the workspace.
        const writer = withAdminClient(pool, async (client) => {
          await client.query('select lock_authorities($1::uuid[], $2::uuid[], $3::uuid[])', [
            [],
            [user.id],
            [],
          ]);
          locked();
          await going;
          await client.query(
            `insert into principals (workspace_id, kind, role, display_name, user_id)
             values ($1, 'human', 'member', 'Re-add Race Fixture', $2)`,
            [workspaceId, user.id],
          );
        });
        await holding;

        const add = callAsAdmin('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        // Not left unhandled while the poll below runs.
        const outcome = add.then(
          () => undefined,
          (err: unknown) => err,
        );
        for (let attempt = 0; ; attempt += 1) {
          const { rows } = await pool.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and position('lock_authorities' in query) > 0`,
          );
          if ((rows[0]?.waiting ?? 0) > 0) break;
          if (attempt > 200) throw new Error('add_membership never waited on the user’s lock');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        go();
        await writer;
        await expectPlatformError(async () => {
          const err = await outcome;
          if (err !== undefined) throw err;
        }, 'already_member');
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

      it('set_membership_role: the same role changes nothing — the sessions and their Handles stay live; a new role ends the sessions and revokes their Handles (legacy 696)', async () => {
        // S3.11 / R-12: only a role change makes a Handle's capability set stale. Legacy 696: the
        // same role used to end the sessions while the Handles they had issued stayed valid until
        // ttl (`verifyHandle` reads only a Handle's own `revoked_at`). Now the person's authority
        // does not change, so nothing does (#493 on legacy 664 batch 22: the repeat walk cannot
        // see this, its second call meets sessions and Handles the first already ended).
        const user = await createUser(pool, {
          login: `role-keep-${randomUUID().slice(0, 8)}`,
          displayName: 'Role Fixture',
          password: PASSWORD,
        });
        const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        const live = await issueSessionHandle(
          workspaceId,
          membership.principalId,
          'member',
          'mcp_session',
        );
        /** The row versions (`xmin`) of the membership Principal, its session and the Handle: a
         *  write to any of them — even one that sets a column to the value it has — changes it. */
        const rowVersions = () =>
          withAdminClient(pool, async (client) => {
            const versions = await client.query<{
              principal: string;
              session: string;
              handle: string;
            }>(
              `select (select xmin::text from principals where workspace_id = $1 and id = $2) as principal,
                      (select xmin::text from sessions where id = $3) as session,
                      (select xmin::text from capability_handles where jti = $4) as handle`,
              [workspaceId, membership.principalId, live.sessionId, live.jti],
            );
            return versions.rows[0];
          });
        const roleAudits = () =>
          withAdminClient(pool, async (client) => {
            const audits = await client.query<{ payload: { unchanged?: boolean } }>(
              `select payload from audit_records
                where action = 'set_membership_role' and resource_id = $1 order by created_at, id`,
              [membership.principalId],
            );
            return audits.rows.map((row) => row.payload.unchanged);
          });
        const before = await rowVersions();

        const same = await callAsAdmin<UserMembershipWire>('set_membership_role', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        expect(same).toMatchObject({ principalId: membership.principalId, role: 'member' });
        expect(await sessionStatus(live.sessionId)).toBe('active');
        expect(await handleRevoked(live.jti)).toBe(false);
        expect(await rowVersions()).toEqual(before);
        // The call is still audited, and its row says it changed nothing.
        expect(await roleAudits()).toEqual([true]);

        await callAsAdmin('set_membership_role', { userId: user.id, workspaceId, role: 'builder' });
        expect(await sessionStatus(live.sessionId)).toBe('revoked');
        expect(await handleRevoked(live.jti)).toBe(true);
        expect(await roleAudits()).toEqual([true, undefined]);
      });

      it('set_membership_role (legacy 699): a role change ends the entry and MCP sessions and the Workers the new role does not cover; a promotion keeps a Worker; the console session stays', async () => {
        const user = await createUser(pool, {
          login: `role-workers-${randomUUID().slice(0, 8)}`,
          displayName: 'Role Workers Fixture',
          password: PASSWORD,
        });
        const { principalId } = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'builder',
        });
        const entry = await issueSessionHandle(workspaceId, principalId, 'builder', 'entry');
        const mcp = await issueSessionHandle(workspaceId, principalId, 'builder', 'mcp_session');
        // `propose_operation` is `minRole: 'builder'`: a member may not hold it.
        const builderWorker = await issueSessionHandle(
          workspaceId,
          principalId,
          'builder',
          'worker_run',
          ['search', 'propose_operation'],
        );
        const memberWorker = await issueSessionHandle(
          workspaceId,
          principalId,
          'builder',
          'worker_run',
        );
        const web = await withAdminClient(pool, async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'web', $2, 'active') returning id`,
            [workspaceId, principalId],
          );
          return result.rows[0]?.id ?? '';
        });

        await callAsAdmin('set_membership_role', { userId: user.id, workspaceId, role: 'member' });
        for (const ended of [entry, mcp, builderWorker]) {
          expect(await sessionStatus(ended.sessionId)).toBe('revoked');
          expect(await handleRevoked(ended.jti)).toBe(true);
        }
        expect(await sessionStatus(memberWorker.sessionId)).toBe('active');
        expect(await handleRevoked(memberWorker.jti)).toBe(false);
        // Every request reads the person's role now, so the console session carries on.
        expect(await sessionStatus(web)).toBe('active');

        await callAsAdmin('set_membership_role', { userId: user.id, workspaceId, role: 'builder' });
        expect(await sessionStatus(memberWorker.sessionId)).toBe('active');
        expect(await handleRevoked(memberWorker.jti)).toBe(false);

        // An auditor starts no Workers: whatever a Worker holds, the new role covers none of it.
        await callAsAdmin('set_membership_role', { userId: user.id, workspaceId, role: 'auditor' });
        expect(await sessionStatus(memberWorker.sessionId)).toBe('revoked');
        expect(await handleRevoked(memberWorker.jti)).toBe(true);
        expect(await sessionStatus(web)).toBe('active');
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

      it('a removed membership stays as it was (legacy 729 / 730): removing it again writes nothing and its audit row says unchanged; a role change is refused (membership_removed), the same role too', async () => {
        const user = await createUser(pool, {
          login: `removed-twice-${randomUUID().slice(0, 8)}`,
          displayName: 'Removed Twice',
          password: PASSWORD,
        });
        const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        await callAsAdmin('remove_membership', { userId: user.id, workspaceId });
        /** The Principal row's version: any write to it, even one that sets a column to the value
         *  it has, changes it. */
        const rowVersion = () =>
          withAdminClient(pool, async (client) => {
            const result = await client.query<{ xmin: string; role: string }>(
              'select xmin::text, role from principals where workspace_id = $1 and id = $2',
              [workspaceId, membership.principalId],
            );
            return result.rows[0];
          });
        const before = await rowVersion();
        expect(before?.role).toBe('member');

        const again = await callAsAdmin('remove_membership', { userId: user.id, workspaceId });
        expect(again).toEqual({ userId: user.id, workspaceId, removed: true });
        for (const role of ['builder', 'member'] as const) {
          await expectPlatformError(
            () => callAsAdmin('set_membership_role', { userId: user.id, workspaceId, role }),
            'membership_removed',
          );
        }
        expect(await rowVersion()).toEqual(before);

        const audits = await withAdminClient(pool, (client) =>
          client.query<{ action: string; unchanged: boolean | null }>(
            `select action, (payload->>'unchanged')::boolean as unchanged from audit_records
              where resource_id = $1 and action in ('remove_membership', 'set_membership_role')
                and coalesce(payload->>'outcome', '') <> 'refused'
              order by created_at, id`,
            [membership.principalId],
          ),
        );
        expect(audits.rows).toEqual([
          { action: 'remove_membership', unchanged: null },
          { action: 'remove_membership', unchanged: true },
        ]);
      });

      it('set_membership_role and remove_membership read the membership again under its lock (legacy 730 / 729): one removed while they waited is refused, or left as it is', async () => {
        const user = await createUser(pool, {
          login: `removed-meanwhile-${randomUUID().slice(0, 8)}`,
          displayName: 'Removed Meanwhile',
          password: PASSWORD,
        });
        for (const call of ['set_membership_role', 'remove_membership'] as const) {
          const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
            userId: user.id,
            workspaceId,
            role: 'member',
          });
          let go!: () => void;
          const going = new Promise<void>((resolve) => {
            go = resolve;
          });
          let locked!: () => void;
          const holding = new Promise<void>((resolve) => {
            locked = resolve;
          });
          // The workspace's own `disable_principal` (or another `remove_membership`), holding the
          // Principal's lock while it removes the membership.
          const writer = withAdminClient(pool, async (client) => {
            await client.query('select lock_authorities($1::uuid[], $2::uuid[], $3::uuid[])', [
              [],
              [],
              [membership.principalId],
            ]);
            locked();
            await going;
            await client.query(
              'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
              [workspaceId, membership.principalId],
            );
          });
          await holding;
          const pending =
            call === 'set_membership_role'
              ? callAsAdmin(call, { userId: user.id, workspaceId, role: 'builder' })
              : callAsAdmin(call, { userId: user.id, workspaceId });
          // Not left unhandled while the poll below runs.
          const outcome = pending.then(
            (result) => ({ result }),
            (err: unknown) => ({ err }),
          );
          for (let attempt = 0; ; attempt += 1) {
            const { rows } = await pool.query<{ waiting: number }>(
              `select count(*)::int as waiting from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and position('lock_authorities' in query) > 0`,
            );
            if ((rows[0]?.waiting ?? 0) > 0) break;
            if (attempt > 200) throw new Error(`${call} never waited on the Principal’s lock`);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          go();
          await writer;
          const settled = await outcome;
          if (call === 'set_membership_role') {
            await expectPlatformError(async () => {
              if ('err' in settled) throw settled.err;
            }, 'membership_removed');
          } else {
            expect(settled).toEqual({ result: { userId: user.id, workspaceId, removed: true } });
            const audit = await withAdminClient(pool, (client) =>
              client.query<{ unchanged: boolean | null }>(
                `select (payload->>'unchanged')::boolean as unchanged from audit_records
                  where resource_id = $1 and action = 'remove_membership'`,
                [membership.principalId],
              ),
            );
            expect(audit.rows).toEqual([{ unchanged: true }]);
          }
          const role = await withAdminClient(pool, (client) =>
            client.query<{ role: string }>(
              'select role from principals where workspace_id = $1 and id = $2',
              [workspaceId, membership.principalId],
            ),
          );
          expect(role.rows[0]?.role).toBe('member');
        }
      });

      // #1198 review (#493 P3-1, #501 optional 1): removed and the user added back while the call
      // waited — the membership read under the lock is the new one, whose lock the call does not
      // hold, and which the caller never saw. Refused with its own code; the new one is untouched.
      it('set_membership_role and remove_membership: a membership removed and the user added back while they waited is refused (membership_replaced), the new one untouched', async () => {
        const user = await createUser(pool, {
          login: `replaced-meanwhile-${randomUUID().slice(0, 8)}`,
          displayName: 'Replaced Meanwhile',
          password: PASSWORD,
        });
        for (const call of ['set_membership_role', 'remove_membership'] as const) {
          const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
            userId: user.id,
            workspaceId,
            role: 'member',
          });
          let go!: () => void;
          const going = new Promise<void>((resolve) => {
            go = resolve;
          });
          let locked!: () => void;
          const holding = new Promise<void>((resolve) => {
            locked = resolve;
          });
          // Holding the seen membership's lock: removes it, lets it go (as adding the user back
          // does, identity/memberships.ts), and gives the user a new membership there.
          const writer = withAdminClient(pool, async (client) => {
            await client.query('select lock_authorities($1::uuid[], $2::uuid[], $3::uuid[])', [
              [],
              [],
              [membership.principalId],
            ]);
            locked();
            await going;
            await client.query(
              `update principals set disabled_at = now(), user_id = null
                where workspace_id = $1 and id = $2`,
              [workspaceId, membership.principalId],
            );
            const inserted = await client.query<{ id: string }>(
              `insert into principals (workspace_id, kind, role, display_name, user_id)
               values ($1, 'human', 'member', 'Replaced Meanwhile', $2) returning id`,
              [workspaceId, user.id],
            );
            return inserted.rows[0]?.id;
          });
          await holding;
          const pending =
            call === 'set_membership_role'
              ? callAsAdmin(call, { userId: user.id, workspaceId, role: 'builder' })
              : callAsAdmin(call, { userId: user.id, workspaceId });
          const outcome = pending.then(
            (result) => ({ result }),
            (err: unknown) => ({ err }),
          );
          for (let attempt = 0; ; attempt += 1) {
            const { rows } = await pool.query<{ waiting: number }>(
              `select count(*)::int as waiting from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and position('lock_authorities' in query) > 0`,
            );
            if ((rows[0]?.waiting ?? 0) > 0) break;
            if (attempt > 200) throw new Error(`${call} never waited on the Principal’s lock`);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          go();
          const replacement = await writer;
          if (!replacement) throw new Error('no membership inserted');
          const settled = await outcome;
          await expectPlatformError(async () => {
            if ('err' in settled) throw settled.err;
          }, 'membership_replaced');
          const rows = await withAdminClient(pool, (client) =>
            client.query<{ id: string; role: string; disabled: boolean }>(
              `select id, role, disabled_at is not null as disabled from principals
                where workspace_id = $1 and id = any($2::uuid[]) order by created_at`,
              [workspaceId, [membership.principalId, replacement]],
            ),
          );
          expect(rows.rows).toEqual([
            { id: membership.principalId, role: 'member', disabled: true },
            { id: replacement, role: 'member', disabled: false },
          ]);
          const audit = await withAdminClient(pool, (client) =>
            client.query(
              `select 1 from audit_records
                where resource_id = any($1::uuid[]) and action = any($2::text[])`,
              [
                [membership.principalId, replacement],
                ['set_membership_role', 'remove_membership'],
              ],
            ),
          );
          expect(audit.rowCount).toBe(0);
          // The next round adds the user again over this one.
          await callAsAdmin('remove_membership', { userId: user.id, workspaceId });
        }
      });

      it('R-12 (D-25): remove_membership revokes that membership’s Handles and API key only — the user’s other membership and console session stay', async () => {
        const otherWorkspaceId = randomUUID();
        await withAdminClient(pool, (client) =>
          client.query('insert into workspaces (id, name) values ($1, $2)', [
            otherWorkspaceId,
            `remove-scope-${otherWorkspaceId.slice(0, 8)}`,
          ]),
        );
        const login = `remove-scope-${randomUUID().slice(0, 8)}`;
        const user = await createUser(pool, {
          login,
          displayName: 'Two Memberships',
          password: PASSWORD,
        });
        const removed = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId: otherWorkspaceId,
          role: 'member',
        });
        const kept = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: user.id,
          workspaceId,
          role: 'member',
        });
        await giveLegacyApiKey(otherWorkspaceId, removed.principalId);
        const keptKey = await giveLegacyApiKey(workspaceId, kept.principalId);
        const removedHandle = await issueSessionHandle(
          otherWorkspaceId,
          removed.principalId,
          'member',
          'mcp_session',
        );
        const keptHandle = await issueSessionHandle(
          workspaceId,
          kept.principalId,
          'member',
          'mcp_session',
        );
        const app = appWithKeys();
        const cookie = await loginAs(app, login, PASSWORD);

        await callAsAdmin('remove_membership', { userId: user.id, workspaceId: otherWorkspaceId });

        expect(await handleRevoked(removedHandle.jti)).toBe(true);
        const removedRow = await withAdminClient(pool, (client) =>
          client.query<{ api_key_hash: string | null }>(
            'select api_key_hash from principals where workspace_id = $1 and id = $2',
            [otherWorkspaceId, removed.principalId],
          ),
        );
        expect(removedRow.rows[0]?.api_key_hash).toBeNull();
        expect(await handleRevoked(keptHandle.jti)).toBe(false);
        expect(await apiKeyWorks(keptKey)).toBe(true);
        const me = await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: `${CONSOLE_SESSION_COOKIE}=${cookie}` },
        });
        expect(me.statusCode).toBe(200);
      }, 30_000);

      it('last_owner counts people only (R-06): a service owner never stands in for the last human owner', async () => {
        // A bare workspace row is enough — memberships are all these two capabilities touch.
        const ws = randomUUID();
        await withAdminClient(pool, (client) =>
          client.query('insert into workspaces (id, name) values ($1, $2)', [
            ws,
            `last-human-owner-${ws.slice(0, 8)}`,
          ]),
        );
        const person = await createUser(pool, {
          login: `last-person-${randomUUID().slice(0, 8)}`,
          displayName: 'Last Person',
        });
        await callAsAdmin('add_membership', { userId: person.id, workspaceId: ws, role: 'owner' });
        await withAdminClient(pool, (client) =>
          client.query(
            `insert into principals (workspace_id, kind, role, display_name, api_key_hash)
             values ($1, 'service', 'owner', 'CI owner', $2)`,
            [ws, hashApiKey(generateApiKey())],
          ),
        );

        await expectPlatformError(
          () =>
            callAsAdmin('set_membership_role', {
              userId: person.id,
              workspaceId: ws,
              role: 'member',
            }),
          'last_owner',
        );
        await expectPlatformError(
          () => callAsAdmin('remove_membership', { userId: person.id, workspaceId: ws }),
          'last_owner',
        );

        // A second person owning the workspace lifts the refusal.
        const second = await createUser(pool, {
          login: `second-person-${randomUUID().slice(0, 8)}`,
          displayName: 'Second Person',
        });
        await callAsAdmin('add_membership', { userId: second.id, workspaceId: ws, role: 'owner' });
        const demoted = await callAsAdmin<UserMembershipWire>('set_membership_role', {
          userId: person.id,
          workspaceId: ws,
          role: 'member',
        });
        expect(demoted.role).toBe('member');
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

      // Legacy 708: merged into a disabled user, the source's memberships would keep their
      // sessions and Handles under a disabled user (I-H2).
      it('refuses a disabled target — user_disabled — and leaves the source and its sessions as they were', async () => {
        const source = await createUser(pool, {
          login: `merge-live-${randomUUID().slice(0, 8)}`,
          displayName: 'Live Source',
        });
        const membership = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: source.id,
          workspaceId,
          role: 'member',
        });
        const session = await withAdminClient(pool, (client) =>
          client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'entry', $2, 'active') returning id`,
            [workspaceId, membership.principalId],
          ),
        );
        const target = await createUser(pool, {
          login: `merge-off-${randomUUID().slice(0, 8)}`,
          displayName: 'Disabled Target',
          password: PASSWORD,
        });
        await callAsAdmin<UserWire>('set_user_status', { userId: target.id, status: 'disabled' });

        await expectPlatformError(
          () => callAsAdmin('merge_user', { sourceUserId: source.id, targetUserId: target.id }),
          'user_disabled',
        );
        const after = await withAdminClient(pool, (client) =>
          client.query<{ user_id: string | null; status: string }>(
            `select p.user_id, s.status from principals p
               join sessions s on s.workspace_id = p.workspace_id and s.on_behalf_of = p.id
              where p.workspace_id = $1 and p.id = $2 and s.id = $3`,
            [workspaceId, membership.principalId, session.rows[0]?.id],
          ),
        );
        expect(after.rows).toEqual([{ user_id: source.id, status: 'active' }]);
      });

      // Legacy 719: a disabled source's memberships act again under the active target — one
      // `platform.membership_restored` row each, found by either user and by the workspace; a
      // removed membership moves as it is and gets none.
      it('a disabled source: each membership usable again gets its own platform.membership_restored row; a removed one gets none', async () => {
        const removedWorkspaceId = randomUUID();
        await withAdminClient(pool, (client) =>
          client.query('insert into workspaces (id, name) values ($1, $2)', [
            removedWorkspaceId,
            `merge-removed-${removedWorkspaceId.slice(0, 8)}`,
          ]),
        );
        const sourceLogin = `merge-dis-${randomUUID().slice(0, 8)}`;
        const source = await createUser(pool, {
          login: sourceLogin,
          displayName: 'Disabled Source',
        });
        const restored = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: source.id,
          workspaceId,
          role: 'member',
        });
        const removed = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: source.id,
          workspaceId: removedWorkspaceId,
          role: 'member',
        });
        await callAsAdmin('remove_membership', {
          userId: source.id,
          workspaceId: removedWorkspaceId,
        });
        await callAsAdmin<UserWire>('set_user_status', { userId: source.id, status: 'disabled' });
        const targetLogin = `merge-on-${randomUUID().slice(0, 8)}`;
        const target = await createUser(pool, {
          login: targetLogin,
          displayName: 'Active Target',
          password: PASSWORD,
        });

        const merged = await callAsAdmin<UserWire>('merge_user', {
          sourceUserId: source.id,
          targetUserId: target.id,
        });
        expect(merged.status).toBe('active');
        expect(
          merged.memberships.map((m) => ({ principalId: m.principalId, disabled: m.disabled })),
        ).toEqual(
          expect.arrayContaining([
            { principalId: restored.principalId, disabled: false },
            { principalId: removed.principalId, disabled: true },
          ]),
        );

        const rows = await withAdminClient(pool, (client) =>
          client.query<{
            workspace_id: string | null;
            actor_user_id: string | null;
            resource_type: string | null;
            resource_id: string | null;
            payload: Record<string, unknown>;
          }>(
            `select workspace_id, actor_user_id, resource_type, resource_id, payload
               from audit_records
              where action = 'platform.membership_restored'
                and payload->'params'->>'sourceUserId' = $1`,
            [source.id],
          ),
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]).toMatchObject({
          workspace_id: null,
          actor_user_id: admin.id,
          resource_type: 'principal',
          resource_id: restored.principalId,
          payload: {
            channel: 'platform',
            actorLogin: admin.login,
            params: { workspaceId, sourceUserId: source.id, targetUserId: target.id },
            // The source row is gone: its login still says who it was.
            sourceLogin,
            targetLogin,
            reason: 'merged_from_disabled_user',
            role: 'member',
            workspaceName: expect.any(String),
            workspaceStatus: 'active',
          },
        });

        // The platform audit finds it by the target, by the (deleted) source and by the workspace.
        for (const filter of [
          { targetUserId: target.id },
          { targetUserId: source.id },
          { targetWorkspaceId: workspaceId },
        ]) {
          const page = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
            'platform_audit_query',
            { ...filter, action: 'platform.membership_restored', limit: 50 },
          );
          expect(page.items.map((item) => item.resourceId)).toContain(restored.principalId);
        }
      });

      it('an active source writes no platform.membership_restored row; the merge_user row keeps both logins', async () => {
        const sourceLogin = `merge-act-${randomUUID().slice(0, 8)}`;
        const source = await createUser(pool, { login: sourceLogin, displayName: 'Active Source' });
        await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: source.id,
          workspaceId,
          role: 'member',
        });
        const targetLogin = `merge-act-dst-${randomUUID().slice(0, 8)}`;
        const target = await createUser(pool, {
          login: targetLogin,
          displayName: 'Active Target Two',
          password: PASSWORD,
        });

        await callAsAdmin<UserWire>('merge_user', {
          sourceUserId: source.id,
          targetUserId: target.id,
        });
        const rows = await withAdminClient(pool, (client) =>
          client.query(
            `select 1 from audit_records
              where action = 'platform.membership_restored'
                and payload->'params'->>'sourceUserId' = $1`,
            [source.id],
          ),
        );
        expect(rows.rowCount).toBe(0);
        // Every merge deletes its source: the merge_user row says who it was by login.
        const mergeRow = await withAdminClient(pool, (client) =>
          client.query<{ payload: Record<string, unknown> }>(
            `select payload from audit_records
              where action = 'merge_user'
                and payload->'params'->>'sourceUserId' = $1`,
            [source.id],
          ),
        );
        expect(mergeRow.rows).toHaveLength(1);
        expect(mergeRow.rows[0]?.payload).toMatchObject({
          channel: 'platform',
          actorLogin: admin.login,
          params: { sourceUserId: source.id, targetUserId: target.id },
          sourceLogin,
          targetLogin,
        });
      });

      // UX acceptance of #1185 (P2): a removed membership is never deleted and every new user
      // joins the default workspace, so counting removed ones as a clash made "remove one first" a
      // dead end. Only two memberships that are not removed clash; a removed one is detached.
      async function mergeWorkspaces(count: number): Promise<string[]> {
        const ids = Array.from({ length: count }, () => randomUUID());
        await withAdminClient(pool, async (client) => {
          for (const id of ids) {
            await client.query('insert into workspaces (id, name) values ($1, $2)', [
              id,
              `merge-clash-${id.slice(0, 8)}`,
            ]);
          }
        });
        return ids;
      }

      async function principalUser(workspace: string, principalId: string): Promise<unknown> {
        const row = await withAdminClient(pool, (client) =>
          client.query<{ user_id: string | null; disabled: boolean }>(
            `select user_id, disabled_at is not null as disabled
               from principals where workspace_id = $1 and id = $2`,
            [workspace, principalId],
          ),
        );
        return row.rows[0];
      }

      it('two memberships in one workspace clash only when neither is removed; "remove one first" then works', async () => {
        const [shared] = await mergeWorkspaces(1);
        const source = await createUser(pool, {
          login: `merge-clash-src-${randomUUID().slice(0, 8)}`,
          displayName: 'Clash Source',
        });
        const target = await createUser(pool, {
          login: `merge-clash-dst-${randomUUID().slice(0, 8)}`,
          displayName: 'Clash Target',
          password: PASSWORD,
        });
        const ours = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: source.id,
          workspaceId: shared,
          role: 'member',
        });
        const theirs = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: target.id,
          workspaceId: shared,
          role: 'member',
        });

        const refused = await expectPlatformError(
          () => callAsAdmin('merge_user', { sourceUserId: source.id, targetUserId: target.id }),
          'already_member',
        );
        expect(refused.message).toContain(`merge-clash-${shared?.slice(0, 8)}`);

        // What the refusal says to do, done: the target's membership there is removed.
        await callAsAdmin('remove_membership', { userId: target.id, workspaceId: shared });
        const merged = await callAsAdmin<UserWire>('merge_user', {
          sourceUserId: source.id,
          targetUserId: target.id,
        });
        expect(merged.memberships.filter((m) => m.workspaceId === shared)).toEqual([
          expect.objectContaining({ principalId: ours.principalId, disabled: false }),
        ]);
        expect(await principalUser(shared as string, theirs.principalId)).toEqual({
          user_id: null,
          disabled: true,
        });
      });

      it('a removed membership on either side is detached: the one not removed stays or moves', async () => {
        const [sourceRemoved, targetRemoved, bothRemoved] = await mergeWorkspaces(3);
        const sourceLogin = `merge-det-src-${randomUUID().slice(0, 8)}`;
        const source = await createUser(pool, {
          login: sourceLogin,
          displayName: 'Detach Source',
        });
        const targetLogin = `merge-det-dst-${randomUUID().slice(0, 8)}`;
        const target = await createUser(pool, {
          login: targetLogin,
          displayName: 'Detach Target',
          password: PASSWORD,
        });
        const add = (userId: string, workspace: string | undefined) =>
          callAsAdmin<UserMembershipWire>('add_membership', {
            userId,
            workspaceId: workspace,
            role: 'member',
          });
        const remove = (userId: string, workspace: string | undefined) =>
          callAsAdmin('remove_membership', { userId, workspaceId: workspace });
        const s1 = await add(source.id, sourceRemoved);
        const t1 = await add(target.id, sourceRemoved);
        const s2 = await add(source.id, targetRemoved);
        const t2 = await add(target.id, targetRemoved);
        const s3 = await add(source.id, bothRemoved);
        const t3 = await add(target.id, bothRemoved);
        await remove(source.id, sourceRemoved);
        await remove(target.id, targetRemoved);
        await remove(source.id, bothRemoved);
        await remove(target.id, bothRemoved);

        const merged = await callAsAdmin<UserWire>('merge_user', {
          sourceUserId: source.id,
          targetUserId: target.id,
        });
        const kept = (workspace: string | undefined) =>
          merged.memberships
            .filter((m) => m.workspaceId === workspace)
            .map((m) => ({ principalId: m.principalId, disabled: m.disabled }));
        // The source's removed one goes; the target keeps its own.
        expect(kept(sourceRemoved)).toEqual([{ principalId: t1.principalId, disabled: false }]);
        expect(await principalUser(sourceRemoved as string, s1.principalId)).toEqual({
          user_id: null,
          disabled: true,
        });
        // The target's removed one goes; the source's moves to the target.
        expect(kept(targetRemoved)).toEqual([{ principalId: s2.principalId, disabled: false }]);
        expect(await principalUser(targetRemoved as string, t2.principalId)).toEqual({
          user_id: null,
          disabled: true,
        });
        // Both removed: the source's goes, the target keeps its own, removed as it was.
        expect(kept(bothRemoved)).toEqual([{ principalId: t3.principalId, disabled: true }]);
        expect(await principalUser(bothRemoved as string, s3.principalId)).toEqual({
          user_id: null,
          disabled: true,
        });

        // The merge_user row says whose each detached membership was.
        const mergeRow = await withAdminClient(pool, (client) =>
          client.query<{ payload: Record<string, unknown> }>(
            `select payload from audit_records
              where action = 'merge_user'
                and payload->'params'->>'sourceUserId' = $1`,
            [source.id],
          ),
        );
        expect(mergeRow.rows[0]?.payload).toMatchObject({ targetLogin });
        // Legacy 725 (UX on #1189): with the login and the workspace's name, so the audit says
        // whose membership it was and where without a lookup (the source row is gone).
        const entry = (
          workspace: string | undefined,
          principalId: string,
          user: { id: string },
          login: string,
        ) => ({
          workspaceId: workspace,
          principalId,
          userId: user.id,
          login,
          workspaceName: `merge-clash-${workspace?.slice(0, 8)}`,
        });
        expect(mergeRow.rows[0]?.payload.detachedPrincipals).toEqual(
          expect.arrayContaining([
            entry(sourceRemoved, s1.principalId, source, sourceLogin),
            entry(targetRemoved, t2.principalId, target, targetLogin),
            entry(bothRemoved, s3.principalId, source, sourceLogin),
          ]),
        );
        expect(mergeRow.rows[0]?.payload.detachedPrincipals).toHaveLength(3);
      });

      // #1189 #501 P3-1: a workspace-side disable takes only the Principal's lock. The merge reads
      // the memberships again once it holds the Principals' locks, so one removed while it waited
      // counts as removed: no clash, and no `membership_restored` for it.
      it('a membership removed while the merge waits for its lock counts as removed: it clashes with nothing and is not restored', async () => {
        const [shared, own] = await mergeWorkspaces(2);
        const source = await createUser(pool, {
          login: `merge-race-src-${randomUUID().slice(0, 8)}`,
          displayName: 'Race Source',
        });
        const target = await createUser(pool, {
          login: `merge-race-dst-${randomUUID().slice(0, 8)}`,
          displayName: 'Race Target',
          password: PASSWORD,
        });
        const add = (userId: string, workspace: string | undefined) =>
          callAsAdmin<UserMembershipWire>('add_membership', {
            userId,
            workspaceId: workspace,
            role: 'member',
          });
        // Both hold one in `shared` (a clash, until the source's is removed); the source alone in
        // `own` (restored by the merge, until it is removed).
        const sharedSource = await add(source.id, shared);
        const sharedTarget = await add(target.id, shared);
        const ownSource = await add(source.id, own);
        await callAsAdmin<UserWire>('set_user_status', { userId: source.id, status: 'disabled' });

        // A writer that removes both of the source's memberships the way `disable_principal` does
        // (its trigger takes each Principal's lock), and holds its transaction open.
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let removing!: () => void;
        const removed = new Promise<void>((resolve) => {
          removing = resolve;
        });
        const writer = withAdminClient(pool, async (client) => {
          for (const [ws, principalId] of [
            [shared, sharedSource.principalId],
            [own, ownSource.principalId],
          ] as const) {
            await client.query(
              'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
              [ws, principalId],
            );
          }
          removing();
          await released;
        });
        await removed;

        const merge = callAsAdmin<UserWire>('merge_user', {
          sourceUserId: source.id,
          targetUserId: target.id,
        });
        for (let attempt = 0; ; attempt += 1) {
          const { rows } = await pool.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and position('lock_authorities' in query) > 0`,
          );
          if ((rows[0]?.waiting ?? 0) > 0) break;
          if (attempt > 200) throw new Error('the merge never waited on the Principals’ locks');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        release();
        await writer;
        const merged = await merge;

        // The source's removed one in `shared` is detached, the target's stays; `own` moves, removed.
        expect(
          merged.memberships
            .map((m) => ({ principalId: m.principalId, disabled: m.disabled }))
            .sort((a, b) => a.principalId.localeCompare(b.principalId)),
        ).toEqual(
          [
            { principalId: sharedTarget.principalId, disabled: false },
            { principalId: ownSource.principalId, disabled: true },
          ].sort((a, b) => a.principalId.localeCompare(b.principalId)),
        );
        expect(await principalUser(shared as string, sharedSource.principalId)).toEqual({
          user_id: null,
          disabled: true,
        });
        const restoredRows = await withAdminClient(pool, (client) =>
          client.query(
            `select 1 from audit_records
              where action = 'platform.membership_restored'
                and payload->'params'->>'sourceUserId' = $1`,
            [source.id],
          ),
        );
        expect(restoredRows.rowCount).toBe(0);
      });
      // Legacy 725 (#493 on #1189): the target's membership in a workspace the source is in is
      // among the locks the merge waits for, so one removed while it waits counts as removed —
      // the target's is let go and the source's moves, instead of a clash read before the removal.
      it('the target’s membership removed while the merge waits for its lock counts as removed: the source’s moves', async () => {
        const [shared] = await mergeWorkspaces(1);
        const source = await createUser(pool, {
          login: `merge-trace-src-${randomUUID().slice(0, 8)}`,
          displayName: 'Target Race Source',
        });
        const target = await createUser(pool, {
          login: `merge-trace-dst-${randomUUID().slice(0, 8)}`,
          displayName: 'Target Race Target',
          password: PASSWORD,
        });
        const sharedSource = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: source.id,
          workspaceId: shared,
          role: 'member',
        });
        const sharedTarget = await callAsAdmin<UserMembershipWire>('add_membership', {
          userId: target.id,
          workspaceId: shared,
          role: 'member',
        });

        // The target's removed the way `disable_principal` does (its trigger takes the
        // Principal's lock, and no user's), the transaction held open.
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let removing!: () => void;
        const removed = new Promise<void>((resolve) => {
          removing = resolve;
        });
        const writer = withAdminClient(pool, async (client) => {
          await client.query(
            'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
            [shared, sharedTarget.principalId],
          );
          removing();
          await released;
        });
        await removed;

        const merge = callAsAdmin<UserWire>('merge_user', {
          sourceUserId: source.id,
          targetUserId: target.id,
        });
        const outcome = merge.then(
          (user) => ({ user }),
          (error: unknown) => ({ error }),
        );
        for (let attempt = 0; ; attempt += 1) {
          const { rows } = await pool.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and position('lock_authorities' in query) > 0`,
          );
          if ((rows[0]?.waiting ?? 0) > 0) break;
          if (attempt > 200) throw new Error('the merge never waited on the target’s lock');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        release();
        await writer;
        const settled = await outcome;
        if ('error' in settled) throw settled.error;

        expect(
          settled.user.memberships.map((m) => ({
            principalId: m.principalId,
            disabled: m.disabled,
          })),
        ).toEqual([{ principalId: sharedSource.principalId, disabled: false }]);
        expect(await principalUser(shared as string, sharedTarget.principalId)).toEqual({
          user_id: null,
          disabled: true,
        });
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

      it('the audit copy is redacted by the shared rule; the settings and their history keep what was sent', async () => {
        // Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet.
        const fake = 'abcdefghijklmnopqrstuvwxyz0123';
        const before = await callAsAdmin<PlatformSettingsWire>('get_platform_settings');
        const announcement = `rotate tonight: PGPASSWORD=${fake} ${randomUUID().slice(0, 8)}`;
        const after = await callAsAdmin<PlatformSettingsWire>('update_platform_settings', {
          announcement,
          passwordMinLength: before.passwordMinLength,
        });
        expect(after.announcement).toBe(announcement);
        expect(after.passwordMinLength).toBe(before.passwordMinLength);

        const audit = await withAdminClient(pool, (client) =>
          client.query<{ payload: { params?: unknown; redactedValues?: number } }>(
            `select payload from audit_records
              where action = 'update_platform_settings' and workspace_id is null
              order by created_at desc limit 1`,
          ),
        );
        // A credential-looking value, and — the accepted over-redaction of the field rule —
        // `passwordMinLength`, whose value stays in the settings and `platform_settings_history`.
        expect(audit.rows[0]?.payload.params).toEqual({
          announcement: announcement.replace(fake, '[redacted]'),
          passwordMinLength: '[redacted]',
        });
        expect(audit.rows[0]?.payload.redactedValues).toBe(2);
        expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain(fake);
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

      it('legacy 420: a payload reads masked — params by field name, the rest by value', async () => {
        const fake = 'abcdefghijklmnopqrstuvwxyz0123'; // synthetic, Handle-shaped
        await withWorkspace(
          pool,
          { workspaceId, principalId: randomUUID() },
          (client) =>
            writeAudit(client, {
              workspaceId: null,
              actorPrincipalId: null,
              actorUserId: admin.id,
              action: 'test.platform_legacy_payload',
              payload: {
                params: { login: 'ops', password: 'plain-word-1' },
                note: `PGPASSWORD=${fake} was in the script`,
                credentialReview: { suspectedSecretValues: 1, confirmed: true },
              },
            }),
          { skipRoleSwitch: true },
        );
        const page = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
          'platform_audit_query',
          { action: 'test.platform_legacy_payload' },
        );
        expect(page.items[0]?.payload).toMatchObject({
          params: { login: 'ops', password: '[redacted]' },
          note: 'PGPASSWORD=[redacted] was in the script',
          credentialReview: { suspectedSecretValues: 1, confirmed: true },
        });
      });

      it('legacy 666: filters by what the act came through', async () => {
        const action = 'test.platform_acting_through';
        await runWithActingContext(
          { actingThrough: 'admin_agent_session', actingSessionId: randomUUID() },
          () =>
            withWorkspace(
              pool,
              { workspaceId, principalId: randomUUID() },
              (client) =>
                writeAudit(client, {
                  workspaceId: null,
                  actorPrincipalId: null,
                  actorUserId: admin.id,
                  action,
                }),
              { skipRoleSwitch: true },
            ),
        );
        const agent = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
          'platform_audit_query',
          { actingThrough: 'admin_agent_session', limit: 200 },
        );
        expect(agent.items.map((item) => item.action)).toContain(action);
        expect(agent.items.every((item) => item.actingThrough === 'admin_agent_session')).toBe(
          true,
        );
        const person = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
          'platform_audit_query',
          { actingThrough: 'person', limit: 200 },
        );
        expect(person.items.length).toBeGreaterThan(0);
        expect(person.items.every((item) => item.actingThrough === 'person')).toBe(true);
        expect(person.items.some((item) => item.action === action)).toBe(false);

        // An admin agent's act from before #1028: no `acting_through`, its session in the
        // payload. 管理员智能体 keeps it; no other value does.
        const older = 'test.platform_acting_through_older_agent';
        await withWorkspace(
          pool,
          { workspaceId, principalId: randomUUID() },
          (client) =>
            writeAudit(client, {
              workspaceId: null,
              actorPrincipalId: null,
              actorUserId: admin.id,
              action: older,
              payload: { sessionKind: 'admin_agent', sessionId: randomUUID() },
            }),
          { skipRoleSwitch: true },
        );
        // A recorded value decides: the same payload on a row recorded as platform work is not the
        // agent's.
        const recordedSystem = 'test.platform_acting_through_recorded_system';
        await runWithActingContext({ actingThrough: 'system' }, () =>
          withWorkspace(
            pool,
            { workspaceId, principalId: randomUUID() },
            (client) =>
              writeAudit(client, {
                workspaceId: null,
                actorPrincipalId: null,
                actorUserId: admin.id,
                action: recordedSystem,
                payload: { sessionKind: 'admin_agent', sessionId: randomUUID() },
              }),
            { skipRoleSwitch: true },
          ),
        );
        const agentAgain = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
          'platform_audit_query',
          { actingThrough: 'admin_agent_session', limit: 200 },
        );
        expect(agentAgain.items.map((item) => item.action)).toEqual(
          expect.arrayContaining([action, older]),
        );
        expect(agentAgain.items.some((item) => item.action === recordedSystem)).toBe(false);
        const personAgain = await callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>(
          'platform_audit_query',
          { actingThrough: 'person', limit: 200 },
        );
        expect(personAgain.items.some((item) => item.action === older)).toBe(false);
      });

      it('legacy 669: excludeReads leaves the reads out before paging, a refused read kept', async () => {
        // A target workspace of its own (`payload.params.workspaceId`), so the page holds only
        // what this test wrote.
        const tag = randomUUID();
        const write = (action: string, extra?: Record<string, unknown>) =>
          withWorkspace(
            pool,
            { workspaceId, principalId: randomUUID() },
            (client) =>
              writeAudit(client, {
                workspaceId: null,
                actorPrincipalId: null,
                actorUserId: admin.id,
                action,
                payload: { params: { workspaceId: tag }, ...extra },
              }),
            { skipRoleSwitch: true },
          );
        await write('create_workspace');
        await write('platform_audit_query', { outcome: 'refused' });
        for (let i = 0; i < 3; i += 1) await write('list_users');

        const query = (params: Record<string, unknown>) =>
          callAsAdmin<ListEnvelope<PlatformAuditRecordWire>>('platform_audit_query', {
            targetWorkspaceId: tag,
            ...params,
          });
        expect((await query({ limit: 100 })).items).toHaveLength(5);
        expect((await query({ excludeReads: false, limit: 100 })).items).toHaveLength(5);
        const first = await query({ excludeReads: true, limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(typeof first.nextCursor).toBe('string');
        const second = await query({ excludeReads: true, limit: 1, cursor: first.nextCursor });
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeUndefined();
        expect([...first.items, ...second.items].map((item) => item.action).sort()).toEqual([
          'create_workspace',
          'platform_audit_query',
        ]);
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

        // S8 W4-C (ui-audit O1/L1): the control tower's three cross-workspace metrics — no
        // seeded pending ActionRequest/running Task in this file's own database, so this only
        // pins the shape and non-negativity, not a specific count.
        expect(overview.counts.pendingActionRequests).toBeGreaterThanOrEqual(0);
        expect(overview.counts.runningTasks).toBeGreaterThanOrEqual(0);
        expect(overview.graphFreshness.staleThresholdMs).toBeGreaterThan(0);
        expect(overview.graphFreshness.staleSourceCount).toBeGreaterThanOrEqual(0);
        expect(overview.graphFreshness.affectedWorkspaceCount).toBeGreaterThanOrEqual(0);

        expect(overview.checklist).toHaveLength(5);
        const defaultWorkspace = overview.checklist.find((item) => item.key === 'defaultWorkspace');
        expect(defaultWorkspace?.done).toBe(true);

        expect(overview.health.map((service) => service.service)).toContain('postgres');
        expect(overview.recentAudit.length).toBeGreaterThan(0);
      });

      // Console audit P1-14: 「最近平台审计」 lists changes; the reads the console polls with
      // (this very call, `platform_audit_query`) never crowd them out.
      it('recentAudit carries changes only, never a read', async () => {
        await callAsAdmin('platform_audit_query', { limit: 1 });
        await callAsAdmin<PlatformOverviewWire>('platform_overview');
        const overview = await callAsAdmin<PlatformOverviewWire>('platform_overview');
        expect(overview.recentAudit.length).toBeGreaterThan(0);
        for (const row of overview.recentAudit) {
          const capability = getCapability(row.action);
          expect(
            capability === undefined || capabilityHasSideEffects(capability),
            `${row.action} is a read`,
          ).toBe(true);
        }
      });
    });

    // S8 W4-C (journey ⑤ 清理验收残留): platform_draft_residue counts drafts across every
    // workspace — never their content (I16). A baseline read before creating drafts, then an
    // exact delta after, keeps this independent of whatever else this file's shared database
    // already has.
    describe('platform_draft_residue', () => {
      it('counts a fresh draft of each kind, and only drafts — never a published row', async () => {
        const before = await callAsAdmin<PlatformDraftResidueWire>('platform_draft_residue');

        const proposer = await addPrincipal(pool, workspaceId, 'Draft Residue Proposer');
        await withWorkspace(pool, { workspaceId, principalId: proposer.principalId }, (client) =>
          proposeWorkerDefinition(client, workspaceId, proposer.principalId, {
            origin: 'human',
            kind: 'worker',
            definition: { systemPrompt: 'You are a test worker.' },
          }),
        );
        await withWorkspace(pool, { workspaceId, principalId: proposer.principalId }, (client) =>
          proposeSkill(client, workspaceId, proposer.principalId, {
            origin: 'human',
            name: 'residue-test-skill',
            description: 'exists only to be counted',
            markdown: 'do nothing',
          }),
        );
        await withWorkspace(pool, { workspaceId, principalId: proposer.principalId }, (client) =>
          proposeProcedure(client, workspaceId, proposer.principalId, {
            origin: 'human',
            name: 'residue-test-procedure',
            description: 'exists only to be counted',
            steps: [],
          }),
        );

        const after = await callAsAdmin<PlatformDraftResidueWire>('platform_draft_residue');
        expect(after.workerDefinitions).toBe(before.workerDefinitions + 1);
        expect(after.skills).toBe(before.skills + 1);
        expect(after.procedures).toBe(before.procedures + 1);
        expect(after.total).toBe(before.total + 3);
        expect(after.expiryThresholdDays).toBeGreaterThanOrEqual(0);
        expect(after.checkedAt).toBeTruthy();
      });
    });
  },
);
