import { afterEach, describe, expect, it } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { AgentRuntimeEvent } from '../host-bridge/index.js';
import { createChatEventSink } from './event-sink.js';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import type { ChatPushEvent } from './push.js';

/** Unit test for the ephemeral (textDelta/toolCallStarted/toolCallEnded) branch of
 *  createChatEventSink — pure in-memory, no DB (this branch never opens a pool transaction). */

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
