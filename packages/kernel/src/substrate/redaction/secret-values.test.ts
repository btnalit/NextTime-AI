import { createHash, randomBytes } from 'node:crypto';
import { namesASecretField } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  CUT_LOOKAHEAD_CHARS,
  HIGH_CONFIDENCE_SECRET_PATTERNS,
  MAX_SECRET_LITERALS,
  OMITTED,
  PLATFORM_API_KEY_PREFIX,
  PLATFORM_KEY_SHAPE_PATTERNS,
  REDACTED,
  SECRET_VALUE_PATTERNS,
  STORED_REWRITE_SECRET_PATTERNS,
  type Scrubbed,
  endsAQuotedValue,
  platformApiKeys,
  platformKeyShapes,
  redactSecretFieldsInJsonText,
  redactSecrets,
  repairSplitQuotedMasks,
  scrubOutsideSpans,
  scrubSecretLiterals,
  scrubSecretLiteralsIn,
  scrubSecretValues,
  scrubbedCut,
  secretFieldLiterals,
} from './index.js';

/** A Handle-shaped compact JWT. Synthetic — `.gitleaks.toml` allows this signature segment, and
 *  every other fixture here spells out `abcdefghijklmnopqrstuvwxyz`, which it allows too. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
/** A platform API key's shape (`generateApiKey`: 43 base64url characters). Synthetic — spells out
 *  `abcdefghijklmnopqrstuvwxyz` too. */
const PLATFORM_KEY = 'FAKE0123456789abcdefghijklmnopqrstuvwxyzXYZ';
/** 32 bytes in standard base64 — 43 characters, the last one's low bits zero, then `=` — the
 *  shape of a WireGuard public key. Synthetic. */
const WIREGUARD_KEY = 'FAKE0123456789abcdefghijklmnopqrstuvwxyzXYQ=';

describe('scrubSecretValues — the common ways a secret is written down', () => {
  it.each([
    ['a quoted .env line', `export API_TOKEN="${FAKE}"`, `export API_TOKEN="${REDACTED}"`],
    ['an unquoted env line', `PGPASSWORD=${FAKE} psql`, `PGPASSWORD=${REDACTED} psql`],
    ['a YAML env entry', `POSTGRES_PASSWORD: ${FAKE}`, `POSTGRES_PASSWORD: ${REDACTED}`],
    ['a YAML key', `  password: '${FAKE}'`, `  password: '${REDACTED}'`],
    ['an ini line', `aws_secret_access_key = ${FAKE}`, `aws_secret_access_key = ${REDACTED}`],
    ['a camelCase key', `clientSecret=${FAKE}`, `clientSecret=${REDACTED}`],
    ['an API key header', `X-Api-Key: ${FAKE}`, `X-Api-Key: ${REDACTED}`],
    ['a cookie header', `Cookie: nt_session=${FAKE}; theme=dark`, `Cookie: ${REDACTED}`],
    ['an Authorization header', `Authorization: Bearer ${HANDLE}`, `Authorization: ${REDACTED}`],
    ['a flag with a space', `psql --password ${FAKE} -h db`, `psql --password ${REDACTED} -h db`],
    ['a flag with =', `--api-key=${FAKE}`, `--api-key=${REDACTED}`],
    ['a Stripe key', `sk_live_${FAKE}`, REDACTED],
    [
      'a query string',
      `/cb?code=1&access_token=${FAKE}&x=1`,
      `/cb?code=1&access_token=${REDACTED}&x=1`,
    ],
    ['JSON text', `{"refreshToken": "${FAKE}", "n": 1}`, `{"refreshToken": "${REDACTED}", "n": 1}`],
    ['a Basic credential', 'Basic dXNlcjpwYXNzd29yZA==', `Basic ${REDACTED}`],
    ['a Handle after CJK text', `我的 Handle 是${HANDLE}。`, `我的 Handle 是${REDACTED}。`],
  ])('replaces %s', (_label, input, expected) => {
    expect(scrubSecretValues(input).value).toBe(expected);
  });

  describe('in JSON text and URL encoding (review #501 on #1571)', () => {
    const certain = (text: string) =>
      redactSecrets(text, { patterns: HIGH_CONFIDENCE_SECRET_PATTERNS });
    const stored = (text: string) =>
      scrubSecretValues(text, { patterns: STORED_REWRITE_SECRET_PATTERNS });

    // A tool's result is JSON text: a secret alone on its line of output follows `\n`, and the
    // letter or digit ending an escape or a URL-encoded byte is not the end of another word.
    it.each([
      [
        'a Handle on its own line',
        JSON.stringify({ stdout: `line1\n${HANDLE}\n` }),
        JSON.stringify({ stdout: `line1\n${REDACTED}\n` }),
      ],
      ['a Handle after \\uXXXX', `"\\uff1a${HANDLE}"`, `"\\uff1a${REDACTED}"`],
      ['a Handle in a query string', `q=my%20${HANDLE}`, `q=my%20${REDACTED}`],
      [
        'a vendor key on its own line',
        JSON.stringify(`a\nsk_live_${FAKE}`),
        JSON.stringify(`a\n${REDACTED}`),
      ],
      [
        'a vendor key after \\t',
        JSON.stringify(`a\tghp_${FAKE}`),
        JSON.stringify(`a\t${REDACTED}`),
      ],
      ['a vendor key URL-encoded', `keys%2Fsk-proj-${FAKE}`, `keys%2F${REDACTED}`],
    ])('hides %s — in every set', (_label, text, expected) => {
      expect(scrubSecretValues(text)).toEqual({ value: expected, redactedValues: 1 });
      expect(certain(text)).toMatchObject({ value: expected, redactedValues: 1 });
      expect(stored(text)).toEqual({ value: expected, redactedValues: 1 });
    });

    it.each([
      ['a Handle after a backslash and a letter that is no JSON escape', `\\a${HANDLE}`],
      ['a vendor prefix ending another word', `ask_live_${FAKE}`],
      ['a vendor prefix after % and one hex digit', `a%2sk_live_${FAKE}`],
    ])('leaves %s', (_label, text) => {
      expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
      expect(certain(text)).toMatchObject({ value: text, redactedValues: 0 });
    });
  });

  // Found by the stream's split-everywhere property test: the stream redacted these, the whole
  // text did not — a pair whose name is not a secret's took the secret's pair as its value.
  it.each([
    ['after a prose label', `I don't know: token=${FAKE} ok`, `I don't know: token=${REDACTED} ok`],
    ['in a non-secret value', `note: password=${FAKE}`, `note: password=${REDACTED}`],
    ['in a JSON string', `{"note": "token=${FAKE}"}`, `{"note": "token=${REDACTED}"}`],
    [
      'in a URL value',
      `url: https://x/?token=${FAKE}&y=1`,
      `url: https://x/?token=${REDACTED}&y=1`,
    ],
    ['after a flag', `--user --password ${FAKE}`, `--user --password ${REDACTED}`],
    ['in an env value', `X=PGPASSWORD=${FAKE}`, `X=PGPASSWORD=${REDACTED}`],
    ['after a JSON string', `{"a": "token": "x y"}`, `{"a": "token": "${REDACTED}"}`],
  ])('replaces a secret pair %s', (_label, input, expected) => {
    expect(scrubSecretValues(input).value).toBe(expected);
  });

  it.each([
    'max_tokens=1024 and tokenCount: 3',
    'Basic configuration comes first; a Bearer instrument is a bond.',
    'HOME=/workspace\nPWD=/workspace\nKERNEL_URL=http://kernel:8080',
    'https://example.test/path?page=2&sort=name',
    'the depends_on edge: kernel → postgres',
    '{"tokensUsed": 1234, "name": "list_facts"}',
  ])('leaves ordinary text alone: %s', (text) => {
    expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
  });

  // Legacy 420: every read shows free text scrubbed, and the console may send a scrubbed text back
  // (an Operation description's edit dialog prefills it) to a write that refuses a credential.
  it.each([
    `Authorization: Bearer ${HANDLE}`,
    `Authorization:   token ${FAKE}`,
    `Cookie: nt_session=${FAKE}`,
    `PGPASSWORD=${FAKE} psql`,
    `  password: '${FAKE}'`,
    `psql --password ${FAKE} -h db`,
    `see https://ops:${FAKE}@db.example/x`,
    `{"refreshToken": "${FAKE}"}`,
  ])('finds nothing to replace in its own output: %s', (text) => {
    const once = scrubSecretValues(text).value;
    expect(scrubSecretValues(once)).toEqual({ value: once, redactedValues: 0 });
  });

  // …but a header whose value only starts with the mark still hides the rest of its line.
  it.each([
    [`Cookie: [redacted]; sid=${FAKE}`, 'Cookie: [redacted]'],
    [`Authorization: [redacted] token ${FAKE}`, 'Authorization: [redacted]'],
    [`Authorization: [redacted] ${FAKE}\nnext line`, 'Authorization: [redacted]\nnext line'],
  ])('replaces what follows the mark on a header line: %s', (text, expected) => {
    expect(scrubSecretValues(text)).toEqual({ value: expected, redactedValues: 1 });
  });

  it('cannot see an encoded secret — the reason the fix is the Handle itself, not this', () => {
    const encoded = Buffer.from(HANDLE).toString('base64');
    expect(scrubSecretValues(encoded).value).toBe(encoded);
    expect(scrubSecretValues([...HANDLE].join(' ')).redactedValues).toBe(0);
  });
});

/**
 * A random value, drawn again while it spells out a vendor key's prefix where a word starts
 * (`sk-`, `ghp_`, …: `VENDOR_KEY` in secret-values.ts). A digest that does is taken by the vendor
 * rule, by that prefix and not by its shape — rarely, but often enough across 2,000 draws to fail
 * a run now and then (review #501 on #1571: about 2% of runs).
 */
function drawWithoutVendorPrefix(draw: () => string): string {
  const VENDOR_PREFIX =
    /\b(?:sk-|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|hf_)/;
  for (;;) {
    const value = draw();
    if (!VENDOR_PREFIX.test(value)) return value;
  }
}

describe('a platform API key standing alone (legacy 168)', () => {
  const certain = (text: string) =>
    redactSecrets(text, { patterns: HIGH_CONFIDENCE_SECRET_PATTERNS });

  it.each([
    ['in a sentence', `my key is ${PLATFORM_KEY}, keep it`, `my key is ${REDACTED}, keep it`],
    ['alone', PLATFORM_KEY, REDACTED],
    ['in quotes', `"${PLATFORM_KEY}"`, `"${REDACTED}"`],
    ['after a colon in CJK text', `密钥：${PLATFORM_KEY}。`, `密钥：${REDACTED}。`],
    ['with - and _ only', `${PLATFORM_KEY.slice(0, 41)}-_`, REDACTED],
    ['in a JSON string', `{"k":"${PLATFORM_KEY}"}`, `{"k":"${REDACTED}"}`],
    ['in parentheses, before a comma', `(${PLATFORM_KEY}),`, `(${REDACTED}),`],
    // A tool's result is JSON text: a key on its own line of output follows `\n` (review #493 on
    // #1571), and Python's json.dumps writes `密钥：` as `\u5bc6\u94a5\uff1a`.
    [
      'on its own line of JSON text',
      JSON.stringify({ stdout: `line1\n${PLATFORM_KEY}\n` }),
      JSON.stringify({ stdout: `line1\n${REDACTED}\n` }),
    ],
    ['after a \\uXXXX escape', `"\\uff1a${PLATFORM_KEY}"`, `"\\uff1a${REDACTED}"`],
  ])(
    'is replaced %s — hidden, never refused by the high-confidence set',
    (_label, text, expected) => {
      expect(scrubSecretValues(text)).toEqual({ value: expected, redactedValues: 1 });
      expect(certain(text)).toMatchObject({ value: text, redactedValues: 0 });
    },
  );

  it('a minted key always has the shape, bar about one in 7,500 that lacks a digit, - and _', () => {
    // generateApiKey's own recipe: 32 random bytes, base64url.
    let missed = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const key = randomBytes(32).toString('base64url');
      expect(key).toHaveLength(43);
      if (scrubSecretValues(`key ${key}`).value !== `key ${REDACTED}`) missed += 1;
    }
    // Expected about 0.27 misses in 2,000; more than 5 has odds of about 4 in 10 million.
    expect(missed).toBeLessThanOrEqual(5);
  });

  it.each([
    ['one character short', PLATFORM_KEY.slice(0, 42)],
    ['one character long', `${PLATFORM_KEY}x`],
    ['inside a longer run', `a-${PLATFORM_KEY}`],
    ['all lower case (a word run, a hex digest)', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq'],
    ['letters only, no digit, - or _', 'AbcdefghijklmnopqrstuvwxyzAbcdefghijklmnopq'],
    ['a sha-256 hex digest', `sha256:${'0123456789abcdef'.repeat(4)}`],
    ['lower case and digits, no upper case', 'abcdefghijklmnopqrstuvwxyz0123456789abcdefg'],
    // 32 bytes in standard base64 are 43 characters and `=`: the next character is the padding.
    ['a WireGuard public key in a config line', `PublicKey = ${WIREGUARD_KEY}`],
    ['a SHA-256 digest header', `Digest: SHA-256=${WIREGUARD_KEY}`],
    ['a 32-byte value in standard base64, alone', WIREGUARD_KEY],
    ['between a + and a / in a longer base64 run', `QUJD+${PLATFORM_KEY}/REVG`],
    ['after a / in a base64 run', `QUJD/${PLATFORM_KEY}`],
    ['before a + in a base64 run', `${PLATFORM_KEY}+REVG`],
    // A URL-encoded byte may stand for `/` or `+`, which this shape is not taken after.
    ['after a URL-encoded /', `keys%2F${PLATFORM_KEY}`],
  ])('is not matched %s', (_label, text) => {
    expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
    expect(certain(text)).toMatchObject({ value: text, redactedValues: 0 });
  });

  it('a 32-byte value in standard base64 (a WireGuard key, a SHA-256= digest) is never one', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const value = randomBytes(32).toString('base64');
      expect(value).toHaveLength(44);
      for (const text of [
        value,
        `PublicKey = ${value}`,
        `Digest: SHA-256=${value}, sent`,
        JSON.stringify(`[Peer]\nPublicKey =\n${value}`),
      ]) {
        expect(scrubSecretValues(text).redactedValues).toBe(0);
        expect(certain(text).redactedValues).toBe(0);
      }
    }
  });

  it('any 32 bytes in base64url (a SHA-256 digest, a JWK public key) is hidden but never refused', () => {
    // The same shape as a key, so the full set hides it (the accepted over-redaction) …
    expect(scrubSecretValues(`{"kty":"OKP","crv":"Ed25519","x":"${PLATFORM_KEY}"}`)).toEqual({
      value: `{"kty":"OKP","crv":"Ed25519","x":"${REDACTED}"}`,
      redactedValues: 1,
    });
    // … and the high-confidence set, which refuses a call outright, never matches it.
    for (let i = 0; i < 2_000; i += 1) {
      const digest = drawWithoutVendorPrefix(() =>
        createHash('sha256').update(randomBytes(16)).digest('base64url'),
      );
      const x = drawWithoutVendorPrefix(() => randomBytes(32).toString('base64url'));
      for (const text of [
        digest,
        `eventId ${digest}`,
        `sha256-${digest}`,
        `{"kty":"OKP","crv":"Ed25519","x":"${x}"}`,
      ]) {
        expect(certain(text).redactedValues).toBe(0);
      }
    }
  });

  it('a rewrite of stored rows leaves the shape and counts it instead (legacy 168 review)', () => {
    const stored = `digest ${PLATFORM_KEY}, then CAPABILITY_HANDLE=${HANDLE}`;
    expect(scrubSecretValues(stored, { patterns: STORED_REWRITE_SECRET_PATTERNS })).toEqual({
      value: `digest ${PLATFORM_KEY}, then CAPABILITY_HANDLE=${REDACTED}`,
      redactedValues: 1,
    });
    expect(
      scrubSecretValues(stored, { patterns: PLATFORM_KEY_SHAPE_PATTERNS }).redactedValues,
    ).toBe(1);
    // Every other pattern is kept, in order.
    expect(STORED_REWRITE_SECRET_PATTERNS).toHaveLength(SECRET_VALUE_PATTERNS.length - 1);
    expect(
      SECRET_VALUE_PATTERNS.filter((p) => !STORED_REWRITE_SECRET_PATTERNS.includes(p)),
    ).toEqual(PLATFORM_KEY_SHAPE_PATTERNS);
  });

  it('platformKeyShapes gives the values the shape-only scrub replaces, as written and in order', () => {
    const other = `${PLATFORM_KEY.slice(0, 40)}-_Q`;
    const text = `first ${PLATFORM_KEY}, then {"x":"${other}"}; not ${WIREGUARD_KEY} nor a-${PLATFORM_KEY}`;
    expect(platformKeyShapes(text)).toEqual([PLATFORM_KEY, other]);
    expect(scrubSecretValues(text, { patterns: PLATFORM_KEY_SHAPE_PATTERNS }).redactedValues).toBe(
      2,
    );
    expect(platformKeyShapes(`Bearer ${PLATFORM_KEY}`)).toEqual([PLATFORM_KEY]);
    expect(platformKeyShapes(WIREGUARD_KEY)).toEqual([]);
    // Minted keys, alone and in text: as many as the scrub counts, each the key itself.
    for (let i = 0; i < 500; i += 1) {
      const key = randomBytes(32).toString('base64url');
      const sample = `k=${key} ${randomBytes(32).toString('base64')} (${key})`;
      const found = platformKeyShapes(sample);
      expect(found).toHaveLength(
        scrubSecretValues(sample, { patterns: PLATFORM_KEY_SHAPE_PATTERNS }).redactedValues,
      );
      for (const shape of found) expect(shape).toBe(key);
    }
  });

  it('no stretch of a 4 KB standard base64 block is one — on one line or folded as PEM', () => {
    for (let i = 0; i < 300; i += 1) {
      const block = randomBytes(3_072).toString('base64');
      expect(block).toHaveLength(4_096);
      const pem = [
        '-----BEGIN CERTIFICATE-----',
        ...(block.match(/.{1,64}/g) ?? []),
        '-----END CERTIFICATE-----',
      ].join('\n');
      for (const text of [
        block,
        `data:application/octet-stream;base64,${block}`,
        pem,
        JSON.stringify({ stdout: pem }),
      ]) {
        expect(scrubSecretValues(text).redactedValues).toBe(0);
        expect(certain(text).redactedValues).toBe(0);
      }
    }
  });
});

