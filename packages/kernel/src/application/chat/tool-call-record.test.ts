import { ToolCallMessageContentSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { REDACTED, scrubSecretValues } from '../../governance/redaction/index.js';
import {
  MESSAGE_TEXT_MAX_CHARS,
  TOOL_CALL_ARGS_PREVIEW_CHARS,
  TOOL_CALL_RESULT_PREVIEW_CHARS,
  buildToolCallRecord,
  redactMessageContent,
  redactToolArgs,
  redactToolResult,
  rescrubStoredToolCallResult,
} from './tool-call-record.js';

/** A Handle-shaped compact JWT (header `{"alg":"EdDSA"}`). Synthetic — `.gitleaks.toml` allows
 *  this signature segment. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], details: {} };
}

function record(overrides: Partial<Parameters<typeof buildToolCallRecord>[0]> = {}) {
  return buildToolCallRecord({
    toolCallId: 'call_1',
    name: 'bash',
    outcome: 'done',
    hasArgs: false,
    hasResult: false,
    startedAt: new Date('2026-10-09T12:00:00Z'),
    endedAt: new Date('2026-10-09T12:00:01Z'),
    ...overrides,
  });
}

describe('redactToolArgs — values that are secrets wherever they appear', () => {
  it('replaces an agent’s own Handle in an `env` dump, once', () => {
    const { value, redactedValues } = redactToolArgs(
      `HOME=/workspace\nCAPABILITY_HANDLE=${HANDLE}\nKERNEL_URL=http://kernel:8080`,
    );
    expect(value).toBe(
      `HOME=/workspace\nCAPABILITY_HANDLE=${REDACTED}\nKERNEL_URL=http://kernel:8080`,
    );
    expect(redactedValues).toBe(1);
  });

  it.each([
    ['a bare JWT', `token is ${HANDLE} ok`, `token is ${REDACTED} ok`],
    ['a Bearer value', 'use Bearer abc.def-123456 here', `use Bearer ${REDACTED} here`],
    ['an Authorization header', 'Authorization: token abc123def', `Authorization: ${REDACTED}`],
    [
      'a PEM private key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----\nrest',
      `${REDACTED}\nrest`,
    ],
    ['a vendor key', 'key sk-ant-api03-abcdefghijklmnopqrstuv end', `key ${REDACTED} end`],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123', REDACTED],
    // Redaction boundary stage 1b: a bare value at the head of a line with more after it is read
    // to the end of the line.
    ['an upper-case env secret', 'PGPASSWORD=hunter2 psql', `PGPASSWORD=${REDACTED}`],
    [
      'a query-string secret',
      '/login?user=a&password=hunter2&x=1',
      `/login?user=a&password=${REDACTED}&x=1`,
    ],
    [
      'a URL password',
      'postgres://nexttime:s3cret@db:5432/x',
      `postgres://nexttime:${REDACTED}@db:5432/x`,
    ],
    ['a quoted JSON pair', '{"api_key": "abc123", "n": 1}', `{"api_key": "${REDACTED}", "n": 1}`],
  ])('replaces %s', (_label, input, expected) => {
    expect(redactToolArgs(input).value).toBe(expected);
  });

  it('leaves ordinary text alone — including names that only contain a secret word', () => {
    const text = 'max_tokens=1024; the depends_on edge kernel → postgres; tokenCount 3';
    expect(redactToolArgs(text)).toEqual({ value: text, redactedValues: 0, omitted: false });
  });
});

describe('redactToolArgs — structured arguments', () => {
  it('replaces every value under a secret-named key and a capability’s declared secret params, keeping the shape', () => {
    const { value, redactedValues } = redactToolArgs(
      {
        gatekeeperKind: 'http',
        connectionSecret: 'from-mint',
        credentials: { user: 'u', pass: 'p' },
        nested: [{ password: 'x', note: `use ${HANDLE}` }],
      },
      'create_connection',
    );
    expect(value).toEqual({
      gatekeeperKind: 'http',
      connectionSecret: REDACTED,
      credentials: { user: REDACTED, pass: REDACTED },
      nested: [{ password: REDACTED, note: `use ${REDACTED}` }],
    });
    expect(redactedValues).toBe(5);
  });

  it('reads a huge value only up to its bounds — what is past them is left out, never shown unscrubbed', () => {
    const wide = Array.from({ length: 6_000 }, (_, index) => ({ index }));
    wide.push({ index: -1, note: HANDLE } as { index: number });
    const walked = redactToolArgs(wide);
    expect(walked.omitted).toBe(true);
    expect(JSON.stringify(walked.value)).not.toContain('eyJhbGci');
    const long = redactToolArgs({ command: `${'y'.repeat(20_000)} ${HANDLE}` });
    expect(long.omitted).toBe(true);
    expect(JSON.stringify(long.value)).not.toContain('eyJhbGci');
  });
});

describe('buildToolCallRecord', () => {
  it('records a capability call: its args as JSON, its result as the text the model saw', () => {
    const content = record({
      name: 'list_facts',
      args: { linkType: 'depends_on' },
      hasArgs: true,
      result: textResult('{\n  "items": []\n}'),
      hasResult: true,
    });
    expect(ToolCallMessageContentSchema.parse(content)).toEqual({
      kind: 'tool_call',
      text: 'list_facts',
      toolCallId: 'call_1',
      name: 'list_facts',
      outcome: 'done',
      args: { text: '{"linkType":"depends_on"}', totalChars: 25, truncated: false },
      result: { text: '{\n  "items": []\n}', totalChars: 17, truncated: false },
      redactedValues: 0,
      startedAt: '2026-10-09T12:00:00.000Z',
      endedAt: '2026-10-09T12:00:01.000Z',
    });
  });

  it('never stores the Handle a bash call printed', () => {
    const content = record({
      args: { command: 'env' },
      hasArgs: true,
      result: textResult(`PATH=/usr/bin\nCAPABILITY_HANDLE=${HANDLE}`),
      hasResult: true,
    });
    expect(JSON.stringify(content)).not.toContain('eyJhbGci');
    expect(content.result?.text).toBe(`PATH=/usr/bin\nCAPABILITY_HANDLE=${REDACTED}`);
    expect(content.redactedValues).toBe(1);
  });

  it('cuts a long result after redacting it, so no secret is half-kept at the cut', () => {
    const filler = 'x'.repeat(TOOL_CALL_RESULT_PREVIEW_CHARS - 10);
    const content = record({ result: textResult(`${filler} ${HANDLE}`), hasResult: true });
    expect(content.result).toEqual({
      text: `${filler} ${REDACTED}`.slice(0, TOOL_CALL_RESULT_PREVIEW_CHARS),
      totalChars: filler.length + 1 + HANDLE.length,
      truncated: true,
    });
    expect(content.result?.text).not.toContain('eyJ');
  });

  it('reads a huge result only as far as its preview needs, and says how long it was', () => {
    const huge = `${'z'.repeat(5_000_000)} ${HANDLE}`;
    const started = performance.now();
    const content = record({ result: textResult(huge), hasResult: true });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(content.result).toEqual({
      text: 'z'.repeat(TOOL_CALL_RESULT_PREVIEW_CHARS),
      totalChars: huge.length,
      truncated: true,
    });
  });

  it('cuts long args to their own, smaller preview', () => {
    const content = record({ args: { command: 'y'.repeat(10_000) }, hasArgs: true });
    expect(content.args?.text).toHaveLength(TOOL_CALL_ARGS_PREVIEW_CHARS);
    expect(content.args?.truncated).toBe(true);
  });

  it('shows a result with no text parts as redacted JSON, and a non-text part by its type', () => {
    expect(
      record({ result: { details: { password: 'p', rows: 2 } }, hasResult: true }).result?.text,
    ).toBe(`{"details":{"password":"${REDACTED}","rows":2}}`);
    expect(
      record({
        result: {
          content: [
            { type: 'image', data: 'AAAA' },
            { type: 'text', text: 'ok' },
          ],
        },
        hasResult: true,
      }).result?.text,
    ).toBe('[image]\nok');
  });

  it('a call whose start was never seen: no args, and a name only if the end carried one', () => {
    const content = record({ name: null, startedAt: null, outcome: 'failed' });
    expect(ToolCallMessageContentSchema.parse(content)).toMatchObject({
      text: 'unknown tool',
      name: null,
      outcome: 'failed',
      startedAt: null,
    });
    expect(content).not.toHaveProperty('args');
    expect(content).not.toHaveProperty('result');
  });
});

describe('legacy 185 — a result never shows what the same call’s args hid', () => {
  /** Not a pattern any value scrub knows — only the field rule or the literal can hide it. */
  const PLAIN_SECRET = 'hunter2-plain-word';
  const args = { name: 'db-1', credentials: { password: PLAIN_SECRET }, user: 'bob' };

  it('hides a secret-named field in a result that is JSON text, at any depth, as in the args', () => {
    const echoed = JSON.stringify(
      { gatekeeper: { name: 'db-1', credentials: { password: PLAIN_SECRET }, apiKey: 12345678 } },
      null,
      2,
    );
    const content = record({
      name: 'some_tool',
      args,
      hasArgs: true,
      result: textResult(echoed),
      hasResult: true,
    });
    expect(content.args?.text).not.toContain(PLAIN_SECRET);
    expect(content.result?.text).not.toContain(PLAIN_SECRET);
    expect(content.result?.text).not.toContain('12345678');
    expect(content.result?.text).toContain(`"password": "${REDACTED}"`);
    expect(content.result?.text).toContain('"name": "db-1"');
  });

  it('hides an arg’s secret value wherever the result quotes it in prose', () => {
    const content = record({
      name: 'some_tool',
      args,
      hasArgs: true,
      result: textResult(`mysql -ubob -p${PLAIN_SECRET} failed: access denied for bob`),
      hasResult: true,
    });
    expect(content.result?.text).toBe(`mysql -ubob -p${REDACTED} failed: access denied for bob`);
  });

  it('the live stream hides the same values, and counts them the same', () => {
    const result = textResult(`{"password":"${PLAIN_SECRET}"} and again ${PLAIN_SECRET}`);
    const live = redactToolResult(result, 'some_tool', args);
    expect(JSON.stringify(live.value)).not.toContain(PLAIN_SECRET);
    const stored = record({ name: 'some_tool', args, hasArgs: true, result, hasResult: true });
    expect(stored.result?.text).not.toContain(PLAIN_SECRET);
    // args: 1 (credentials.password); result: 2 (the field, then the literal).
    expect(live.redactedValues).toBe(2);
    expect(stored.redactedValues).toBe(1 + 2);
  });

  it('without the args (a call whose start was never seen), still applies the field rule', () => {
    const content = record({
      result: textResult(`{"token":"${PLAIN_SECRET}"}`),
      hasResult: true,
    });
    expect(content.result?.text).toBe(`{"token":"${REDACTED}"}`);
  });

  it('leaves a result that repeats only non-secret args alone', () => {
    const content = record({
      name: 'some_tool',
      args: { name: 'db-1' },
      hasArgs: true,
      result: textResult('{"name":"db-1","rows":2}'),
      hasResult: true,
    });
    expect(content.result?.text).toBe('{"name":"db-1","rows":2}');
    expect(content.redactedValues).toBe(0);
  });
});

