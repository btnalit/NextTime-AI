import { describe, expect, it } from 'vitest';
import { getCapability } from './capabilities.js';
import {
  MAX_SECRET_LITERALS,
  MAX_SECRET_LITERAL_CHARS,
  SECRET_FIELD_NAME_JUDGED_CHARS,
  secretFieldLiterals,
} from './secret-field-name.js';
import { toolCallSecretKeyRule } from './tool-call-secrets.js';
import {
  DEFAULT_TASK_TOOL_CALLS_LIMIT,
  MAX_TASK_TOOL_CALLS_LIMIT,
  MAX_WORKER_RUN_TOOL_CALL_RECORDS,
  REPORT_TOOL_CALLS_MAX_CALLS,
  ReportToolCallsParamsSchema,
  TOOL_CALL_PAYLOAD_LEFT_OUT,
  WORKER_TOOL_CALL_ID_MAX_CHARS,
  WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS,
  boundToolCallArgs,
  boundToolCallResult,
} from './worker-tool-calls.js';

describe('boundToolCallArgs / boundToolCallResult (legacy 155)', () => {
  it('sends a payload within the bounds as it is', () => {
    const args = { command: 'uptime', timeout: 30, verbose: true, note: null, list: [1, 'two'] };
    expect(boundToolCallArgs(args, { maxChars: 1_000 })).toEqual(args);
    expect(boundToolCallArgs('plain text', { maxChars: 1_000 })).toBe('plain text');
    expect(boundToolCallArgs(42, { maxChars: 1_000 })).toBe(42);
  });

  it('past the bound in all, leaves out the rest of each object and array, never cutting an item it began', () => {
    const bounded = boundToolCallArgs(
      { path: '/tmp/a', content: 'x'.repeat(100), after: 'never read', more: ['y'] },
      { maxChars: 20 },
    );
    // The object (1), `path` (4), `/tmp/a` (6) and `content` (7) leave 2: the content is begun,
    // so it is sent whole; nothing is left for `after`.
    expect(bounded).toEqual({
      path: '/tmp/a',
      content: 'x'.repeat(100),
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
    });
    expect(boundToolCallArgs(['a'.repeat(5), 'b'.repeat(5), 'c'], { maxChars: 8 })).toEqual([
      'aaaaa',
      'bbbbb',
      TOOL_CALL_PAYLOAD_LEFT_OUT,
    ]);
  });

  it(`cuts any one string, and any key, at ${WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS} characters, past what the kernel reads of it`, () => {
    const long = 'x'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS + 1_000);
    expect(boundToolCallArgs(long)).toBe('x'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS));
    const keyed = boundToolCallArgs({ [long]: 1 }) as Record<string, unknown>;
    expect(Object.keys(keyed)).toEqual(['x'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS)]);
    // Never through a surrogate pair: the bound falls inside the emoji, which is left out whole.
    const paired = `${'a'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS - 1)}😀tail`;
    expect(boundToolCallArgs(paired)).toBe('a'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS - 1));
  });

  it('counts numbers, booleans and null by their characters, as the kernel reads them', () => {
    // The array (1), 12345 (5), true (4) and null (4) are 14: the last item does not fit.
    expect(boundToolCallArgs([12345, true, null, 'x'], { maxChars: 14 })).toEqual([
      12345,
      true,
      null,
      TOOL_CALL_PAYLOAD_LEFT_OUT,
    ]);
  });

  it('counts every object and array, so a payload of empty ones is bounded too', () => {
    const empties = Array.from({ length: 1_000 }, () => []);
    const bounded = boundToolCallArgs(empties, { maxChars: 100 }) as unknown[];
    // The outer array (1) and 99 empty ones spend the 100.
    expect(bounded).toHaveLength(100);
    expect(bounded[99]).toBe(TOOL_CALL_PAYLOAD_LEFT_OUT);
  });

  it('sends what JSON.stringify would for a value with toJSON, and keeps a "__proto__" key as a field', () => {
    const at = new Date('2026-11-20T08:00:00.000Z');
    expect(boundToolCallArgs({ at }, { maxChars: 100 })).toEqual({
      at: '2026-11-20T08:00:00.000Z',
    });
    const bounded = boundToolCallArgs(JSON.parse('{"__proto__": {"polluted": true}}'), {
      maxChars: 100,
    });
    expect(Object.getPrototypeOf(bounded)).toBe(Object.prototype);
    expect(JSON.stringify(bounded)).toBe('{"__proto__":{"polluted":true}}');
  });

  it('stops descending past its depth limit', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 40; i += 1) deep = { d: deep };
    let walked = boundToolCallArgs(deep, { maxChars: 10_000 }) as Record<string, unknown> | string;
    let levels = 0;
    while (typeof walked === 'object') {
      walked = walked.d as Record<string, unknown> | string;
      levels += 1;
    }
    expect(walked).toBe(TOOL_CALL_PAYLOAD_LEFT_OUT);
    expect(levels).toBe(32);
  });

  it('drops what is no JSON value (a function, a symbol) as JSON.stringify would', () => {
    expect(
      boundToolCallArgs({ keep: 1, fn: () => 1, sym: Symbol('s') }, { maxChars: 100 }),
    ).toEqual({
      keep: 1,
    });
    expect(boundToolCallArgs([() => 1], { maxChars: 100 })).toEqual([null]);
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
    expect(boundToolCallResult(result, 1_000)).toEqual({
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
    expect(boundToolCallResult(result, 15)).toEqual({
      content: [
        { type: 'text', text: 'a'.repeat(10) },
        { type: 'text', text: 'b'.repeat(4) },
      ],
    });
  });

  it('reads a result whose parts carry no type as any other value', () => {
    expect(boundToolCallResult({ content: ['plain', 1] }, 100)).toEqual({ content: ['plain', 1] });
  });
});