describe('a platform API key with its prefix (legacy 906)', () => {
  const certain = (text: string) =>
    redactSecrets(text, { patterns: HIGH_CONFIDENCE_SECRET_PATTERNS });
  const stored = (text: string) =>
    scrubSecretValues(text, { patterns: STORED_REWRITE_SECRET_PATTERNS });
  const KEY = `ntk_${PLATFORM_KEY}`;

  it.each([
    ['alone', KEY, REDACTED],
    ['in a sentence', `my key is ${KEY}, keep it`, `my key is ${REDACTED}, keep it`],
    ['in a JSON string', `{"k":"${KEY}"}`, `{"k":"${REDACTED}"}`],
    ['after CJK text', `密钥：${KEY}。`, `密钥：${REDACTED}。`],
    ['after `_` in a longer run', `call_${KEY}`, `call_${REDACTED}`],
    ['after `/` in a URL path', `/keys/${KEY}/x`, `/keys/${REDACTED}/x`],
    ['after `-`', `x-${KEY}`, `x-${REDACTED}`],
    ['with more after it', `${KEY}tail`, `${REDACTED}tail`],
    ['all lower case after the prefix', `ntk_${'a'.repeat(43)}`, REDACTED],
    // A letter or a digit that ends a JSON escape or a URL-encoded byte stands for what precedes
    // the key (review #493 on #1571): a tool's result is JSON text, a key on its own line of
    // output follows `\n`, and Python's json.dumps writes `密钥：` as `\u5bc6\u94a5\uff1a`.
    [
      'on its own line of JSON text',
      JSON.stringify({ stdout: `line1\n${KEY}\n` }),
      JSON.stringify({ stdout: `line1\n${REDACTED}\n` }),
    ],
    ['after \\t in JSON text', JSON.stringify(`a\t${KEY}`), JSON.stringify(`a\t${REDACTED}`)],
    ['after \\r in JSON text', JSON.stringify(`a\r${KEY}`), JSON.stringify(`a\r${REDACTED}`)],
    ['after \\b in JSON text', JSON.stringify(`a\b${KEY}`), JSON.stringify(`a\b${REDACTED}`)],
    ['after \\f in JSON text', JSON.stringify(`a\f${KEY}`), JSON.stringify(`a\f${REDACTED}`)],
    [
      'after \\uXXXX escapes',
      `"\\u5bc6\\u94a5\\uff1a${KEY}"`,
      `"\\u5bc6\\u94a5\\uff1a${REDACTED}"`,
    ],
    ['after a URL-encoded space', `q=my%20${KEY}`, `q=my%20${REDACTED}`],
    ['after a URL-encoded /', `keys%2F${KEY}`, `keys%2F${REDACTED}`],
  ])(
    'is hidden %s — by the full set, refused by the high-confidence set, rewritten in stored rows',
    (_label, text, expected) => {
      expect(scrubSecretValues(text)).toEqual({ value: expected, redactedValues: 1 });
      expect(certain(text)).toMatchObject({ value: expected, redactedValues: 1 });
      expect(stored(text)).toEqual({ value: expected, redactedValues: 1 });
    },
  );

  it.each([
    ['one character short', `ntk_${PLATFORM_KEY.slice(0, 42)}`],
    ['after a letter, the end of another word', `agentk_${PLATFORM_KEY}`],
    ['after a digit', `2ntk_${PLATFORM_KEY}`],
    ['in upper case', `NTK_${PLATFORM_KEY}`],
    ['after a backslash and a letter that is no JSON escape', `\\antk_${PLATFORM_KEY}`],
    ['after a \\u escape one hex digit short', `x\\u4e2ntk_${PLATFORM_KEY}`],
    ['after % and one hex digit', `a%2ntk_${PLATFORM_KEY}`],
  ])('is not matched %s', (_label, text) => {
    expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
    expect(certain(text)).toMatchObject({ value: text, redactedValues: 0 });
  });

  it('a minted key always has it, never the bare shape, and is the key platformApiKeys gives', () => {
    // generateApiKey's own recipe (application/gateway/auth.ts).
    for (let i = 0; i < 2_000; i += 1) {
      const key = `${PLATFORM_API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
      expect(key).toHaveLength(47);
      for (const scrub of [scrubSecretValues, certain, stored]) {
        expect(scrub(`key ${key}.`)).toMatchObject({
          value: `key ${REDACTED}.`,
          redactedValues: 1,
        });
      }
      expect(platformKeyShapes(key)).toEqual([]);
      expect(platformApiKeys(`k=${key} (${key})`)).toEqual([key, key]);
    }
  });

  it('is hidden whole when its body spells a vendor key (`-sk-` and 16 more; review #501 on #1571)', () => {
    // 43 characters, upper and lower case and digits: the vendor rule alone would take `sk-…XY`.
    const body = 'FAKE-sk-abcdefghijklmnopqrstuvwxyz0123456XY';
    expect(body).toHaveLength(43);
    for (const scrub of [scrubSecretValues, certain, stored]) {
      expect(scrub(`key ntk_${body}.`)).toMatchObject({
        value: `key ${REDACTED}.`,
        redactedValues: 1,
      });
    }
    // The shape minted before the prefix, likewise — hidden whole by the full set.
    expect(scrubSecretValues(`key ${body}.`)).toEqual({
      value: `key ${REDACTED}.`,
      redactedValues: 1,
    });
  });

  it('platformApiKeys gives prefixed keys and pre-prefix shapes as written, in order', () => {
    const text = `old ${PLATFORM_KEY}, new ${KEY}; call_${KEY} not ${WIREGUARD_KEY} nor agentk_${PLATFORM_KEY}`;
    expect(platformApiKeys(text)).toEqual([PLATFORM_KEY, KEY, KEY]);
    expect(platformKeyShapes(text)).toEqual([PLATFORM_KEY]);
    expect(platformApiKeys('nothing here')).toEqual([]);
    const json = JSON.stringify({ stdout: `${PLATFORM_KEY}\n${KEY}\n` });
    expect(platformApiKeys(json)).toEqual([PLATFORM_KEY, KEY]);
    expect(platformKeyShapes(json)).toEqual([PLATFORM_KEY]);
  });
});

describe('scrubSecretValues — linear time on adversarial input', () => {
  /** 200 KB of `unit` repeated. Each shape below took the previous patterns seconds (the review's
   *  probes: `a.` 26 s at 200 KB); a linear pattern does any of them in a few milliseconds. */
  const SIZE = 200_000;
  const repeat = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

  it.each([
    'a.',
    'ab-',
    '-eyJ',
    'eyJaaaaaaa.',
    'X_TOKEN',
    'A="',
    'A=a ',
    '"a":"',
    '"token',
    'password=',
    'password: "x" ',
    '--password ',
    'a: ',
    '--a ',
    '"a": ',
    'note: password=',
    'a://b:',
    'sk-',
    'Basic ',
    'Bearer aaaaaaa ',
    'authorization ',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Ab1',
    `${'Ab1'.repeat(14)}A `,
    'ntk_',
    '_ntk_a',
    `ntk_${'a'.repeat(42)} `,
    '\\n',
    '\\nntk_',
    '\\u00e9ntk_',
    '%2Fntk_',
    `\\n${'Ab1'.repeat(15)}`,
    '\\neyJ',
    '%20eyJaaaaaa.',
    '\\nsk-',
    '%2Fsk_live_',
    'A=\\"',
    'A=\\"a',
    'A=\\"a\\"',
    'password: \\"x\\" ',
    '--password \\"',
    'password=\\"a b ',
    'A=\\\\\\"',
    'A=\\\\\\"a\\"',
    'A=\\\\',
    'A=\\\\\\\\\\\\\\"a ',
    'password: \\\\\\"x\\\\\\" ',
    '\\"password\\":',
    '\\"password\\": \\"',
    '{\\"password\\":\\"\\\\',
    '{\\"password\\":\\"a\\\\\\"',
    '\\"a\\": \\"',
    'A="a ',
    "password: 'a ",
    '{"session cookie": "a ',
    '{\\"session cookie\\": \\"a ',
    'A=a\\\\\\',
    'A=\\\\"a ',
    'password: \\\\\\"a\\',
    'password: "\\"',
    'A="a\\',
    '"password":"a\\\\',
    'password: "a\\" ',
    'password="a\\" token=" ',
    'API_TOKEN="\\" "k" : "',
    'password="\\" a, --b ',
    // The next pair's '…' value looked into for a quote (legacy 926), and an escaped key's `=`.
    'password="a token=\'"',
    'token: "a\\" --token \'"',
    'password=\\"a --token \'"',
    'A=\\"a API_TOKEN=\'"b\\"',
    'password="a\\" token=\'b',
    'token=\'" ',
    '\\"password\\" = \\"',
    // Pairs read together that cross, a bare value that stops before the next pair, and a secret
    // key after `\"` (legacy 928, 929).
    '"api_key": "\'.API_TOKEN="',
    '--token "a API_TOKEN="',
    '--token "a API_TOKEN="b --token "',
    "password='a API_TOKEN='",
    'token=x,api_key="',
    'token=A_TOKEN="',
    '--token x,--password "',
    'token: \\"password":',
    'token: \\"password" = ',
    // A next pair's name against a bare value, and a pattern that reads on from where a match
    // ended before one crossed it (review #493 on #1586).
    '--password=a--api-key="',
    'token=;a',
    "--token TOKEN='token':",
    "TOKEN='t':",
  ])('%j × 200 KB within 1 s', (unit) => {
    const text = repeat(unit);
    scrubSecretValues(text.slice(0, 1_000));
    const started = performance.now();
    scrubSecretValues(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  // One long run, not a short unit repeated: a closing run read back from each place in a line
  // of backslashes, as long as the run that opened it (review #501 on #1577: 1.9 s at 200 KB).
  const run = (length: number) => '\\'.repeat(length);
  it.each([
    ['a run, a quote and a run twice as long', `password: ${run(66_667)}"${run(133_334)}`],
    ['an env line', `API_TOKEN=${run(66_667)}"${run(133_334)}`],
    ['a --password flag', `--password ${run(66_667)}"${run(133_334)}`],
    ['a closing run one short', `password: ${run(50_001)}"${run(50_000)}"${'x'.repeat(100_000)}`],
    ['JSON text in a string', `{\\"password\\":\\"${run(199_970)}`],
    // A next pair's '…' value read to the line's end for its closing quote, once (legacy 926).
    ["a next pair's value never closed", `password="a\\" token='"${'x'.repeat(199_970)}`],
    ['many next pairs, one value', `password="a${` token='"${'x'.repeat(30)}`.repeat(5_000)}`],
    // Pairs inside the value of the pair they cross, each read on from where it ends (legacy 928).
    ['pairs inside a value they cross', `password="a${' API_TOKEN="x'.repeat(16_000)}"`],
    [
      '--flags inside a value they cross',
      `--token "a${' API_TOKEN="x --password "y'.repeat(7_000)}"`,
    ],
    // The blanks before the end of a value not closed, read once (review #501 on #1583).
    ['blanks in a value not closed', `token: \\"a${' \t'.repeat(99_000)}x`],
    // Matches left out inside one that crossed, each read on from where it ended before.
    ["'…' values that cross a --flag's", `--token ${"TOKEN='t':".repeat(20_000)}`],
  ])('%s × 200 KB within 1 s', (_name, text) => {
    scrubSecretValues(text.slice(0, 1_000));
    const started = performance.now();
    scrubSecretValues(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('a quoted value written inside a string: \\"…\\" (legacy 918)', () => {
  it.each([
    ['a shell command', `sh -c "export API_TOKEN=\\"${FAKE}\\" && run"`],
    ['a compose command', `command: "PGPASSWORD=\\"${FAKE} x\\" psql"`],
    ['source code', `const s = "password: \\"${FAKE} x\\"";`],
    ['a --password flag', `run --password \\"${FAKE} x\\" now`],
    ['a --api-key= flag', `run --api-key=\\"${FAKE}\\" now`],
    ['a Makefile line', `\tAPI_KEY=\\"${FAKE}\\" ./build`],
    ['a header', `-H "X-Api-Key: \\"${FAKE}\\""`],
  ])('hides the value whole, its quotes kept: %s', (_label, text) => {
    const once = scrubSecretValues(text);
    expect(once.redactedValues).toBe(1);
    expect(once.value).not.toContain(FAKE);
    expect(once.value).toBe(text.replace(/\\"[^"]*\\"/, `\\"${REDACTED}\\"`));
    expect(scrubSecretValues(once.value)).toEqual({ value: once.value, redactedValues: 0 });
  });

  it('takes the value to the next \\" on its line, as "…" to the next "', () => {
    expect(scrubSecretValues(`API_TOKEN=\\"${FAKE}\\" and \\"note\\"`).value).toBe(
      `API_TOKEN=\\"${REDACTED}\\" and \\"note\\"`,
    );
    expect(scrubSecretValues('note=\\"a b\\" API_TOKEN=\\"\\"')).toEqual({
      value: `note=\\"a b\\" API_TOKEN=\\"${REDACTED}\\"`,
      redactedValues: 1,
    });
  });

  it('stops at its line and at the first quote not escaped (review #493, #501 on #1575)', () => {
    // No closing \" on its line: read as before, the next line kept.
    expect(scrubSecretValues('API_TOKEN=\\"a b\nrun \\"x\\"').value).toContain('\nrun \\"x\\"');
    expect(scrubSecretValues('export API_TOKEN=\\"a" b && echo \\"done\\"').value).toContain(
      ' b && echo \\"done\\"',
    );
  });

  it('leaves a name that is not a secret, and a value already hidden, as it is', () => {
    for (const text of [
      'note=\\"a b\\" max_tokens: \\"1024\\"',
      `API_TOKEN=\\"${REDACTED}\\" --password \\"${REDACTED}\\"`,
    ]) {
      expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
    }
  });
});

describe('a value written inside a string twice over, and JSON text inside a string (review #501 on #1575)', () => {
  it.each([
    [
      'a JSON string printed in a log',
      `"cmd": "export API_TOKEN=\\\\\\"${FAKE}\\\\\\""`,
      `"cmd": "export API_TOKEN=\\\\\\"${REDACTED}\\\\\\""`,
    ],
    [
      'spaces in it',
      `"cmd": "run --password \\\\\\"${FAKE} x\\\\\\" now"`,
      `"cmd": "run --password \\\\\\"${REDACTED}\\\\\\" now"`,
    ],
    [
      'a YAML key',
      `"line": "password: \\\\\\"${FAKE}\\\\\\""`,
      `"line": "password: \\\\\\"${REDACTED}\\\\\\""`,
    ],
    [
      'three times over',
      `API_TOKEN=\\\\\\\\\\\\\\"${FAKE}\\\\\\\\\\\\\\" b`,
      `API_TOKEN=\\\\\\\\\\\\\\"${REDACTED}\\\\\\\\\\\\\\" b`,
    ],
    [
      'a JSON body in a log',
      `payload={\\"password\\":\\"${FAKE}\\",\\"x\\":\\"y\\"}`,
      `payload={\\"password\\":\\"${REDACTED}\\",\\"x\\":\\"y\\"}`,
    ],
    [
      'a key in words, escapes of the inner text in the value',
      `{\\"client secret\\" : \\"a b\\\\\\"c\\\\\\\\ d\\\\n${FAKE}\\"}`,
      `{\\"client secret\\" : \\"${REDACTED}\\"}`,
    ],
    [
      'after a quoted value of another key',
      `{\\"note\\":\\"say \\\\\\"hi\\\\\\"\\",\\"token\\":\\"${FAKE}\\"}`,
      `{\\"note\\":\\"say \\\\\\"hi\\\\\\"\\",\\"token\\":\\"${REDACTED}\\"}`,
    ],
  ])('hides the value whole, its quotes kept: %s', (_label, text, hidden) => {
    expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
    expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
  });

  it('takes a value to the next quote, which the run it opened with closes', () => {
    expect(scrubSecretValues(`API_TOKEN=\\\\\\"a b\\\\\\" c \\\\\\"d\\\\\\"`).value).toBe(
      `API_TOKEN=\\\\\\"${REDACTED}\\\\\\" c \\\\\\"d\\\\\\"`,
    );
    expect(scrubSecretValues(`{\\"password\\":\\"a\\",\\"b\\":\\"c\\"}`).value).toBe(
      `{\\"password\\":\\"${REDACTED}\\",\\"b\\":\\"c\\"}`,
    );
  });

  it('leaves a key that is not a secret, a value already hidden, and a key with no value', () => {
    for (const text of [
      `{\\"user\\":\\"bob\\",\\"max_tokens\\":\\"1024\\"}`,
      `{\\"password\\":\\"${REDACTED}\\"} API_TOKEN=\\\\\\"${REDACTED}\\\\\\"`,
      `\\"password\\" and \\"x\\"`,
    ]) {
      expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
    }
  });
});

describe('a quoted value whose closing quote is not on its line (legacy 921)', () => {
  it.each([
    [
      'tool output cut short',
      `export API_TOKEN=\\"${FAKE} and the rest`,
      `export API_TOKEN=\\"${REDACTED}`,
    ],
    [
      'written inside a string',
      `sh -c "export API_TOKEN=\\\"${FAKE} x`,
      `sh -c "export API_TOKEN=\\\"${REDACTED}`,
    ],
    ['twice over', `API_TOKEN=\\\\\\"${FAKE} x`, `API_TOKEN=\\\\\\"${REDACTED}`],
    ['a --password flag', `run --password \\"${FAKE}`, `run --password \\"${REDACTED}`],
    [
      'closed after a carriage return',
      `API_TOKEN=\\"${FAKE}\r\\" b`,
      `API_TOKEN=\\"${REDACTED}\r\\" b`,
    ],
    [
      'going on to the next line',
      `password=\\"${FAKE} a\n b\\" c`,
      `password=\\"${REDACTED}\n b\\" c`,
    ],
    [
      'inside a JSON string, to its quote',
      `{"cmd":"PASSWORD=\\"${FAKE}","x":1}`,
      `{"cmd":"PASSWORD=\\"${REDACTED}","x":1}`,
    ],
    [
      'JSON text cut short',
      `{"user":"bob","password": "${FAKE} a`,
      `{"user":"bob","password": "${REDACTED}`,
    ],
    [
      'a JSON key in words, a backslash last',
      `{"session cookie": "${FAKE} a\\`,
      `{"session cookie": "${REDACTED}\\`,
    ],
    [
      'JSON text inside a string, cut short',
      `payload={\\"session cookie\\":\\"${FAKE} a`,
      `payload={\\"session cookie\\":\\"${REDACTED}`,
    ],
    [
      'JSON text inside a string, to an unescaped quote',
      `log "{\\"client secret\\":\\"${FAKE}" x`,
      `log "{\\"client secret\\":\\"${REDACTED}" x`,
    ],
  ])(
    'hides it to the end of its line, with no closing quote written: %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    [
      'a name',
      `API_TOKEN=\\"abc password="${FAKE}"`,
      `API_TOKEN=\\"${REDACTED} password="${REDACTED}"`,
    ],
    [
      'a --flag',
      `run --password \\"abc --token "${FAKE}"`,
      `run --password \\"${REDACTED} --token "${REDACTED}"`,
    ],
    [
      'a --flag after a dot',
      `my.token=\\".--password="${FAKE}"`,
      `my.token=\\"${REDACTED}--password="${REDACTED}"`,
    ],
    [
      'an env name',
      `PASSWORD=\\"abc API_TOKEN="${FAKE}"`,
      `PASSWORD=\\"${REDACTED} API_TOKEN="${REDACTED}"`,
    ],
    [
      'a quoted key',
      `token=\\"abc 'password': "${FAKE}"`,
      `token=\\"${REDACTED} 'password': "${REDACTED}"`,
    ],
    [
      'a tab and spaces',
      `token=\\"abc \t password = "${FAKE}"`,
      `token=\\"${REDACTED} \t password = "${REDACTED}"`,
    ],
  ])(
    'ends before the next pair, whose value it read on to and kept (after legacy 921): %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it('reads on past what no value rule takes for a name, to its first quote, as it did', () => {
    expect(scrubSecretValues(`token=\\"a _k: "b ${FAKE}`).value).toBe(
      `token=\\"${REDACTED}"b ${FAKE}`,
    );
    expect(scrubSecretValues(`token=\\"a note: c ${FAKE}`).value).toBe(`token=\\"${REDACTED}`);
  });

  it('still writes the closing quote of a value closed on its line', () => {
    expect(scrubSecretValues(`password="${FAKE}" b="c`).value).toBe(`password="${REDACTED}" b="c`);
    expect(scrubSecretValues(`{"session cookie": "${FAKE}", "a": ""}`).value).toBe(
      `{"session cookie": "${REDACTED}", "a": ""}`,
    );
    expect(scrubSecretValues('{"session cookie": "", "password": ""}').value).toBe(
      `{"session cookie": "${REDACTED}", "password": "${REDACTED}"}`,
    );
  });

  it('never takes into a bare value the \\ of a \\" that ends it, but a pair of its own', () => {
    for (const [text, hidden] of [
      [`-e \\"API_TOKEN=${FAKE}\\" -e`, `-e \\"API_TOKEN=${REDACTED}\\" -e`],
      [`-e \\"API_TOKEN=${FAKE}\\\\\\" -e`, `-e \\"API_TOKEN=${REDACTED}\\" -e`],
      [`{"cmd":"PASSWORD=${FAKE}\\\\","x":1}`, `{"cmd":"PASSWORD=${REDACTED}","x":1}`],
      [`password=${FAKE}\\\\\\x`, `password=${REDACTED}`],
      [`export API_TOKEN=${FAKE}\\x${FAKE}`, `export API_TOKEN=${REDACTED}`],
      [`{"cmd":"run --password ${FAKE}\\\\","x":1}`, `{"cmd":"run --password ${REDACTED}","x":1}`],
      [`sh -c \\"run --password ${FAKE}\\" x`, `sh -c \\"run --password ${REDACTED}\\" x`],
    ] as const) {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
    }
  });

  it('leaves a quote with nothing after it on its line', () => {
    for (const text of [
      'password="',
      "API_TOKEN='\nb",
      'API_TOKEN=\\"\r\n',
      '{"client secret": "',
      '{\\"client secret\\": \\"\nb',
    ]) {
      expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
    }
  });

  // A `"` or `'` with no close on its line is no value: here it closes a prompt or a label that
  // ends with a name and its separator (review #501 on #1577), and the stored rewrite would cut
  // the rows for good.
  it('leaves a name quoted in code or a prompt, the quote after it one that closes', () => {
    for (const text of [
      'pw = input("Password:")',
      'read -sp "Password:" PW',
      'console.log("Password:", value);',
      '  "loginPrompt": "Enter password: ",',
      '{"label":"Password:"}',
      'The field labeled "API token:" is required.',
      "prompt('New secret: ');",
      '<input placeholder="Password:">',
      'msg="Password:" retry=3',
      'echo "API_TOKEN=" >> .env',
      "VALUES ('api_key=');",
    ]) {
      expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
    }
  });

  it('ends a value opened with backslashes where its string does, that \\ of a \\" kept', () => {
    for (const [text, hidden] of [
      [
        `{"cmd":"{\\"env\\":\\"password: \\\\\\"${FAKE}\\"}"}`,
        `{"cmd":"{\\"env\\":\\"password: \\\\\\"${REDACTED}\\"}"}`,
      ],
      [`password: \\\\\\"${FAKE}\\" b\\\\\\" c`, `password: \\\\\\"${REDACTED}\\" b\\\\\\" c`],
      [`password: \\\\\\"${FAKE}\\\\" b`, `password: \\\\\\"${REDACTED}" b`],
      [
        `password: ${'\\'.repeat(9)}"${FAKE}${'\\'.repeat(9)}" b`,
        `password: ${'\\'.repeat(9)}"${REDACTED}\\" b`,
      ],
    ] as const) {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    }
  });
});

describe('a quoted value with escaped quotes inside it (review #501 on #1577)', () => {
  it.each([
    ['JSON text', `{"password": "a \\"b ${FAKE}"}`, `{"password": "${REDACTED}"}`],
    [
      'a JSON key the name rule reads, more pairs after it',
      `{"api_key":"x\\"${FAKE}","user":"bob"}`,
      `{"api_key":"${REDACTED}","user":"bob"}`,
    ],
    ['a YAML key', `password: "a \\"b ${FAKE}"`, `password: "${REDACTED}"`],
    [
      'a shell string',
      `export PASSWORD="a\\"${FAKE}" && run`,
      `export PASSWORD="${REDACTED}" && run`,
    ],
    [
      'a --password flag',
      `run --password "a \\"b ${FAKE}" now`,
      `run --password "${REDACTED}" now`,
    ],
    [
      'escaped backslashes and a quote escaped once more',
      `{"user":"bob","password":"a\\\\\\"b ${FAKE}\\\\","x":1}`,
      `{"user":"bob","password":"${REDACTED}","x":1}`,
    ],
    [
      'a line break escaped before it (#493 on #1579)',
      `{"password": "a\\nb \\"c ${FAKE}"}`,
      `{"password": "${REDACTED}"}`,
    ],
  ])('hides it to the quote no backslash escapes: %s', (_label, text, hidden) => {
    expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
    expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
  });

  it('ends at an escaped backslash before its quote, and leaves what follows', () => {
    expect(scrubSecretValues(`{"password": "a \\\\", "x": "${FAKE}"}`).value).toBe(
      `{"password": "${REDACTED}", "x": "${FAKE}"}`,
    );
  });

  it('closes at the first quote, as before, when no quote no backslash escapes is on its line', () => {
    expect(scrubSecretValues('password="C:\\dir\\" x').value).toBe(`password="${REDACTED}" x`);
    expect(scrubSecretValues('password="a\\"b\nc" d').value).toBe(`password="${REDACTED}"b\nc" d`);
  });

  it.each([' ', '\t', '\n', ',', ';', '}', ')', ']', '&', '.', "'", '|', '<', '>', ''])(
    'is closed by a quote what ends a value follows: %j',
    (after) => {
      expect(scrubSecretValues(`password="a\\"b ${FAKE}"${after}`).value).toBe(
        `password="${REDACTED}"${after}`,
      );
    },
  );

  it('closes at the first quote, as before, when no such quote follows', () => {
    expect(scrubSecretValues('password="a\\"b"c').value).toBe(`password="${REDACTED}"b"c`);
  });

  it('is not closed by the quote of a JSON key, its colon after it (#501 on #1579)', () => {
    expect(scrubSecretValues(`API_TOKEN="a \\"b \\"password":${FAKE}`).value).not.toContain(FAKE);
  });

  it.each([
    [
      'a name',
      `password="C:\\dir\\" token="${FAKE}"`,
      `password="${REDACTED}" token="${REDACTED}"`,
    ],
    [
      'a --password flag',
      `--password "C:\\dir\\" --token "${FAKE}"`,
      `--password "${REDACTED}" --token "${REDACTED}"`,
    ],
    [
      'an env line',
      `PASSWORD="C:\\dir\\" API_TOKEN="${FAKE}" x`,
      `PASSWORD="${REDACTED}" API_TOKEN="${REDACTED}" x`,
    ],
  ])(
    'hides the next pair after a value that ends with a backslash before its quote (#493 on #1579): %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
    },
  );

  it.each([
    `password="C:\\dir\\" token="${FAKE}"`,
    `run --password "C:\\k\\" --token "${FAKE}"`,
    `$env:GOOGLE_APPLICATION_CREDENTIALS="C:\\keys\\"; $env:API_TOKEN="${FAKE}"`,
    `export DB_PASSWORD="ab\\" API_TOKEN="${FAKE}"`,
    `password: "a\\" token: "${FAKE}"`,
    `<x password="C:\\d\\" token="${FAKE}">`,
    `user=bob password="p\\" api_key="${FAKE}" ok`,
    `API_TOKEN="a \\"b \\"password":${FAKE}`,
    // Not closed by a quote a backslash follows: the next value opens with one (`\n`, `\\host`).
    `password="C:\\dir\\" token="\\n${FAKE}"`,
  ])(
    'hides the next value, as main does, after one read on to its quote (#501 on #1579): %s',
    (text) => {
      expect(scrubSecretValues(text).value).not.toContain(FAKE);
    },
  );

  it.each([
    ['a name', `password="C:\\dir\\" token=" ${FAKE}"`],
    ['a --password flag', `--password "C:\\dir\\" --token " ${FAKE}"`],
    ['an env line', `PASSWORD="C:\\dir\\" API_TOKEN=" ${FAKE}" x`],
    ['a JSON key', `{"password": "C:\\dir\\", "api_key": " ${FAKE}"}`],
    ['a & first', `password="C:\\dir\\"&token=" ${FAKE}"`],
    ['a ; first', `password="C:\\dir\\";token=" ${FAKE}"`],
    ['a single-quoted key', `{'password': "C:\\dir\\", 'token': " ${FAKE}"}`],
    ['PowerShell', `$env:PASSWORD="C:\\k\\"; $env:API_TOKEN=" ${FAKE}"`],
    ['a YAML key, a comma first', `password: "a\\" token: ",${FAKE}"`],
    ['an attribute, a > first', `<x password="C:\\d\\" token=">${FAKE}">`],
    ['a single-quoted value, a quote first', `password="C:\\dir\\" token='" ${FAKE}'`],
    ['an escaped quote that opens the value', `"token": "\\"a && password: " ${FAKE}"`],
    ['a pair with a bare value between', `api_key = "a\\" API_TOKEN = b client_secret: " ${FAKE}"`],
    ['spaces around the separator', `password = "C:\\dir\\" token = " ${FAKE}"`],
    ['a quoted key after a dot (#493 on #1581)', `password="a\\".'token' = " ${FAKE}"`],
    ['a name right after a quote', `password="a\\"API_TOKEN = " ${FAKE}"`],
    ['a flag right after a dot', `password="a\\".--token " ${FAKE}"`],
    ['a flag right after an apostrophe', `password="a\\" x'--token " ${FAKE}"`],
    ['a --flag= (#501 on #1581)', `run --password="C:\\k\\" --token=" ${FAKE}"`],
    ['a name with a dot in it', `password="C:\\dir\\" my.token=" ${FAKE}"`],
    ['an env name right after a dot', `PASSWORD="C:\\dir\\".API_TOKEN=" ${FAKE}"`],
    ['an env name longer than a name', `PASSWORD="C:\\dir\\" ${'A'.repeat(100)}_TOKEN=" ${FAKE}"`],
    ['two spaces before the colon', `API_TOKEN="a \\"b \\"api_key"  : "${FAKE}"`],
    ['a key and `=` (#501 on 05f9be71)', `API_TOKEN="a \\"b \\"api_key" = " ${FAKE}"`],
    ['a key, a tab and `=`', `API_TOKEN="a \\"b \\"api_key"\t=\t" ${FAKE}"`],
    ['spaces before the colon (#501 on #1579)', `API_TOKEN="a \\"b \\"api_key" : "${FAKE}"`],
    ['a tab before the colon', `API_TOKEN="a \\"b \\"api_key"\t:\t"${FAKE}"`],
  ])(
    'never closes at the opening quote of the next pair, its value opening with a space or what ends one (legacy 924): %s',
    (_label, text) => {
      expect(scrubSecretValues(text).value).not.toContain(FAKE);
    },
  );

  it('a quote that blanks and a colon follow closes no value, read where the stream cuts (#501, #493 on #1581)', () => {
    expect(endsAQuotedValue('  : 1')).toBe(false);
    expect(endsAQuotedValue('\t:')).toBe(false);
    expect(endsAQuotedValue(':')).toBe(false);
    expect(endsAQuotedValue('  = 1')).toBe(false);
    expect(endsAQuotedValue('  x')).toBe(true);
    expect(endsAQuotedValue('')).toBe(false);
  });

  it.each([
    ['a word no name rule takes', 'password="a\\"b _k: " x'],
    ['a flag after a letter', 'password="a\\"b x--k " x'],
    ['an env name after `_`', 'password="a\\"b _API=" x'],
    ['a name after a dot', 'password="a\\"b _.k: " x'],
    ['a word whose value no rule hides (legacy 926)', 'password="a \\"b note: " x'],
  ])(
    'a quote after what no value rule takes for a name still closes the value: %s',
    (_label, text) => {
      expect(scrubSecretValues(text).value).toBe(`password="${REDACTED}" x`);
    },
  );

  it("reads a value whose last word is a secret's name and its separator to its first quote, as v0.69.2 does", () => {
    expect(scrubSecretValues('password="a \\"b token: " x').value).toBe(
      `password="${REDACTED}"b token: " x`,
    );
  });

  /** Pins the next line only: a plain quote with no close on its line is no value (main). */
  it.each([
    ['a name', 'password="a\\\nb" c', '\nb" c'],
    ['an env line', 'PASSWORD="a\\\r\nb" c', '\r\nb" c'],
    ['a JSON pair', '{"password": "a\\\nb", "x": "y"}', '\nb", "x": "y"}'],
  ])('reads no escape past the end of its line: %s', (_label, text, nextLine) => {
    expect(scrubSecretValues(text).value).toContain(nextLine);
  });
});

describe('a value read with escapes never reads in the next pair (legacy 926)', () => {
  it.each([
    [
      'a --flag, a YAML value before it',
      `token: "a\\" --token 'x", ${FAKE}'`,
      `token: "${REDACTED}" --token '${REDACTED}'`,
    ],
    [
      'a --flag, a path before it',
      `password="C:\\dir\\" --token 'x", ${FAKE}'`,
      `password="${REDACTED}" --token '${REDACTED}'`,
    ],
    [
      'a name',
      `password="C:\\dir\\" token='x" ${FAKE}'`,
      `password="${REDACTED}" token='${REDACTED}'`,
    ],
    [
      'an env line',
      `export PGPASSWORD="C:\\pg\\" API_TOKEN='x"; ${FAKE}'`,
      `export PGPASSWORD="${REDACTED}" API_TOKEN='${REDACTED}'`,
    ],
    [
      'a \\"…\\" value',
      `API_TOKEN=\\"a --token 'b\\" ${FAKE}'`,
      `API_TOKEN=\\"${REDACTED} --token '${REDACTED}'`,
    ],
    [
      'a \\"… value not closed',
      `password=\\"abc --token 'x" ${FAKE}'`,
      `password=\\"${REDACTED} --token '${REDACTED}'`,
    ],
    [
      'an upper-case --flag',
      `password="C:\\dir\\" --PASSWORD 'x" ${FAKE}'`,
      `password="${REDACTED}" --PASSWORD '${REDACTED}'`,
    ],
    [
      'a camel-cased name',
      `password="C:\\dir\\" myToken='x" ${FAKE}'`,
      `password="${REDACTED}" myToken='${REDACTED}'`,
    ],
    [
      'a camel-cased --flag',
      `password="C:\\dir\\" --myToken 'x" ${FAKE}'`,
      `password="${REDACTED}" --myToken '${REDACTED}'`,
    ],
    [
      'an env name only the env rule takes',
      `API_TOKEN=\\"a PGPASSWORD='x" ${FAKE}'`,
      `API_TOKEN=\\"${REDACTED} PGPASSWORD='${REDACTED}'`,
    ],
  ])(
    "ends before the next pair whose '…' value holds the quote it would have closed at (review #501 on #1581): %s",
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    ['its value holds no quote', `password="a\\" token='b' ${FAKE}"`, `password="${REDACTED}"`],
    ['its value is empty', `API_TOKEN=\\"a API_TOKEN='' ${FAKE}\\"`, `API_TOKEN=\\"${REDACTED}\\"`],
    ['its value is not closed', `password="a\\" token=' ${FAKE}"`, `password="${REDACTED}"`],
    ['a value not closed either', `password=\\"a token='b' ${FAKE}`, `password=\\"${REDACTED}`],
  ])(
    "reads on, as main does, past a next pair whose '…' value it covers: %s",
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
    },
  );

  it('leaves the blanks at the end of its line out of a value not closed, as text cut there reads it', () => {
    expect(scrubSecretValues('API_TOKEN=\\"a  \nnext').value).toBe(
      `API_TOKEN=\\"${REDACTED}  \nnext`,
    );
    expect(scrubSecretValues('API_TOKEN=\\"a \r\nnext').value).toBe(
      `API_TOKEN=\\"${REDACTED} \r\nnext`,
    );
    expect(scrubSecretValues('API_TOKEN=\\"a  ').value).toBe(`API_TOKEN=\\"${REDACTED}  `);
  });

  it.each([
    // Seed 8 of #501's run on #1581: main kept the last value.
    `API_TOKEN=note: "}"API_TOKEN = " ' ${FAKE}\\\\\\", token: '\\\\";password="${FAKE}\\"${FAKE}'\\\\"\t:\t`,
    // main kept the second value, v0.69.2 the second and the fourth (#501 on #1581).
    `"secret": "${FAKE}=\\" \\"secret" = \\" k: ${FAKE} : 'password': "${FAKE}"|PASSWORD=\\"${FAKE}`,
  ])('hides every value of the lines #501 found: %s', (text) => {
    expect(scrubSecretValues(text).value).not.toContain(FAKE);
  });
});

describe('an escaped JSON key and `=` (review #501 on #1581)', () => {
  it.each([
    ['spaces around it', `\\"password\\" = \\"${FAKE}\\"`, `\\"password\\" = \\"${REDACTED}\\"`],
    ['none', `\\"password\\"=\\"${FAKE}\\"`, `\\"password\\"=\\"${REDACTED}\\"`],
    [
      'a PowerShell hash table in a command',
      `pwsh -c "Invoke-X -Body @{\\"Password\\" = \\"${FAKE}\\"}"`,
      `pwsh -c "Invoke-X -Body @{\\"Password\\" = \\"${REDACTED}\\"}"`,
    ],
  ])('hides the value, as with a colon: %s', (_label, text, hidden) => {
    expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
  });

  it.each([
    ['a key that names no secret', '\\"user\\" = \\"bob\\"'],
    ['a comparison', 'if (\\"password\\" == \\"x\\")'],
  ])('keeps what is no secret pair: %s', (_label, text) => {
    expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
  });
});

describe('the name rules read together, each on the text as it is written (legacy 928)', () => {
  it.each([
    [
      "a --flag's '…' value an escaped key and `=` end inside",
      `--token='\\${FAKE}":api_key=\\"'\\"`,
      `--token='${REDACTED}'\\"`,
    ],
    [
      "a --flag's '…' value an escaped JSON pair ends inside",
      `--api-key='${FAKE}x"note: "\t:\tx"v|\\"secret" : "\\"a${FAKE}='"`,
      `--api-key='${REDACTED}'"`,
    ],
    [
      "a YAML '…' value an env line ends inside",
      `note: API_TOKEN: '${FAKE}} .API_TOKEN=\\"x'`,
      `note: API_TOKEN: '${REDACTED}'`,
    ],
  ])(
    "hides a '…' value whose closing quote the rule read before it hid, as v0.69.2 did: %s",
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    [
      'a JSON value and an env line',
      `"api_key": "'.API_TOKEN="${FAKE}'"`,
      `"api_key": "${REDACTED}"${REDACTED}"`,
    ],
    [
      'a --flag and an env line',
      `--token "a API_TOKEN="${FAKE} b"`,
      `--token "${REDACTED}"${REDACTED}"`,
    ],
    [
      'a name and an env line',
      `password='a API_TOKEN='${FAKE} b'`,
      `password='${REDACTED}'${REDACTED}'`,
    ],
  ])(
    'hides both values of pairs that cross, the rest of the second after the first, as main does: %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    [
      'a name and a --flag, whose value v0.69.2 and main kept',
      `api_key = a}.--token '${FAKE} x'`,
      `api_key = ${REDACTED} '${REDACTED}'`,
    ],
    [
      'a name and a --flag with an escaped quote, whose value v0.69.2 and main kept',
      `password= --token \\"${FAKE}"&`,
      `password= ${REDACTED} \\"${REDACTED}"&`,
    ],
    [
      'a --flag and a name, as main does',
      `--token ;password: '${FAKE} x'`,
      `--token ${REDACTED} '${REDACTED}'`,
    ],
    [
      'a name and an env line whose value starts where the name ends, as main does',
      `password=|API_TOKEN=\\"${FAKE}\\" x`,
      `password=${REDACTED}\\"${REDACTED}\\" x`,
    ],
  ])(
    "keeps what stands between a value and the value of the pair it crosses, and that value's opening quote: %s",
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    ['an env line', `--token "a API_TOKEN="b API_TOKEN="${FAKE} c"`, `--token "${REDACTED}"`],
    ['a --flag', `api_key="a.--token "b --password "${FAKE} c"`, `api_key="${REDACTED}"`],
  ])(
    'reads a pair inside the rest of a value that crosses, from where the pair it crossed ended (v0.69.2 and main kept the last value): %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({
        value: `${hidden}${REDACTED}"${REDACTED}"`,
        redactedValues: 3,
      });
    },
  );

  it.each([
    [
      'a name after it, no blank between',
      `token=x,api_key="${FAKE} y"`,
      `token=${REDACTED}api_key="${REDACTED}"`,
    ],
    [
      'an env name',
      `API_TOKEN=x,password="${FAKE} y"`,
      `API_TOKEN=${REDACTED}password="${REDACTED}"`,
    ],
    ['a --flag', `--token x,--password "${FAKE} y"`, `--token ${REDACTED}--password "${REDACTED}"`],
    ['a name after a `;`', `token=x;api_key="${FAKE} y"`, `token=${REDACTED}api_key="${REDACTED}"`],
    ['a name after a `|`', `token=x|api_key="${FAKE} y"`, `token=${REDACTED}api_key="${REDACTED}"`],
    [
      'an env name after a `&`, which only the env rule reads (review #501 on #1586)',
      `API_TOKEN=x&TOKEN_VALUE="${FAKE} y"`,
      `API_TOKEN=${REDACTED}TOKEN_VALUE="${REDACTED}"`,
    ],
  ])(
    'ends a bare value before the next pair, whose value v0.69.2 and main kept: %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
    },
  );

  it.each([
    [
      'a JSON key',
      `token=x,password: "api_key": ${FAKE}`,
      `token=${REDACTED} "api_key": ${REDACTED}`,
    ],
    [
      'a key after the same name',
      `token=x,token: "password": ${FAKE}`,
      `token=${REDACTED} "password": ${REDACTED}`,
    ],
    [
      "a '…' value",
      `"token" = a,token:  "api_key": '${FAKE}'`,
      `"token" = ${REDACTED}  "api_key": '${REDACTED}'`,
    ],
    [
      'a `;`',
      `token=x;password: "api_key": "${FAKE}"`,
      `token=${REDACTED} "api_key": "${REDACTED}"`,
    ],
    [
      'a TOML key after a `|`',
      `token=x|password: "api_key" = ${FAKE}`,
      `token=${REDACTED} "api_key" = ${REDACTED}`,
    ],
  ])(
    "reads a bare value on past a next pair whose value is a secret's key, which the key's rule hides, as v0.70.0 does (review #501 on #1586; main kept it): %s",
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it('still ends a bare value before a next pair whose value is a key no rule hides', () => {
    // Read on there, no rule would hide that pair's value.
    expect(scrubSecretValues('token=x,password: "note": y')).toEqual({
      value: `token=${REDACTED}password: "${REDACTED}": y`,
      redactedValues: 2,
    });
  });

  it.each([
    ['a --flag', `--password=${FAKE}--api-key="abc"`, `--password=${REDACTED}"${REDACTED}"`],
    ['an env name', `token=A_TOKEN="${FAKE} x"`, `token=${REDACTED}"${REDACTED}"`],
    ['an env line', `API_TOKEN=note${FAKE}API_TOKEN="x"`, `API_TOKEN=${REDACTED}"${REDACTED}"`],
    ['a `;` first', `token=;${FAKE}clientSecret--token : "x"`, `token=${REDACTED} : "${REDACTED}"`],
    ['a `,` first', `token=,${FAKE}clientSecret--token : "x"`, `token=${REDACTED} : "${REDACTED}"`],
    ['a `|` first', `token=|${FAKE}clientSecret--token : "x"`, `token=${REDACTED} : "${REDACTED}"`],
    ['an `=` first', `API_TOKEN==${FAKE}--token :"x"`, `API_TOKEN=${REDACTED} :"${REDACTED}"`],
  ])(
    "hides a bare value a next pair's name is written against, as v0.69.2 and main do, and that pair's value, which they kept (review #493 on #1586; legacy 934): %s",
    (_label, text, hidden) => {
      // The pair that starts inside the bare value and goes on past it is read from where that
      // value starts, as its rule reads on there (`readTogether`).
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    [
      "a '…' value",
      `--token TOKEN='token':${FAKE}`,
      `--token ${REDACTED}'${REDACTED}':${REDACTED}`,
    ],
    [
      "a --flag's value",
      `--password=I_TOKEN='token':${FAKE}`,
      `--password=${REDACTED}'${REDACTED}':${REDACTED}`,
    ],
    [
      'a "…" value',
      `--token "TOKEN="x apikey":${FAKE};`,
      `--token "${REDACTED}"${REDACTED}":${REDACTED}`,
    ],
    [
      'an escaped quote',
      `--token TOKEN=\\"token:\\":${FAKE}`,
      `--token ${REDACTED}\\"${REDACTED}\\"${REDACTED}`,
    ],
    [
      'a name after an escaped quote (review #501 on #1586)',
      `--token "a TOKEN=\\"b secret = \\" ${FAKE}`,
      `--token "${REDACTED}"${REDACTED}\\"${REDACTED}`,
    ],
  ])(
    'reads on from where a match ended before one crossed it, whichever rule comes first at one place (review #493 on #1586; v0.69.2 and main kept the last value): %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 3 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    ['a name', `token:"TOKEN=\\"${FAKE}`, `token:"${REDACTED}"${REDACTED}`],
    ['a --flag', `--token "TOKEN=\\"${FAKE}`, `--token "${REDACTED}"${REDACTED}`],
  ])(
    'adds no closing quote to the rest of a value it crosses that was never closed, as main does (review #501 on #1586): %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 2 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    [
      'a bare --flag value',
      `token:--token I_TOKEN="token:\\"${FAKE}`,
      `token:${REDACTED} ${REDACTED}"${REDACTED}"${REDACTED}`,
    ],
    [
      'a quoted --flag value',
      `token=--password="I_TOKEN="apikey:\\"${FAKE}`,
      `token=${REDACTED}"${REDACTED}"${REDACTED}"${REDACTED}`,
    ],
  ])(
    'reads on from where a match ended before the last one crossed it, in a run crossed twice (v0.69.2 and main kept the last value): %s',
    (_label, text, hidden) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 4 });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it('reads on from its own end inside a match no match crossed (review #501 on #1586; v0.70.0 and v0.69.2 kept the value)', () => {
    // The env rule takes `API_KEY=x&secret:`, the name rule, whose value stops at the `&`,
    // `API_KEY=x` inside it: read on from where the env match ends, it skipped `secret: '…'`.
    const hidden = `API_KEY=${REDACTED} '${REDACTED}'`;
    expect(scrubSecretValues(`API_KEY=x&secret: '${FAKE}'`)).toEqual({
      value: hidden,
      redactedValues: 2,
    });
    expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
  });

  it('counts a pair inside the value of the one it starts in once, with that value', () => {
    expect(scrubSecretValues(`token="a PASSWORD=${FAKE} b"`)).toEqual({
      value: `token="${REDACTED}"`,
      redactedValues: 1,
    });
    // Two masks that meet are one: the rest of a value read on past the `&` the first stops at.
    expect(scrubSecretValues(`--TOKEN=${FAKE}&${FAKE}`)).toEqual({
      value: `--TOKEN=${REDACTED}`,
      redactedValues: 1,
    });
  });

  it('reads the pairs from where it is told, looking back into what comes before', () => {
    // After a `.` the name rule takes no name, as in the whole text; and no match starts in what
    // was read before (`secret-stream.ts`).
    const text = `password: "a ${FAKE}"`;
    expect(scrubSecretValues(text, { readAfter: '"hi".' })).toEqual({
      value: text,
      redactedValues: 0,
    });
    expect(scrubSecretValues(`'${FAKE} b'`, { readAfter: 'token: ' })).toEqual({
      value: `'${FAKE} b'`,
      redactedValues: 0,
    });
    expect(scrubSecretValues(text).value).toBe(`password: "${REDACTED}"`);
  });
});