describe('redactMessageContent — a stored reply', () => {
  it('scrubs a Handle the agent repeated, and cuts a reply past its bound before scrubbing', () => {
    expect(redactMessageContent({ text: `我的 Handle 是 ${HANDLE}` })).toEqual({
      value: { text: `我的 Handle 是 ${REDACTED}` },
      redactedValues: 1,
      cut: false,
    });
    const long = redactMessageContent({ text: 'a'.repeat(MESSAGE_TEXT_MAX_CHARS + 10) });
    expect(long.cut).toBe(true);
    expect(long.value.text).toBe(`${'a'.repeat(MESSAGE_TEXT_MAX_CHARS)}…`);
  });
});

/**
 * Legacy 819: where reading stops inside a string, no copy — the live stream's, the record's, a
 * stored reply's — ends in the start of a secret, and the live stream's key rule reads what its
 * walk reads.
 */
describe('legacy 819 — reading stops, a secret never shows', () => {
  const PASSWORD = 'password: "qz7 correct horse battery staple" done';

  it('the live stream hides every value under a secret-named key of a long JSON result, past where masking shortened it', () => {
    // Field values the value patterns do not catch (only the key rule does), long enough that
    // hiding them shortens the text by more than the rest of the bound.
    const items = Array.from(
      { length: 400 },
      (_, index) => `{"credentials":{"user":"horse-${index}-${'v'.repeat(80)}"}}`,
    );
    const result = textResult(`{"items":[${items.join(',')}]}`);
    const live = redactToolResult(result, 'some_tool');
    expect(live.omitted).toBe(true);
    expect(JSON.stringify(live.value)).not.toContain('horse-');
    expect(record({ result, hasResult: true }).result?.text).not.toContain('horse-');
  });

  it('the live stream cuts a result where its bound falls inside a secret without keeping its start', () => {
    const text = `${'x'.repeat(TOOL_CALL_RESULT_PREVIEW_CHARS + 4_096 - 60)} ${PASSWORD}`;
    const live = redactToolResult(textResult(text), 'bash');
    expect(live.omitted).toBe(true);
    expect(JSON.stringify(live.value)).not.toContain('qz7');
  });

  it('the record never keeps the start of a secret its read stopped in, after Handles shortened the preview', () => {
    // Handles before the read bound shorten the scrubbed text below the preview, so what ends the
    // preview is where reading stopped — inside the password.
    const handles = `${HANDLE} `.repeat(100);
    const bound = TOOL_CALL_RESULT_PREVIEW_CHARS + 4_096;
    const text = `${handles}${' '.repeat(bound - 15 - handles.length)}${PASSWORD}${'z'.repeat(9_000)}`;
    expect(text.indexOf(PASSWORD)).toBe(bound - 15);
    const content = record({ result: textResult(text), hasResult: true });
    expect(content.result?.truncated).toBe(true);
    expect(content.result?.text).not.toContain('qz7');
    expect(content.result?.text).not.toContain('eyJ');
  });

  it('a stored reply cut inside a secret keeps none of it', () => {
    const text = `${'a'.repeat(MESSAGE_TEXT_MAX_CHARS - 20)} ${PASSWORD}`;
    const reply = redactMessageContent({ text });
    expect(reply.cut).toBe(true);
    expect(reply.value.text).not.toContain('qz7');
    expect(String(reply.value.text).startsWith('a'.repeat(MESSAGE_TEXT_MAX_CHARS - 20))).toBe(true);
  });
});

