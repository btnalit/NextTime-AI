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
      rejected: 0,
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
    expect(res.json()).toEqual({
      ok: true,
      result: {
        inserted: 3,
        groups: [
          { workspaceId: wsA, outcome: 'recorded', inserted: 2, rejected: 0 },
          { workspaceId: wsB, outcome: 'recorded', inserted: 1, rejected: 0 },
        ],
      },
    });
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
    expect(res.json()).toEqual({ ok: true, result: { inserted: 0, groups: [] } });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  // R-68 (L1-11): one failing workspace group used to 500 the whole POST before later groups were
  // even attempted, and llm-proxy re-sent everything — one poisoned group stalled every workspace.
  it('records every other group when one fails, and answers per group so only that one is retried', async () => {
    app = Fastify();
    const wsA = randomUUID();
    const wsBroken = randomUUID();
    const wsC = randomUUID();
    const recordUsage = vi.fn(async (_client: unknown, records: readonly LlmUsageRecord[]) => {
      if (records[0]?.workspaceId === wsBroken) throw new Error('connection reset');
      return { inserted: records.length, rejected: 0 };
    });
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: [
        baseRecord({ workspaceId: wsA }),
        baseRecord({ workspaceId: wsBroken }),
        baseRecord({ workspaceId: wsC }),
      ],
    });

    expect(recordUsage).toHaveBeenCalledTimes(3);
    // 500, so an llm-proxy that predates R-68 still retries (every recorded group replays as a
    // no-op); the per-group answer tells a current one to requeue only the broken group.
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal_error');
    expect(body.error.details.groups).toEqual([
      { workspaceId: wsA, outcome: 'recorded', inserted: 1, rejected: 0 },
      { workspaceId: wsBroken, outcome: 'retry' },
      { workspaceId: wsC, outcome: 'recorded', inserted: 1, rejected: 0 },
    ]);
    expect(JSON.stringify(body)).not.toContain('connection reset');
  });

  it('acknowledges a group whose workspace is gone after a foreign-key violation (permanent), and retries one whose workspace still exists', async () => {
    const fkViolation = (): Error => Object.assign(new Error('fk'), { code: '23503' });
    const wsGone = randomUUID();
    const wsPresent = randomUUID();
    const recordUsage = vi.fn(async () => {
      throw fkViolation();
    });
    // `select 1 from workspaces where id = $1` finds only `wsPresent`.
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) =>
        sql.includes('from workspaces') && params?.[0] === wsPresent
          ? { rows: [{ '?column?': 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      ),
      release: vi.fn(),
    };
    const pool: PoolLike = { connect: vi.fn(async () => client as unknown as PoolClient) };

    app = Fastify();
    await registerLlmUsageRoutes(app, { pool, recordUsage });
    const gone = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: [baseRecord({ workspaceId: wsGone }), baseRecord({ workspaceId: wsGone })],
    });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual({
      ok: true,
      result: {
        inserted: 0,
        groups: [{ workspaceId: wsGone, outcome: 'rejected', reason: 'workspace_not_found' }],
      },
    });

    const present = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: [baseRecord({ workspaceId: wsPresent })],
    });
    expect(present.statusCode).toBe(500);
    expect(present.json().error.details.groups).toEqual([
      { workspaceId: wsPresent, outcome: 'retry' },
    ]);
  });

  it('passes recordUsage rejections through as a recorded group with its rejected count', async () => {
    app = Fastify();
    const ws = randomUUID();
    const recordUsage = vi.fn(async () => ({ inserted: 1, rejected: 2 }));
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: [
        baseRecord({ workspaceId: ws }),
        baseRecord({ workspaceId: ws }),
        baseRecord({ workspaceId: ws }),
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      result: {
        inserted: 1,
        groups: [{ workspaceId: ws, outcome: 'recorded', inserted: 1, rejected: 2 }],
      },
    });
  });

  it('accepts a record with a requestId (R-67) and rejects one whose requestId is not a uuid', async () => {
    app = Fastify();
    const recordUsage = vi.fn(async (_client: unknown, records: readonly LlmUsageRecord[]) => ({
      inserted: records.length,
      rejected: 0,
    }));
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

    const requestId = randomUUID();
    const ok = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: [baseRecord({ requestId })],
    });
    expect(ok.statusCode).toBe(200);
    expect((recordUsage.mock.calls[0]?.[1] as LlmUsageRecord[])[0]?.requestId).toBe(requestId);

    const bad = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: [baseRecord({ requestId: 'not-a-uuid' })],
    });
    expect(bad.statusCode).toBe(400);
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
