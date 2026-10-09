import { describe, expect, it } from 'vitest';
import {
  HIGH_CONFIDENCE_SECRET_PATTERNS,
  OMITTED,
  REDACTED,
  redactSecrets,
  scrubSecretValues,
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
    `Authorization: token ${FAKE}`,
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
  ])('%j × 200 KB within 1 s', (unit) => {
    const text = repeat(unit);
    certain(text.slice(0, 1_000));
    const started = performance.now();
    certain(text);
    expect(performance.now() - started).toBeLessThan(1_000);
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
