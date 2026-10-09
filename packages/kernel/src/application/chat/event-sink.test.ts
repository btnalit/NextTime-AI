import { ToolCallMessageContentSchema } from '@nexttime/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { AgentRuntimeEvent } from '../host-bridge/index.js';
import { MAX_TOOL_CALL_RECORDS_PER_TURN, createChatEventSink } from './event-sink.js';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import type { ChatPushEvent } from './push.js';

/** Unit tests for createChatEventSink — `textDelta` is pure in-memory, no DB; the tool events also
 *  store a tool-call record, and the turnEnded case records the order of its UPDATE, COMMIT and
 *  the push, both through fake pools. */

afterEach(() => {
  _resetChatPushEventsForTests();
});

/** A Handle-shaped compact JWT. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';

function correlation() {
  return { workspaceId: 'ws1', chatId: 'chat1', turnId: 'turn1', principalId: 'p1' };
}

interface StoredToolRow {
  readonly sequence: number;
  readonly content: Record<string, unknown>;
}

/** A fake pool that stores tool-call records (`insertToolCallMessage`'s INSERT) in `rows` — or
 *  fails them while `outage.down` — and logs every statement kind in `log`. A record for a
 *  `toolCallId` already stored inserts nothing, like the real `where not exists`. */
function toolRecordPool(log: string[], outage = { down: false }) {
  const rows: StoredToolRow[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      const sql = text.trim();
      if (sql.startsWith('insert into chat_messages') && sql.includes("'tool'")) {
        if (outage.down) {
          log.push('tool-insert:fail');
          throw Object.assign(new Error('connection refused'), { code: '08006' });
        }
        const content = JSON.parse(String(values?.[3])) as Record<string, unknown>;
        if (rows.some((row) => row.content.toolCallId === values?.[4])) {
          log.push(`tool-insert:dup:${String(values?.[4])}`);
          return { rows: [], rowCount: 0 };
        }
        const sequence = rows.length + 1;
        rows.push({ sequence, content });
        log.push(`tool-insert:${String(content.toolCallId)}:${String(content.outcome)}`);
        return {
          rows: [
            {
              workspace_id: 'ws1',
              id: `msg-${sequence}`,
              chat_id: 'chat1',
              turn_id: 'turn1',
              role: 'tool',
              content,
              sequence: String(sequence),
              created_at: new Date('2026-10-09T12:00:00Z'),
              source_outbox_id: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith('update activities')) {
        log.push('end');
        return { rows: [{ chat_id: 'chat1', status: 'completed' }], rowCount: 1 };
      }
      if (sql.startsWith('COMMIT')) log.push('commit');
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as PoolLike, rows };
}

const DEPS = { pool: toolRecordPool([]).pool, log: () => {} };

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

    expect(received[0]).toEqual({
      type: 'chat.stream',
      chatId: 'chat1',
      turnId: 'turn1',
      payload: {
        streamKind: 'toolCallEnded',
        toolCallId: 'tc1',
        result: { ok: false },
        isError: true,
      },
    });
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

    expect(received[0]).toEqual({
      type: 'chat.stream',
      chatId: 'chat1',
      turnId: 'turn1',
      payload: { streamKind: 'toolCallEnded', toolCallId: 'tc1', result: { ok: true } },
    });
  });
});

