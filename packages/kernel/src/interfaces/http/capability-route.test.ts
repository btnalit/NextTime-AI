import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { ChatNotFoundError, TurnAlreadyRunningError } from '../../application/chat/index.js';
import { hashApiKey } from '../../application/gateway/index.js';
import { HANDLE_SIGNING_ALG, issueHandle } from '../../governance/capability/index.js';
import { createServer } from '../../index.js';
import { mapCapabilityError } from './capability-route.js';

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

describe('mapCapabilityError — application/chat domain errors (unit)', () => {
  it('TurnAlreadyRunningError → 409 turn_already_running (§9.4, HTTP twin of WS -32010)', () => {
    const mapped = mapCapabilityError(new TurnAlreadyRunningError('chat-1'));
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('turn_already_running');
  });

  it('ChatNotFoundError → 404 chat_not_found', () => {
    const mapped = mapCapabilityError(new ChatNotFoundError('ws-1', 'chat-1'));
    expect(mapped.status).toBe(404);
    expect(mapped.code).toBe('chat_not_found');
  });

  it('an unknown error still maps to a generic 500 that never echoes its message', () => {
    const mapped = mapCapabilityError(new Error('secret detail'));
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe('internal error');
  });
});

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
      // `issue_handle` (governance group, human channel, minRole:'owner') has no wired handler
      // yet — used here rather than `set_quota` (S2.7 gave it a handler; same reasoning as
      // application/gateway/dispatch.test.ts's own swap for this exact reason, which `set_quota`
      // itself replaced there for the identical cause: S2.3 having wired `approve`/`reject`).
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/issue_handle',
        headers: { authorization: `Bearer ${ownerApiKey}` },
        payload: { sessionId: '00000000-0000-0000-0000-000000000000', scope: {} },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json().error.code).toBe('not_implemented');
    });

    it('set_quota (owner) → 200, persisted, audited with a null resource_id (quota keys are not uuids)', async () => {
      // Regression: the handler used to return the quota key as `resourceId`; audit_records.
      // resource_id is a uuid column, so the audit INSERT failed and every set_quota was a 500.
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/set_quota',
        headers: { authorization: `Bearer ${ownerApiKey}` },
        payload: { key: 'task.max_depth', value: 2 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().ok).toBe(true);

      const quota = await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        (client) =>
          client.query<{ value: unknown }>(
            'select value from quotas where workspace_id = $1 and key = $2',
            [workspaceId, 'task.max_depth'],
          ),
        { skipRoleSwitch: true },
      );
      expect(quota.rows[0]?.value).toBe(2);

      const audit = await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        (client) =>
          client.query<{ resource_type: string | null; resource_id: string | null }>(
            `select resource_type, resource_id from audit_records
             where workspace_id = $1 and action = 'set_quota' order by created_at desc limit 1`,
            [workspaceId],
          ),
        { skipRoleSwitch: true },
      );
      expect(audit.rows[0]).toMatchObject({ resource_type: 'quota', resource_id: null });
    });

    it('assert_fact (handler present, write unimplemented) → 501 not_implemented, not 500', async () => {
      // S2.6 gave assert_fact a handler (the I16 meta-ontology guard); its write half still throws
      // AssertFactWriteNotImplementedError, which must map to the same stable 501 code as a
      // capability with no handler at all — not fall through to a generic 500.
      const app = createServer({ pool });
      const response = await app.inject({
        method: 'POST',
        url: '/api/cap/assert_fact',
        headers: { authorization: `Bearer ${ownerApiKey}` },
        payload: { objectId: randomUUID(), linkType: 'has_note', value: 'x' },
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

      // A real Handle, not a hand-crafted JWT: `issueHandle` both signs the token and records the
      // `capability_handles` row `createDbRevocationCheck` looks up — a jti with no such row is
      // treated as revoked (fail-closed), so a token that skips this step would always 401.
      const token = await withWorkspace(
        pool,
        { workspaceId, principalId: memberId },
        async (client) => {
          const sessionResult = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'entry', $2, 'active') returning id`,
            [workspaceId, memberId],
          );
          const sessionRow = sessionResult.rows[0];
          if (!sessionRow) throw new Error('fixture: session insert produced no row');
          const issued = await issueHandle(client, {
            sessionId: sessionRow.id,
            scope: { capabilities: ['get_object'], resources: {} },
            ttlSeconds: 3600,
            privateKey,
          });
          return issued.token;
        },
      );

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
