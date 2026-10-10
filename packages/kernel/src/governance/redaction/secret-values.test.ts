import { namesASecretField } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  HIGH_CONFIDENCE_SECRET_PATTERNS,
  MAX_SECRET_LITERALS,
  OMITTED,
  REDACTED,
  redactSecretFieldsInJsonText,
  redactSecrets,
  scrubSecretLiterals,
  scrubSecretLiteralsIn,
  scrubSecretValues,
  secretFieldLiterals,
} from './index.js';

/** A Handle-shaped compact JWT. Synthetic — `.gitleaks.toml` allows this signature segment, and
 *  every other fixture here spells out `abcdefghijklmnopqrstuvwxyz`, which it allows too. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

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

  it('cannot see an encoded secret — the reason the fix is the Handle itself, not this', () => {
    const encoded = Buffer.from(HANDLE).toString('base64');
    expect(scrubSecretValues(encoded).value).toBe(encoded);
    expect(scrubSecretValues([...HANDLE].join(' ')).redactedValues).toBe(0);
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