describe('createChatEventSink — a Turn’s tool calls are stored, redacted (tool-call records)', () => {
  const started = (toolCallId: string, name: string, args: unknown): AgentRuntimeEvent => ({
    ...correlation(),
    type: 'toolCallStarted',
    toolCallId,
    name,
    args,
  });
  const ended = (toolCallId: string, result: unknown, extra = {}): AgentRuntimeEvent => ({
    ...correlation(),
    type: 'toolCallEnded',
    toolCallId,
    result,
    ...extra,
  });
  const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

  it('stores one record per finished call and pushes it after the stream delta', async () => {
    const log: string[] = [];
    const { pool, rows } = toolRecordPool(log);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => received.push(e));
    const sink = createChatEventSink({ pool, log: () => {} });

    await sink.handle(started('tc1', 'list_facts', { linkType: 'depends_on' }));
    await sink.handle(ended('tc1', text('{"items":[]}')));

    expect(log).toEqual(['tool-insert:tc1:done', 'commit']);
    expect(ToolCallMessageContentSchema.parse(rows[0]?.content)).toMatchObject({
      name: 'list_facts',
      outcome: 'done',
      args: { text: '{"linkType":"depends_on"}' },
      result: { text: '{"items":[]}' },
    });
    expect(received.map((e) => (e.type === 'chat.stream' ? e.payload.streamKind : e.type))).toEqual(
      ['toolCallStarted', 'toolCallEnded', 'chat.message'],
    );
    expect(received[2]).toMatchObject({
      type: 'chat.message',
      message: { role: 'tool', kind: 'tool_call', text: 'list_facts', turnId: 'turn1' },
    });
  });

  it('redacts the live stream too: a Handle a bash call printed never leaves the kernel', async () => {
    const { pool, rows } = toolRecordPool([]);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => received.push(e));
    const sink = createChatEventSink({ pool, log: () => {} });

    await sink.handle(
      started('tc1', 'bash', { command: `curl -H "Authorization: Bearer ${HANDLE}"` }),
    );
    await sink.handle(ended('tc1', text(`CAPABILITY_HANDLE=${HANDLE}`)));

    expect(JSON.stringify(received)).not.toContain('eyJhbGci');
    expect(JSON.stringify(rows)).not.toContain('eyJhbGci');
    expect(received[1]).toMatchObject({
      payload: { result: { content: [{ type: 'text', text: 'CAPABILITY_HANDLE=[redacted]' }] } },
    });
  });

  it('a call whose start it never saw is recorded under the name its end carries, without args', async () => {
    const { pool, rows } = toolRecordPool([]);
    const sink = createChatEventSink({ pool, log: () => {} });

    await sink.handle(ended('tc9', text('boom'), { name: 'traverse', isError: true }));

    expect(rows[0]?.content).toMatchObject({
      name: 'traverse',
      outcome: 'failed',
      startedAt: null,
    });
    expect(rows[0]?.content).not.toHaveProperty('args');
  });

  it('records a call still open when the Turn ends as not_finished, before the Turn’s end', async () => {
    const log: string[] = [];
    const { pool, rows } = toolRecordPool(log);
    const sink = createChatEventSink({ pool, log: () => {} });

    await sink.handle(started('tc1', 'invoke_worker', { workerDefinitionId: 'w1' }));
    await sink.handle({ ...correlation(), type: 'turnEnded', status: 'interrupted' });

    expect(log).toEqual(['tool-insert:tc1:not_finished', 'commit', 'end', 'commit']);
    expect(rows[0]?.content).toMatchObject({ outcome: 'not_finished' });
    expect(rows[0]?.content).not.toHaveProperty('result');
  });

  it('a record it cannot store is logged and skipped — the Turn still ends as the runtime says', async () => {
    const log: string[] = [];
    const lines: string[] = [];
    const outage = { down: true };
    const { pool } = toolRecordPool(log, outage);
    const sink = createChatEventSink({ pool, log: (line) => lines.push(line) });

    await expect(sink.handle(started('tc1', 'search', {}))).resolves.toBeUndefined();
    await expect(sink.handle(ended('tc1', text('[]')))).resolves.toBeUndefined();
    outage.down = false;
    await sink.handle({ ...correlation(), type: 'turnEnded', status: 'completed' });

    // No Turn metadata write: unlike a lost reply, a lost tool record does not fail the Turn.
    expect(log).toEqual(['tool-insert:fail', 'end', 'commit']);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 'error', turnId: 'turn1', toolCallIds: ['tc1'] }),
    ]);
  });

  it('a replayed end stores nothing new and pushes nothing new', async () => {
    const log: string[] = [];
    const { pool } = toolRecordPool(log);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => received.push(e));
    const sink = createChatEventSink({ pool, log: () => {} });

    await sink.handle(ended('tc1', text('a'), { name: 'search' }));
    await sink.handle(ended('tc1', text('a'), { name: 'search' }));

    expect(log).toEqual(['tool-insert:tc1:done', 'commit', 'tool-insert:dup:tc1', 'commit']);
    expect(received.filter((e) => e.type === 'chat.message')).toHaveLength(1);
  });

  it(`stores at most ${MAX_TOOL_CALL_RECORDS_PER_TURN} records per Turn and says so once`, async () => {
    const { pool, rows } = toolRecordPool([]);
    const lines: string[] = [];
    const sink = createChatEventSink({ pool, log: (line) => lines.push(line) });

    for (let index = 0; index < MAX_TOOL_CALL_RECORDS_PER_TURN + 5; index += 1) {
      await sink.handle(ended(`tc${index}`, text('x'), { name: 'search' }));
    }

    expect(rows).toHaveLength(MAX_TOOL_CALL_RECORDS_PER_TURN);
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(['warn']);
  });
});

describe('createChatEventSink — live text is scrubbed across deltas', () => {
  function liveText(received: readonly ChatPushEvent[]): string[] {
    return received.flatMap((e) =>
      e.type === 'chat.stream' && e.payload.streamKind === 'textDelta' ? [e.payload.delta] : [],
    );
  }
  const delta = (value: string): AgentRuntimeEvent => ({
    ...correlation(),
    type: 'textDelta',
    delta: value,
  });

  it('a Handle split across deltas never goes out; what is held goes out, scrubbed, before the next event', async () => {
    const { pool } = toolRecordPool([]);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => received.push(e));
    const lines: string[] = [];
    const sink = createChatEventSink({ pool, log: (line) => lines.push(line) });

    for (const piece of [
      '我的 Handle 是 ',
      HANDLE.slice(0, 25),
      HANDLE.slice(25, 60),
      HANDLE.slice(60),
    ]) {
      await sink.handle(delta(piece));
    }
    await sink.handle(delta(' ，别外传'));
    await sink.handle({
      ...correlation(),
      type: 'toolCallStarted',
      toolCallId: 'tc1',
      name: 'list_facts',
      args: {},
    });

    expect(JSON.stringify(received)).not.toContain('eyJ');
    expect(liveText(received).join('')).toBe('我的 Handle 是 [redacted] ，别外传');
    const kinds = received.map((e) => (e.type === 'chat.stream' ? e.payload.streamKind : e.type));
    expect(kinds.at(-1)).toBe('toolCallStarted');
    expect(lines.some((line) => line.includes('live text of a Turn'))).toBe(true);
  });

  it('CAPABILITY_HANDLE= in one delta and its value in the next', async () => {
    const { pool } = toolRecordPool([]);
    const received: ChatPushEvent[] = [];
    subscribeToChatPushEvents('chat1', (e) => received.push(e));
    const sink = createChatEventSink({ pool, log: () => {} });

    await sink.handle(delta('env says CAPABILITY_HANDLE='));
    await sink.handle(delta(`${HANDLE}\nHOME=/workspace`));
    // The Turn's end emits what is held before anything else (this fake pool has no Turn to end).
    await Promise.resolve(
      sink.handle({ ...correlation(), type: 'turnEnded', status: 'completed' }),
    ).catch(() => {});

    expect(liveText(received).join('')).toBe(
      'env says CAPABILITY_HANDLE=[redacted]\nHOME=/workspace',
    );
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
