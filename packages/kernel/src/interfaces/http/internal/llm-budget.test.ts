import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolLike } from '../../../adapters/db/pool.js';
import { nextUtcMidnight } from '../../../governance/llm-usage/index.js';
import { registerLlmBudgetRoutes } from './llm-budget.js';

/**
 * interfaces/http/internal/llm-budget.test: route-shape tests only (`deps.listExhaustedBudgets`
 * faked; Postgres never touched — the real query is covered by
 * application/gateway/llm-admin.integration.test.ts, DB-gated).
 */

function fakePool(): PoolLike {
  const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  return { connect: vi.fn(async () => client as unknown as PoolClient) };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /internal/llm-budget-exhausted', () => {
  it('returns the complete exhausted set and the kernel clock', async () => {
    app = Fastify();
    const row = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      scope: 'workspace_daily_cost' as const,
      budget: 5,
      spent: 6.5,
      until: '2026-09-20T00:00:00.000Z',
    };
    await registerLlmBudgetRoutes(app, {
      pool: fakePool(),
      listExhaustedBudgets: async () => ({ exhausted: [row], now: '2026-09-19T10:00:00.000Z' }),
    });
    const res = await app.inject({ method: 'GET', url: '/internal/llm-budget-exhausted' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exhausted: [row], now: '2026-09-19T10:00:00.000Z' });
  });

  it('500s with the internal_error envelope when the query fails', async () => {
    app = Fastify();
    await registerLlmBudgetRoutes(app, {
      pool: fakePool(),
      listExhaustedBudgets: async () => {
        throw new Error('boom');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/internal/llm-budget-exhausted' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'internal_error' } });
  });
});

describe('nextUtcMidnight', () => {
  it('is the next 00:00:00Z strictly after now, across month and year ends', () => {
    expect(nextUtcMidnight(new Date('2026-09-19T10:00:00.000Z')).toISOString()).toBe(
      '2026-09-20T00:00:00.000Z',
    );
    expect(nextUtcMidnight(new Date('2026-09-30T23:59:59.999Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(nextUtcMidnight(new Date('2026-12-31T00:00:00.000Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});
