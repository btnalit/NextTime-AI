import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import { OutboxDispatcher } from './dispatcher.js';

/**
 * Unit tests (fake `pg` pool, no Postgres) for OutboxDispatcher — mirrors the fake-pool pattern
 * already used by adapters/db/pool.test.ts and substrate/outbox/enqueue.test.ts. A DB-gated
 * integration test for the "crash before delivery, a fresh dispatcher instance replays exactly
 * once" acceptance criterion (docs/development-tasks.md S1.4 deliverable 3) lives in
 * dispatcher.integration.test.ts.
 */

interface FakeOutboxRow {
  id: string;
  workspace_id: string;
  event_type: string;
  payload: unknown;
  dispatched_at: string | null;
  /** Defaults to 0 when omitted — most tests don't care about this axis at all. */
  attempts?: number;
}

/**
 * A tiny in-memory stand-in for the `outbox` table, shared across every `pool.connect()` call the
 * dispatcher makes (one per row it processes) — faithful enough to dispatcher.ts's own SQL text
 * (matched by distinguishing substrings) to exercise its two-phase (claim+increment, then deliver)
 * BEGIN/SELECT…FOR UPDATE SKIP LOCKED/UPDATE/COMMIT/ROLLBACK sequencing without a real database.
 */
function createFakeOutboxPool(initialRows: readonly FakeOutboxRow[]) {
  const rows: Array<FakeOutboxRow & { attempts: number }> = initialRows.map((r) => ({
    ...r,
    attempts: r.attempts ?? 0,
  }));
  const queryTexts: string[] = [];

  function makeClient(): PoolClient {
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        const t = text.trim();
        queryTexts.push(t.split('\n')[0]?.trim() ?? t);

        if (t === 'BEGIN' || t === 'ROLLBACK' || t === 'COMMIT') {
          return { rows: [], rowCount: 0 };
        }
        // Phase 1: claim query (excludeIds[] + attempts < maxAttempts) — checked before the more
        // generic phase-2 `startsWith` below, since both queries share the same first line.
        if (t.includes('not (id = any($1::bigint[]))')) {
          const excludeIds = new Set(((values?.[0] as string[] | undefined) ?? []).map(String));
          const maxAttempts = Number(values?.[1]);
          const row = rows.find(
            (r) => r.dispatched_at === null && !excludeIds.has(r.id) && r.attempts < maxAttempts,
          );
          return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        // Phase 1: durable attempts increment.
        if (t.startsWith('update outbox set attempts = attempts + 1')) {
          const id = String(values?.[1]);
          const row = rows.find((r) => r.id === id);
          if (row) row.attempts += 1;
          return { rows: [], rowCount: row ? 1 : 0 };
        }
        // Phase 2: relock by (workspace_id, id).
        if (t.startsWith('select id, workspace_id, event_type, payload')) {
          const id = String(values?.[1]);
          const row = rows.find((r) => r.id === id && r.dispatched_at === null);
          return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        // Phase 2: dispatched_at update.
        if (t.startsWith('update outbox set dispatched_at')) {
          const id = String(values?.[1]);
          const row = rows.find((r) => r.id === id);
          if (row) row.dispatched_at = new Date().toISOString();
          return { rows: [], rowCount: row ? 1 : 0 };
        }
        // pruneDispatched: `dispatched_at < now() - make_interval(days => $1)`, emulated with real
        // Date arithmetic against each row's own dispatched_at.
        if (t.startsWith('delete from outbox')) {
          const olderThanDays = Number(values?.[0]);
          const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
          const before = rows.length;
          const survivors = rows.filter(
            (r) => !(r.dispatched_at !== null && new Date(r.dispatched_at).getTime() < cutoff),
          );
          const deletedCount = before - survivors.length;
          rows.length = 0;
          rows.push(...survivors);
          return { rows: [], rowCount: deletedCount };
        }
        throw new Error(`unexpected query against fake outbox pool: ${t}`);
      }),
      release: vi.fn(),
    };
    return client as unknown as PoolClient;
  }

  const pool = { connect: vi.fn(async () => makeClient()) };
  return { pool: pool as unknown as Pool, rows, queryTexts };
}

