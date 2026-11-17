import { randomUUID } from 'node:crypto';
import { LLM_USAGE_TOKENS_MAX } from '@nexttime/shared';
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
  it('400s on a body that is not an array', async () => {
    app = Fastify();
    await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage: vi.fn() });

    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      payload: { not: 'an array' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      ok: false,
      error: { code: 'invalid_body', message: 'the body must be a JSON array of usage records' },
    });
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

  it('accepts a record with a requestId (R-67) and drops one whose requestId is not a uuid', async () => {
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
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toEqual({ ok: true, result: { inserted: 0, groups: [], invalid: 1 } });
    expect(recordUsage).toHaveBeenCalledTimes(1);
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

  // Legacy 829: one record llm-proxy should never have sent used to answer the whole batch 400
  // with no groups, so llm-proxy requeued all of it and every workspace's usage waited behind it.
  describe('one record never stalls the batch (legacy 829)', () => {
    function capturingApp(lines: Record<string, unknown>[]): FastifyInstance {
      return Fastify({
        logger: {
          level: 'warn',
          stream: {
            write: (line: string) => {
              lines.push(JSON.parse(line) as Record<string, unknown>);
            },
          },
        },
      });
    }

    it('drops each record that fails validation, records the rest, and counts the dropped ones', async () => {
      const lines: Record<string, unknown>[] = [];
      app = capturingApp(lines);
      const recordUsage = vi.fn(async (_client: unknown, records: readonly LlmUsageRecord[]) => ({
        inserted: records.length,
        rejected: 0,
      }));
      await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

      const wsA = randomUUID();
      const wsB = randomUUID();
      const goodA = baseRecord({ workspaceId: wsA, inputTokens: LLM_USAGE_TOKENS_MAX });
      const goodB = baseRecord({ workspaceId: wsB, costUsd: 999_999_999_999.9998 });
      const requestId = randomUUID();
      const payload: unknown[] = [
        goodA,
        { ...baseRecord({ workspaceId: wsA, requestId }), inputTokens: -1 },
        { ...baseRecord({ workspaceId: wsB }), outputTokens: 1.5 },
        { ...baseRecord(), inputTokens: '10' },
        { ...baseRecord(), cacheReadTokens: LLM_USAGE_TOKENS_MAX + 1 },
        { ...baseRecord(), costUsd: 1e12 },
        { ...baseRecord(), workspaceId: 'not-a-workspace-id' },
        null,
        goodB,
      ];
      const res = await app.inject({ method: 'POST', url: '/internal/llm-usage', payload });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        result: {
          inserted: 2,
          groups: [
            { workspaceId: wsA, outcome: 'recorded', inserted: 1, rejected: 0 },
            { workspaceId: wsB, outcome: 'recorded', inserted: 1, rejected: 0 },
          ],
          invalid: 7,
        },
      });
      expect(recordUsage.mock.calls.map((call) => call[1])).toEqual([[goodA], [goodB]]);

      const warned = lines.filter((line) => line.level === 40);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({
        msg: 'llm-usage: dropped usage records that are not valid usage records; they are not retried',
        invalid: 7,
        records: [
          {
            index: 1,
            workspaceId: wsA,
            requestId,
            issues: [{ path: 'inputTokens', code: 'too_small' }],
          },
          { index: 2, workspaceId: wsB, issues: [{ path: 'outputTokens', code: 'invalid_type' }] },
          { index: 3, issues: [{ path: 'inputTokens', code: 'invalid_type' }] },
          { index: 4, issues: [{ path: 'cacheReadTokens', code: 'too_big' }] },
          { index: 5, issues: [{ path: 'costUsd', code: 'too_big' }] },
          { index: 6, issues: [{ path: 'workspaceId', code: 'invalid_format' }] },
          { index: 7, issues: [{ path: '', code: 'invalid_type' }] },
        ],
      });
      // A dropped record's values never reach the log, only where it failed.
      expect(JSON.stringify(warned[0])).not.toContain('not-a-workspace-id');
    });

    it('carries the dropped count next to the groups on a 500 too', async () => {
      app = Fastify();
      const recordUsage = vi.fn(async () => {
        throw new Error('transient');
      });
      await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

      const ws = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm-usage',
        payload: [baseRecord({ workspaceId: ws }), { ...baseRecord(), outputTokens: -5 }],
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.details).toEqual({
        groups: [{ workspaceId: ws, outcome: 'retry' }],
        invalid: 1,
      });
    });

    it('describes at most ten dropped records in its one warn line, and counts them all', async () => {
      const lines: Record<string, unknown>[] = [];
      app = capturingApp(lines);
      const recordUsage = vi.fn();
      await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

      const payload = Array.from({ length: 12 }, () => ({ ...baseRecord(), inputTokens: -1 }));
      const res = await app.inject({ method: 'POST', url: '/internal/llm-usage', payload });

      expect(res.json()).toEqual({ ok: true, result: { inserted: 0, groups: [], invalid: 12 } });
      expect(recordUsage).not.toHaveBeenCalled();
      const warned = lines.filter((line) => line.level === 40);
      expect(warned).toHaveLength(1);
      expect(warned[0]?.invalid).toBe(12);
      expect((warned[0]?.records as { index: number }[]).map((record) => record.index)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    });

    // A record from a newer llm-proxy (a field, or a closed-set value, this kernel does not know)
    // is not malformed: it is held for a resend, not dropped.
    it('holds the workspace of a record from a newer llm-proxy for a resend, recording its valid records now', async () => {
      const lines: Record<string, unknown>[] = [];
      app = capturingApp(lines);
      const recordUsage = vi.fn(async (_client: unknown, records: readonly LlmUsageRecord[]) => ({
        inserted: records.length,
        rejected: 0,
      }));
      await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

      const wsNewer = randomUUID();
      const wsNewerScope = randomUUID();
      const wsOther = randomUUID();
      const requestId = randomUUID();
      const payload: unknown[] = [
        baseRecord({ workspaceId: wsNewer }),
        { ...baseRecord({ workspaceId: wsNewer, requestId }), reasoningTokens: 3 },
        {
          ...baseRecord({ workspaceId: wsNewerScope, inputTokens: 0, outputTokens: 0 }),
          status: 'refused',
          refusalScope: 'workspace_monthly_cost',
        },
        baseRecord({ workspaceId: wsOther }),
        // Unknown field and a malformed workspace: nothing to hold it under.
        { ...baseRecord(), workspaceId: 'not-a-workspace-id', reasoningTokens: 3 },
        // Unknown field and a bad count: malformed whatever version sent it.
        { ...baseRecord(), inputTokens: -1, reasoningTokens: 3 },
      ];
      const res = await app.inject({ method: 'POST', url: '/internal/llm-usage', payload });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.details).toEqual({
        groups: [
          { workspaceId: wsNewer, outcome: 'retry' },
          { workspaceId: wsOther, outcome: 'recorded', inserted: 1, rejected: 0 },
          { workspaceId: wsNewerScope, outcome: 'retry' },
        ],
        invalid: 2,
      });
      expect(
        recordUsage.mock.calls.map((call) => (call[1] as LlmUsageRecord[])[0]?.workspaceId),
      ).toEqual([wsNewer, wsOther]);
      const held = lines.filter((line) => line.level === 40 && 'held' in line);
      expect(held).toEqual([
        expect.objectContaining({
          held: 2,
          records: [
            {
              index: 1,
              workspaceId: wsNewer,
              requestId,
              issues: [{ path: '', code: 'unrecognized_keys' }],
            },
            {
              index: 2,
              workspaceId: wsNewerScope,
              issues: [{ path: 'refusalScope', code: 'invalid_value' }],
            },
          ],
        }),
      ]);
      expect(lines.filter((line) => line.level === 40 && 'invalid' in line)).toEqual([
        expect.objectContaining({
          invalid: 2,
          records: [
            {
              index: 4,
              issues: [
                { path: 'workspaceId', code: 'invalid_format' },
                { path: '', code: 'unrecognized_keys' },
              ],
            },
            expect.objectContaining({ index: 5 }),
          ],
        }),
      ]);
    });

    it('drops a record it would hold once it started more than a day ago, and still holds a newer one', async () => {
      const lines: Record<string, unknown>[] = [];
      app = capturingApp(lines);
      const recordUsage = vi.fn(async (_client: unknown, records: readonly LlmUsageRecord[]) => ({
        inserted: records.length,
        rejected: 0,
      }));
      await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

      const hour = 60 * 60 * 1000;
      const wsStale = randomUUID();
      const wsRecent = randomUUID();
      const payload: unknown[] = [
        {
          ...baseRecord({
            workspaceId: wsStale,
            startedAt: new Date(Date.now() - 25 * hour).toISOString(),
          }),
          reasoningTokens: 3,
        },
        {
          ...baseRecord({
            workspaceId: wsRecent,
            startedAt: new Date(Date.now() - 23 * hour).toISOString(),
          }),
          reasoningTokens: 3,
        },
      ];
      const res = await app.inject({ method: 'POST', url: '/internal/llm-usage', payload });

      expect(res.statusCode).toBe(500);
      expect(res.json().error.details).toEqual({
        groups: [{ workspaceId: wsRecent, outcome: 'retry' }],
        invalid: 1,
      });
      expect(recordUsage).not.toHaveBeenCalled();
      expect(lines.filter((line) => line.level === 40 && 'invalid' in line)).toEqual([
        expect.objectContaining({
          invalid: 1,
          records: [
            {
              index: 0,
              workspaceId: wsStale,
              issues: [{ path: '', code: 'unrecognized_keys' }],
              heldTooLong: true,
            },
          ],
        }),
      ]);
    });

    it('drops a record that starts or finishes in year 0000, which Postgres cannot store', async () => {
      app = Fastify();
      const recordUsage = vi.fn();
      await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm-usage',
        payload: [
          baseRecord({ startedAt: '0000-01-01T00:00:00Z' }),
          baseRecord({ finishedAt: '0000-12-31T23:59:59Z' }),
        ],
      });

      expect(res.json()).toEqual({ ok: true, result: { inserted: 0, groups: [], invalid: 2 } });
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('logs nothing about dropped records when there are none', async () => {
      const lines: Record<string, unknown>[] = [];
      app = capturingApp(lines);
      const recordUsage = vi.fn(async () => ({ inserted: 1, rejected: 0 }));
      await registerLlmUsageRoutes(app, { pool: fakePool(), recordUsage });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm-usage',
        payload: [baseRecord()],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().result).not.toHaveProperty('invalid');
      expect(lines).toEqual([]);
    });
  });
});
