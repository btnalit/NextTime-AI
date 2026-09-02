import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolLike } from '../../../adapters/db/pool.js';
import type { LlmUsageRecord } from '../../../governance/llm-usage/index.js';
import { registerLlmUsageRoutes } from './llm-usage.js';

/**
 * interfaces/http/internal/llm-usage.test: route-shape tests only — `deps.recordUsage` and
 * `deps.pool` are both faked, so this file never touches Postgres (the real `recordUsage`'s own
 * behavior is covered by governance/llm-usage/service.test.ts, DB-gated).
 */

function fakePool(): PoolLike {
  const client = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client as unknown as PoolClient) };
}

function baseRecord(overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord {
  return {
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    jti: randomUUID(),
    provider: 'example-provider',
    model: 'example-model',
    inputTokens: 10,
    outputTokens: 5,
    startedAt: new Date().toISOString(),
    status: 'completed',
    ...overrides,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /internal/llm-usage', () => {
  it('400s on a body that is not an array of valid records', async () => {
    app = Fastify();
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage: vi.fn() });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: { not: 'an array' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it('calls recordUsage once per distinct workspaceId group and sums inserted counts', async () => {
    app = Fastify();
    const recordUsage = vi.fn(async (_client: unknown, records: readonly LlmUsageRecord[]) => ({
      inserted: records.length,
    }));
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

    const wsA = randomUUID();
    const wsB = randomUUID();
    const body = [
      baseRecord({ workspaceId: wsA }),
      baseRecord({ workspaceId: wsA }),
      baseRecord({ workspaceId: wsB }),
    ];

    const res = await app.inject({ method: 'POST', url: '/internal/llm-usage', payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { inserted: 3 } });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    for (const call of recordUsage.mock.calls) {
      const records = call[1] as LlmUsageRecord[];
      const workspaceIds = new Set(records.map((r) => r.workspaceId));
      expect(workspaceIds.size).toBe(1);
    }
  });

  it('accepts an empty array and reports 0 inserted without calling recordUsage', async () => {
    app = Fastify();
    const recordUsage = vi.fn();
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

    const res = await app.inject({ method: 'POST', url: '/internal/llm-usage', payload: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { inserted: 0 } });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('500s when recordUsage throws, without leaking the raw error', async () => {
    app = Fastify();
    const recordUsage = vi.fn(async () => {
      throw new Error('db exploded');
    });
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: [baseRecord()],
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('db exploded');
  });
});
