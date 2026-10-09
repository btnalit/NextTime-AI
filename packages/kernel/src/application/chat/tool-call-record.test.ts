import { ToolCallMessageContentSchema } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  TOOL_CALL_ARGS_PREVIEW_CHARS,
  TOOL_CALL_RESULT_PREVIEW_CHARS,
  buildToolCallRecord,
  redactToolPayload,
} from './tool-call-record.js';

/** A Handle-shaped compact JWT (header `{"alg":"EdDSA"}`). */
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

describe('redactToolPayload — values that are secrets wherever they appear', () => {
  it('replaces an agent’s own Handle in an `env` dump, once', () => {
    const { value, redactedValues } = redactToolPayload(
      `HOME=/workspace\nCAPABILITY_HANDLE=${HANDLE}\nKERNEL_URL=http://kernel:8080`,
    );
    expect(value).toBe(
      `HOME=/workspace\nCAPABILITY_HANDLE=${REDACTED}\nKERNEL_URL=http://kernel:8080`,
    );
    expect(redactedValues).toBe(1);
  });

  it.each([
    ['a bare JWT', `token is ${HANDLE} ok`, `token is ${REDACTED} ok`],
    ['a Bearer value', 'Authorization: Bearer abc.def-123456', `Authorization: Bearer ${REDACTED}`],
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
    expect(redactToolPayload(input).value).toBe(expected);
  });

  it('leaves ordinary text alone — including names that only contain a secret word', () => {
    const text = 'max_tokens=1024; the depends_on edge kernel → postgres; tokenCount 3';
    expect(redactToolPayload(text)).toEqual({ value: text, redactedValues: 0 });
  });
});

describe('redactToolPayload — structured arguments', () => {
  it('replaces a secret-named key and a capability’s declared secret params, keeping the shape', () => {
    const { value, redactedValues } = redactToolPayload(
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

  it('bounds the walk over a huge value and still scrubs what is past the bound', () => {
    const wide = Array.from({ length: 6_000 }, (_, index) => ({ index }));
    wide.push({ index: -1, note: HANDLE } as { index: number });
    const { value } = redactToolPayload(wide);
    expect(JSON.stringify(value)).not.toContain('eyJhbGci');
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
      totalChars: filler.length + 1 + REDACTED.length,
      truncated: true,
    });
    expect(content.result?.text).not.toContain('eyJ');
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