describe('review #493 on #1571 — a key on its own line of a tool’s JSON output', () => {
  /** A platform API key as minted before legacy 906, and with its prefix. Synthetic —
   *  `.gitleaks.toml` allows `abcdefghijklmnopqrstuvwxyz`. */
  const OLD_KEY = 'FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ';
  const KEY = `ntk_${OLD_KEY}`;

  it('is hidden in the live result and in the record — `\\n` before it is a line break', () => {
    // A Handle the same way (review #501 on #1571).
    for (const key of [KEY, OLD_KEY, HANDLE]) {
      // `cat` of a file holding only the key: the result's text part is JSON, so the line break
      // before the key reaches the scrub as `\n`.
      const result = textResult(JSON.stringify({ stdout: `line1\n${key}\n`, code: 0 }));
      const live = redactToolResult(result, 'bash');
      expect(JSON.stringify(live.value)).not.toContain(key.slice(-20));
      expect(live.redactedValues).toBe(1);
      const stored = record({ result, hasResult: true });
      expect(stored.result?.text).toBe(JSON.stringify({ stdout: `line1\n${REDACTED}\n`, code: 0 }));
    }
  });
});

describe('legacy 916 — a secret on its own line of a tool’s JSON output, by its name', () => {
  /** Synthetic — `.gitleaks.toml` allows `abcdefghijklmnopqrstuvwxyz`. */
  const SECRET = 'FAKEabcdefghijklmnopqrstuvwxyz';
  /** `env` through a capability: its stdout reaches the scrub as JSON text, each line after `\n`. */
  const dump = JSON.stringify({
    stdout: `HOME=/workspace\nPGPASSWORD=${SECRET}\nAWS_SECRET_ACCESS_KEY=${SECRET}9\n`,
    code: 0,
  });
  const hidden = JSON.stringify({
    stdout: `HOME=/workspace\nPGPASSWORD=${REDACTED}\nAWS_SECRET_ACCESS_KEY=${REDACTED}\n`,
    code: 0,
  });

  it('is hidden in the live result and in the record, counted the same', () => {
    const result = textResult(dump);
    const live = redactToolResult(result, 'some_tool');
    expect(live.value).toEqual(textResult(hidden));
    expect(live.redactedValues).toBe(2);
    const stored = record({ name: 'some_tool', result, hasResult: true });
    expect(stored.result?.text).toBe(hidden);
    expect(stored.redactedValues).toBe(2);
  });

  it('a stored record that kept it is rewritten the same way, once', () => {
    const stored = { ...record({ name: 'some_tool' }), result: { text: dump }, redactedValues: 0 };
    const once = rescrubStoredToolCallResult(stored);
    expect(once.value).toMatchObject({ result: { text: hidden }, redactedValues: 2 });
    expect(once.redactedValues).toBe(2);
    expect(rescrubStoredToolCallResult(once.value)).toEqual({
      value: once.value,
      redactedValues: 0,
    });
  });

  it('the rewrite leaves a bare platform-key shape on its own line, as it leaves one anywhere', () => {
    // One-way, and that shape is any 32 bytes in base64url: the scrub counts it instead.
    const text = JSON.stringify({ stdout: 'line1\nFAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ\n' });
    const stored = { ...record({ name: 'some_tool' }), result: { text }, redactedValues: 0 };
    expect(rescrubStoredToolCallResult(stored)).toEqual({ value: stored, redactedValues: 0 });
  });

  it('a stored result cut inside a string, with the old note after it, is rewritten too (review #501 on #1629)', () => {
    // Before legacy 967 a long result was cut at a character count and a note appended after a
    // raw newline: the string the text ends inside did not decode, so its lines read as `\n…`.
    const cut = `${dump.slice(0, dump.indexOf('\\nAWS'))}\n\n[... 40 more characters omitted — the full result is not shown ...]`;
    const live = redactToolResult(textResult(cut), 'some_tool');
    expect(JSON.stringify(live.value)).not.toContain(SECRET);
    expect(live.redactedValues).toBe(1);
    const stored = { ...record({ name: 'some_tool' }), result: { text: cut }, redactedValues: 0 };
    const once = rescrubStoredToolCallResult(stored);
    expect(JSON.stringify(once.value)).not.toContain(SECRET);
    expect(once.redactedValues).toBe(1);
    // The string still ends inside, the raw newline and the note after it as they were: a second
    // rewrite (every upgrade runs one) leaves the record as it is.
    const text = (once.value.result as { text: string }).text;
    expect(text).toBe(
      `${dump.slice(0, dump.indexOf('PGPASSWORD=') + 'PGPASSWORD='.length)}${REDACTED}\n\n[... 40 more characters omitted — the full result is not shown ...]`,
    );
    const twice = rescrubStoredToolCallResult(once.value);
    expect(twice).toEqual({ value: once.value, redactedValues: 0 });
  });

  describe('a stored result cut inside a quoted value, the quote left open (review #501 on #1629)', () => {
    const NOTE = '\n\n[... 40 more characters omitted — the full result is not shown ...]';
    /** `stdout` as JSON text, cut 8 characters into `SECRET`, the old note after it. */
    const cutIn = (stdout: string) => {
      const text = JSON.stringify({ stdout, code: 0 });
      return `${text.slice(0, text.indexOf(SECRET) + 8)}${NOTE}`;
    };
    const stored = (text: string) => ({
      ...record({ name: 'some_tool' }),
      result: { text },
      redactedValues: 0,
    });

    it.each([
      ['an env line, single quotes', `start\nPGPASSWORD='${SECRET}' psql`, 'start\\nPGPASSWORD='],
      ['an export, double quotes', `export API_TOKEN="${SECRET}"\nok`, 'export API_TOKEN='],
      ['the first line, no escape before it', `password: '${SECRET}'`, 'password: '],
      // The rule for a JSON key's value not closed on its line hid it already, its quote kept.
      ['a JSON key in the output', `{"password": "${SECRET}"}`, '{\\"password\\": \\"'],
    ])('%s: hidden from its quote to the cut, the note kept, once', (_, stdout, before) => {
      const cut = cutIn(stdout);
      const once = rescrubStoredToolCallResult(stored(cut));
      const text = (once.value.result as { text: string }).text;
      expect(text).toBe(`{"stdout":"${before}${REDACTED}${NOTE}`);
      expect(once.redactedValues).toBe(1);
      expect(rescrubStoredToolCallResult(once.value)).toEqual({
        value: once.value,
        redactedValues: 0,
      });
      // The live reading hides it too (the tail check, at the line's end).
      expect(JSON.stringify(redactToolResult(textResult(cut), 'some_tool').value)).not.toContain(
        SECRET.slice(0, 8),
      );
    });

    it.each([
      ['a quote left open on a line that goes on (legacy 923)', `PGPASSWORD='${SECRET}\nnext line`],
      ['an open quote after a name that names no secret', `greeting='${SECRET}`],
      ['what is left of the value is the mask', `PGPASSWORD='${REDACTED}`],
      ['what is left of the value is the start of the mask', `PGPASSWORD='${REDACTED.slice(0, 4)}`],
    ])('%s: left as it is', (_, stdout) => {
      const text = JSON.stringify({ stdout }).slice(0, -2) + NOTE;
      expect(rescrubStoredToolCallResult(stored(text))).toEqual({
        value: stored(text),
        redactedValues: 0,
      });
    });

    it('a record the kernel cut itself, at its preview’s end inside a string, is never rewritten', () => {
      // The preview is scrubbed before it is cut (16,000 characters): wherever the cut lands in a
      // masked value, what is left of it is the mask or the start of it.
      for (const [name, quote] of [
        ['PGPASSWORD=', "'"],
        ['export API_TOKEN=', '\\"'],
        ['password: ', "'"],
      ] as const) {
        const line = `${name}${quote}${SECRET}${quote}`;
        for (let shift = 0; shift < line.length + 24; shift += 1) {
          const stdout = `${'x'.repeat(16_000 - 12 - shift)}\n${line.replaceAll('\\"', '"')} ok\n${'y'.repeat(2_000)}`;
          const built = record({
            name: 'some_tool',
            result: textResult(JSON.stringify({ stdout })),
            hasResult: true,
          });
          expect(built.result?.truncated).toBe(true);
          expect(JSON.stringify(built)).not.toContain(SECRET.slice(0, 4));
          expect(rescrubStoredToolCallResult(built)).toEqual({ value: built, redactedValues: 0 });
        }
      }
    });
  });

  it('an arg’s secret value the result quotes is hidden though JSON escaped a character of it', () => {
    // A quote and a backslash: the JSON text carries `\"` and `\\`, so the literal is not in it.
    const args = { password: 'pa"ss\\word-9' };
    const result = textResult(JSON.stringify({ stdout: `login pa"ss\\word-9 failed` }));
    const live = redactToolResult(result, 'some_tool', args);
    expect(JSON.stringify(live.value)).not.toContain('word-9');
    const stored = record({ name: 'some_tool', args, hasArgs: true, result, hasResult: true });
    expect(stored.result?.text).toBe(JSON.stringify({ stdout: `login ${REDACTED} failed` }));
    expect(stored.redactedValues).toBe(1 + 1);
  });

  it('a quoted value is hidden once and the text stays JSON (review #493 on #1573)', () => {
    const stdout = `export API_TOKEN="${SECRET}"\nok`;
    const result = textResult(JSON.stringify({ stdout }));
    const expected = JSON.stringify({ stdout: `export API_TOKEN="${REDACTED}"\nok` });
    const live = redactToolResult(result, 'some_tool');
    expect(live).toMatchObject({ value: textResult(expected), redactedValues: 1 });
    const stored = record({ name: 'some_tool', result, hasResult: true });
    expect(stored.result?.text).toBe(expected);
    expect(stored.redactedValues).toBe(1);
  });

  it('a result past its read bound is cut inside a string, which is still read (review #493)', () => {
    const result = textResult(
      JSON.stringify({ stdout: `start\nPGPASSWORD=${SECRET}\n${'x'.repeat(40_000)}`, code: 0 }),
    );
    const live = redactToolResult(result, 'some_tool');
    expect(JSON.stringify(live.value)).not.toContain(SECRET);
    expect(live.redactedValues).toBe(1);
    const stored = record({ name: 'some_tool', result, hasResult: true });
    expect(stored.result?.text).toContain(`start\\nPGPASSWORD=${REDACTED}\\n`);
    expect(stored.result?.truncated).toBe(true);
    expect(stored.redactedValues).toBe(1);
    // A preview stored cut the same way is rewritten the same way.
    const text = JSON.stringify({ stdout: `start\nPGPASSWORD=${SECRET}\n` }).slice(0, -3);
    const old = { ...record({ name: 'some_tool' }), result: { text }, redactedValues: 0 };
    expect(rescrubStoredToolCallResult(old)).toMatchObject({
      value: { result: { text: `{"stdout":"start\\nPGPASSWORD=${REDACTED}\\` } },
      redactedValues: 1,
    });
  });

  describe('a quoted value the text pass split before legacy 916, stored (coordinator, #1573)', () => {
    /** As the value patterns over the text as written left it before legacy 916: `\` taken for
     *  the value. */
    const split = (stdout: string) =>
      JSON.stringify({ stdout }).replace(`\\"${SECRET}\\"`, `${REDACTED}"${SECRET}\\"`);
    const stored = (text: string) => ({
      ...record({ name: 'some_tool' }),
      result: { text },
      redactedValues: 1,
    });

    it.each([
      ['an env line', 'API_TOKEN='],
      ['an export', 'export X_TOKEN='],
      ['a YAML key', 'password: '],
      ['a header, no space', 'X-Api-Key:'],
      ['a --password flag', '--password '],
      ['a query string', 'api_key='],
    ])('is rewritten as the value patterns write it now, once, the JSON whole: %s', (_l, name) => {
      const stdout = `a ${name}"${SECRET}" b\nok`;
      const text = split(stdout);
      expect(text).toBe(`{"stdout":"a ${name}${REDACTED}"${SECRET}\\" b\\nok"}`);
      const once = rescrubStoredToolCallResult(stored(text));
      const fixed = JSON.stringify({ stdout: `a ${name}"${REDACTED}" b\nok` });
      // What the value patterns over the text as written make of it now (legacy 918).
      expect(scrubSecretValues(JSON.stringify({ stdout })).value).toBe(fixed);
      expect(once).toMatchObject({ value: { result: { text: fixed }, redactedValues: 2 } });
      expect(once.redactedValues).toBe(1);
      expect(JSON.parse(fixed)).toEqual({ stdout: `a ${name}"${REDACTED}" b\nok` });
      expect(rescrubStoredToolCallResult(once.value)).toEqual({
        value: once.value,
        redactedValues: 0,
      });
    });

    it('leaves plain text alone, where a quoted mask is the mask written whole (review #493)', () => {
      for (const text of [
        `export TOKEN="${REDACTED}"\nrun --name app\necho \\"done\\"`,
        `TOKEN="${REDACTED}" and later \\"x\\"`,
        // JSON, then a raw line break: a string never holds one, so the mask's quote closed one.
        `{"a":"${REDACTED}"}\nlog \\"x\\"`,
        // A log line starts as JSON would; the mask stands after its own quote (review #501).
        `[INFO] password="${REDACTED}" msg=\\"x\\"`,
        `{worker} TOKEN="${REDACTED}" next \\"y\\"`,
      ]) {
        expect(rescrubStoredToolCallResult(stored(text))).toEqual({
          value: stored(text),
          redactedValues: 0,
        });
      }
    });

    it('repairs plain text too, as it is written now (legacy 918)', () => {
      const plain = `sh -c "export API_TOKEN=\\"${SECRET} x\\" && run"`;
      const now = `sh -c "export API_TOKEN=\\"${REDACTED}\\" && run"`;
      const live = record({ result: textResult(plain), hasResult: true });
      expect(live.result?.text).toBe(now);
      const text = `sh -c "export API_TOKEN=${REDACTED}"${SECRET} x\\" && run"`;
      const once = rescrubStoredToolCallResult(stored(text));
      expect(once).toEqual({
        value: { ...stored(text), result: { text: now }, redactedValues: 2 },
        redactedValues: 1,
      });
      expect(rescrubStoredToolCallResult(once.value)).toEqual({
        value: once.value,
        redactedValues: 0,
      });
    });

    it('reads JSON text after leading white space (review #493)', () => {
      const text = ` \n${split(`a API_TOKEN="${SECRET}" b`)}`;
      expect(text).toContain(`${REDACTED}"${SECRET}`);
      expect(rescrubStoredToolCallResult(stored(text))).toEqual({
        value: {
          ...stored(text),
          result: { text: ` \n{"stdout":"a API_TOKEN=\\"${REDACTED}\\" b"}` },
          redactedValues: 2,
        },
        redactedValues: 1,
      });
    });

    it('leaves JSON that is valid alone, where a closing quote follows a mask', () => {
      for (const text of [
        `{"a":"${REDACTED}"}`,
        `["x","${REDACTED}"]`,
        `{"password":"${REDACTED}","note":"say \\"hi\\""}`,
        `["${REDACTED}",1,true,null,"a\\"b"]`,
        `{"a":"${REDACTED}"}\n{"b":"x\\"y"}`,
        `{"a":"x ${REDACTED}","b":"\\\\"}`,
        `{"a":"${REDACTED}","b":"c\\\\"}`,
      ]) {
        expect(rescrubStoredToolCallResult(stored(text))).toEqual({
          value: stored(text),
          redactedValues: 0,
        });
      }
    });

    // Legacy 937 (review #493 on #1597): an earlier release hid a quoted value to its closing
    // quote and kept the rest of its word, written right against that quote, as it was.
    it.each([
      ['plain text', (text: string) => text],
      ['a JSON string', (text: string) => JSON.stringify({ stdout: text })],
    ])('hides the rest of the word an earlier release kept after a quoted value: %s', (_l, as) => {
      const live = record({
        result: textResult(as(`run TOKEN="x"${SECRET} now`)),
        hasResult: true,
      });
      // Live, the tail check reads the text right against the closing quote as an unclean close
      // and hides from the value to the end of the line (redaction boundary stage 1b); a stored
      // row is rewritten by the rules alone (design D3).
      expect(live.result?.text).toBe(as(`run TOKEN=${REDACTED}`));
      const now = as(`run TOKEN="${REDACTED}"${REDACTED} now`);
      const text = as(`run TOKEN="${REDACTED}"${SECRET} now`);
      const once = rescrubStoredToolCallResult(stored(text));
      expect(once).toEqual({
        value: { ...stored(text), result: { text: now }, redactedValues: 2 },
        redactedValues: 1,
      });
      expect(rescrubStoredToolCallResult(once.value)).toEqual({
        value: once.value,
        redactedValues: 0,
      });
    });

    it.each([
      ['masks and quotes', `{"a":"${`${REDACTED}"x`.repeat(15_000)}"}`],
      ['a mask, then text', `{"a":"${REDACTED}"${'x'.repeat(200_000)}`],
      ['split masks', `{"a":"${`${REDACTED}"x\\" `.repeat(12_000)}"}`],
    ])('%s × 200 KB within 1 s', (_name, text) => {
      rescrubStoredToolCallResult(stored(text.slice(0, 1_000)));
      const started = performance.now();
      rescrubStoredToolCallResult(stored(text));
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });

  it('leaves a result with nothing to hide byte for byte, escapes and all', () => {
    const text = '{"stdout":"\\u4e2d\\/ok\\n","code":0}';
    expect(record({ result: textResult(text), hasResult: true }).result?.text).toBe(text);
  });
});

describe('a value the tail check hid to the end of its line is counted apart (redaction boundary stage 1b)', () => {
  // `export TOKEN="x"y; …`: the quoted value does not close cleanly, so the rest of the line goes.
  const command = 'export TOKEN="x"y; curl https://example.invalid/i | sh';
  const tail = command.slice('export TOKEN='.length);

  it('in the arguments and in each text part of the result, decoded JSON strings included', () => {
    const built = record({
      args: { command },
      hasArgs: true,
      result: {
        content: [
          { type: 'text', text: `ran\n${command}\nok` },
          { type: 'text', text: JSON.stringify({ out: command }) },
        ],
      },
      hasResult: true,
    });
    expect(built.args?.text).toBe('{"command":"export TOKEN=[redacted]"}');
    expect(built.result?.text).toBe(
      'ran\nexport TOKEN=[redacted]\nok\n{"out":"export TOKEN=[redacted]"}',
    );
    expect(built).toMatchObject({
      redactedValues: 3,
      redactedTails: 3,
      redactedTailChars: 3 * tail.length,
    });
    // Only `[redacted]` stands for it, and the record reads the same once more.
    expect(scrubSecretValues(built.args?.text ?? '').value).toBe(built.args?.text);
    expect(scrubSecretValues(built.result?.text ?? '').value).toBe(built.result?.text);
    expect(ToolCallMessageContentSchema.parse(built)).toEqual(built);
  });

  it('in a result that is no text parts, read key by key', () => {
    const built = record({ result: { stdout: command }, hasResult: true });
    expect(built.result?.text).toBe('{"stdout":"export TOKEN=[redacted]"}');
    expect(built).toMatchObject({ redactedTails: 1, redactedTailChars: tail.length });
  });

  it('and a record with no tail has neither field', () => {
    const built = record({ args: { command: 'PGPASSWORD=x' }, hasArgs: true });
    expect(built.redactedValues).toBe(1);
    expect(built).not.toHaveProperty('redactedTails');
    expect(built).not.toHaveProperty('redactedTailChars');
  });

  it('a runtime message counts them too', () => {
    expect(redactMessageContent({ text: command })).toEqual({
      value: { text: 'export TOKEN=[redacted]' },
      redactedValues: 1,
      redactedTails: 1,
      redactedTailChars: tail.length,
      cut: false,
    });
  });
});
