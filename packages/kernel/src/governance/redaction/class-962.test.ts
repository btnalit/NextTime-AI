import { describe, expect, it } from 'vitest';
import { createSecretStreamScrubber, scrubSecretValues } from './index.js';

/**
 * governance/redaction/class-962.test (pure, no DB) — the examples of the legacy rows merged into
 * class legacy 962 («值读到哪里停»), each row as `docs/status-history.md` «并入类遗留 962 的原行»
 * lists them, pinned as the stage-1b tail check reads them
 * (`docs/redaction-boundary-design-2026-11-27.md` §6, §8 «类里列过的写法»): every one hidden in
 * full, the whole text and the stream alike, at every cut, and read again unchanged. 958 is the P3
 * #1600 registered (release.md §3.221 «仍然露的», second item). 951 (the counted categories' report)
 * is pinned in `application/platform/scrub-raw-secrets.tail-unproven.integration.test.ts`.
 *
 * `K` stands for the key each row wrote as `<密钥>`. FAKE values only.
 */
const K = 'FAKEabcdefghijklmnopqrstuvwxyz';
const R = '[redacted]';

/** [legacy, text, whole text scrubbed, values replaced, tails hidden to the end of the line]. */
const EXAMPLES: readonly (readonly [string, string, string, number, number])[] = [
  // 927: `=>`. The value rules still take `>` for the value (as main does: only more hidden, the
  // name grammar is stage 2); the tail check reads `=>` as the pair and hides the quoted value.
  ['927', `$config = ['password' => '${K}'];`, `$config = ['password' =${R} '${R}'];`, 2, 0],
  ['927', `password => "${K}"`, `password =${R} "${R}"`, 2, 0],
  ['927', `:password => "${K}"`, `:password =${R} "${R}"`, 2, 0],
  ['927', `{ api_key => '${K}' }`, `{ api_key =${R} '${R}' }`, 2, 0],
  // 933: a pair inside the value an earlier pair took.
  ['933', `TOKEN=\\"b : secret = \\" ${K}`, `TOKEN=${R}`, 2, 1],
  ['933', `API_KEY=x;secret: '${K}'`, `API_KEY=${R}`, 2, 1],
  ['933', `API_KEY=x,,secret: '${K}'`, `API_KEY=${R}`, 2, 1],
  // 935: a pair inside a quoted value, and a quoted value followed by the next key's `=`.
  ['935', `password='token = apiKey' = "${K}"`, `password=${R}`, 1, 1],
  ['935', `password='apiKey' = "${K}"`, `password=${R}`, 2, 1],
  // 936: a value opened and never closed, after a key quoted on one side, or quoted with `=`.
  ['936', `api_key" : "${K}`, `api_key" : ${R}`, 1, 1],
  ['936', `password:api_key" : "${K}`, `password:${R}`, 1, 1],
  ['936', `"secret" = "${K}`, `"secret" = ${R}`, 1, 1],
  ['936', `x "password" = "${K}`, `x "password" = ${R}`, 1, 1],
  // 940: an escaped JSON key followed by a bare value.
  ['940', `token: \\"password\\": ${K}`, `token: ${R}`, 1, 1],
  ['940', `token: \\"note": ${K}`, `token: ${R}`, 1, 1],
  // 941: a JSON key followed by `=`.
  ['941', `token=x,note:""tokenValue"="${K}`, `token=${R}`, 1, 1],
  ['941', `{note: \\"passwordx"="${K}"`, `{note: \\"passwordx"="${R}"`, 1, 0],
  ['941', `"passwordx"="${K}"`, `"passwordx"="${R}"`, 1, 0],
  // 942: an inner value closed at `\\\"` in a JSON value written inside a string.
  ['942', `\\"passwordx\\": \\"a token: x\\\\\\" ${K}\\"`, `\\"passwordx\\": ${R}`, 3, 1],
  ['942', `\\"_password\\": \\"a API_TOKEN=x\\\\\\" ${K}\\"`, `\\"_password\\": \\"${R}`, 3, 1],
  // 949: text against the closing quote, with a quote in it, starting with a quote or a
  // backslash, or ending like a key.
  ['949', `token='a'b'${K}`, `token=${R}`, 1, 1],
  ['949', `token="a"b"${K}`, `token=${R}`, 1, 1],
  ['949', `token="x"y"${K}"`, `token=${R}`, 1, 1],
  ['949', `token="a"b'${K}`, `token=${R}`, 1, 1],
  ['949', `token='a'b"${K}`, `token=${R}`, 1, 1],
  ['949', `TOKEN=""'${K}'`, `TOKEN=${R}`, 1, 1],
  ['949', `TOKEN="x"''${K}`, `TOKEN=${R}`, 1, 1],
  ['949', `token="a""${K}`, `token=${R}`, 1, 1],
  ['949', `token="x"${K}": 1`, `token=${R}`, 1, 1],
  ['949', `token='x'${K}': 1`, `token=${R}`, 1, 1],
  ['949', `TOKEN=""${K}"        : 1`, `TOKEN=${R}`, 1, 1],
  ['949', `token="x"\\"${K}`, `token=${R}`, 1, 1],
  ['949', `token="x"\\\\${K}`, `token=${R}`, 1, 1],
  ['949', `{"cmd":"password=\\"a\\\\\\"b\\"${K}"}`, `{"cmd":"password=${R}`, 1, 1],
  // …and the same after a value closed by an escaped quote (release.md §3.221).
  ['949', `token=\\"x\\"\\"${K}`, `token=${R}`, 1, 1],
  ['949', `token=\\"x\\"'${K}`, `token=${R}`, 1, 1],
  ['949', `password="a\\"b"'${K}`, `password=${R}`, 1, 1],
  // 950: a mask already in the text with text against it.
  ['950', `run password="${R}"${K}y`, `run password=${R}`, 1, 1],
  // 958 (#1600): a pair inside a value closed by an escaped quote, or a name after its first `\"`.
  ['958', `password="a\\"b token='c"d'"${K} y`, `password=${R}`, 2, 1],
  ['958', `password="a\\" token=b"${K} y`, `password=${R}`, 2, 1],
];

/** `pieces` streamed and flushed. */
function streamed(pieces: readonly string[]): string {
  const scrubber = createSecretStreamScrubber();
  let out = '';
  for (const piece of pieces) out += scrubber.push(piece).value;
  return out + scrubber.flush().value;
}

describe('class legacy 962 — the examples its merged rows list, hidden in full', () => {
  it.each(EXAMPLES)('%s: %s', (_legacy, text, expected, redactedValues, tails) => {
    const whole = scrubSecretValues(text);
    expect(whole.value).toBe(expected);
    expect(whole.value).not.toContain(K);
    expect(whole.redactedValues).toBe(redactedValues);
    expect(whole.redactedTails ?? 0).toBe(tails);
    // Read again (the next upgrade's live reading of what this one wrote): unchanged.
    expect(scrubSecretValues(whole.value).value).toBe(whole.value);
  });

  it.each(EXAMPLES.map(([legacy, text, expected]) => [legacy, text, expected]))(
    '%s, streamed in two at every offset and a character at a time: %s',
    (_legacy, text, expected) => {
      for (let at = 0; at <= text.length; at += 1) {
        const got = streamed([text.slice(0, at), text.slice(at)]);
        if (got !== expected) expect({ at, got }).toEqual({ at, got: expected });
      }
      expect(streamed([...text])).toBe(expected);
    },
  );
});
