import { describe, expect, it } from 'vitest';
import { getCapability } from './capabilities.js';
import {
  DEFAULT_TASK_TOOL_CALLS_LIMIT,
  MAX_TASK_TOOL_CALLS_LIMIT,
  MAX_WORKER_RUN_TOOL_CALL_RECORDS,
  REPORT_TOOL_CALLS_MAX_CALLS,
  ReportToolCallsParamsSchema,
  TOOL_CALL_PAYLOAD_LEFT_OUT,
  WORKER_TOOL_CALL_ID_MAX_CHARS,
  WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS,
  boundToolCallPayload,
} from './worker-tool-calls.js';

describe('boundToolCallPayload (legacy 155)', () => {
  it('sends a payload within the bounds as it is', () => {
    const args = { command: 'uptime', timeout: 30, verbose: true, note: null, list: [1, 'two'] };
    expect(boundToolCallPayload(args, 1_000)).toEqual(args);
    expect(boundToolCallPayload('plain text', 1_000)).toBe('plain text');
    expect(boundToolCallPayload(42, 1_000)).toBe(42);
  });

  it('past the bound in all, leaves out the rest of each object and array, never cutting an item it began', () => {
    const bounded = boundToolCallPayload(
      { path: '/tmp/a', content: 'x'.repeat(100), after: 'never read', more: ['y'] },
      20,
    );
    // The object (1), `path` (4), `/tmp/a` (6) and `content` (7) leave 2: the content is begun,
    // so it is sent whole; nothing is left for `after`.
    expect(bounded).toEqual({
      path: '/tmp/a',
      content: 'x'.repeat(100),
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
    });
    expect(boundToolCallPayload(['a'.repeat(5), 'b'.repeat(5), 'c'], 8)).toEqual([
      'aaaaa',
      'bbbbb',
      TOOL_CALL_PAYLOAD_LEFT_OUT,
    ]);
  });

  it(`cuts any one string, and any key, at ${WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS} characters, past what the kernel reads of it`, () => {
    const long = 'x'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS + 1_000);
    expect(boundToolCallPayload(long)).toBe('x'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS));
    const keyed = boundToolCallPayload({ [long]: 1 }) as Record<string, unknown>;
    expect(Object.keys(keyed)).toEqual(['x'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS)]);
    // Never through a surrogate pair: the bound falls inside the emoji, which is left out whole.
    const paired = `${'a'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS - 1)}😀tail`;
    expect(boundToolCallPayload(paired)).toBe('a'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS - 1));
  });

  it('counts numbers, booleans and null by their characters, as the kernel reads them', () => {
    // The array (1), 12345 (5), true (4) and null (4) are 14: the last item does not fit.
    expect(boundToolCallPayload([12345, true, null, 'x'], 14)).toEqual([
      12345,
      true,
      null,
      TOOL_CALL_PAYLOAD_LEFT_OUT,
    ]);
  });

  it('counts every object and array, so a payload of empty ones is bounded too', () => {
    const empties = Array.from({ length: 1_000 }, () => []);
    const bounded = boundToolCallPayload(empties, 100) as unknown[];
    // The outer array (1) and 99 empty ones spend the 100.
    expect(bounded).toHaveLength(100);
    expect(bounded[99]).toBe(TOOL_CALL_PAYLOAD_LEFT_OUT);
  });

  it('sends what JSON.stringify would for a value with toJSON, and keeps a "__proto__" key as a field', () => {
    const at = new Date('2026-11-20T08:00:00.000Z');
    expect(boundToolCallPayload({ at }, 100)).toEqual({ at: '2026-11-20T08:00:00.000Z' });
    const bounded = boundToolCallPayload(JSON.parse('{"__proto__": {"polluted": true}}'), 100);
    expect(Object.getPrototypeOf(bounded)).toBe(Object.prototype);
    expect(JSON.stringify(bounded)).toBe('{"__proto__":{"polluted":true}}');
  });

  it('stops descending past its depth limit', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 40; i += 1) deep = { d: deep };
    let walked = boundToolCallPayload(deep, 10_000) as Record<string, unknown> | string;
    let levels = 0;
    while (typeof walked === 'object') {
      walked = walked.d as Record<string, unknown> | string;
      levels += 1;
    }
    expect(walked).toBe(TOOL_CALL_PAYLOAD_LEFT_OUT);
    expect(levels).toBe(32);
  });

  it('drops what is no JSON value (a function, a symbol) as JSON.stringify would', () => {
    expect(boundToolCallPayload({ keep: 1, fn: () => 1, sym: Symbol('s') }, 100)).toEqual({
      keep: 1,
    });
    expect(boundToolCallPayload([() => 1], 100)).toEqual([null]);
  });

  it("sends a pi tool result's parts the record shows — text, and the type of any other — never its details", () => {
    const result = {
      content: [
        { type: 'text', text: 'first line' },
        { type: 'image', data: 'aW1hZ2UgYnl0ZXM=', mimeType: 'image/png' },
        { type: 'text', text: 'second' },
      ],
      details: { exitCode: 0, fullOutputPath: '/tmp/out.log' },
    };
    expect(boundToolCallPayload(result, 1_000)).toEqual({
      content: [
        { type: 'text', text: 'first line' },
        { type: 'image' },
        { type: 'text', text: 'second' },
      ],
    });
  });

  it("cuts a pi result's text where the record's reading counts it: parts, a separator between them", () => {
    const result = {
      content: [
        { type: 'text', text: 'a'.repeat(10) },
        { type: 'text', text: 'b'.repeat(10) },
        { type: 'text', text: 'never sent' },
      ],
    };
    // 10, then a separator (1) and 4 of the second part's 10: 15. Nothing is left for the third.
    expect(boundToolCallPayload(result, 15)).toEqual({
      content: [
        { type: 'text', text: 'a'.repeat(10) },
        { type: 'text', text: 'b'.repeat(4) },
      ],
    });
  });

  it('reads a result whose parts carry no type as any other value', () => {
    expect(boundToolCallPayload({ content: ['plain', 1] }, 100)).toEqual({ content: ['plain', 1] });
  });
});

