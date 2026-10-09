import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  STREAM_HOLD_MAX_CHARS,
  createSecretStreamScrubber,
  scrubSecretValues,
} from './index.js';

/** A Handle-shaped compact JWT (header `{"alg":"EdDSA"}`). Synthetic — `.gitleaks.toml` allows
 *  this signature segment, and `abcdefghijklmnopqrstuvwxyz` in `FAKE`. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

/** Texts with a secret of every shape the scrub knows, at the start, middle and end. */
const TEXTS: readonly string[] = [
  `my Handle is ${HANDLE}, keep it safe`,
  `HOME=/workspace\nCAPABILITY_HANDLE=${HANDLE}\nKERNEL_URL=http://kernel:8080\n`,
  `token: ${HANDLE}`,
  `图里没有 depends_on 关系。我的 Handle 是${HANDLE}。请勿外传。`,
  'Authorization: Bearer abc.def-123456 and Basic dXNlcjpwYXNzd29yZA== done',
  'connect to postgres://nexttime:s3cret@db:5432/x now',
  '{"api_key": "abc 123 def", "n": 1, "note": "a \\"quoted\\" token"}',
  'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\nAAAAC3Nza\n-----END OPENSSH PRIVATE KEY-----\nafter',
  'run PGPASSWORD=hunter2 psql and /login?user=a&password=hunter2&x=1',
  'nothing secret here: max_tokens=1024, the depends_on edge, tokenCount 3 — 普通的中文句子。',
  'export API_TOKEN="abcdefghijklmnopqrstuvwxyz 0123" && password: \'two words\' --password  x y',
  'I don\'t know; password: "correct horse battery" said the note. Cookie: a=1; b=2\nnext',
  'POSTGRES_PASSWORD: abcdefghijklmnopqrstuvwxyz\nX-Api-Key: abcdefghijklmnopqrstuvwxyz0123 end',
];

/** Everything a scrubber emits for `pieces`, then its flush. */
function stream(pieces: readonly string[]): { text: string; redactedValues: number } {
  const scrubber = createSecretStreamScrubber();
  let text = '';
  let redactedValues = 0;
  for (const piece of [...pieces.map((p) => scrubber.push(p)), scrubber.flush()]) {
    text += piece.value;
    redactedValues += piece.redactedValues;
  }
  return { text, redactedValues };
}

describe('createSecretStreamScrubber — a secret split across pieces is still scrubbed', () => {
  it.each(TEXTS.map((text) => [text.slice(0, 32), text]))(
    'split anywhere in two, the output is the whole text scrubbed: %s…',
    (_label, text) => {
      const whole = scrubSecretValues(text);
      for (let at = 0; at <= text.length; at += 1) {
        expect(stream([text.slice(0, at), text.slice(at)])).toEqual({
          text: whole.value,
          redactedValues: whole.redactedValues,
        });
      }
    },
  );

  it.each(TEXTS.map((text) => [text.slice(0, 32), text]))(
    'one character at a time, and in uneven pieces, the same: %s…',
    (_label, text) => {
      const whole = scrubSecretValues(text).value;
      expect(stream([...text]).text).toBe(whole);
      for (const size of [2, 3, 5, 7, 13]) {
        const pieces = [];
        for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
        expect(stream(pieces).text).toBe(whole);
      }
    },
  );

  it('never emits any part of a Handle, whatever was emitted so far', () => {
    const text = `我的 Handle 是 ${HANDLE} 。`;
    const scrubber = createSecretStreamScrubber();
    let emitted = '';
    for (const char of text) {
      emitted += scrubber.push(char).value;
      expect(emitted).not.toContain('eyJ');
    }
    emitted += scrubber.flush().value;
    expect(emitted).toBe(`我的 Handle 是 ${REDACTED} 。`);
  });

  it('holds a secret JSON value back until it is closed, spaces and all', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('{"password": "correct horse').value).toBe('{');
    expect(scrubber.push(' battery staple"}, ').value).toBe(`"password": "${REDACTED}"}, `);
    expect(scrubber.flush().value).toBe('');
  });
});

