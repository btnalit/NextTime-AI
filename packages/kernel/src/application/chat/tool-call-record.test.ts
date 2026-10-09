import { ToolCallMessageContentSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../governance/redaction/index.js';
import {
  MESSAGE_TEXT_MAX_CHARS,
  TOOL_CALL_ARGS_PREVIEW_CHARS,
  TOOL_CALL_RESULT_PREVIEW_CHARS,
  buildToolCallRecord,
  redactMessageContent,
  redactToolArgs,
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
    ['an upper-case env secret', 'PGPASSWORD=hunter2 psql', `PGPASSWORD=${REDACTED} psql`],
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
  it('replaces a secret-named key and a capability’s declared secret params, keeping the shape', () => {
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
      credentials: REDACTED,
      nested: [{ password: REDACTED, note: `use ${REDACTED}` }],
    });
    expect(redactedValues).toBe(4);
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
