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

describe('createChatEventSink — a message it could not store (legacy 128)', () => {
  function pgError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
  }

  /** A fake pool whose `chat_messages` insert always fails and whose Turn writes fail while
   *  `outage.down` is set — the sequence of statements that reached it lands in `log`. */
  function fakePool(log: string[], outage: { down: boolean }) {
    const client = {
      async query(text: string, values?: unknown[]) {
        const sql = text.trim();
        if (sql.startsWith('insert into chat_messages')) {
          log.push('insert:fail');
          throw pgError('unsupported Unicode escape sequence', '22P05');
        }
        if (sql.startsWith('update activities') && sql.includes('set metadata')) {
          if (outage.down) {
            log.push('record:fail');
            throw pgError('terminating connection due to administrator command', '57P01');
          }
          log.push(`record:count=${values?.[3]}:code=${values?.[4]}`);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('update activities')) {
          log.push(`end:${values?.[2]}`);
          return { rows: [{ chat_id: 'chat1', status: 'failed' }], rowCount: 1 };
        }
        if (sql.startsWith('COMMIT')) log.push('commit');
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    return { connect: async () => client } as unknown as PoolLike;
  }

  const message: AgentRuntimeEvent = {
    ...correlation(),
    type: 'message',
    role: 'assistant',
    content: { text: 'the answer' },
  };

  it('records the failure on the Turn and does not throw — the Turn is still the runtime’s to end', async () => {
    const log: string[] = [];
    const lines: string[] = [];
    const sink = createChatEventSink({
      pool: fakePool(log, { down: false }),
      log: (line) => lines.push(line),
    });

    await expect(sink.handle(message)).resolves.toBeUndefined();

    expect(log).toEqual(['insert:fail', 'record:count=1:code=22P05', 'commit']);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 'error', turnId: 'turn1', role: 'assistant' }),
    ]);
  });

  it('when the failure cannot be recorded yet, records it in the transaction that ends the Turn', async () => {
    const log: string[] = [];
    const outage = { down: true };
    const sink = createChatEventSink({ pool: fakePool(log, outage), log: () => {} });
    subscribeToChatPushEvents('chat1', (e) => log.push(`push:${e.type}`));

    await sink.handle(message);
    await sink.handle(message);
    outage.down = false;
    await sink.handle({ ...correlation(), type: 'turnEnded', status: 'completed' });

    expect(log).toEqual([
      'insert:fail',
      'record:fail',
      'insert:fail',
      'record:fail',
      // Both losses, before the end — so `endTurn` reads the Turn as failed, not completed.
      'record:count=2:code=22P05',
      'end:completed',
      'commit',
      'push:chat.metadata',
    ]);
  });
});
