import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import type { ChatPushEvent } from './push.js';
import { interruptStaleRunningTurns } from './recovery.js';

/**
 * Unit tests (fake `pg` client, no Postgres) for interruptStaleRunningTurns — mirrors the
 * fake-client pattern already used throughout this package (e.g.
 * application/outbox/dispatcher.test.ts). A DB-gated integration test for the real UPDATE
 * behavior lives in recovery.integration.test.ts.
 *
 * Lane-4 P1 fix (docs/development-tasks.md): this function no longer takes an age/`timeoutMs`
 * threshold — it interrupts *every* `running` agent_turn Activity, unconditionally, since its one
 * call site (packages/kernel/src/index.ts's startup `start()`) runs before this process could
 * possibly have started one itself. See recovery.ts's own doc comment for the full reasoning.
 */

afterEach(() => {
  _resetChatPushEventsForTests();
});

interface FakeRow {
  id: string;
  workspace_id: string;
  chat_id: string | null;
}

function createFakePool(rows: FakeRow[]) {
  const queries: { text: string; values?: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      const t = text.trim();
      queries.push({ text: t, values });
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('update activities')) return { rows, rowCount: rows.length };
      throw new Error(`unexpected query: ${t}`);
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client as unknown as PoolClient) };
  return { pool, client, queries };
}

describe('interruptStaleRunningTurns', () => {
  it('runs the UPDATE with no age filter (no bound parameters), inside BEGIN/COMMIT', async () => {
    const { pool, queries } = createFakePool([]);

    const count = await interruptStaleRunningTurns({ pool });

    expect(count).toBe(0);
    const texts = queries.map((q) => q.text.split('\n')[0]);
    expect(texts).toEqual(['BEGIN', 'update activities', 'COMMIT']);
    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    expect(updateQuery?.values ?? []).toHaveLength(0);
    expect(updateQuery?.text).not.toMatch(/created_at/);
  });

  it('publishes chat.metadata (turnStatus: interrupted) for every returned row that has a chat_id', async () => {
    const rows: FakeRow[] = [
      { id: 'turn-1', workspace_id: 'ws1', chat_id: 'chat-1' },
      { id: 'turn-2', workspace_id: 'ws1', chat_id: 'chat-2' },
      { id: 'turn-3', workspace_id: 'ws1', chat_id: null }, // no chat_id -> no push possible
    ];
    const { pool } = createFakePool(rows);

    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat-1', (e) => received.push(e));
    subscribeToChatPushEvents('chat-2', (e) => received.push(e));

    const count = await interruptStaleRunningTurns({ pool });

    expect(count).toBe(3);
    expect(received).toHaveLength(2);
    expect(received).toEqual(
      expect.arrayContaining([
        {
          type: 'chat.metadata',
          chatId: 'chat-1',
          metadata: { turnId: 'turn-1', turnStatus: 'interrupted' },
        },
        {
          type: 'chat.metadata',
          chatId: 'chat-2',
          metadata: { turnId: 'turn-2', turnStatus: 'interrupted' },
        },
      ]),
    );
  });

  it('rolls back and rethrows if the UPDATE fails', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        const t = text.trim();
        queries.push(t.split('\n')[0] ?? t);
        if (t === 'BEGIN') return { rows: [], rowCount: 0 };
        if (t.startsWith('update activities')) throw new Error('boom');
        if (t === 'ROLLBACK') return { rows: [], rowCount: 0 };
        throw new Error(`unexpected: ${t}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client as unknown as PoolClient) };

    await expect(interruptStaleRunningTurns({ pool })).rejects.toThrow('boom');
    expect(queries).toEqual(['BEGIN', 'update activities', 'ROLLBACK']);
  });
});