describe('report_tool_calls params (legacy 155)', () => {
  const call = {
    toolCallId: 'call-1',
    name: 'bash',
    outcome: 'done',
    args: { command: 'uptime' },
    result: { content: [{ type: 'text', text: 'up 3 days' }] },
    startedAt: '2026-11-20T08:00:00.000Z',
    endedAt: '2026-11-20T08:00:01.000Z',
  };

  it('takes a report of finished, failed and unfinished calls', () => {
    const parsed = ReportToolCallsParamsSchema.parse({
      calls: [
        call,
        { ...call, toolCallId: 'call-2', outcome: 'failed' },
        {
          toolCallId: 'call-3',
          name: null,
          outcome: 'not_finished',
          startedAt: null,
          endedAt: null,
        },
      ],
    });
    expect(parsed.calls).toHaveLength(3);
  });

  it(`refuses an empty report, one over ${REPORT_TOOL_CALLS_MAX_CALLS} calls, and malformed calls`, () => {
    const refused = [
      { calls: [] },
      {
        calls: Array.from({ length: REPORT_TOOL_CALLS_MAX_CALLS + 1 }, (_, i) => ({
          ...call,
          toolCallId: `call-${i}`,
        })),
      },
      { calls: [{ ...call, toolCallId: '' }] },
      { calls: [{ ...call, toolCallId: 'x'.repeat(WORKER_TOOL_CALL_ID_MAX_CHARS + 1) }] },
      { calls: [{ ...call, name: '' }] },
      { calls: [{ ...call, outcome: 'ok' }] },
      { calls: [{ ...call, startedAt: 'yesterday' }] },
      { calls: [{ ...call, workerRunId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }] },
      { calls: [call], taskId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
    ];
    for (const params of refused) {
      expect(
        ReportToolCallsParamsSchema.safeParse(params).success,
        JSON.stringify(params).slice(0, 80),
      ).toBe(false);
    }
  });

  it('says in each description the numbers the code holds it to', () => {
    // The descriptions spell the numbers out (no interpolation): this keeps them in step.
    const report = getCapability('report_tool_calls')?.description ?? '';
    expect(report).toContain(String(REPORT_TOOL_CALLS_MAX_CALLS));
    expect(report).toContain(String(MAX_WORKER_RUN_TOOL_CALL_RECORDS));
    const read = getCapability('get_task_tool_calls')?.description ?? '';
    expect(read).toContain(String(DEFAULT_TASK_TOOL_CALLS_LIMIT));
    expect(read).toContain(String(MAX_TASK_TOOL_CALLS_LIMIT));
  });
});
