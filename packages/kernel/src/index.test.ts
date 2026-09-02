import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PoolLike } from './adapters/db/pool.js';
import { createServer } from './index.js';

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
    const app = createServer({
      pool: unusedPool,
      listRevokedSince: async () => ({ revoked: [], now }),
    });

    const response = await app.inject({ method: 'GET', url: '/internal/handle-revocations' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: [], now });
  });

  it('POST /internal/llm-usage rejects a malformed batch with 400 before touching the database', async () => {
    const app = createServer({ pool: unusedPool });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: { not: 'an array' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'invalid_body' } });
  });
});
