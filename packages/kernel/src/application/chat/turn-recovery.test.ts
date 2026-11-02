import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import type { ChatPushEvent } from './push.js';
import {
  endTurn,
  endUnknownRuntimeTurn,
  publishTurnEnded,
  requestTurnStop,
} from './turn-recovery.js';

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
 *  the Turn was not running (no row moved). `refused` is what the legacy 589 check reads of the
 *  Turn's own entry-agent usage (`entryTurnRefusedOnly`): no refused call unless given. */
function createFakeClient(
  endedRow?: { chat_id: string | null; status: string; model_refused?: boolean },
  refused?: { refusedCalls: number; scope: string; lastRefusedAt: Date; answered?: boolean },
) {
  const queries: { text: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    const t = text.trim();
    queries.push({ text: t, values });
    if (t.startsWith('select count(*) as refused_calls')) {
      return {
        rows: [
          refused
            ? {
                refused_calls: String(refused.refusedCalls),
                scope: refused.scope,
                last_refused_at: refused.lastRefusedAt,
              }
            : { refused_calls: '0', scope: null, last_refused_at: null },
        ],
        rowCount: 1,
      };
    }
    if (t.startsWith('select 1')) {
      return refused?.answered ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
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
  it('moves a running Turn only from the states TURN_TRANSITIONS allows and enqueues TurnCompleted — the push is left to the caller, after its commit', async () => {
    const { client, queries } = createFakeClient({ chat_id: CHAT_ID, status: 'completed' });
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endTurn(client, WORKSPACE_ID, TURN_ID, 'completed');

    expect(result).toEqual({ turnId: TURN_ID, status: 'completed', chatId: CHAT_ID });
    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    // No refused call of the Turn's own (legacy 589): nothing about a refusal is written.
    expect(updateQuery?.values).toEqual([
      WORKSPACE_ID,
      TURN_ID,
      'completed',
      ['running'],
      false,
      null,
    ]);
    expect(updateQuery?.text).toContain("metadata ? 'stopRequestedAt'");
    expect(outboxPayload(queries)).toMatchObject({
      type: 'TurnCompleted',
      workspaceId: WORKSPACE_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      status: 'completed',
    });
    expect(received).toEqual([]);
  });

  it('reports the status the row actually landed in (a stop-requested completed lands interrupted), and publishTurnEnded pushes that status', async () => {
    const { client, queries } = createFakeClient({ chat_id: CHAT_ID, status: 'interrupted' });
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endTurn(client, WORKSPACE_ID, TURN_ID, 'completed');
    publishTurnEnded(result);

    expect(result?.status).toBe('interrupted');
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
    publishTurnEnded(result);

    expect(result).toBeUndefined();
    expect(queries.some((q) => q.text.startsWith('insert into outbox'))).toBe(false);
    expect(received).toEqual([]);
  });
});

describe('publishTurnEnded', () => {
  it('pushes nothing for a Turn without a Chat', () => {
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    publishTurnEnded({ turnId: TURN_ID, status: 'completed', chatId: null });

    expect(received).toEqual([]);
  });
});

describe('endTurn: refused model calls (legacy 589)', () => {
  const lastRefusedAt = new Date('2026-11-01T21:00:00.000Z');

  it('asks for the refusal only on a completed end, and hands the verdict to the guarded UPDATE', async () => {
    // Stop was requested: the row lands interrupted, without the refusal, so no message is written.
    const { client, queries } = createFakeClient(
      { chat_id: CHAT_ID, status: 'interrupted', model_refused: false },
      { refusedCalls: 2, scope: 'workspace_daily_cost', lastRefusedAt },
    );

    const result = await endTurn(client, WORKSPACE_ID, TURN_ID, 'completed');

    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    expect(updateQuery?.values).toEqual([
      WORKSPACE_ID,
      TURN_ID,
      'completed',
      ['running'],
      true,
      JSON.stringify({ scope: 'workspace_daily_cost', refusedCalls: 2 }),
    ]);
    // Stop intent comes first in the UPDATE itself.
    expect(updateQuery?.text.indexOf("metadata ? 'stopRequestedAt'")).toBeLessThan(
      updateQuery?.text.indexOf('$5::boolean') ?? -1,
    );
    expect(result).toEqual({ turnId: TURN_ID, status: 'interrupted', chatId: CHAT_ID });
    expect(queries.some((q) => q.text.includes('chat_messages'))).toBe(false);
  });

  it('one answered call of the Turn means it was not refused', async () => {
    const { client, queries } = createFakeClient(
      { chat_id: CHAT_ID, status: 'completed' },
      { refusedCalls: 1, scope: 'workspace_daily_tokens', lastRefusedAt, answered: true },
    );

    await endTurn(client, WORKSPACE_ID, TURN_ID, 'completed');

    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    expect(updateQuery?.values?.slice(4)).toEqual([false, null]);
  });

  it('an end other than completed never reads the usage', async () => {
    const { client, queries } = createFakeClient({ chat_id: CHAT_ID, status: 'failed' });

    await endTurn(client, WORKSPACE_ID, TURN_ID, 'failed');

    expect(queries.some((q) => q.text.includes('llm_usage'))).toBe(false);
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
  it('ends a running Turn interrupted, enqueues TurnCompleted, and returns what publishTurnEnded pushes as chat.metadata', async () => {
    const { client, queries } = createFakeClient({ chat_id: CHAT_ID, status: 'interrupted' });
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endUnknownRuntimeTurn(client, WORKSPACE_ID, CHAT_ID, TURN_ID);
    expect(received).toEqual([]);
    publishTurnEnded(result);

    expect(result).toEqual({ turnId: TURN_ID, status: 'interrupted', chatId: CHAT_ID });
    const updateQuery = queries.find((q) => q.text.startsWith('update activities'));
    expect(updateQuery?.values).toEqual([
      WORKSPACE_ID,
      TURN_ID,
      'interrupted',
      ['running'],
      false,
      null,
    ]);
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

  it('is a no-op (returns undefined, no TurnCompleted, nothing to push) when the Turn is not currently running', async () => {
    const { client, queries } = createFakeClient(undefined);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents(CHAT_ID, (e) => received.push(e));

    const result = await endUnknownRuntimeTurn(client, WORKSPACE_ID, CHAT_ID, TURN_ID);
    publishTurnEnded(result);

    expect(result).toBeUndefined();
    expect(queries.some((q) => q.text.startsWith('insert into outbox'))).toBe(false);
    expect(received).toEqual([]);
  });
});