function factAssertedEvent(
  overrides: Partial<Extract<DomainEvent, { type: 'FactAsserted' }>> = {},
) {
  return {
    type: 'FactAsserted' as const,
    workspaceId: 'ws1',
    factId: 'fact1',
    epistemicStatus: 'asserted' as const,
    ...overrides,
  };
}

describe('OutboxDispatcher.pollOnce', () => {
  it('delivers a matching row to its consumer and marks it dispatched', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    const received: unknown[] = [];
    dispatcher.subscribe('FactAsserted', (event, meta) => {
      received.push({ event, meta });
    });

    const delivered = await dispatcher.pollOnce();

    expect(delivered).toBe(1);
    expect(received).toEqual([
      { event: factAssertedEvent(), meta: { outboxId: '1', workspaceId: 'ws1' } },
    ]);
    expect(rows[0]?.dispatched_at).not.toBeNull();
  });

  it('never calls a consumer registered for a different event type', async () => {
    const { pool } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    const taskUpdated = vi.fn();
    dispatcher.subscribe('TaskUpdated', taskUpdated);

    const delivered = await dispatcher.pollOnce();

    expect(delivered).toBe(1); // the row is still drained/marked dispatched...
    expect(taskUpdated).not.toHaveBeenCalled(); // ...just never handed to the wrong consumer
  });

  it('calls every consumer subscribed to the same event type, in registration order', async () => {
    const { pool } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    const order: string[] = [];
    dispatcher.subscribe('FactAsserted', () => {
      order.push('first');
    });
    dispatcher.subscribe('FactAsserted', () => {
      order.push('second');
    });

    await dispatcher.pollOnce();

    expect(order).toEqual(['first', 'second']);
  });

  it('unsubscribe stops further delivery', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    const consumer = vi.fn();
    const unsubscribe = dispatcher.subscribe('FactAsserted', consumer);
    unsubscribe();

    await dispatcher.pollOnce();

    expect(consumer).not.toHaveBeenCalled();
    expect(rows[0]?.dispatched_at).not.toBeNull(); // still drained — just not handed to anyone
  });

  it('resolves 0 with no database access when there is nothing undelivered', async () => {
    const { pool } = createFakeOutboxPool([]);
    const dispatcher = new OutboxDispatcher(pool);

    const delivered = await dispatcher.pollOnce();

    expect(delivered).toBe(0);
  });

  it('stops at batchSize even if more rows remain undelivered', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
      {
        id: '2',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
      {
        id: '3',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool, { batchSize: 2 });
    dispatcher.subscribe('FactAsserted', () => {});

    const delivered = await dispatcher.pollOnce();

    expect(delivered).toBe(2);
    expect(rows.filter((r) => r.dispatched_at !== null)).toHaveLength(2);
  });

  it('a poison-pill row (consumer throws) is left undelivered but does not block a later row in the same batch', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent({ factId: 'bad' }),
        dispatched_at: null,
      },
      {
        id: '2',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent({ factId: 'good' }),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    const seen: string[] = [];
    dispatcher.subscribe('FactAsserted', (event) => {
      if (event.factId === 'bad') throw new Error('boom');
      seen.push(event.factId);
    });

    await expect(dispatcher.pollOnce()).rejects.toThrow('boom');

    expect(seen).toEqual(['good']);
    expect(rows.find((r) => r.id === '1')?.dispatched_at).toBeNull();
    expect(rows.find((r) => r.id === '2')?.dispatched_at).not.toBeNull();
  });

  it('a failed row is retried on the next pollOnce call and can then succeed', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    let attempt = 0;
    dispatcher.subscribe('FactAsserted', () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
    });

    await expect(dispatcher.pollOnce()).rejects.toThrow('transient');
    expect(rows[0]?.dispatched_at).toBeNull();

    const delivered = await dispatcher.pollOnce();
    expect(delivered).toBe(1);
    expect(attempt).toBe(2);
    expect(rows[0]?.dispatched_at).not.toBeNull();
  });

  it('lane-1 P2 fix: attempts is durably incremented even when the consumer throws (not rolled back)', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    dispatcher.subscribe('FactAsserted', () => {
      throw new Error('boom');
    });

    await expect(dispatcher.pollOnce()).rejects.toThrow('boom');

    // Before this fix, attempts stayed 0 forever on a consumer throw (it only incremented inside
    // the same transaction the throw rolled back) — a poison-pill event retried at full poll
    // cadence with no way to ever recognize or cap it.
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.dispatched_at).toBeNull();

    await expect(dispatcher.pollOnce()).rejects.toThrow('boom');
    expect(rows[0]?.attempts).toBe(2);
  });

  it('lane-1 P2 fix: a row is dead-lettered (no longer claimed) once attempts reaches maxAttempts', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool, { maxAttempts: 2 });
    dispatcher.subscribe('FactAsserted', () => {
      throw new Error('boom');
    });

    await expect(dispatcher.pollOnce()).rejects.toThrow('boom');
    expect(rows[0]?.attempts).toBe(1);
    await expect(dispatcher.pollOnce()).rejects.toThrow('boom');
    expect(rows[0]?.attempts).toBe(2);

    // A third poll finds nothing left to claim — the row is dead-lettered (attempts >=
    // maxAttempts), not retried indefinitely. It stays dispatched_at IS NULL (a durable,
    // queryable dead-letter marker), never silently deleted.
    const delivered = await dispatcher.pollOnce();
    expect(delivered).toBe(0);
    expect(rows[0]?.attempts).toBe(2);
    expect(rows[0]?.dispatched_at).toBeNull();
  });

  it('reentrancy guard: a concurrent pollOnce call while one is in flight resolves 0 and touches nothing', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatcher.subscribe('FactAsserted', async () => {
      await gate;
    });

    const first = dispatcher.pollOnce();
    const second = dispatcher.pollOnce();

    expect(await second).toBe(0);
    release?.();
    expect(await first).toBe(1);
    expect(rows[0]?.dispatched_at).not.toBeNull();
  });
});