describe('a secret key after an escaped quote is no value (legacy 929)', () => {
  it.each([
    ['a colon', `token: \\"password":${FAKE}`, `token: \\"password":${REDACTED}`],
    ['a colon and a blank', `token: \\"password": ${FAKE}`, `token: \\"password": ${REDACTED}`],
    ['an `=`', `token: \\"password" = ${FAKE}`, `token: \\"password" = ${REDACTED}`],
    ["a '…' value", `token:  \\"password" = '${FAKE} x'`, `token:  \\"password" = '${REDACTED}'`],
    ['a camel-cased key', `token: \\"myApiKey": ${FAKE}`, `token: \\"myApiKey": ${REDACTED}`],
    [
      'a camel-cased key and `=`',
      `token: \\"userPassword" = ${FAKE}`,
      `token: \\"userPassword" = ${REDACTED}`,
    ],
    ['a dotted key', `token: \\"my.api_key": ${FAKE}`, `token: \\"my.api_key": ${REDACTED}`],
  ])("hides the key's value, which main kept: %s", (_label, text, hidden) => {
    expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
  });
});

describe('a value read with escapes and the next pair (review #493, #501 on #1583)', () => {
  it("ends before a next pair's name and quote, not a `'` before it", () => {
    expect(scrubSecretValues(`password="a\\" x ${FAKE} --token '"}`)).toEqual({
      value: `password="${REDACTED}"}`,
      redactedValues: 1,
    });
  });

  it.each([
    ['YAML', `password: "a\\"${FAKE}token: " x`, `password: "${REDACTED}" x`],
    ['JSON', `{"password": "p\\"w${FAKE}token: "}`, `{"password": "${REDACTED}"}`],
  ])('reads on past a name right after its text, no blank between: %s', (_label, text, hidden) => {
    expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: 1 });
  });

  it.each([40, 58])('ends before a next pair whose name is %i characters and _token', (length) => {
    const name = `${'x'.repeat(length)}_token`;
    expect(scrubSecretValues(`password="a\\" ${name}='b" ${FAKE}'`)).toEqual({
      value: `password="${REDACTED}" ${name}='${REDACTED}'`,
      redactedValues: 2,
    });
  });
});

