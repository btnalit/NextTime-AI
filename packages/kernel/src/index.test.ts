import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PoolLike } from './adapters/db/pool.js';
import { createServer } from './index.js';

/** The internal-plane shared secret every `/internal/*` test below presents (or deliberately
 *  withholds). Generated per run — never a literal that could look like a real credential. */
const INTERNAL_TOKEN = randomBytes(32).toString('hex');
const internalHeaders = { authorization: `Bearer ${INTERNAL_TOKEN}` };
const UNAUTHORIZED = { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } };

/** A pool that throws if ever connected to — proves a route never touches the database. */
const unusedPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('unusedPool: connect() should not have been called');
  },
};

describe('GET /api/health', () => {
  it('responds with status ok, with no database access', async () => {
    const app = createServer({ pool: unusedPool });

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('/internal/* routes are wired into the composition root (S1.7 → main)', () => {
  it('GET /internal/handle-revocations answers through the injected lister, no database access', async () => {
    const now = new Date().toISOString();
    const app = createServer(
      { pool: unusedPool, listRevokedSince: async () => ({ revoked: [], now }) },
      { internalAuth: { token: INTERNAL_TOKEN } },
    );

    const response = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: internalHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: [], now });
  });

  it('POST /internal/llm-usage rejects a malformed batch with 400 before touching the database', async () => {
    const app = createServer({ pool: unusedPool }, { internalAuth: { token: INTERNAL_TOKEN } });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      headers: internalHeaders,
      payload: { not: 'an array' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'invalid_body' } });
  });
});

describe('the internal plane is behind the shared-secret guard (fix/internal-plane-auth)', () => {
  const listRevokedSince = async () => ({ revoked: [], now: new Date().toISOString() });

  it('401s GET /internal/handle-revocations without an Authorization header, never reaching the lister', async () => {
    let listerCalls = 0;
    const app = createServer(
      {
        pool: unusedPool,
        listRevokedSince: async () => {
          listerCalls += 1;
          return listRevokedSince();
        },
      },
      { internalAuth: { token: INTERNAL_TOKEN } },
    );

    const response = await app.inject({ method: 'GET', url: '/internal/handle-revocations' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED);
    expect(listerCalls).toBe(0);
  });

  it('401s with a wrong token and does not echo either token', async () => {
    const app = createServer(
      { pool: unusedPool, listRevokedSince },
      { internalAuth: { token: INTERNAL_TOKEN } },
    );
    const wrong = randomBytes(32).toString('hex');

    const response = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: { authorization: `Bearer ${wrong}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED);
    expect(response.body).not.toContain(wrong);
    expect(response.body).not.toContain(INTERNAL_TOKEN);
  });

  it('401s every internal route, including POST /internal/llm-usage and /internal/egress, before body validation', async () => {
    const app = createServer({ pool: unusedPool }, { internalAuth: { token: INTERNAL_TOKEN } });

    for (const url of ['/internal/llm-usage', '/internal/egress']) {
      const response = await app.inject({ method: 'POST', url, payload: { not: 'valid' } });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toEqual(UNAUTHORIZED);
    }
  });

  it('rejects a peer inside NEXTTIME_SUBNET_WORKERS even with the right token, and accepts the same request from elsewhere', async () => {
    const app = createServer(
      { pool: unusedPool, listRevokedSince },
      { internalAuth: { token: INTERNAL_TOKEN, workersSubnet: '203.0.113.0/24' } },
    );

    const fromWorker = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: internalHeaders,
      remoteAddress: '203.0.113.9',
    });
    expect(fromWorker.statusCode).toBe(401);
    expect(fromWorker.json()).toEqual(UNAUTHORIZED);

    const fromControl = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: internalHeaders,
      remoteAddress: '198.51.100.9',
    });
    expect(fromControl.statusCode).toBe(200);
  });

  it('is fail-closed when createServer is given no internalAuth: 401 even with a token', async () => {
    const app = createServer({ pool: unusedPool, listRevokedSince });

    const response = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: internalHeaders,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED);
  });

  it('leaves the capability API and health check untouched (no internal token required or consulted)', async () => {
    const app = createServer({ pool: unusedPool }, { internalAuth: { token: INTERNAL_TOKEN } });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    // /api/cap/* keeps its own (Handle / API-key) 401 for a missing Authorization header — the
    // guard's body shape is never what answers here (capability-route.ts owns this response).
    const cap = await app.inject({ method: 'POST', url: '/api/cap/get_object', payload: {} });
    expect(cap.statusCode).toBe(401);
    expect(cap.headers['www-authenticate']).toBeUndefined();
  });
});