describe("boundToolCallArgs keeps the arguments' secret values the kernel hides in the result (legacy 155, #501 F1)", () => {
  const rule = toolCallSecretKeyRule('bash');

  it('keeps a secret value past the bound where it was, after the `[…]` that left the rest out', () => {
    const args = { blob: 'x'.repeat(100), note: 'left out', password: 'hunter22' };
    expect(boundToolCallArgs(args, { isSecretKey: rule, maxChars: 20 })).toEqual({
      blob: 'x'.repeat(100),
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
      password: 'hunter22',
    });
    // Without the rule (a call sent without its result) nothing is kept.
    expect(boundToolCallArgs(args, { maxChars: 20 })).toEqual({
      blob: 'x'.repeat(100),
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
    });
  });

  it('keeps one whose key spent the bound, and the way to one in a left-out object or array', () => {
    // The object (1), `a` (1) and its 10 leave 8, which `password` spends: its value is kept.
    expect(
      boundToolCallArgs(
        { a: 'x'.repeat(10), password: 'hunter22' },
        { isSecretKey: rule, maxChars: 20 },
      ),
    ).toEqual({ a: 'x'.repeat(10), password: 'hunter22' });
    const nested = {
      data: { rows: Array.from({ length: 50 }, (_, i) => `row ${i}`) },
      auth: { user: 'svc', secret: 'abcd1234', extra: ['x', { token: 'tok-5678' }] },
      items: ['plain', { headers: { authorization: 'Basic dXNlcjpwYXNz' } }],
    };
    expect(boundToolCallArgs(nested, { isSecretKey: rule, maxChars: 40 })).toEqual({
      data: {
        rows: ['row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5', TOOL_CALL_PAYLOAD_LEFT_OUT],
      },
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
      // Under a secret key every value is one (the kernel's field rule); `user` is not.
      auth: { secret: 'abcd1234', extra: [{ token: 'tok-5678' }] },
      items: [{ headers: { authorization: 'Basic dXNlcjpwYXNz' } }],
    });
  });

  it('keeps exactly the values the kernel collects from the whole arguments', () => {
    const tooShort = { blob: 'x'.repeat(100), password: 'abc' };
    const tooLong = { blob: 'x'.repeat(100), password: 'p'.repeat(MAX_SECRET_LITERAL_CHARS + 1) };
    for (const args of [tooShort, tooLong]) {
      expect(boundToolCallArgs(args, { isSecretKey: rule, maxChars: 20 })).toEqual({
        blob: 'x'.repeat(100),
        [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
      });
    }
    // More than it collects: the kernel's walk meets the last written first, and keeps 64.
    const many = {
      blob: 'x'.repeat(100),
      secrets: Array.from({ length: 80 }, (_, i) => `secret-${String(i).padStart(2, '0')}`),
    };
    const sent = boundToolCallArgs(many, { isSecretKey: rule, maxChars: 20 }) as {
      secrets: unknown[];
    };
    // Only what is on the way is kept: `secrets` was left out whole, so it holds them alone.
    expect(sent.secrets).toEqual(many.secrets.slice(80 - MAX_SECRET_LITERALS));
    expect(secretFieldLiterals(sent, rule).sort()).toEqual(secretFieldLiterals(many, rule).sort());
  });

  it('keeps one past the depth limit, and cuts a key on the way to the start the key rule judges', () => {
    let deep: unknown = { password: 'hunter22' };
    for (let i = 0; i < 40; i += 1) deep = { d: deep, pad: 'p' };
    let walked = boundToolCallArgs(deep, { isSecretKey: rule }) as Record<string, unknown>;
    for (let i = 0; i < 40; i += 1) walked = walked.d as Record<string, unknown>;
    expect(walked).toEqual({ password: 'hunter22' });

    const longKey = `api_key_${'k'.repeat(SECRET_FIELD_NAME_JUDGED_CHARS)}`;
    const keyed = boundToolCallArgs(
      { blob: 'x'.repeat(100), [longKey]: 'hunter22' },
      { isSecretKey: rule, maxChars: 20 },
    ) as Record<string, unknown>;
    expect(keyed[longKey.slice(0, SECRET_FIELD_NAME_JUDGED_CHARS)]).toBe('hunter22');
    // Two that start alike both stay, the second numbered after the start.
    const alike = boundToolCallArgs(
      { blob: 'x'.repeat(100), [`${longKey}-a`]: 'hunter22', [`${longKey}-b`]: 'hunter33' },
      { isSecretKey: rule, maxChars: 20 },
    );
    const start = longKey.slice(0, SECRET_FIELD_NAME_JUDGED_CHARS);
    expect(alike).toEqual({
      blob: 'x'.repeat(100),
      [TOOL_CALL_PAYLOAD_LEFT_OUT]: TOOL_CALL_PAYLOAD_LEFT_OUT,
      [start]: 'hunter22',
      [`${start} 2`]: 'hunter33',
    });
    expect(secretFieldLiterals(alike, rule)).toEqual(['hunter22', 'hunter33'].sort().reverse());
  });

  it('bounds arguments shaped like a pi result as any other value', () => {
    const args = { content: [{ type: 'text', text: 'note' }], password: 'hunter22' };
    expect(boundToolCallArgs(args, { isSecretKey: rule, maxChars: 1_000 })).toEqual(args);
  });

  it("toolCallSecretKeyRule: a capability tool's declared keys, and every secret-named one", () => {
    const declared = getCapability('create_user')?.redactedParamKeys ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const createUser = toolCallSecretKeyRule('create_user');
    for (const key of declared) expect(createUser(key)).toBe(true);
    expect(createUser('displayName')).toBe(false);
    expect(rule('apiKey')).toBe(true);
    expect(rule('command')).toBe(false);
    expect(toolCallSecretKeyRule(null)('GITHUB_TOKEN')).toBe(true);
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
