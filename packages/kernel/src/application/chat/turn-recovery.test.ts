import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import type { ChatPushEvent } from './push.js';
import { endUnknownRuntimeTurn } from './turn-recovery.js';

/**
 * Unit tests (fake `pg` client, no Postgres) for endUnknownRuntimeTurn — lane-4 P1/P2 fix
 * (docs/development-tasks.md: "stop_agent on a Turn the runtime does not know ends the Activity
 * interrupted + enqueues TurnCompleted").
 */

afterEach(() => {
  _resetChatPushEventsForTests();
});

function createFakeClient(updateRowCount: number) {
  const queries: { text: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    const t = text.trim();
    queries.push({ text: t, values });
    if (t.startsWith('update activities')) return { rows: [], rowCount: updateRowCount };
    if (t.startsWith('insert into outbox')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${t}`);
  });
  return { client: { query } as unknown as PoolClient, queries };
}

const WORKSPACE_ID = 'ws1';
const CHAT_ID = 'chat1';
const TURN_ID = 'turn1';

describe('endUnknownRuntimeTurn', () => {
  it('ends a running Turn, enqueues TurnCompleted, and pushes chat.metadata — returns true', async () => {
    const { client, queries } = createFakeClient(1);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endUnknownRuntimeTurn(client, WORKSPACE_ID, CHAT_ID, TURN_ID);

    expect(result).toBe(true);

    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    expect(updateQuery?.values).toEqual([WORKSPACE_ID, TURN_ID]);

    const outboxQuery = queries.find((q) => q.text.startsWith('insert into outbox'));
    expect(outboxQuery).toBeDefined();
    const payload = JSON.parse(outboxQuery?.values?.[2] as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'TurnCompleted',
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      status: 'interrupted',
    });

    expect(received).toEqual([
      {
        type: 'chat.metadata',
        chatId: CHAT_ID,
        metadata: { turnId: TURN_ID, turnStatus: 'interrupted' },
      },
    ]);
  });

  it('is a no-op (returns false, no TurnCompleted, no push) when the Turn is not currently running', async () => {
    const { client, queries } = createFakeClient(0);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endUnknownRuntimeTurn(client, WORKSPACE_ID, CHAT_ID, TURN_ID);

    expect(result).toBe(false);
    expect(queries.some((q) => q.text.startsWith('insert into outbox'))).toBe(false);
    expect(received).toEqual([]);
  });
});
