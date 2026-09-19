import { describe, expect, it } from 'vitest';
import type { ExhaustedBudgetRow } from './budget-sync.js';
import { startBudgetSync } from './budget-sync.js';

/**
 * budget-sync.test: the leftover-19 poll — replace semantics, self-expiring rows, fail-open on a
 * failed poll, no-op without a kernel, and the internal token on every request.
 */

function row(overrides: Partial<ExhaustedBudgetRow> = {}): ExhaustedBudgetRow {
  return {
    workspaceId: 'ws-1',
    scope: 'workspace_daily_cost',
    budget: 10,
    spent: 12.5,
    until: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeKernel(responses: Array<{ status: number; body?: unknown }>) {
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: headers.get('authorization') ?? undefined });
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, seen };
}

describe('startBudgetSync', () => {
  it('is a no-op without a kernel url', async () => {
    const sync = startBudgetSync({ kernelUrl: undefined, intervalMs: 60_000, log: () => {} });
    await sync.forceSync();
    expect(sync.isExhausted('ws-1')).toBeUndefined();
    sync.close();
  });

  it('pulls the exhausted set with the internal token and replaces it on every successful poll', async () => {
    const kernel = fakeKernel([
      { status: 200, body: { exhausted: [row()], now: '2026-09-19T10:00:00.000Z' } },
      {
        status: 200,
        body: { exhausted: [row({ workspaceId: 'ws-2' })], now: '2026-09-19T10:00:15.000Z' },
      },
    ]);
    const sync = startBudgetSync({
      kernelUrl: 'http://kernel.internal:8080',
      authorizationHeader: 'Bearer internal-token',
      intervalMs: 60_000,
      fetchImpl: kernel.fetchImpl,
      log: () => {},
    });
    sync.close(); // stop the timer; drive it by hand
    await sync.forceSync();
    expect(kernel.seen[0]).toEqual({
      url: 'http://kernel.internal:8080/internal/llm-budget-exhausted',
      authorization: 'Bearer internal-token',
    });
    expect(sync.isExhausted('ws-1')).toMatchObject({ scope: 'workspace_daily_cost', spent: 12.5 });

    await sync.forceSync();
    expect(sync.isExhausted('ws-1')).toBeUndefined(); // released — replaced, not accumulated
    expect(sync.isExhausted('ws-2')).toBeDefined();
  });

  it('keeps the last known set on a failed poll (fail-open on the sync, not on the refusal)', async () => {
    const kernel = fakeKernel([
      { status: 200, body: { exhausted: [row()], now: '2026-09-19T10:00:00.000Z' } },
      { status: 503 },
    ]);
    const lines: string[] = [];
    const sync = startBudgetSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 60_000,
      fetchImpl: kernel.fetchImpl,
      log: (line) => lines.push(line),
    });
    sync.close();
    await sync.forceSync();
    await sync.forceSync();
    expect(sync.isExhausted('ws-1')).toBeDefined();
    expect(lines.some((line) => line.includes('budget sync failed'))).toBe(true);
  });

  it('stops enforcing a row once its until has passed, even with no new poll', async () => {
    let clock = Date.parse('2026-09-19T23:59:00.000Z');
    const kernel = fakeKernel([
      {
        status: 200,
        body: { exhausted: [row({ until: '2026-09-20T00:00:00.000Z' })], now: '' },
      },
    ]);
    const sync = startBudgetSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 60_000,
      fetchImpl: kernel.fetchImpl,
      log: () => {},
      now: () => clock,
    });
    sync.close();
    await sync.forceSync();
    expect(sync.isExhausted('ws-1')).toBeDefined();
    clock = Date.parse('2026-09-20T00:00:01.000Z');
    expect(sync.isExhausted('ws-1')).toBeUndefined();
  });

  it('keeps the first row per workspace (cost axis listed first by the kernel)', async () => {
    const kernel = fakeKernel([
      {
        status: 200,
        body: {
          exhausted: [row(), row({ scope: 'workspace_daily_tokens', budget: 1000, spent: 2000 })],
          now: '',
        },
      },
    ]);
    const sync = startBudgetSync({
      kernelUrl: 'http://kernel.internal:8080',
      intervalMs: 60_000,
      fetchImpl: kernel.fetchImpl,
      log: () => {},
    });
    sync.close();
    await sync.forceSync();
    expect(sync.isExhausted('ws-1')?.scope).toBe('workspace_daily_cost');
  });
});
