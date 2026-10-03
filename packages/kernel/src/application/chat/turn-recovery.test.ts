import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import type { ChatPushEvent } from './push.js';
import { endTurn, endUnknownRuntimeTurn, requestTurnStop } from './turn-recovery.js';

/**
 * Unit tests (fake `pg` client, no Postgres) for the Turn-end primitives — `endTurn` (R-55, the
 * one guarded writer of a Turn's terminal status) and `endUnknownRuntimeTurn` (lane-4 P1/P2 fix,
 * docs/development-tasks.md: "stop_agent on a Turn the runtime does not know ends the Activity
 * interrupted + enqueues TurnCompleted"). The guard itself — `status = any(<source states>)`, and a
 * `completed` on a stop-requested Turn landing `interrupted` — is SQL;
 * `application/gateway/turn-terminal.integration.test.ts` runs it against Postgres.
 */

afterEach(() => {
  _resetChatPushEventsForTests();
});

/** `endedRow` is what the guarded UPDATE's `returning chat_id, status` yields — `undefined` when
 *  the Turn was not running (no row moved). */
function createFakeClient(endedRow?: { chat_id: string | null; status: string }) {
  const queries: { text: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    const t = text.trim();
    queries.push({ text: t, values });
    if (t.startsWith('update activities')) {
      const rows = endedRow ? [endedRow] : [];
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith('insert into outbox')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${t}`);
  });
  return { client: { query } as unknown as PoolClient, queries };
}

const WORKSPACE_ID = 'ws1';
const CHAT_ID = 'chat1';
const TURN_ID = 'turn1';

function outboxPayload(queries: { text: string; values?: unknown[] }[]) {
  const outboxQuery = queries.find((q) => q.text.startsWith('insert into outbox'));
  return outboxQuery
    ? (JSON.parse(outboxQuery.values?.[2] as string) as Record<string, unknown>)
    : undefined;
}

describe('endTurn', () => {
  it('moves a running Turn only from the states TURN_TRANSITIONS allows, enqueues TurnCompleted and pushes chat.metadata', async () => {
    const { client, queries } = createFakeClient({ chat_id: CHAT_ID, status: 'completed' });
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endTurn(client, WORKSPACE_ID, TURN_ID, 'completed');

    expect(result).toBe('completed');
    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    expect(updateQuery?.values).toEqual([WORKSPACE_ID, TURN_ID, 'completed', ['running']]);
    expect(updateQuery?.text).toContain("metadata ? 'stopRequestedAt'");
    expect(outboxPayload(queries)).toMatchObject({
      type: 'TurnCompleted',
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      status: 'completed',
    });
    expect(received).toEqual([
      {
        type: 'chat.metadata',
        chatId: CHAT_ID,
        metadata: { turnId: TURN_ID, turnStatus: 'completed' },
      },
    ]);
  });

  it('reports and publishes the status the row actually landed in (a stop-requested completed lands interrupted)', async () => {
    const { client, queries } = createFakeClient({ chat_id: CHAT_ID, status: 'interrupted' });
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endTurn(client, WORKSPACE_ID, TURN_ID, 'completed');

    expect(result).toBe('interrupted');
    expect(outboxPayload(queries)).toMatchObject({ status: 'interrupted' });
    expect(received).toEqual([
      {
        type: 'chat.metadata',
        chatId: CHAT_ID,
        metadata: { turnId: TURN_ID, turnStatus: 'interrupted' },
      },
    ]);
  });

  it('a late report for a Turn that already ended is a no-op: no TurnCompleted, no push', async () => {
    const { client, queries } = createFakeClient(undefined);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endTurn(client, WORKSPACE_ID, TURN_ID, 'completed');

    expect(result).toBeUndefined();
    expect(queries.some((q) => q.text.startsWith('insert into outbox'))).toBe(false);
    expect(received).toEqual([]);
  });
});

describe('requestTurnStop', () => {
  it('marks stopRequestedAt on the Turn, only while it is running', async () => {
    const { client, queries } = createFakeClient(undefined);

    await requestTurnStop(client, WORKSPACE_ID, TURN_ID);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("jsonb_build_object('stopRequestedAt', now())");
    expect(queries[0]?.text).toContain("status = 'running'");
    expect(queries[0]?.values).toEqual([WORKSPACE_ID, TURN_ID]);
  });
});

describe('endUnknownRuntimeTurn', () => {
  it('ends a running Turn interrupted, enqueues TurnCompleted, and pushes chat.metadata — returns true', async () => {
    const { client, queries } = createFakeClient({ chat_id: CHAT_ID, status: 'interrupted' });
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endUnknownRuntimeTurn(client, WORKSPACE_ID, CHAT_ID, TURN_ID);

    expect(result).toBe(true);
    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    expect(updateQuery?.values).toEqual([WORKSPACE_ID, TURN_ID, 'interrupted', ['running']]);
    expect(outboxPayload(queries)).toMatchObject({
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
    const { client, queries } = createFakeClient(undefined);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endUnknownRuntimeTurn(client, WORKSPACE_ID, CHAT_ID, TURN_ID);

    expect(result).toBe(false);
    expect(queries.some((q) => q.text.startsWith('insert into outbox'))).toBe(false);
    expect(received).toEqual([]);
  });
});
