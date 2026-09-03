import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECENT_TURN_WINDOW_MINUTES,
  findAttributableTurn,
  findAttributableTurnForSession,
} from './turn-attribution.js';

/**
 * Unit tests (fake `pg` client, no Postgres) for `findAttributableTurn` /
 * `findAttributableTurnForSession` — mirrors the fake-client pattern already used throughout this
 * package (e.g. application/chat/recovery.test.ts, application/outbox/dispatcher.test.ts): a
 * `client.query` mock that records each call and returns canned rows in call order, so these tests
 * assert on exactly what SQL/params this module issues without touching Postgres. The real
 * Postgres behavior (RLS, actual row visibility) is covered by the existing DB-gated
 * `egress-observations.integration.test.ts` (unchanged, still exercises this same logic via the
 * `recordEgressObservations` caller) plus this task's new `governance/llm-usage/service.test.ts`
 * / interfaces-level DB-gated coverage for the `llm-usage` caller.
 */

interface QueryCall {
  readonly text: string;
  readonly values?: readonly unknown[];
}

function fakeClient(responses: readonly { rows: unknown[] }[]): {
  client: PoolClient;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let call = 0;
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text: text.trim(), values });
      const response = responses[call] ?? { rows: [] };
      call++;
      return { rows: response.rows, rowCount: response.rows.length };
    }),
  };
  return { client: client as unknown as PoolClient, calls };
}

describe('findAttributableTurn', () => {
  it('prefers the currently running Turn and never queries for a recent one', async () => {
    const { client, calls } = fakeClient([{ rows: [{ id: 'turn-running' }] }]);

    const result = await findAttributableTurn(client, {
      workspaceId: 'ws-1',
      principalId: 'p-1',
      at: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(result).toEqual({ id: 'turn-running', wasRunning: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("status = 'running'");
    expect(calls[0]?.values).toEqual(['ws-1', 'p-1']);
  });

  it('falls back to the most recent Turn within the window when none is running', async () => {
    const { client, calls } = fakeClient([{ rows: [] }, { rows: [{ id: 'turn-recent' }] }]);
    const at = new Date('2026-09-01T00:10:00.000Z');

    const result = await findAttributableTurn(client, {
      workspaceId: 'ws-1',
      principalId: 'p-1',
      at,
      recentTurnWindowMinutes: 5,
    });

    expect(result).toEqual({ id: 'turn-recent', wasRunning: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).toContain("created_at > $3::timestamptz - ($4 || ' minutes')::interval");
    expect(calls[1]?.values).toEqual(['ws-1', 'p-1', at.toISOString(), 5]);
  });

  it('defaults recentTurnWindowMinutes to DEFAULT_RECENT_TURN_WINDOW_MINUTES when omitted', async () => {
    const { client, calls } = fakeClient([{ rows: [] }, { rows: [{ id: 'turn-recent' }] }]);

    await findAttributableTurn(client, {
      workspaceId: 'ws-1',
      principalId: 'p-1',
      at: new Date(),
    });

    expect(calls[1]?.values?.[3]).toBe(DEFAULT_RECENT_TURN_WINDOW_MINUTES);
  });

  it('returns undefined when neither a running nor a recent-enough Turn exists', async () => {
    const { client } = fakeClient([{ rows: [] }, { rows: [] }]);

    const result = await findAttributableTurn(client, {
      workspaceId: 'ws-1',
      principalId: 'p-1',
      at: new Date(),
    });

    expect(result).toBeUndefined();
  });
});

describe('findAttributableTurnForSession', () => {
  it('resolves sessionId to principalId, re-points app.principal_id, then applies the same running/recent rule', async () => {
    const { client, calls } = fakeClient([
      { rows: [{ principal_id: 'p-1' }] }, // sessions lookup
      { rows: [] }, // set_config
      { rows: [{ id: 'turn-running' }] }, // running-turn lookup
    ]);

    const result = await findAttributableTurnForSession(client, {
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      at: new Date(),
    });

    expect(result).toEqual({ id: 'turn-running', wasRunning: true });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.text).toContain('from sessions');
    expect(calls[0]?.values).toEqual(['ws-1', 'session-1']);
    expect(calls[1]?.text).toContain("set_config('app.principal_id'");
    expect(calls[1]?.values).toEqual(['p-1']);
    expect(calls[2]?.text).toContain("status = 'running'");
    expect(calls[2]?.values).toEqual(['ws-1', 'p-1']);
  });

  it('returns undefined without querying activities when the session does not resolve', async () => {
    const { client, calls } = fakeClient([{ rows: [] }]);

    const result = await findAttributableTurnForSession(client, {
      workspaceId: 'ws-1',
      sessionId: 'missing-session',
      at: new Date(),
    });

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
