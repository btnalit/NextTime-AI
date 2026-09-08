import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PoolLike } from './adapters/db/pool.js';
import { createServer, parsePositiveIntEnvVar } from './index.js';

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

// P2-9 fix: `Number(env)` on an unvalidated env var silently becomes `NaN`, which turns a
// reaper's deadline math / `setInterval` cadence into a tight loop instead of a startup error.
describe('parsePositiveIntEnvVar', () => {
  it('returns undefined when the env var is unset', () => {
    expect(parsePositiveIntEnvVar('X', undefined)).toBeUndefined();
  });

  it('parses a valid positive integer string', () => {
    expect(parsePositiveIntEnvVar('X', '5000')).toBe(5000);
  });

  it('throws on a non-numeric value', () => {
    expect(() => parsePositiveIntEnvVar('X', 'not-a-number')).toThrow(/X="not-a-number"/);
  });

  it('throws on an empty string', () => {
    expect(() => parsePositiveIntEnvVar('X', '')).toThrow();
  });

  it('throws on zero', () => {
    expect(() => parsePositiveIntEnvVar('X', '0')).toThrow();
  });

  it('throws on a negative number', () => {
    expect(() => parsePositiveIntEnvVar('X', '-100')).toThrow();
  });

  it('throws on Infinity', () => {
    expect(() => parsePositiveIntEnvVar('X', 'Infinity')).toThrow();
  });
});