describe('a pair that starts inside a value and goes on past it (legacy 934)', () => {
  it.each([
    [
      'a name in a "…" value after a `,`',
      `TOKEN=x,token="apikey:"${FAKE}"`,
      `TOKEN=${REDACTED}token="${REDACTED}"${REDACTED}"`,
      3,
    ],
    [
      'a name and `=`',
      `apikey=x,apikey="Secret="${FAKE}"`,
      `apikey=${REDACTED}apikey="${REDACTED}"${REDACTED}"`,
      3,
    ],
    [
      'an escaped quote',
      `TOKEN=x,I_TOKEN="password:\\"${FAKE}`,
      `TOKEN=${REDACTED}I_TOKEN="${REDACTED}"${REDACTED}`,
      3,
    ],
    // The quote that closed the first value is inside the value of the pair that crossed it: the
    // first value goes on to its next quote (review #501 on #1589).
    [
      'a \'…\' value in a "…" value',
      `password:"TOKEN='"'${FAKE}"`,
      `password:"${REDACTED}"'${REDACTED}"`,
      2,
    ],
    [
      'a "…" value in a \'…\' value',
      `token='TOKEN="'"${FAKE}'`,
      `token='${REDACTED}'"${REDACTED}'`,
      2,
    ],
    ['a --flag', `--apikey='password:"'"${FAKE}'`, `--apikey='${REDACTED}'"${REDACTED}'`, 2],
    [
      'to the end of the line',
      `password:"TOKEN='"'${FAKE}\nx`,
      `password:"${REDACTED}"'${REDACTED}\nx`,
      2,
    ],
    // A value read as no value where the next pair starts at its first character, the pair took
    // the quote after its own for its value; read in, the value goes on to its own quote.
    [
      'a pair at the first character of a `\\"…\\"` value',
      `--token \\"TOKEN='\\"'${FAKE}\\"`,
      `--token \\"${REDACTED}\\"'${REDACTED}\\"`,
      2,
    ],
    [
      'a pair at the first character of a `\\"…` value',
      `api_key: \\"TOKEN='\\"'${FAKE} y;`,
      `api_key: \\"${REDACTED}\\"'${REDACTED}`,
      2,
    ],
    // A value that stopped, not closed, before the next pair, past blanks: the pair is inside it,
    // and it goes on past the pair to its own quote, as v0.70.0 read it to the line's end.
    [
      'a pair after a `\\"…` value cut short',
      `--token \\"xa TOKEN='\\"'${FAKE} y':`,
      `--token \\"${REDACTED} TOKEN='${REDACTED}'${REDACTED}`,
      3,
    ],
    [
      'a pair whose value holds no `\\"`',
      `apikey=\\"a TOKEN='"'${FAKE}`,
      `apikey=\\"${REDACTED} TOKEN='${REDACTED}'${REDACTED}`,
      3,
    ],
    [
      'a tab before the pair',
      `apikey:\\"'\tTOKEN='"'${FAKE}`,
      `apikey:\\"${REDACTED}\tTOKEN='${REDACTED}'${REDACTED}`,
      3,
    ],
  ])(
    'hides the value of a pair that starts inside a value and goes on past it, which main kept and v0.70.0 hid: %s',
    (_label, text, hidden, values) => {
      // Its rule reads on from where the value it starts in starts (`readTogether`).
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: values });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    [
      'a pair after a `"…` value',
      `api_key: "xa TOKEN='"'${FAKE} y';`,
      `api_key: "${REDACTED}"'${REDACTED}`,
      2,
    ],
    [
      'a pair right after a `\\"` value cut short',
      `TOKEN=\\";passwd=""${FAKE}`,
      `TOKEN=\\"${REDACTED}passwd="${REDACTED}"${REDACTED}`,
      3,
    ],
    [
      "a pair at the first character of a `\\\"…` value in a '…' value",
      `token='a password=\\"secret': "${FAKE}"`,
      `token='${REDACTED}'${REDACTED}`,
      2,
    ],
    [
      "a secret's key whose opening quote is escaped",
      `--token "passwd='"'\\"secret"=""${FAKE}`,
      `--token "${REDACTED}"'${REDACTED}secret"="${REDACTED}"${REDACTED}`,
      4,
    ],
  ])(
    'hides the value of a pair that starts inside a value and goes on past it, which main and v0.70.0 kept: %s',
    (_label, text, hidden, values) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: values });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it('writes one mask for a value that goes on from where it ends hidden', () => {
    // `password`'s value goes on past the one that crossed it, which runs to the line's end.
    expect(scrubSecretValues(`password:'a TOKEN=\\"x'${FAKE}  `)).toEqual({
      value: `password:'${REDACTED}'${REDACTED}`,
      redactedValues: 2,
    });
  });

  it('reads no pair into a value cut short where other text stands between them, as main and v0.70.0 do', () => {
    expect(scrubSecretValues(`api_key: \\"a"b TOKEN='\\"' c`)).toEqual({
      value: `api_key: \\"${REDACTED}"b TOKEN='${REDACTED}' c`,
      redactedValues: 2,
    });
  });

  it.each([
    ['a name', `token: "password": ${FAKE}`, `token: "password": ${REDACTED}`, 1],
    [
      'an escaped quote',
      `token: \\"password\\": \\"${FAKE}\\"`,
      `token: \\"password\\": \\"${REDACTED}\\"`,
      1,
    ],
    ['`=`', `token=\\"secret\\" = \\"${FAKE}\\"`, `token=\\"secret\\" = \\"${REDACTED}\\"`, 1],
    [
      'a tab',
      `my.token=\\"apiKey\\"\t:\\"${FAKE}\\"`,
      `my.token=\\"apiKey\\"\t:\\"${REDACTED}\\"`,
      1,
    ],
    [
      'a --flag',
      `--token \\"apiKey\\"\t:\\"${FAKE}\\"`,
      `--token \\"apiKey\\"\t:\\"${REDACTED}\\"`,
      1,
    ],
    ['a JSON key', `"token": "password": "${FAKE}"`, `"token": "password": "${REDACTED}"`, 1],
    [
      'an escaped JSON key',
      `\\"token\\": \\"password\\": \\"${FAKE}\\"`,
      `\\"token\\": \\"password\\": \\"${REDACTED}\\"`,
      1,
    ],
    [
      'after a crossed value',
      `--token "TOKEN="apikey":${FAKE};`,
      `--token "${REDACTED}"apikey":${REDACTED}`,
      2,
    ],
  ])(
    "reads no value that is a secret's key and its quote, whose value v0.70.0 kept: %s",
    (_label, text, hidden, values) => {
      // Read as the value of the name before it, the key's own value was kept (legacy 930).
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: values });
      expect(scrubSecretValues(hidden)).toEqual({ value: hidden, redactedValues: 0 });
    },
  );

  it.each([
    [
      'an escaped JSON key',
      `"password":\\"&token: "\\\\"\\\\\\" : \\"password\\": \\",${FAKE}\\"`,
      `"password":\\"${REDACTED}token: "${REDACTED}"${REDACTED}\\"password\\": \\"${REDACTED}\\"`,
      4,
    ],
    [
      'a JSON key',
      `--token '\\";"API_TOKEN = \\"'C:'\t:\t"password":"${FAKE}'x'|`,
      `--token '${REDACTED}'${REDACTED}"password":"${REDACTED}`,
      3,
    ],
  ])(
    "goes on to a value's own quote no further than a secret's key, which its JSON rule reads, as main and v0.70.0 do: %s",
    (_label, text, hidden, values) => {
      expect(scrubSecretValues(text)).toEqual({ value: hidden, redactedValues: values });
    },
  );

  // Known failures, which legacy 930 closes before the next release: the JSON rules still read
  // the text the name rules rewrote, and a key the name rules hid as a value is no key there.
  // v0.70.0 hid these; v0.69.2 kept them. Once one is hidden, move it to the cases above.
  it.fails.each([
    `apikey=passwd:"apikeye":"${FAKE}`,
    `apikey:passwd="\\"apiKey\\":\\"${FAKE}`,
    `secret"=apikey='passwd":"'${FAKE}`,
    `--token --token \\",passwd\\"=\\"${FAKE}`,
    `--token "Secret":""apikey":"${FAKE}`,
    `TOKEN=token="\\"TOKEN\\"=\\"${FAKE}`,
    `apikey:passwd:'\\"Passwd\\"=\\"'${FAKE}`,
    // Kept since #1586, as main does (review #501 on #1589).
    `APIKEY=--apikey="passwordx":"${FAKE}"`,
  ])('hides the value of a JSON key the name rules read as a value (legacy 930): %s', (text) => {
    expect(scrubSecretValues(text).value).not.toContain(FAKE);
  });
});

