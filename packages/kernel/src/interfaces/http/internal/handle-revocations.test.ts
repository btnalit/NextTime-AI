import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveInternalCredential, registerInternalPlaneGuard } from '../../internal-auth/index.js';
import { registerHandleRevocationRoutes } from './handle-revocations.js';

/**
 * interfaces/http/internal/handle-revocations.test: route-shape tests only —
 * `deps.listRevokedSince` is faked, so this file never touches Postgres. The last `describe`
 * composes the route with `interfaces/internal-auth`'s guard the way the composition root does, to
 * pin the 401/401/200 contract `llm-proxy`'s revocation poller relies on.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /internal/handle-revocations', () => {
  it('defaults `since` to the epoch when the query param is omitted', async () => {
    app = Fastify();
    const listRevokedSince = vi.fn(async (since: Date) => {
      expect(since.getTime()).toBe(0);
      return { revoked: [], now: '2026-01-01T00:00:00.000Z' };
    });
    await registerHandleRevocationRoutes(app, { pool: {} as never, listRevokedSince });

    const res = await app.inject({ method: 'GET', url: '/internal/handle-revocations' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: [], now: '2026-01-01T00:00:00.000Z', hasMore: false });
    expect(listRevokedSince).toHaveBeenCalledTimes(1);
  });

  it('passes a parsed `since` query param through', async () => {
    app = Fastify();
    const listRevokedSince = vi.fn(async (since: Date) => {
      expect(since.toISOString()).toBe('2026-06-01T12:00:00.000Z');
      return {
        revoked: [{ jti: 'jti-1', revokedAt: '2026-06-01T12:00:01.000Z' }],
        now: '2026-06-01T12:00:02.000Z',
      };
    });
    await registerHandleRevocationRoutes(app, { pool: {} as never, listRevokedSince });

    const res = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations?since=2026-06-01T12%3A00%3A00.000Z',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      revoked: [{ jti: 'jti-1', revokedAt: '2026-06-01T12:00:01.000Z' }],
      now: '2026-06-01T12:00:02.000Z',
      hasMore: false,
    });
  });

  it('400s on a malformed `since` value', async () => {
    app = Fastify();
    await registerHandleRevocationRoutes(app, {
      pool: {} as never,
      listRevokedSince: vi.fn(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations?since=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it('500s when the query fails, without leaking the raw error', async () => {
    app = Fastify();
    await registerHandleRevocationRoutes(app, {
      pool: {} as never,
      listRevokedSince: vi.fn(async () => {
        throw new Error('db exploded');
      }),
    });

    const res = await app.inject({ method: 'GET', url: '/internal/handle-revocations' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('db exploded');
  });

  it('R-14: a full page answers hasMore with a nextCursor that, passed back, reaches the lister unchanged', async () => {
    app = Fastify();
    const exactCursor = {
      revokedAt: '2026-06-01T12:00:01.123456Z',
      jti: '0b6f7c1e-2f5d-4a8b-9c3e-1d2e3f4a5b6c',
    };
    const listRevokedSince = vi.fn(
      async (_since: Date, limit: number, after: typeof exactCursor | undefined) => {
        expect(limit).toBe(2);
        return after === undefined
          ? {
              revoked: [
                { jti: 'jti-1', revokedAt: '2026-06-01T12:00:01.123Z' },
                { jti: exactCursor.jti, revokedAt: '2026-06-01T12:00:01.123Z' },
              ],
              now: '2026-06-01T12:00:02.000Z',
              next: exactCursor,
            }
          : { revoked: [], now: '2026-06-01T12:00:03.000Z' };
      },
    );
    await registerHandleRevocationRoutes(app, {
      pool: {} as never,
      listRevokedSince,
      revocationPageSize: 2,
    });

    const first = (
      await app.inject({ method: 'GET', url: '/internal/handle-revocations' })
    ).json() as { hasMore: boolean; nextCursor?: string };
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextCursor).toBe('string');

    const second = await app.inject({
      method: 'GET',
      url: `/internal/handle-revocations?cursor=${first.nextCursor}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ revoked: [], now: '2026-06-01T12:00:03.000Z', hasMore: false });
    // The microseconds survive the round trip — a millisecond cursor would replay the page.
    expect(listRevokedSince.mock.calls[1]?.[2]).toEqual(exactCursor);
  });

  it('R-14: 400s on a cursor the route did not issue', async () => {
    app = Fastify();
    const listRevokedSince = vi.fn();
    await registerHandleRevocationRoutes(app, { pool: {} as never, listRevokedSince });

    const res = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations?cursor=not-a-cursor',
    });
    expect(res.statusCode).toBe(400);
    expect(listRevokedSince).not.toHaveBeenCalled();
  });
});

describe('GET /internal/handle-revocations behind the internal-plane guard', () => {
  const token = randomBytes(32).toString('hex');
  const unauthorized = { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } };

  async function guardedApp(): Promise<{
    app: FastifyInstance;
    listRevokedSince: ReturnType<typeof vi.fn>;
  }> {
    const instance = Fastify();
    registerInternalPlaneGuard(instance, { token });
    const listRevokedSince = vi.fn(async () => ({
      revoked: [],
      now: '2026-01-01T00:00:00.000Z',
    }));
    await registerHandleRevocationRoutes(instance, { pool: {} as never, listRevokedSince });
    return { app: instance, listRevokedSince };
  }

  it('401s without an Authorization header and never calls the lister', async () => {
    const built = await guardedApp();
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/internal/handle-revocations' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(unauthorized);
    expect(built.listRevokedSince).not.toHaveBeenCalled();
  });

  it('401s with a wrong token', async () => {
    const built = await guardedApp();
    app = built.app;
    const res = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: { authorization: `Bearer ${randomBytes(32).toString('hex')}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(unauthorized);
    expect(built.listRevokedSince).not.toHaveBeenCalled();
  });

  it('200s with llm-proxy’s credential and serves the route normally', async () => {
    const built = await guardedApp();
    app = built.app;
    const res = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: { authorization: `Bearer ${deriveInternalCredential(token, 'llm-proxy')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: [], now: '2026-01-01T00:00:00.000Z', hasMore: false });
    expect(built.listRevokedSince).toHaveBeenCalledTimes(1);
  });
});
