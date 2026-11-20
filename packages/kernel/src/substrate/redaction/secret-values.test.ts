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
  platformApiKeys,
  platformKeyShapes,
  redactSecretFieldsInJsonText,
  redactSecrets,
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
  ])('is not matched %s', (_label, text) => {
    expect(scrubSecretValues(text)).toEqual({ value: text, redactedValues: 0 });
    expect(certain(text)).toMatchObject({ value: text, redactedValues: 0 });
  });

  it('a 32-byte value in standard base64 (a WireGuard key, a SHA-256= digest) is never one', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const value = randomBytes(32).toString('base64');
      expect(value).toHaveLength(44);
      for (const text of [value, `PublicKey = ${value}`, `Digest: SHA-256=${value}, sent`]) {
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
      const digest = createHash('sha256').update(randomBytes(16)).digest('base64url');
      const x = randomBytes(32).toString('base64url');
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
      for (const text of [block, `data:application/octet-stream;base64,${block}`, pem]) {
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

  it('platformApiKeys gives prefixed keys and pre-prefix shapes as written, in order', () => {
    const text = `old ${PLATFORM_KEY}, new ${KEY}; call_${KEY} not ${WIREGUARD_KEY} nor agentk_${PLATFORM_KEY}`;
    expect(platformApiKeys(text)).toEqual([PLATFORM_KEY, KEY, KEY]);
    expect(platformKeyShapes(text)).toEqual([PLATFORM_KEY]);
    expect(platformApiKeys('nothing here')).toEqual([]);
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
  ])('%j × 200 KB within 1 s', (unit) => {
    const text = repeat(unit);
    scrubSecretValues(text.slice(0, 1_000));
    const started = performance.now();
    scrubSecretValues(text);
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

describe('redactSecretFieldsInJsonText — the field rule over JSON text (legacy 185)', () => {
  const mask = (text: string) => redactSecretFieldsInJsonText(text, namesASecretField);

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
    expect(
      redactSecretFieldsInJsonText('{"connectionSecret":"x","pin":4321}', (key) => key === 'pin'),
    ).toEqual({ value: `{"connectionSecret":"x","pin":"${REDACTED}"}`, redactedValues: 1 });
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
});