/** The secret names a `name<separator>value` pair is written with: each pattern's kind of name
 *  (last word, camelCase, env, header, quoted key, a key with a space). */
const PAIR_NAMES = [
  'token',
  'password',
  'api_key',
  'DB_PASSWORD',
  'aws_secret_access_key',
  'clientSecret',
  'X-Api-Key',
  'Authorization',
  'Cookie',
  'Set-Cookie',
  'CAPABILITY_HANDLE',
  'API_TOKEN',
  '"token"',
  "'password'",
  '"client secret"',
];
/** Every separator the patterns take, with spaces on either side, before and after. */
const SEPARATORS = ['=', ':', ' = ', ' : ', ' =', ': ', '\t:\t', '  =  ', ' :'];
const PAIR_VALUES = [FAKE, `"${FAKE} two"`, `'${FAKE} two'`, HANDLE];

/** Every other shape a secret is written in. */
const SHAPES = [
  `{"password" : "${FAKE} x"}`,
  '{"client secret":"a b"}',
  '{ "api_key" :  "v\\"q x" }',
  '{"note": "a \\"quoted\\" token", "token": "x y"}',
  '{"secret value": "x y"}',
  `{"api_key_id": "${FAKE}"}`,
  '{"token count" :  "a b"}',
  '{"a": "token": "x y"}',
  `{"note": "a", "handle": "${HANDLE}"}`,
  '{"capability_handle":"x\\"y z"}',
  '{"token":"a","password":"b c"}',
  '{"password": "[redacted]"}',
  '"api_key"   :   "v w"',
  `Authorization : Bearer ${FAKE}`,
  'Cookie  :  a=1; b=2',
  'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==',
  `curl -H 'Authorization: Bearer ${FAKE}' x`,
  `Bearer  ${FAKE}`,
  'Basic\tdXNlcjpwYXNzd29yZA==',
  `Basic configuration then Bearer ${FAKE}`,
  `--password  "${FAKE} x"`,
  `--api-key=${FAKE}`,
  `--token\t${FAKE}`,
  `--user --password ${FAKE}`,
  'API_TOKEN="a b c"',
  "export PGPASSWORD='x y'",
  `X=PGPASSWORD=${FAKE}`,
  `note: password=${FAKE}`,
  `password: [redacted] and token: ${FAKE}`,
  `token=${FAKE}&password=${FAKE}`,
  `url: https://x/?token=${FAKE}&y=1`,
  'postgres://u:s3cret@db:5432/x',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  `sk-ant-${FAKE}`,
  `ghp_${FAKE}`,
  HANDLE,
  `5" screen {"secret value": "x y"}`,
  `a\npassword: "x y"\nCookie: a=1\n{"token": "q r"}\n`,
  `密码是 password: ${FAKE}。`,
  `值 token = "${FAKE} 中文"`,
  `我的 Handle 是${HANDLE}。`,
];

/** What surrounds a shape: nothing; prose; CJK and a newline; an apostrophe, an unclosed quote,
 *  and a JSON string before it — the quotes a stream cannot pair up. */
const CONTEXTS: readonly (readonly [string, string])[] = [
  ['', ''],
  ['see ', ' ok'],
  ['说：', '\nnext'],
  ["I don't know: ", ', ok'],
  ['he said "', '" twice'],
  ['{"note": "', '"}'],
  ["it's '", "' done"],
];

/** `text` split at `cuts`, streamed, and flushed — with how many values were replaced. */
function streamedAt(text: string, cuts: readonly number[]): string {
  const pieces: string[] = [];
  let from = 0;
  for (const at of cuts) {
    pieces.push(text.slice(from, at));
    from = at;
  }
  pieces.push(text.slice(from));
  const out = stream(pieces);
  return `${out.text} (${out.redactedValues})`;
}

