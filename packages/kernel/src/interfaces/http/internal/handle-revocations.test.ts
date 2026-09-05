import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInternalPlaneGuard } from '../../internal-auth/index.js';
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
    expect(res.json()).toEqual({ revoked: [], now: '2026-01-01T00:00:00.000Z' });
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

  it('200s with the right token and serves the route normally', async () => {
    const built = await guardedApp();
    app = built.app;
    const res = await app.inject({
      method: 'GET',
      url: '/internal/handle-revocations',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: [], now: '2026-01-01T00:00:00.000Z' });
    expect(built.listRevokedSince).toHaveBeenCalledTimes(1);
  });
});
