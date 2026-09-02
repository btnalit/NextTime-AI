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
