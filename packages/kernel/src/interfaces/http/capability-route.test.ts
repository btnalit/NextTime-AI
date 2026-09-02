import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, generateKeyPair } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { hashApiKey } from '../../application/gateway/index.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/keys.js';
import { createServer } from '../../index.js';

/**
 * interfaces/http/capability-route.test: HTTP-level tests through Fastify `inject` (no real
 * listener — docs/development-tasks.md S1.3 item 8 "Test HTTP through Fastify inject"). Two
 * suites:
 *
 *   - Unit (no DB): the Authorization-header short-circuit — "无 key 401" never touches the
 *     database.
 *   - Integration (DATABASE_URL, auto-skip otherwise): the full auth → authorize → dispatch →
 *     audit path end-to-end, including the S1.3 acceptance criterion "member 调 grant_capability
 *     403".
 */

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('should not touch the database for this request');
  },
};

describe('POST /api/cap/:name — no database access when unauthenticated (unit)', () => {
  it('no Authorization header → 401', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({ method: 'POST', url: '/api/cap/get_object', payload: {} });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'unauthorized' },
    });
  });

  it('a non-Bearer Authorization header → 401', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({
      method: 'POST',
      url: '/api/cap/get_object',
      headers: { authorization: 'Basic dGVzdA==' },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().ok).toBe(false);
  });

  it('GET /api/health still works alongside the capability route', async () => {
    const app = createServer({ pool: neverConnectPool });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'POST /api/cap/:name — integration (real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerApiKey: string;
    let memberApiKey: string;

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

    async function adminInsertPrincipalWithKey(opts: {
      role: string;
      apiKey: string;
    }): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
             values ($1, $2, 'human', $3, $4, $5)`,
            [workspaceId, id, opts.role, opts.role, hashApiKey(opts.apiKey)],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('http-capability-route-test-workspace');
      ownerApiKey = `owner-key-${randomUUID()}`;
      memberApiKey = `member-key-${randomUUID()}`;
      await adminInsertPrincipalWithKey({ role: 'owner', apiKey: ownerApiKey });
      await adminInsertPrincipalWithKey({ role: 'member', apiKey: memberApiKey });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('member calling grant_capability → 403 (S1.3 acceptance)', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/grant_capability',
        headers: { authorization: `Bearer ${memberApiKey}` },
        payload: { principalId: randomUUID(), capability: 'get_object', scope: {} },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'forbidden', message: expect.any(String) },
      });
    });

    it('unknown capability name → 404', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/no_such_capability',
        headers: { authorization: `Bearer ${ownerApiKey}` },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
    });

    it('a registered but unimplemented capability → 501', async () => {
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/approve',
        headers: { authorization: `Bearer ${ownerApiKey}` },
        payload: { actionRequestId: randomUUID() },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json().error.code).toBe('not_implemented');
    });

    it('get_object round-trips a real Object end-to-end', async () => {
      const objectId = await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into objects (workspace_id, object_type, properties) values ($1, 'test.http-thing', '{}'::jsonb) returning id`,
            [workspaceId],
          );
          const row = result.rows[0];
          if (!row) throw new Error('fixture: object insert produced no row');
          return row.id;
        },
      );

      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/get_object',
        headers: { authorization: `Bearer ${ownerApiKey}` },
        payload: { objectId },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.result.id).toBe(objectId);
    });

    it('a Handle bearer token dispatches on the handle channel', async () => {
      const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });

      const memberId = await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          const result = await client.query<{ id: string }>(
            'select id from principals where workspace_id = $1 and role = $2 limit 1',
            [workspaceId, 'member'],
          );
          const row = result.rows[0];
          if (!row) throw new Error('fixture: no member principal found');
          return row.id;
        },
      );

      const objectId = await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into objects (workspace_id, object_type, properties) values ($1, 'test.http-handle-thing', '{}'::jsonb) returning id`,
            [workspaceId],
          );
          const row = result.rows[0];
          if (!row) throw new Error('fixture: object insert produced no row');
          return row.id;
        },
      );

      const token = await new SignJWT({
        ws: workspaceId,
        sid: randomUUID(),
        obo: memberId,
        scope: { capabilities: ['get_object'], resources: {} },
        jti: randomUUID(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
        .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
        .sign(privateKey);

      const app = createServer({ pool, loadHandlePublicKey: async () => publicKey });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/get_object',
        headers: { authorization: `Bearer ${token}` },
        payload: { objectId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result.id).toBe(objectId);
    });
  },
);
