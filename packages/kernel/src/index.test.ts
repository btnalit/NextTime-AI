import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolLike } from './adapters/db/pool.js';
import { OutboxDispatcher } from './application/outbox/index.js';
import {
  DEFAULT_OUTBOX_PRUNE_DAYS,
  DEFAULT_OUTBOX_PRUNE_INTERVAL_MS,
  OUTBOX_PRUNE_INITIAL_DELAY_MS,
  createBackgroundServices,
  createServer,
  parseNonNegativeIntEnvVar,
  parsePositiveIntEnvVar,
} from './index.js';

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

describe('parseNonNegativeIntEnvVar', () => {
  it('returns undefined when the env var is unset', () => {
    expect(parseNonNegativeIntEnvVar('X', undefined)).toBeUndefined();
  });

  it('accepts 0 (the OUTBOX_PRUNE_DAYS "disable" sentinel)', () => {
    expect(parseNonNegativeIntEnvVar('X', '0')).toBe(0);
  });

  it('parses a valid positive integer string', () => {
    expect(parseNonNegativeIntEnvVar('X', '7')).toBe(7);
  });

  it('throws on a negative number', () => {
    expect(() => parseNonNegativeIntEnvVar('X', '-1')).toThrow(/not a non-negative/);
  });

  it('throws on a non-numeric value', () => {
    expect(() => parseNonNegativeIntEnvVar('X', 'nope')).toThrow(/not a non-negative/);
  });
});

/**
 * `createBackgroundServices`'s outbox-prune loop (fix/invoke-worker-wait-and-outbox-prune) — unit
 * tests (fake `pg` pool, no Postgres; `vi.useFakeTimers()`), mirroring
 * `application/outbox/dispatcher.test.ts`'s own `OutboxDispatcher.start/stop` fake-timer style.
 * `OutboxDispatcher.prototype.pruneDispatched` is spied directly (rather than emulating its own
 * `delete from outbox` SQL a second time here — already covered by dispatcher.test.ts) so these
 * tests exercise only what this file itself adds: the scheduling (initial delay, interval,
 * `outboxPruneDays:0` disables, `onOutboxPruneComplete`/`onOutboxPruneError`, `stop()` clears both
 * timers).
 */
