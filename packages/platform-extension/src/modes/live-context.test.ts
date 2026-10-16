import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryContextResult } from './entry-context.js';
import { type LiveContext, installLiveContext } from './live-context.js';

/**
 * live-context.test: where the live context goes in each call (legacy 229), against a minimal
 * `ExtensionAPI` stub. What the real pi-ai request then repeats between calls — the property the
 * placement exists for — is covered end to end in `prompt-cache.sdk.test.ts`.
 */

// biome-ignore lint/suspicious/noExplicitAny: event/handler shapes vary per pi.on() overload.
type Handler = (...args: any[]) => any;
type Message = { role: string; content: unknown; timestamp: number; customType?: string };

const TITLE = 'NextTime entry context';

function user(text: string, timestamp: number): Message {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function toolTurn(timestamp: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `call-${timestamp}`, name: 'get_task', arguments: {} }],
      timestamp,
    },
    {
      role: 'toolResult',
      content: [{ type: 'text', text: `result ${timestamp}` }],
      timestamp: timestamp + 1,
    },
  ];
}

function textOf(message: Message | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

function contextIndexes(messages: readonly Message[]): number[] {
  return messages.flatMap((message, index) => (message.role === 'custom' ? [index] : []));
}

describe('installLiveContext', () => {
  let handlers: Map<string, Handler>;
  let live: LiveContext;
  let next: EntryContextResult | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handlers = new Map();
    const api = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    next = { tasks: [{ taskId: 't-1', status: 'running' }] };
    live = installLiveContext(api, {
      title: TITLE,
      customType: 'nexttime-entry-context',
      component: 'entry',
      read: async () => next,
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function call(messages: Message[]): Promise<Message[] | undefined> {
    const handler = handlers.get('context');
    if (!handler) throw new Error('context handler not registered');
    // pi hands every handler a structured clone of the history.
    const result = await handler({ type: 'context', messages: structuredClone(messages) }, {});
    return result?.messages;
  }

  it('places the context after the prompt once, then repeats it there unchanged while the run grows', async () => {
    const history = [user('What runs?', 1)];
    live.startRun();
    const first = await call(history);
    expect(first?.map((message) => message.role)).toEqual(['user', 'custom']);
    const snapshot = first?.[1];

    history.push(...toolTurn(2));
    const second = await call(history);
    expect(second?.map((message) => message.role)).toEqual([
      'user',
      'custom',
      'assistant',
      'toolResult',
    ]);
    expect(second?.[1]).toEqual(snapshot);
    expect(logSpy).toHaveBeenLastCalledWith(
      'nexttime-entry check=live_context result=reused changed=- update_chars=0',
    );
  });

  it('a section that changes mid-run goes last as an update carrying only that section; the snapshot stays put', async () => {
    next = {
      pendingApprovals: [{ actionRequestId: 'ar-1' }],
      tasks: [{ taskId: 't-1', status: 'running' }],
    };
    const history = [user('Restart it', 1)];
    live.startRun();
    const first = await call(history);

    history.push(...toolTurn(2));
    next = {
      pendingApprovals: [{ actionRequestId: 'ar-1' }],
      tasks: [{ taskId: 't-1', status: 'completed' }],
    };
    const second = await call(history);
    expect(contextIndexes(second ?? [])).toEqual([1, 4]);
    expect(second?.[1]).toEqual(first?.[1]);
    const update = textOf(second?.[4]);
    expect(update).toContain(`## ${TITLE} — update`);
    expect(update).toContain('"status":"completed"');
    expect(update).not.toContain('Pending approvals');

    // Back to what the snapshot says: no update any more.
    history.push(...toolTurn(4));
    next = {
      pendingApprovals: [{ actionRequestId: 'ar-1' }],
      tasks: [{ taskId: 't-1', status: 'running' }],
    };
    expect(contextIndexes((await call(history)) ?? [])).toEqual([1]);
  });

  it('a section that empties mid-run reads "(none now)" in the update', async () => {
    const history = [user('Status?', 1)];
    live.startRun();
    await call(history);
    history.push(...toolTurn(2));
    next = {};
    const second = await call(history);
    expect(textOf(second?.[second.length - 1])).toContain('### Running tasks\n(none now)');
  });

  it('a new run keeps an unchanged snapshot where it is (its whole history stays cached)', async () => {
    const history = [user('Turn 1', 1), ...toolTurn(2)];
    live.startRun();
    await call([history[0] as Message]);
    history.push(user('Turn 2', 10));
    live.startRun();
    const turnTwo = await call(history);
    expect(contextIndexes(turnTwo ?? [])).toEqual([1]);
    expect(turnTwo).toHaveLength(history.length + 1);
  });

  it('a new run places a changed context after the new prompt and drops the old one', async () => {
    const history = [user('Turn 1', 1)];
    live.startRun();
    await call(history);
    history.push(...toolTurn(2), user('Turn 2', 10));
    next = { tasks: [{ taskId: 't-1', status: 'completed' }] };
    live.startRun();
    const turnTwo = await call(history);
    expect(contextIndexes(turnTwo ?? [])).toEqual([history.length]);
    expect(textOf(turnTwo?.[history.length])).toContain('"status":"completed"');
    expect(textOf(turnTwo?.[history.length])).not.toContain('update');
    expect(logSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('result=placed reason=changed sections=tasks'),
    );
  });

  it('a new run whose context is empty injects nothing and forgets the snapshot', async () => {
    const history = [user('Turn 1', 1)];
    live.startRun();
    await call(history);
    history.push(user('Turn 2', 10));
    next = {};
    live.startRun();
    expect(await call(history)).toBeUndefined();
    history.push(...toolTurn(11));
    expect(await call(history)).toBeUndefined();
  });

  it('places the context again at the end when the message it followed is gone (compaction)', async () => {
    live.startRun();
    await call([user('Old prompt', 1)]);
    const compacted = [user('Summary of earlier conversation', 50), ...toolTurn(51)];
    const result = await call(compacted);
    expect(contextIndexes(result ?? [])).toEqual([compacted.length]);
    expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining('reason=anchor_lost'));
  });

  it('a failed read with no snapshot injects nothing', async () => {
    next = undefined;
    live.startRun();
    expect(await call([user('Hi', 1)])).toBeUndefined();
  });

  // #575 review must-fix, case 1: the update already said t-1 completed; a failed read must not
  // fall back to the snapshot's "running" as if it were current.
  it('a failed read mid-run keeps the snapshot in place and repeats the last update under a not-refreshed notice', async () => {
    const history = [user('Restart it', 1)];
    live.startRun();
    const first = await call(history);
    history.push(...toolTurn(2));
    next = { tasks: [{ taskId: 't-1', status: 'completed' }] };
    const second = await call(history);
    const update = textOf(second?.[second.length - 1]);

    history.push(...toolTurn(4));
    next = undefined;
    const third = await call(history);
    expect(contextIndexes(third ?? [])).toEqual([1, history.length + 1]);
    expect(third?.[1]).toEqual(first?.[1]);
    const notice = textOf(third?.[third.length - 1]);
    expect(notice).toContain(`## ${TITLE} — not refreshed`);
    expect(notice).toContain('may be out of date');
    expect(notice).toContain(update);
    expect(notice).toContain('"status":"completed"');
    expect(errorSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('nexttime-entry check=live_context result=kept_on_read_error'),
    );
  });

  // #575 review must-fix, case 2: a new run whose first read fails must not present the previous
  // run's snapshot (an approval report_turn may already have acknowledged) as current.
  it('a failed read at the start of a run marks the previous snapshot as not refreshed', async () => {
    next = { pendingApprovals: [{ actionRequestId: 'ar-1' }] };
    const history = [user('Turn 1', 1)];
    live.startRun();
    await call(history);
    history.push(...toolTurn(2), user('Turn 2', 10));
    live.startRun();
    next = undefined;
    const result = await call(history);
    expect(contextIndexes(result ?? [])).toEqual([1, history.length + 1]);
    const notice = textOf(result?.[result.length - 1]);
    expect(notice).toContain('not refreshed');
    expect(notice).toContain(`The ${TITLE} above is from an earlier call`);
    expect(notice).not.toContain('— update');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'oops'],
  ])('a result that is %s counts as a failed read', async (_label, value) => {
    const history = [user('Hi', 1)];
    live.startRun();
    await call(history);
    history.push(...toolTurn(2));
    next = value as unknown as EntryContextResult;
    const result = await call(history);
    expect(textOf(result?.[result.length - 1])).toContain('not refreshed');
  });

  it('a field of the wrong type renders as an empty section instead of throwing', async () => {
    next = { tasks: 'not-a-list' as unknown as unknown[], pendingApprovals: [{ id: 'ar-1' }] };
    live.startRun();
    const result = await call([user('Hi', 1)]);
    expect(textOf(result?.[1])).toContain('Pending approvals');
    expect(textOf(result?.[1])).not.toContain('Running tasks');
  });

  it('after a successful read the not-refreshed notice is gone', async () => {
    const history = [user('Hi', 1)];
    live.startRun();
    await call(history);
    history.push(...toolTurn(2));
    next = undefined;
    await call(history);
    history.push(...toolTurn(4));
    next = { tasks: [{ taskId: 't-1', status: 'running' }] };
    expect(contextIndexes((await call(history)) ?? [])).toEqual([1]);
  });

  it('a run whose first read fails still decides at its first successful read', async () => {
    const history = [user('Turn 1', 1)];
    live.startRun();
    await call(history);
    history.push(user('Turn 2', 10));
    live.startRun();
    next = undefined;
    await call(history);
    next = { tasks: [{ taskId: 't-2' }] };
    const result = await call(history);
    expect(contextIndexes(result ?? [])).toEqual([history.length]);
  });

  it('the same change in the middle of a run is not placed again (only a run start moves the snapshot)', async () => {
    const history = [user('Turn 1', 1)];
    live.startRun();
    await call(history);
    history.push(...toolTurn(2));
    next = { tasks: [{ taskId: 't-1', status: 'completed' }] };
    const result = await call(history);
    expect(contextIndexes(result ?? [])).toEqual([1, history.length + 1]);
  });
});
