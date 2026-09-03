import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolLike } from '../../../adapters/db/pool.js';
import type { EgressObservationInput } from '../../../application/host-bridge/index.js';
import { registerEgressRoutes } from './egress.js';

/**
 * interfaces/http/internal/egress.test: route-shape tests only — `deps.recordEgressObservations`
 * and `deps.pool` are both faked, so this file never touches Postgres (the real
 * `recordEgressObservations`'s own behavior is covered by
 * application/host-bridge/egress-observations.integration.test.ts, DB-gated).
 */

function fakePool(): PoolLike {
  const client = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client as unknown as PoolClient) };
}

function baseObservation(overrides: Record<string, unknown> = {}) {
  return {
    type: 'EgressObserved',
    sourceId: `entry:${randomUUID()}:${randomUUID()}`,
    clientIp: '198.51.100.10',
    domain: 'example.com',
    port: 443,
    protocol: 'connect',
    allowed: true,
    bytesUp: 120,
    bytesDown: 4096,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /internal/egress', () => {
  it('400s on a body that does not match the egress-proxy report shape', async () => {
    app = Fastify();
    await registerEgressRoutes(app, { pool: fakePool(), recordEgressObservations: vi.fn() });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/egress',
      payload: { not: 'an observations envelope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it('400s on an observation missing a required field', async () => {
    app = Fastify();
    await registerEgressRoutes(app, { pool: fakePool(), recordEgressObservations: vi.fn() });

    const { domain: _domain, ...missingDomain } = baseObservation();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/egress',
      payload: { observations: [missingDomain] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('maps bytesUp/bytesDown to bytesOut/bytesIn and domain to hostname before delegating', async () => {
    app = Fastify();
    const recordEgressObservations = vi.fn(async () => ({
      attributedToRunningTurn: 1,
      attributedToRecentTurn: 0,
      skippedUnknownSource: 0,
      skippedNoTurn: 0,
      attributedToWorkerRun: 0,
      skippedNoWorkerRun: 0,
    }));
    await registerEgressRoutes(app, { pool: fakePool(), recordEgressObservations });

    const observation = baseObservation({ reason: 'ok', bytesUp: 10, bytesDown: 20 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/egress',
      payload: { observations: [observation] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      result: {
        attributedToRunningTurn: 1,
        attributedToRecentTurn: 0,
        skippedUnknownSource: 0,
        skippedNoTurn: 0,
        attributedToWorkerRun: 0,
        skippedNoWorkerRun: 0,
      },
    });
    expect(recordEgressObservations).toHaveBeenCalledTimes(1);
    const call = recordEgressObservations.mock.calls[0];
    if (!call) throw new Error('recordEgressObservations was not called');
    const [, observations] = call as unknown as [unknown, readonly EgressObservationInput[]];
    expect(observations).toEqual([
      expect.objectContaining({
        sourceId: observation.sourceId,
        hostname: 'example.com',
        bytesOut: 10,
        bytesIn: 20,
        allowed: true,
        reason: 'ok',
        at: observation.observedAt,
      }),
    ]);
  });

  it('accepts an empty observations array and reports zero counts without calling the recorder', async () => {
    app = Fastify();
    const recordEgressObservations = vi.fn(async () => ({
      attributedToRunningTurn: 0,
      attributedToRecentTurn: 0,
      skippedUnknownSource: 0,
      skippedNoTurn: 0,
      attributedToWorkerRun: 0,
      skippedNoWorkerRun: 0,
    }));
    await registerEgressRoutes(app, { pool: fakePool(), recordEgressObservations });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/egress',
      payload: { observations: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      attributedToRunningTurn: 0,
      attributedToRecentTurn: 0,
      skippedUnknownSource: 0,
      skippedNoTurn: 0,
      attributedToWorkerRun: 0,
      skippedNoWorkerRun: 0,
    });
    expect(recordEgressObservations).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('500s when the recorder throws, without leaking the raw error', async () => {
    app = Fastify();
    const recordEgressObservations = vi.fn(async () => {
      throw new Error('db exploded');
    });
    await registerEgressRoutes(app, { pool: fakePool(), recordEgressObservations });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/egress',
      payload: { observations: [baseObservation()] },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('db exploded');
  });
});