describe('repairSplitQuotedMasks — a \\"…\\" value an earlier release split, stored', () => {
  /** What the value patterns wrote before they read `\\"…\\"` as one value: the `\\` alone hidden. */
  const split = (text: string) => text.replace(/\\"([^"]*)\\"/, `${REDACTED}"$1\\"`);

  it.each([
    ['an env line', `export API_TOKEN=\\"${FAKE} x\\" && run`],
    ['a YAML key', `command: "password: \\"${FAKE}\\""`],
    ['a header, no space', `-H X-Api-Key:\\"${FAKE}\\"`],
    ['a --password flag', `run --password \\"${FAKE}\\" now`],
    ['a tab', `password:\t\\"${FAKE}\\"`],
    ['in JSON text', JSON.stringify({ stdout: `a\nAPI_TOKEN="${FAKE}" b` })],
  ])('writes it as the value patterns write it now, once: %s', (_label, text) => {
    const stored = split(text);
    expect(stored).toContain(`${REDACTED}"${FAKE}`);
    const now = scrubSecretValues(text).value;
    expect(repairSplitQuotedMasks(stored)).toEqual({ value: now, redactedValues: 1 });
    expect(repairSplitQuotedMasks(now)).toEqual({ value: now, redactedValues: 0 });
  });

  it('writes a value written inside a string twice over with its own run (review #501 on #1575)', () => {
    // As written before: the bare run took the whole opening `\\\\\\"`.
    const text = `"cmd": "export API_TOKEN=\\\\\\"${FAKE} x\\\\\\" && run"`;
    const now = `"cmd": "export API_TOKEN=\\\\\\"${REDACTED}\\\\\\" && run"`;
    expect(scrubSecretValues(text).value).toBe(now);
    expect(
      repairSplitQuotedMasks(`"cmd": "export API_TOKEN=${REDACTED}"${FAKE} x\\\\\\" && run"`),
    ).toEqual({ value: now, redactedValues: 1 });
    expect(repairSplitQuotedMasks(now)).toEqual({ value: now, redactedValues: 0 });
  });

  it('leaves the mask written whole alone, a quote before it (review #493, #501 on #1573)', () => {
    for (const text of [
      `TOKEN="${REDACTED}" and later \\"x\\"`,
      `[INFO] password="${REDACTED}" msg=\\"x\\"`,
      `{"a":"${REDACTED}","note":"say \\"hi\\""}`,
      `["${REDACTED}",1,"a\\"b"]`,
      // A line break between: the value was quoted to the next \" on its line.
      `export TOKEN=${REDACTED}"\nrun \\"done\\"`,
      // A separator before the mask, and then (review #501 on #1573): a quote that is not
      // escaped; the end of the text; a line break before the \".
      `{"a":"password: ${REDACTED}","note":"say \\"hi\\""}`,
      `{"a":"password: ${REDACTED}"}`,
      `{"a":"password: ${REDACTED}"}\nlog \\"x\\"`,
      `password: ${REDACTED}" and "later" \\"x\\"`,
    ]) {
      expect(repairSplitQuotedMasks(text)).toEqual({ value: text, redactedValues: 0 });
    }
  });

  // The text up to the next \" is taken for the value. The value patterns still write this one,
  // and the stored rewrite runs at each upgrade: a row written from now on is rewritten once too.
  it('cannot tell a bare value cut by a quote, a \\" later on its line, from a split one: rewritten once', () => {
    const text = `-e "PW_TOKEN=${FAKE}" img \\"x\\"`;
    const written = `-e "PW_TOKEN=${REDACTED}" img \\"x\\"`;
    const rewritten = `-e "PW_TOKEN=\\"${REDACTED}\\"x\\"`;
    expect(scrubSecretValues(text)).toEqual({ value: written, redactedValues: 1 });
    expect(repairSplitQuotedMasks(written)).toEqual({ value: rewritten, redactedValues: 1 });
    expect(repairSplitQuotedMasks(rewritten)).toEqual({ value: rewritten, redactedValues: 0 });
    expect(scrubSecretValues(rewritten)).toEqual({ value: rewritten, redactedValues: 0 });
  });

  // Review #501 on #1575: the bare run took the \ of the \" that closes the string, and wrote
  // `[redacted]"`. It no longer does, so only rows stored before are read wrong, once.
  it('writes a name and its bare value inside \\"…\\" with its \\" kept, which it leaves', () => {
    const text = `docker run -e \\"API_TOKEN=${FAKE}\\" -e \\"DEBUG=1\\" img`;
    const written = `docker run -e \\"API_TOKEN=${REDACTED}\\" -e \\"DEBUG=1\\" img`;
    expect(scrubSecretValues(text)).toEqual({ value: written, redactedValues: 1 });
    expect(repairSplitQuotedMasks(written)).toEqual({ value: written, redactedValues: 0 });
    const stored = `docker run -e \\"API_TOKEN=${REDACTED}" -e \\"DEBUG=1\\" img`;
    const rewritten = `docker run -e \\"API_TOKEN=\\"${REDACTED}\\"DEBUG=1\\" img`;
    expect(repairSplitQuotedMasks(stored)).toEqual({ value: rewritten, redactedValues: 1 });
    expect(repairSplitQuotedMasks(rewritten)).toEqual({ value: rewritten, redactedValues: 0 });
  });

  it.each([
    ['masks and quotes', `${`=${REDACTED}"x`.repeat(15_000)}`],
    ['a mask, then text', `=${REDACTED}"${'x'.repeat(200_000)}`],
    ['split masks', `${`=${REDACTED}"x\\" `.repeat(12_000)}`],
    ['a long run of backslashes', `=${REDACTED}"${'\\'.repeat(199_999)}"`],
  ])('%s × 200 KB within 1 s', (_name, text) => {
    repairSplitQuotedMasks(text.slice(0, 1_000));
    const started = performance.now();
    repairSplitQuotedMasks(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('HIGH_CONFIDENCE_SECRET_PATTERNS — a credential itself, never text about one', () => {
  const certain = (text: string) =>
    redactSecrets(text, { patterns: HIGH_CONFIDENCE_SECRET_PATTERNS });
  /** A `Basic` value, built at run time from the synthetic `FAKE`. */
  const BASIC = Buffer.from(`ops:${FAKE}`).toString('base64');

  it.each([
    ['a JWT', `token ${HANDLE}`, `token ${REDACTED}`],
    ['a vendor key', `key sk-ant-${FAKE}`, `key ${REDACTED}`],
    [
      'a literal Bearer token',
      `Authorization: Bearer ${FAKE}`,
      `Authorization: Bearer ${REDACTED}`,
    ],
    [
      'a URL’s literal password',
      `postgres://ops:${FAKE}@db/app`,
      `postgres://ops:${REDACTED}@db/app`,
    ],
    [
      'a PEM private key',
      `-----BEGIN PRIVATE KEY-----\n${FAKE}\n-----END PRIVATE KEY-----`,
      REDACTED,
    ],
    ['a Basic user:password', `Authorization: Basic ${BASIC}`, `Authorization: Basic ${REDACTED}`],
    ['a bare Basic user:password', `Basic ${BASIC}`, `Basic ${REDACTED}`],
    [
      'the token scheme of an Authorization header',
      `Authorization: token ${FAKE}`,
      `Authorization: token ${REDACTED}`,
    ],
  ])('replaces %s — as the full pattern set does', (_label, text, expected) => {
    expect(certain(text)).toMatchObject({ value: expected, redactedValues: 1 });
    expect(scrubSecretValues(text).redactedValues).toBe(1);
  });

  it.each([
    '{app="api"} |= "Authorization: failed"',
    'level=error msg="invalid token=expired"',
    'curl -H "Authorization: Bearer $TOKEN" https://api.example.invalid',
    'curl -H "Authorization: Bearer ${TOKEN}" https://api.example.invalid',
    'mysql --password=$MYSQL_PWD -h db',
    'postgres://ops:$PGPASS@db/app',
    'postgres://ops:${PGPASS}@db/app',
    'WWW-Authenticate: Bearer authentication_failed_for_user',
    'Authorization: token ****',
    'WWW-Authenticate: Basic realm="api"',
    'msg="Basic auth failed for user=bob"',
    `invalid token ${FAKE}`,
    `Basic ${FAKE}`,
    `PGPASSWORD=${FAKE} psql`,
    `{"apiKey": "${FAKE}"}`,
    `--password ${FAKE}`,
    `https://api.example.invalid/items?page_token=${FAKE}`,
  ])('leaves text the other patterns hit: %s', (text) => {
    expect(certain(text)).toMatchObject({ value: text, redactedValues: 0 });
  });

  const SIZE = 200_000;
  const repeat = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  it.each([
    'Bearer ',
    'Bearer aaaaaaaaaaaaaaaaaaaaaaaaa ',
    'a://b:',
    'a://b:$',
    'a://b:${',
    'sk-',
    'eyJaaaaaaa.',
    'Basic YWFhYWFh',
    'Basic YWFhYWFhOmE= ',
    'authorization: token ',
    'authorization:token aaaaaaaaaaaaaaaaaaaaa1 ',
    'authorization',
  ])('%j × 200 KB within 1 s', (unit) => {
    const text = repeat(unit);
    certain(text.slice(0, 1_000));
    const started = performance.now();
    certain(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('scrubSecretValues — a Basic credential', () => {
  it('replaces a short Basic value that decodes to user:password, not the next word', () => {
    const short = Buffer.from('user:pass').toString('base64');
    expect(scrubSecretValues(`Basic ${short}`)).toEqual({
      value: `Basic ${REDACTED}`,
      redactedValues: 1,
    });
    expect(scrubSecretValues('Basic configuration').redactedValues).toBe(0);
    expect(scrubSecretValues('Basic realm="api"').redactedValues).toBe(0);
  });
});

describe('redactSecrets — structured values', () => {
  it('scrubs every string and keeps the shape; only declared keys are replaced whole', () => {
    expect(
      redactSecrets(
        { summary: `found ${HANDLE}`, findings: ['ok', `PGPASSWORD=${FAKE}`], n: 1, token: 'x' },
        { maxNodes: Number.POSITIVE_INFINITY },
      ),
    ).toEqual({
      value: {
        summary: `found ${REDACTED}`,
        findings: ['ok', `PGPASSWORD=${REDACTED}`],
        n: 1,
        token: 'x',
      },
      redactedValues: 2,
      omitted: false,
    });
  });

  it('within maxChars, cuts the string that crosses it and leaves the rest out', () => {
    expect(redactSecrets(['abcd', 'efgh', 'ijkl'], { maxChars: 6 })).toEqual({
      value: ['abcd', 'ef…', OMITTED],
      redactedValues: 0,
      omitted: true,
    });
  });
});

describe('redactSecrets — a bounded walk reads no further than its bound (legacy 237)', () => {
  /** An object whose every property read is counted — what the walk read, not what it kept. */
  function countingObject(keys: number): { readonly value: object; reads(): number } {
    let reads = 0;
    const value = {};
    for (let i = 0; i < keys; i += 1) {
      Object.defineProperty(value, `k${i}`, {
        enumerable: true,
        get: () => {
          reads += 1;
          return i;
        },
      });
    }
    return { value, reads: () => reads };
  }

  it('charges keys to maxChars and, once it is spent, leaves the rest of the object out as one entry', () => {
    const object = countingObject(10_000);
    const redacted = redactSecrets(object.value, { maxChars: 30 });
    // `k0`…`k9` and their values (2 + 1 characters each) spend the budget; the rest is one `[…]`
    // entry, unread.
    expect(redacted.value).toEqual({
      ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])),
      [OMITTED]: OMITTED,
    });
    expect(redacted.omitted).toBe(true);
    expect(object.reads()).toBe(10);
  });

  it('cuts a key past the budget like a string, and keeps a real `[…]` key apart from the marker', () => {
    expect(
      redactSecrets({ [OMITTED]: 'kept', later: 1 }, { maxChars: OMITTED.length + 3 }),
    ).toEqual({
      value: { [OMITTED]: 'kep…', [`${OMITTED} (2)`]: OMITTED },
      redactedValues: 0,
      omitted: true,
    });
    // `ab` and `1` leave 2 characters for the next key; cutting it spends the rest.
    expect(redactSecrets({ ab: 1, longkey: 2, c: 3 }, { maxChars: 5 })).toEqual({
      value: { ab: 1, 'lo…': 2, [OMITTED]: OMITTED },
      redactedValues: 0,
      omitted: true,
    });
  });

  it('once the budget is spent, leaves the rest of an array out as one item, unread', () => {
    let reads = 0;
    const items = new Proxy(['abcd', 'efgh', ...Array.from({ length: 10_000 }, (_, i) => i)], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(redactSecrets(items, { maxChars: 6 })).toEqual({
      value: ['abcd', 'ef…', OMITTED],
      redactedValues: 0,
      omitted: true,
    });
    expect(reads).toBe(2);
  });

  it('charges a number’s characters too: an array of numbers is read only up to the bound', () => {
    let reads = 0;
    const numbers = new Proxy(
      Array.from({ length: 10_000 }, (_, i) => i),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(redactSecrets(numbers, { maxChars: 5 }).value).toEqual([0, 1, 2, 3, 4, OMITTED]);
    expect(reads).toBe(5);
  });

  /** `items` behind a Proxy that counts the items read. */
  function countingArray(items: unknown[]): { readonly value: unknown[]; reads(): number } {
    let reads = 0;
    const value = new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    return { value, reads: () => reads };
  }

  it('charges an empty string one character: an array of them is read only up to the bound', () => {
    const empties = countingArray(Array.from({ length: 10_000 }, () => ''));
    expect(redactSecrets(empties.value, { maxChars: 5 })).toEqual({
      value: ['', '', '', '', '', OMITTED],
      redactedValues: 0,
      omitted: true,
    });
    expect(empties.reads()).toBe(5);
  });

  it('charges a secret field’s value what replaces it: an array of them is read only up to the bound', () => {
    const tokens = countingArray(Array.from({ length: 10_000 }, () => 'x'));
    // `token` (5) leaves 25: three `[redacted]` (10 each) spend it.
    const redacted = redactSecrets(
      { token: tokens.value },
      { maxChars: 30, isSecretKey: (key) => key === 'token' },
    );
    expect(redacted.value).toEqual({ token: [REDACTED, REDACTED, REDACTED, OMITTED] });
    expect(redacted.omitted).toBe(true);
    expect(tokens.reads()).toBe(3);
  });

  it('a bounded walk that runs out of nodes reads no further either', () => {
    const value = Array.from({ length: 10 }, () => ({}));
    expect(redactSecrets(value, { maxChars: 1000, maxNodes: 3 })).toEqual({
      value: [{}, {}, OMITTED, OMITTED],
      redactedValues: 0,
      omitted: true,
    });
  });

  it('without maxChars, the walk is as before: keys uncut, every item and entry visited', () => {
    const object = countingObject(1_000);
    const redacted = redactSecrets(
      { list: Array.from({ length: 5 }, () => ({})), object: object.value },
      { maxNodes: 3 },
    );
    expect(redacted.value).toEqual({
      list: [{}, OMITTED, OMITTED, OMITTED, OMITTED],
      object: OMITTED,
    });
    const unbounded = redactSecrets(object.value, { maxNodes: Number.POSITIVE_INFINITY });
    expect(Object.keys(unbounded.value as object)).toHaveLength(1_000);
    expect(unbounded.omitted).toBe(false);
  });
});

describe('redactSecrets — object keys (legacy 444)', () => {
  it('scrubs a key the way it scrubs a value, counts it, and keeps the value under it', () => {
    const paths: string[] = [];
    expect(
      redactSecrets(
        {
          [`Bearer ${FAKE}`]: 1,
          note: 'ok',
          nested: [{ [HANDLE]: { [`PGPASSWORD=${FAKE}`]: 'v' } }],
        },
        { maxNodes: Number.POSITIVE_INFINITY, onRedacted: (path) => paths.push(path) },
      ),
    ).toEqual({
      value: {
        [`Bearer ${REDACTED}`]: 1,
        note: 'ok',
        nested: [{ [REDACTED]: { [`PGPASSWORD=${REDACTED}`]: 'v' } }],
      },
      redactedValues: 3,
      omitted: false,
    });
    // Each place by the key as shown — never the original.
    expect(paths).toEqual([
      `Bearer ${REDACTED}`,
      `nested[0].${REDACTED}`,
      `nested[0].${REDACTED}.PGPASSWORD=${REDACTED}`,
    ]);
    expect(paths.join(' ')).not.toContain(FAKE);
  });

  it('keeps two keys that scrub to the same spelling as two fields, never merging their values', () => {
    const other = 'zyxwvutsrqponmlkjihgfedcba9876';
    const { value, redactedValues } = redactSecrets({
      [`Bearer ${FAKE}`]: 'first',
      [`Bearer ${other}`]: 'second',
      [`Bearer ${REDACTED} (2)`]: 'third',
    });
    expect(value).toEqual({
      [`Bearer ${REDACTED}`]: 'first',
      [`Bearer ${REDACTED} (2)`]: 'second',
      [`Bearer ${REDACTED} (2) (2)`]: 'third',
    });
    expect(redactedValues).toBe(2);
  });

  it('leaves ordinary keys, secret-named ones included, as they are', () => {
    const input = {
      password: 'x',
      apiKey: 'y',
      maxTokens: 3,
      'x-request-id': 'z',
      __proto__key: 1,
    };
    expect(redactSecrets(input).value).toEqual(input);
    expect(redactSecrets(input).redactedValues).toBe(0);
  });

  it('is idempotent: a key already shown is not counted again on a second read', () => {
    const once = redactSecrets({ [`Bearer ${FAKE}`]: 1, [`Authorization: Basic ${FAKE}`]: 2 });
    expect(once.redactedValues).toBe(2);
    const twice = redactSecrets(once.value);
    expect(twice.value).toEqual(once.value);
    expect(twice.redactedValues).toBe(0);
  });

  it('runs the high-confidence patterns over keys too (what a refusal reads)', () => {
    const found = redactSecrets(
      { [HANDLE]: 1, 'token=expired': 2 },
      { patterns: HIGH_CONFIDENCE_SECRET_PATTERNS },
    );
    expect(found.redactedValues).toBe(1);
    expect(found.value).toEqual({ [REDACTED]: 1, 'token=expired': 2 });
  });
});

/** `redactSecretFieldsInJsonText`'s text and count (its `decodedSpans` are tested apart). */
function fieldsIn(
  text: string,
  isSecretKey: (key: string) => boolean,
  scrubValue?: (value: string) => Scrubbed<string>,
): Scrubbed<string> {
  const { value, redactedValues } = redactSecretFieldsInJsonText(text, isSecretKey, scrubValue);
  return { value, redactedValues };
}

describe('redactSecretFieldsInJsonText — the field rule over JSON text (legacy 185)', () => {
  const mask = (text: string) => fieldsIn(text, namesASecretField);

  it('hides, at any depth, every string and number under a secret-named key, as redactSecrets does', () => {
    const value = {
      id: 'ar-1',
      params: {
        password: 12345,
        credentials: { user: 'svc', pass: FAKE, nested: [FAKE, 7] },
        apiKey0: FAKE,
        maxTokens: 1024,
        tokenCount: 3,
        passwordRequired: true,
        token: '',
        secret: null,
      },
    };
    for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
      const masked = mask(text);
      const structured = redactSecrets(value, {
        isSecretKey: namesASecretField,
        maxNodes: Number.POSITIVE_INFINITY,
      });
      expect(JSON.parse(masked.value)).toEqual(structured.value);
      expect(masked.redactedValues).toBe(structured.redactedValues);
      expect(masked.redactedValues).toBe(6);
    }
  });

  it('keeps the text as it was written around what it replaces', () => {
    const text = '{\n  "user": "svc",\n  "password": "hunter2",\n  "n": 1\n}';
    expect(mask(text)).toEqual({
      value: `{\n  "user": "svc",\n  "password": "${REDACTED}",\n  "n": 1\n}`,
      redactedValues: 1,
    });
  });

  it('reads a key the way JSON does (escapes, a quote inside a value)', () => {
    expect(mask('{"api\\u004bey":"x","note":"say \\"password\\": no"}')).toEqual({
      value: `{"api\\u004bey":"${REDACTED}","note":"say \\"password\\": no"}`,
      redactedValues: 1,
    });
  });

  it('hides a value the text ends inside, and leaves a runtime note after the JSON alone', () => {
    expect(mask('{"a": 1, "token": "abcdef')).toEqual({
      value: `{"a": 1, "token": "${REDACTED}"`,
      redactedValues: 1,
    });
    expect(mask('{"a": 1, "tok')).toEqual({ value: '{"a": 1, "tok', redactedValues: 0 });
    const cut = '{"items": [{"secret": "s1"}, {"secret": "s2"'; // cut by the runtime
    expect(mask(`${cut}\n\n[... 900 more characters omitted ...]`).value).toBe(
      `{"items": [{"secret": "${REDACTED}"}, {"secret": "${REDACTED}"\n\n[... 900 more characters omitted ...]`,
    );
  });

  it('leaves text that is not JSON, and stops where the JSON ends', () => {
    for (const text of ['password: hunter2', 'ok', '', '  "password": "x"']) {
      expect(mask(text)).toEqual({ value: text, redactedValues: 0 });
    }
    expect(mask('{"a":1} {"password":"x"}')).toEqual({
      value: '{"a":1} {"password":"x"}',
      redactedValues: 0,
    });
  });

  it('leaves a value that is already the mask alone, so a second pass changes and counts nothing', () => {
    const once = mask('{"password":"hunter2-plain-word","token":"[redacted]"}');
    expect(once).toEqual({
      value: `{"password":"${REDACTED}","token":"${REDACTED}"}`,
      redactedValues: 1,
    });
    expect(mask(once.value)).toEqual({ value: once.value, redactedValues: 0 });
  });

  it('takes the key rule it is given (a capability’s declared keys)', () => {
    expect(fieldsIn('{"connectionSecret":"x","pin":4321}', (key) => key === 'pin')).toEqual({
      value: `{"connectionSecret":"x","pin":"${REDACTED}"}`,
      redactedValues: 1,
    });
  });

  it.each([
    ['deep nesting', '['.repeat(200_000)],
    ['deep secret nesting', `{"password":${'['.repeat(199_000)}`],
    ['many keys', '{"a":1,'.repeat(30_000)],
    ['many secret pairs', '{"token":"x",'.repeat(15_000)],
    ['one long key', `{"${'a'.repeat(200_000)}`],
    ['escapes', `{"password":"${'\\\\'.repeat(100_000)}`],
    ['long numbers', `{"password":${'9'.repeat(200_000)}`],
  ])('%s × 200 KB within 1 s', (_name, text) => {
    mask(text.slice(0, 1_000));
    const started = performance.now();
    mask(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('secret literals — a secret param value quoted back in free text (legacy 185/187)', () => {
  const params = {
    host: 'db-1',
    user: 'bob',
    password: 'hunter2-not-a-pattern',
    nested: { apiKey: 98765432, list: [{ token: 'tok-quoted-back' }], pin: 'abc' },
    tokenCount: 12,
    secretRef: '   ',
  };

  it('collects every string and number under a secret-named key, longest first, skipping short and blank ones', () => {
    expect(secretFieldLiterals(params, namesASecretField)).toEqual([
      'hunter2-not-a-pattern',
      'tok-quoted-back',
      '98765432',
    ]);
    expect(secretFieldLiterals({ password: 'x'.repeat(5_000) }, namesASecretField)).toEqual([]);
    expect(secretFieldLiterals('hunter2', namesASecretField)).toEqual([]);
  });

  it('collects at most MAX_SECRET_LITERALS', () => {
    const many = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`password${i}`, `value-${i}-long`]),
    );
    expect(secretFieldLiterals(many, namesASecretField)).toHaveLength(MAX_SECRET_LITERALS);
  });

  it('hides each literal wherever free text repeats it, and counts each occurrence', () => {
    const literals = secretFieldLiterals(params, namesASecretField);
    expect(
      scrubSecretLiterals(
        "mysql -ubob -phunter2-not-a-pattern db-1: Access denied for 'bob' (hunter2-not-a-pattern); retry 98765432",
        literals,
      ),
    ).toEqual({
      value: `mysql -ubob -p${REDACTED} db-1: Access denied for 'bob' (${REDACTED}); retry ${REDACTED}`,
      redactedValues: 3,
    });
    expect(scrubSecretLiterals('nothing here', literals)).toEqual({
      value: 'nothing here',
      redactedValues: 0,
    });
  });

  it('never hides a literal shorter than four characters, or one inside the mask itself', () => {
    expect(scrubSecretLiterals('abc on red', ['abc', 'on', 'redacted', 'acte'])).toEqual({
      value: 'abc on red',
      redactedValues: 0,
    });
  });

  it('hides literals in every string of a JSON value, keeping keys and shape', () => {
    const literals = secretFieldLiterals(params, namesASecretField);
    expect(
      scrubSecretLiteralsIn(
        { stdout: 'created bob / hunter2-not-a-pattern', code: 0, lines: ['tok-quoted-back'] },
        literals,
      ),
    ).toEqual({
      value: { stdout: `created bob / ${REDACTED}`, code: 0, lines: [REDACTED] },
      redactedValues: 2,
    });
    expect(scrubSecretLiteralsIn(undefined, literals)).toEqual({
      value: undefined,
      redactedValues: 0,
    });
    const same = { a: 'x' };
    expect(scrubSecretLiteralsIn(same, []).value).toBe(same);
  });
});

/**
 * Legacy 819: where a bounded walk stops reading inside a string or a key, its copy never ends in
 * the start of a secret. A value pattern recognizes only a whole secret, so before this a cut inside
 * one kept its start as it was.
 */
describe('a cut never ends in the start of a secret (legacy 819)', () => {
  // Each with the part of it that is the secret.
  const SECRETS: readonly (readonly [string, string])[] = [
    ['password: "correct horse battery staple" done', 'correct horse battery staple'],
    ['{"apiToken": "correct horse battery staple"}', 'correct horse battery staple'],
    ['PGPASSWORD="correct horse battery staple" psql', 'correct horse battery staple'],
    [`postgres://ops:${FAKE}@db/app`, FAKE],
    [`Authorization: Bearer ${FAKE} next`, FAKE],
    [`key sk-ant-${FAKE} next`, `sk-ant-${FAKE}`],
    [`token ${HANDLE} next`, HANDLE],
    [`-----BEGIN PRIVATE KEY-----\n${FAKE}\n-----END PRIVATE KEY-----`, FAKE],
  ];

  it.each(SECRETS)(
    'cut anywhere, %j keeps no part of its secret — as a string and as a key',
    (text, secret) => {
      const start = secret.slice(0, 3);
      for (let length = 1; length < text.length; length += 1) {
        const asString = redactSecrets([text], { maxChars: length });
        expect(asString.omitted).toBe(true);
        expect(String((asString.value as unknown[])[0])).not.toContain(start);
        const asKey = redactSecrets({ [text]: 1 }, { maxChars: length });
        expect(Object.keys(asKey.value as object)[0]).not.toContain(start);
      }
    },
  );

  it('reads far enough past the cut for a secret as long as any replaced whole (a 3 KB JWT)', () => {
    // Claims of ~3 KB (a Handle is well under 2k, a PEM RSA-4096 key ~3.3k): cut short of its
    // end, it would no longer be a JWT to the value patterns.
    const claims = Buffer.from(JSON.stringify({ sub: 'a', pad: 'p'.repeat(2_300) }));
    const jwt = `${HANDLE.split('.')[0]}.${claims.toString('base64url')}.${HANDLE.split('.')[2]}`;
    expect(jwt.length).toBeGreaterThan(3_000);
    const text = `token ${jwt} next`;
    const kept = String((redactSecrets([text], { maxChars: 20 }).value as unknown[])[0]);
    expect(kept).toBe(`${`token ${REDACTED} next`.slice(0, 20)}…`);
  });

  it('a string with nothing to replace is cut exactly where reading stops, however long', () => {
    const text = 'a'.repeat(3 * CUT_LOOKAHEAD_CHARS);
    expect(redactSecrets([text], { maxChars: 1000 }).value).toEqual([`${'a'.repeat(1000)}…`]);
  });

  it('a secret reading stopped in is left out, however much the replacements before it shortened the copy', () => {
    // Handles replaced by `[redacted]` before the cut, then a long password that the read past the
    // cut (`CUT_LOOKAHEAD_CHARS`) stops 1500 characters inside: its start is all the patterns see
    // of it, and the replacements shortened what was read to less than the lookahead.
    const length = 2_000;
    const handles = `${HANDLE} `.repeat(35);
    const password = `password: "qz7 ${'w'.repeat(3_000)}" done`;
    const stop = length + CUT_LOOKAHEAD_CHARS;
    const text = `${handles}${' '.repeat(stop - 1_500 - handles.length)}${password}`;
    expect(text.indexOf(password)).toBe(stop - 1_500);

    const cut = redactSecrets([text], { maxChars: length });
    const kept = String((cut.value as unknown[])[0]);
    expect(kept).not.toContain('qz7');
    expect(kept).not.toContain(HANDLE.slice(0, 10));
    expect(kept.length).toBeLessThan(length);
    expect(cut.omitted).toBe(true);
  });

  it('scrubbedCut keeps at most the cut, and never the last lookahead of a read that stopped short of the end', () => {
    // A scrub that shortens every `secret ` by one character.
    const scrub = (read: string) => read.replaceAll('secret', 'secre');
    const text = 'secret '.repeat(2_000);
    const read = scrub(text.slice(0, 3_000 + CUT_LOOKAHEAD_CHARS));
    expect(read.length - CUT_LOOKAHEAD_CHARS).toBeLessThan(3_000);
    expect(scrubbedCut(text, 3_000, scrub)).toBe(read.slice(0, read.length - CUT_LOOKAHEAD_CHARS));
    // Without replacements, exactly the cut.
    expect(scrubbedCut(text, 3_000, (part) => part)).toBe(text.slice(0, 3_000));
    // A read that reaches the end of the text keeps up to the cut.
    expect(scrubbedCut('secret secret', 4, scrub)).toBe('secr');
  });

  it('a cut never leaves half of an emoji: it ends before the pair instead (legacy 834)', () => {
    const EMOJI = '\u{1F600}';
    const text = `${'a'.repeat(999)}${EMOJI}${'b'.repeat(10_000)}`;
    // Read to the end, and short of it.
    expect(scrubbedCut(`${'a'.repeat(999)}${EMOJI}`, 1_000, (read) => read)).toBe('a'.repeat(999));
    expect(scrubbedCut(text, 1_000, (read) => read)).toBe('a'.repeat(999));
    expect(scrubbedCut(text, 1_001, (read) => read)).toBe(`${'a'.repeat(999)}${EMOJI}`);
    // The walk's cut of a string, and of a key.
    const [value] = redactSecrets([text], { maxChars: 1_000 }).value as string[];
    expect(value).toBe(`${'a'.repeat(999)}…`);
    const keys = Object.keys(redactSecrets({ [text]: 1 }, { maxChars: 1_000 }).value as object);
    expect(keys[0]).toBe(`${'a'.repeat(999)}…`);
  });
});

describe('redactSecretFieldsInJsonText — its escaped strings scrubbed decoded (legacy 916)', () => {
  const scrub = (text: string) => fieldsIn(text, namesASecretField, scrubSecretValues);
  /** As the callers use it: then the value patterns over the rest of the text as it is. */
  const scrubAll = (text: string): Scrubbed<string> => {
    const fields = redactSecretFieldsInJsonText(text, namesASecretField, scrubSecretValues);
    const rest = scrubOutsideSpans(fields.value, fields.decodedSpans, scrubSecretValues);
    return { value: rest.value, redactedValues: fields.redactedValues + rest.redactedValues };
  };
  /** A tool's JSON result carrying `stdout` (and nothing else to hide). */
  const result = (stdout: string) => JSON.stringify({ stdout, code: 0 });

  // A line of output reaches the value patterns as `…\nNAME=…`: the `n` of the escape reads as
  // the end of another word, and the name is passed over.
  it.each([
    [
      'an env line',
      `HOME=/workspace\nPGPASSWORD=${FAKE}\n`,
      `HOME=/workspace\nPGPASSWORD=${REDACTED}\n`,
    ],
    ['a Basic credential', 'ok\nBasic dXNlcjpwYXNzd29yZA==', `ok\nBasic ${REDACTED}`],
    [
      'a --password flag',
      `$ psql\n--password ${FAKE} -h db`,
      `$ psql\n--password ${REDACTED} -h db`,
    ],
    ['a YAML key', `db:\npassword: '${FAKE}'`, `db:\npassword: '${REDACTED}'`],
    ['a query string', `GET\napi_key=${FAKE}&x=1`, `GET\napi_key=${REDACTED}&x=1`],
    ['after a tab', `a\tPGPASSWORD=${FAKE}`, `a\tPGPASSWORD=${REDACTED}`],
  ])('hides %s that follows an escape', (_label, stdout, expected) => {
    expect(scrub(result(stdout))).toEqual({ value: result(expected), redactedValues: 1 });
  });

  it('is needed: the value patterns over the text as written pass an env line after `\\n`', () => {
    const text = result(`HOME=/workspace\nPGPASSWORD=${FAKE}`);
    expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
  });

  it('keeps a string it leaves byte for byte, and writes one it changes as JSON.stringify does', () => {
    const text = `{"a":"\\u4e2d\\/x\\n","b":"\\u4e2d\\nPGPASSWORD=${FAKE}"}`;
    expect(scrub(text)).toEqual({
      value: `{"a":"\\u4e2d\\/x\\n","b":${JSON.stringify(`中\nPGPASSWORD=${REDACTED}`)}}`,
      redactedValues: 1,
    });
  });

  it('leaves keys, strings without an escape and strings that do not decode to the text pass', () => {
    for (const text of [
      '{"x\\nBasic dXNlcjpwYXNzd29yZA==":1}',
      `{"a":"PGPASSWORD=${FAKE}"}`,
      `{"a":"\\x\\nPGPASSWORD=${FAKE}"}`,
    ]) {
      expect(scrub(text)).toEqual({ value: text, redactedValues: 0 });
      expect(
        redactSecretFieldsInJsonText(text, namesASecretField, scrubSecretValues).decodedSpans,
      ).toEqual([]);
    }
  });

  // Review #493 on #1573: the text pass read `\"` as a value starting with `\` — before this PR
  // the value itself was kept; after the decoded pass it broke the JSON and counted twice.
  it.each([
    ['an env line', `API_TOKEN="${FAKE}"`, `API_TOKEN="${REDACTED}"`],
    ['an export', `export X_TOKEN="${FAKE}"`, `export X_TOKEN="${REDACTED}"`],
    ['a YAML key', `password: "${FAKE}"`, `password: "${REDACTED}"`],
    ['a --password flag', `--password "${FAKE}"`, `--password "${REDACTED}"`],
    ['a query string', `api_key="${FAKE}"`, `api_key="${REDACTED}"`],
  ])('hides %s with a quoted value once, the text still JSON', (_label, line, expected) => {
    for (const stdout of [`a ${line} b`, `a\n${line}\n`]) {
      const hidden = scrubAll(result(stdout));
      expect(hidden).toEqual({ value: result(stdout.replace(line, expected)), redactedValues: 1 });
      expect(scrubAll(hidden.value)).toEqual({ value: hidden.value, redactedValues: 0 });
    }
  });

  // Review #501 on #1577: JSON text a tool printed is a string here, decoded and read as plain
  // text, and its value ended at the escaped quote inside it.
  it.each([
    ['a JSON value', `{"password": "a \\"b ${FAKE}"}`, `{"password": "${REDACTED}"}`],
    [
      'a JSON key the name rule reads, more pairs after it',
      `{"api_key":"x\\"${FAKE}","user":"bob"}`,
      `{"api_key":"${REDACTED}","user":"bob"}`,
    ],
  ])(
    'hides %s with an escaped quote in it, written inside a string, to its end',
    (_label, stdout, expected) => {
      const hidden = scrubAll(result(stdout));
      expect(hidden).toEqual({ value: result(expected), redactedValues: 1 });
      expect(scrubAll(hidden.value)).toEqual({ value: hidden.value, redactedValues: 0 });
    },
  );

  it('skips what it read, rewritten or kept, in a pass over the text: the spans', () => {
    // `\r` after the separator: no value decoded, the line breaks there.
    const kept = '"\\u4e2d\\nAPI_TOKEN=\\rx"';
    const text = `{"a":${kept},"b":"x\\nPGPASSWORD=${FAKE}","c":"plain","d":${kept}}`;
    const fields = redactSecretFieldsInJsonText(text, namesASecretField, scrubSecretValues);
    const rewritten = JSON.stringify(`x\nPGPASSWORD=${REDACTED}`);
    expect(fields.value).toBe(`{"a":${kept},"b":${rewritten},"c":"plain","d":${kept}}`);
    const at = (part: string) => fields.value.indexOf(part);
    const last = fields.value.lastIndexOf(kept);
    expect(fields.decodedSpans).toEqual([
      [at(kept), at(kept) + kept.length],
      [at(rewritten), at(rewritten) + rewritten.length],
      [last, last + kept.length],
    ]);
    // Read over as it is, the kept string's `\r` reads as the start of a value.
    expect(scrubSecretValues(kept).redactedValues).toBe(1);
    expect(scrubAll(text)).toEqual({ value: fields.value, redactedValues: 1 });
  });

  it('decodes a string the text ends inside, an escape the cut left unfinished kept after it', () => {
    const open = `{"stdout":"a\\nPGPASSWORD=${FAKE}\\nmore`;
    const hidden = `{"stdout":"a\\nPGPASSWORD=${REDACTED}\\nmore`;
    for (const partial of ['', '\\', '\\u', '\\u4', '\\u4e2']) {
      const fields = redactSecretFieldsInJsonText(
        open + partial,
        namesASecretField,
        scrubSecretValues,
      );
      expect({ value: fields.value, redactedValues: fields.redactedValues }).toEqual({
        value: hidden + partial,
        redactedValues: 1,
      });
      expect(fields.decodedSpans).toEqual([[hidden.indexOf('"a'), hidden.length + partial.length]]);
    }
    // An escaped backslash is a whole escape, not a cut one.
    expect(scrub(`${open}\\\\`).value).toBe(`${hidden}\\\\`);
    expect(scrub(`${open}\\\\u4`).value).toBe(`${hidden}\\\\u4`);
  });

  it('still replaces a secret-named field whole, and counts each once; a second pass changes nothing', () => {
    const text = `{"password":"a\\nb","items":["x\\nPGPASSWORD=${FAKE}"]}`;
    const once = scrub(text);
    expect(once).toEqual({
      value: `{"password":"${REDACTED}","items":[${JSON.stringify(`x\nPGPASSWORD=${REDACTED}`)}]}`,
      redactedValues: 2,
    });
    expect(scrub(once.value)).toEqual({ value: once.value, redactedValues: 0 });
  });

  it('without scrubValue, strings are left to the text pass as before', () => {
    const text = result(`x\nPGPASSWORD=${FAKE}`);
    expect(fieldsIn(text, namesASecretField)).toEqual({
      value: text,
      redactedValues: 0,
    });
  });

  it.each([
    ['one long escaped string', `{"a":"${'\\nPGPASSWORD=x'.repeat(14_000)}"}`],
    ['many escaped strings', `[${'"\\nPGPASSWORD=x",'.repeat(10_000)}"y"]`],
    ['escapes only', `{"a":"${'\\n'.repeat(100_000)}"}`],
    ['quoted values', `{"a":"${'API_TOKEN=\\"x\\" '.repeat(12_000)}"}`],
    ['a string cut open', `{"a":"${'\\nPGPASSWORD=x'.repeat(14_000)}\\u4`],
    ['many kept strings', `[${'"\\n",'.repeat(40_000)}"y"]`],
  ])('%s × 200 KB within 1 s', (_name, text) => {
    scrubAll(text.slice(0, 1_000));
    const started = performance.now();
    scrubAll(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('redactSecrets — jsonTextFields: the key rule over strings that are JSON text', () => {
  // The value patterns alone take only the token after `"credentials": ` (here the `{`).
  const text = '{"name": "db-1", "credentials": {"user": "bob", "pin": 1234}}';
  const shown = (options: Parameters<typeof redactSecrets>[1]) => {
    const redacted = redactSecrets({ text }, options);
    return { text: (redacted.value as { text: string }).text, count: redacted.redactedValues };
  };

  it('hides every value under a secret-named key of a string that is JSON, and counts it', () => {
    const fields = shown({ isSecretKey: namesASecretField, jsonTextFields: true });
    expect(fields.text).not.toContain('bob');
    expect(fields.text).not.toContain('1234');
    expect(fields.text).toContain('"name": "db-1"');
    expect(fields.count).toBe(shown({ isSecretKey: namesASecretField }).count + 2);
  });

  it('without it (or without isSecretKey), only the value patterns run over the text', () => {
    for (const options of [{ isSecretKey: namesASecretField }, { jsonTextFields: true }]) {
      expect(shown(options).text).toContain('"user": "bob", "pin": 1234');
    }
  });

  it('scrubs its escaped strings decoded too — the literals and the patterns (legacy 916)', () => {
    const dump = JSON.stringify({ stdout: `HOME=/w\nPGPASSWORD=${FAKE}\nNOTE=hunter2-plain-word` });
    const redacted = redactSecrets(
      { text: dump },
      { isSecretKey: namesASecretField, jsonTextFields: true, literals: ['hunter2-plain-word'] },
    );
    expect((redacted.value as { text: string }).text).toBe(
      JSON.stringify({ stdout: `HOME=/w\nPGPASSWORD=${REDACTED}\nNOTE=${REDACTED}` }),
    );
    expect(redacted.redactedValues).toBe(2);
  });
});
