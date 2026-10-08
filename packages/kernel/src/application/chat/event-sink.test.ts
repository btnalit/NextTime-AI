import { afterEach, describe, expect, it } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { AgentRuntimeEvent } from '../host-bridge/index.js';
import { createChatEventSink } from './event-sink.js';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import type { ChatPushEvent } from './push.js';

/** Unit tests for createChatEventSink — the ephemeral (textDelta/toolCallStarted/toolCallEnded)
 *  branch is pure in-memory, no DB (it never opens a pool transaction); the turnEnded case uses a
 *  fake pool that records the order of its UPDATE, COMMIT and the push. */

afterEach(() => {
  _resetChatPushEventsForTests();
});

const DEPS = { pool: {} as PoolLike };

function correlation() {
  return { workspaceId: 'ws1', chatId: 'chat1', turnId: 'turn1', principalId: 'p1' };
}

describe('createChatEventSink — toolCallEnded.isError', () => {
  it('publishes a chat.stream payload carrying isError when the event has one', async () => {
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => received.push(e));
    const sink = createChatEventSink(DEPS);

    const event: AgentRuntimeEvent = {
      ...correlation(),
      type: 'toolCallEnded',
      toolCallId: 'tc1',
      result: { ok: false },
      isError: true,
    };
    await sink.handle(event);

    expect(received).toEqual([
      {
        type: 'chat.stream',
        chatId: 'chat1',
        turnId: 'turn1',
        payload: {
          streamKind: 'toolCallEnded',
          toolCallId: 'tc1',
          result: { ok: false },
          isError: true,
        },
      },
    ]);
  });

  it('omits isError from the payload when the event does not carry one', async () => {
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => received.push(e));
    const sink = createChatEventSink(DEPS);

    const event: AgentRuntimeEvent = {
      ...correlation(),
      type: 'toolCallEnded',
      toolCallId: 'tc1',
      result: { ok: true },
    };
    await sink.handle(event);

    expect(received).toEqual([
      {
        type: 'chat.stream',
        chatId: 'chat1',
        turnId: 'turn1',
        payload: { streamKind: 'toolCallEnded', toolCallId: 'tc1', result: { ok: true } },
      },
    ]);
  });
});

describe('createChatEventSink — turnEnded pushes only after its transaction commits', () => {
  it('commits the Turn end before chat.metadata tells a client it ended', async () => {
    const log: string[] = [];
    const client = {
      async query(text: string) {
        const sql = text.trim();
        if (sql.startsWith('update activities')) {
          log.push('update');
          return { rows: [{ chat_id: 'chat1', status: 'completed' }], rowCount: 1 };
        }
        if (sql.startsWith('COMMIT')) log.push('commit');
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as PoolLike;
    subscribeToChatPushEvents('chat1', (e) => log.push(`push:${e.type}`));

    await createChatEventSink({ pool }).handle({
      ...correlation(),
      type: 'turnEnded',
      status: 'completed',
    });

    expect(log).toEqual(['update', 'commit', 'push:chat.metadata']);
  });
});