describe('createBackgroundServices: outbox-prune loop', () => {
  /** Supports exactly the one query `interruptStaleRunningTurns` (start()'s own synchronous
   *  recovery scan, application/chat/recovery.ts) issues — see recovery.test.ts's own identical
   *  fake pool. Nothing else in createBackgroundServices()/start() queries the pool eagerly:
   *  every other reaper here only queries from inside its own setInterval tick, none of which
   *  this suite ever advances into. */
  function createRecoveryOnlyFakePool(): { pool: Pool; queries: string[] } {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        const t = text.trim();
        queries.push(t.split('\n')[0] ?? t);
        if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (t.startsWith('update activities')) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected query against fake pool: ${t}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) };
    return { pool: pool as unknown as Pool, queries };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the first prune tick after OUTBOX_PRUNE_INITIAL_DELAY_MS (not a full interval), with the default days, then schedules the recurring tick at the default interval', async () => {
    const { pool } = createRecoveryOnlyFakePool();
    const pruneSpy = vi.spyOn(OutboxDispatcher.prototype, 'pruneDispatched').mockResolvedValue(3);
    // The recurring interval's own delay is asserted directly off the `setInterval` call rather
    // than by actually waiting out a real DEFAULT_OUTBOX_PRUNE_INTERVAL_MS (6h) of fake time —
    // doing that would also have to step through every other reaper's own faster timer in this
    // file (the outbox dispatcher's 200ms poll alone is 100k+ firings over 6h), which is correct
    // but far too slow for a unit test.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const background = createBackgroundServices({ pool, kind: 'fake' });

    await background.start();
    expect(pruneSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(pruneSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    expect(pruneSpy).toHaveBeenCalledWith(DEFAULT_OUTBOX_PRUNE_DAYS);

    const pruneIntervalCall = setIntervalSpy.mock.calls.find(
      ([, delay]) => delay === DEFAULT_OUTBOX_PRUNE_INTERVAL_MS,
    );
    expect(pruneIntervalCall).toBeDefined();

    background.stop();
  });

  it('respects custom outboxPruneDays/outboxPruneIntervalMs', async () => {
    const { pool } = createRecoveryOnlyFakePool();
    const pruneSpy = vi.spyOn(OutboxDispatcher.prototype, 'pruneDispatched').mockResolvedValue(0);
    const background = createBackgroundServices({
      pool,
      kind: 'fake',
      outboxPruneDays: 30,
      outboxPruneIntervalMs: 60_000,
    });

    await background.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    expect(pruneSpy).toHaveBeenCalledWith(30);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pruneSpy).toHaveBeenCalledTimes(2);

    background.stop();
  });

  it('outboxPruneDays: 0 disables the prune loop entirely — no setTimeout is ever scheduled for it', async () => {
    const { pool } = createRecoveryOnlyFakePool();
    const pruneSpy = vi.spyOn(OutboxDispatcher.prototype, 'pruneDispatched').mockResolvedValue(0);
    // `setTimeout` (as opposed to `setInterval`) is used nowhere else in `createBackgroundServices`
    // — only the outbox-prune loop's own initial delay and (S3.8) the invariant-check loop's own
    // initial delay — so its total absence, with the latter also opted out via
    // `invariantCheckIntervalMs: 0`, proves the prune loop's timer never started, with no need to
    // advance fake time at all (let alone the 7 real days that would otherwise have to elapse to
    // be sure nothing was merely scheduled far in the future — which would also drag every other
    // reaper's own faster timer through that same span, the same cost this suite's other
    // rewritten test avoids).
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const background = createBackgroundServices({
      pool,
      kind: 'fake',
      outboxPruneDays: 0,
      invariantCheckIntervalMs: 0,
    });

    await background.start();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(pruneSpy).not.toHaveBeenCalled();
    background.stop();
  });

  it('calls onOutboxPruneComplete with { deleted } after a successful tick', async () => {
    const { pool } = createRecoveryOnlyFakePool();
    vi.spyOn(OutboxDispatcher.prototype, 'pruneDispatched').mockResolvedValue(5);
    const onOutboxPruneComplete = vi.fn();
    const background = createBackgroundServices({ pool, kind: 'fake', onOutboxPruneComplete });

    await background.start();
    await vi.advanceTimersByTimeAsync(OUTBOX_PRUNE_INITIAL_DELAY_MS);

    expect(onOutboxPruneComplete).toHaveBeenCalledTimes(1);
    expect(onOutboxPruneComplete).toHaveBeenCalledWith({ deleted: 5 });
    background.stop();
  });

  it('routes a rejected pruneDispatched to onOutboxPruneError instead of an unhandled rejection', async () => {
    const { pool } = createRecoveryOnlyFakePool();
    const boom = new Error('boom');
    vi.spyOn(OutboxDispatcher.prototype, 'pruneDispatched').mockRejectedValue(boom);
    const onOutboxPruneError = vi.fn();
    const onOutboxPruneComplete = vi.fn();
    const background = createBackgroundServices({
      pool,
      kind: 'fake',
      onOutboxPruneError,
      onOutboxPruneComplete,
    });

    await background.start();
    await vi.advanceTimersByTimeAsync(OUTBOX_PRUNE_INITIAL_DELAY_MS);

    expect(onOutboxPruneError).toHaveBeenCalledTimes(1);
    expect(onOutboxPruneError).toHaveBeenCalledWith(boom);
    expect(onOutboxPruneComplete).not.toHaveBeenCalled();
    background.stop();
  });

  it('stop() clears both the initial-delay timer and the interval timer', async () => {
    const { pool } = createRecoveryOnlyFakePool();
    const pruneSpy = vi.spyOn(OutboxDispatcher.prototype, 'pruneDispatched').mockResolvedValue(0);
    const background = createBackgroundServices({ pool, kind: 'fake' });

    // Case A: stop() before the initial delay even fires.
    await background.start();
    background.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_OUTBOX_PRUNE_INTERVAL_MS * 2);
    expect(pruneSpy).not.toHaveBeenCalled();

    // Case B: stop() after the first tick — the recurring interval must not fire either.
    pruneSpy.mockClear();
    const background2 = createBackgroundServices({ pool, kind: 'fake' });
    await background2.start();
    await vi.advanceTimersByTimeAsync(OUTBOX_PRUNE_INITIAL_DELAY_MS);
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    background2.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_OUTBOX_PRUNE_INTERVAL_MS * 2);
    expect(pruneSpy).toHaveBeenCalledTimes(1);
  });
});
