import { WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS, boundToolCallPayload } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { CUT_LOOKAHEAD_CHARS } from '../../substrate/redaction/index.js';
import {
  SECRET_MARGIN_CHARS,
  TOOL_CALL_ARGS_PREVIEW_CHARS,
  TOOL_CALL_RESULT_PREVIEW_CHARS,
  buildToolCallRecord,
} from '../chat/tool-call-record.js';

/**
 * application/task/tool-calls (legacy 155): what worker mode sends of a payload
 * (`boundToolCallPayload`, packages/shared/src/worker-tool-calls.ts) gives the record the whole
 * payload gives — the kernel never reads as far as worker mode cut, so it never sees a cut string's
 * end, and a secret worker mode cut through is never half shown.
 */

// Synthetic, in a shape the value patterns know (a GitHub token): never a real credential.
const FAKE_TOKEN = `ghp_${'F'.repeat(36)}`;

function record(args: unknown, result: unknown) {
  return buildToolCallRecord({
    toolCallId: 'call-1',
    name: 'bash',
    outcome: 'done',
    args,
    hasArgs: true,
    result,
    hasResult: true,
    startedAt: null,
    endedAt: null,
  });
}

describe('a Worker tool call as worker mode sends it (legacy 155)', () => {
  it('cuts a string only past what the kernel reads of any one string', () => {
    const furthestRead =
      Math.max(TOOL_CALL_ARGS_PREVIEW_CHARS, TOOL_CALL_RESULT_PREVIEW_CHARS) +
      SECRET_MARGIN_CHARS +
      CUT_LOOKAHEAD_CHARS;
    expect(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS).toBeGreaterThan(furthestRead);
  });

  it('gives the record the whole payload gives, a secret at the cut included', () => {
    // A token across each place worker mode cuts: a string's bound, a pi result's text bound.
    const atCut = `${'a'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS - 10)}${FAKE_TOKEN}${'b'.repeat(1_000)}`;
    const args = {
      command: `echo ${FAKE_TOKEN}`,
      content: atCut,
      many: Array.from({ length: 5_000 }, (_, i) => ({ key: `k${i}`, value: i })),
    };
    const result = {
      content: [
        { type: 'text', text: 'x'.repeat(10_000) },
        { type: 'image', data: 'aW1hZ2U=' },
        { type: 'text', text: atCut },
      ],
      details: { exitCode: 0 },
    };
    // Worker mode did cut both.
    expect(JSON.stringify(boundToolCallPayload(args)).length).toBeLessThan(
      JSON.stringify(args).length,
    );
    expect(JSON.stringify(boundToolCallPayload(result)).length).toBeLessThan(
      JSON.stringify(result).length,
    );
    const whole = record(args, result);
    const sent = record(boundToolCallPayload(args), boundToolCallPayload(result));

    expect(sent.args).toEqual(whole.args);
    expect(sent.redactedValues).toBe(whole.redactedValues);
    // A pi result's length is what was sent: a lower bound once worker mode cut it.
    const { totalChars: sentTotal, ...sentResult } = sent.result ?? { totalChars: 0 };
    const { totalChars: wholeTotal, ...wholeResult } = whole.result ?? { totalChars: 0 };
    expect(sentResult).toEqual(wholeResult);
    expect(sent.result?.truncated).toBe(true);
    expect(sentTotal).toBeLessThan(wholeTotal);
    expect(sentTotal).toBeGreaterThanOrEqual(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS);
    // Neither copy shows the token, nor any start of it.
    for (const text of [sent.args?.text ?? '', sent.result?.text ?? '']) {
      expect(text).not.toContain('ghp_');
    }
  });

  it('gives a structured result the record its whole gives', () => {
    const result = {
      rows: Array.from({ length: 20_000 }, (_, i) => ({ id: i, note: `row ${i} ${FAKE_TOKEN}` })),
    };
    const whole = record({ query: 'select' }, result);
    const sent = record({ query: 'select' }, boundToolCallPayload(result));
    expect(sent.result).toEqual(whole.result);
    expect(sent.result?.text).not.toContain('ghp_');
  });

  it('shows less, never a cut string, where long values under secret-named keys let the kernel read further', () => {
    // The kernel charges each value under a secret-named key the `[redacted]` it writes, so past
    // 32 768 characters of them it reads on; worker mode left the rest out by then.
    const args = {
      password: 's'.repeat(WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS),
      note: `${'n'.repeat(100)} ${FAKE_TOKEN}`,
    };
    const sent = record(boundToolCallPayload(args), undefined);
    expect(record(args, undefined).args?.text).toContain('nnnn');
    expect(sent.args?.text).toContain('[…]');
    expect(sent.args?.text).not.toContain('nnnn');
    expect(sent.args?.text).not.toContain('ssss');
  });
});