/** The first split of `text` — in two at every offset, and with `inThree` in three at every pair of
 *  offsets — whose streamed output is not the whole text scrubbed; `undefined` when there is none. */
function firstMismatch(text: string, inThree: boolean): string | undefined {
  const scrubbed = scrubSecretValues(text);
  const whole = `${scrubbed.value} (${scrubbed.redactedValues})`;
  for (let first = 0; first <= text.length; first += 1) {
    if (streamedAt(text, [first]) !== whole) return `${JSON.stringify(text)} split at ${first}`;
    for (let second = first; inThree && second <= text.length; second += 1) {
      if (streamedAt(text, [first, second]) !== whole) {
        return `${JSON.stringify(text)} split at ${first}, ${second}`;
      }
    }
  }
  return undefined;
}

describe('createSecretStreamScrubber — split anywhere, the output is the whole text scrubbed', () => {
  it.each(PAIR_NAMES)(
    '%s with every separator and value: in two at every offset, in three at every pair',
    (name) => {
      const mismatches = SEPARATORS.flatMap((separator, index) =>
        PAIR_VALUES.map((value, valueIndex) =>
          firstMismatch(`see ${name}${separator}${value} ok`, valueIndex === index % 4),
        ),
      );
      expect(mismatches.filter((found) => found !== undefined)).toEqual([]);
    },
  );

  it.each(SHAPES.map((shape, index) => [shape.slice(0, 40), index]))(
    '%s… in every context: in two at every offset, in one context in three at every pair',
    (_label, index) => {
      const shape = SHAPES[index as number] ?? '';
      const mismatches = CONTEXTS.map(([before, after], contextIndex) =>
        firstMismatch(
          `${before}${shape}${after}`,
          contextIndex === (index as number) % CONTEXTS.length,
        ),
      );
      expect(mismatches.filter((found) => found !== undefined)).toEqual([]);
    },
  );

  it('in up to nine uneven pieces, cut at random', () => {
    let seed = 7;
    const random = (below: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((seed / 2_147_483_648) * below);
    };
    const texts = [
      ...PAIR_NAMES.flatMap((name) =>
        SEPARATORS.map((separator, index) => `see ${name}${separator}${PAIR_VALUES[index % 4]} ok`),
      ),
      ...SHAPES.flatMap((shape) => CONTEXTS.map(([before, after]) => `${before}${shape}${after}`)),
    ];
    const mismatches: string[] = [];
    for (const text of texts) {
      const scrubbed = scrubSecretValues(text);
      const whole = `${scrubbed.value} (${scrubbed.redactedValues})`;
      for (let round = 0; round < 20; round += 1) {
        const cuts = Array.from({ length: 1 + random(8) }, () => random(text.length + 1));
        cuts.sort((a, b) => a - b);
        if (streamedAt(text, cuts) !== whole) {
          mismatches.push(`${JSON.stringify(text)} split at ${cuts.join(', ')}`);
          break;
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('createSecretStreamScrubber — the stream stays live', () => {
  it('emits Chinese prose as it arrives — no spaces does not mean held back', () => {
    const scrubber = createSecretStreamScrubber();
    for (const char of '图里没有这类关系。') expect(scrubber.push(char).value).toBe(char);
  });

  it('holds back only the word being written', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push('hello wor').value).toBe('hello ');
    expect(scrubber.push('ld and').value).toBe('world ');
    expect(scrubber.flush().value).toBe('and');
  });

  it('past its bound it drops what it held and emits nothing more until flushed', () => {
    const scrubber = createSecretStreamScrubber();
    expect(scrubber.push(`start ${'A'.repeat(STREAM_HOLD_MAX_CHARS + 1)}`)).toEqual({
      value: `start ${REDACTED}`,
      redactedValues: 1,
    });
    expect(scrubber.push(' more text ').value).toBe('');
    expect(scrubber.flush().value).toBe('');
    expect(scrubber.push('next ').value).toBe('next ');
  });
});