describe('OutboxDispatcher.pruneDispatched', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('deletes only dispatched rows older than olderThanDays', async () => {
    const now = Date.now();
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: new Date(now - 10 * DAY_MS).toISOString(), // old — pruned
      },
      {
        id: '2',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: new Date(now - 1 * DAY_MS).toISOString(), // recent — kept
      },
      {
        id: '3',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null, // never dispatched — kept regardless of age
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);

    const deletedCount = await dispatcher.pruneDispatched(7);

    expect(deletedCount).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(['2', '3']);
  });

  it('never prunes a dead-lettered row (dispatched_at still null regardless of attempts)', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
        attempts: 999,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool);

    const deletedCount = await dispatcher.pruneDispatched(1);

    expect(deletedCount).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('rejects a non-positive olderThanDays', async () => {
    const { pool } = createFakeOutboxPool([]);
    const dispatcher = new OutboxDispatcher(pool);

    await expect(dispatcher.pruneDispatched(0)).rejects.toThrow(RangeError);
    await expect(dispatcher.pruneDispatched(-1)).rejects.toThrow(RangeError);
  });
});

describe('OutboxDispatcher.start/stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls on an interval and delivers events without an explicit pollOnce() call', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool, { pollIntervalMs: 50 });
    const consumer = vi.fn();
    dispatcher.subscribe('FactAsserted', consumer);

    dispatcher.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(rows[0]?.dispatched_at).not.toBeNull();

    dispatcher.stop();
  });

  it('routes a poll error to onError instead of an unhandled rejection', async () => {
    const { pool } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const onError = vi.fn();
    const dispatcher = new OutboxDispatcher(pool, { pollIntervalMs: 50, onError });
    dispatcher.subscribe('FactAsserted', () => {
      throw new Error('boom');
    });

    dispatcher.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('boom');

    dispatcher.stop();
  });

  it('stop() prevents further polling', async () => {
    const { pool } = createFakeOutboxPool([]);
    const dispatcher = new OutboxDispatcher(pool, { pollIntervalMs: 10 });
    const connectSpy = vi.spyOn(pool, 'connect');

    dispatcher.start();
    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('start() twice does not create a second timer', async () => {
    const { pool, rows } = createFakeOutboxPool([
      {
        id: '1',
        workspace_id: 'ws1',
        event_type: 'FactAsserted',
        payload: factAssertedEvent(),
        dispatched_at: null,
      },
    ]);
    const dispatcher = new OutboxDispatcher(pool, { pollIntervalMs: 50 });
    const consumer = vi.fn();
    dispatcher.subscribe('FactAsserted', consumer);

    dispatcher.start();
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(rows[0]?.dispatched_at).not.toBeNull();
    dispatcher.stop();
  });
});
