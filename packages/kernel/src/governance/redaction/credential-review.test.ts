import { maskSecretFields } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  CredentialReviewRequiredError,
  ObserveParamsCarryCredentialsError,
  assertCredentialsReviewed,
  assertDraftCredentialsReviewed,
  countSuspectedSecrets,
  credentialReviewAudit,
  findCredentialValues,
  findSuspectedSecrets,
  namesASecretField,
  redactSecrets,
  redactSuspectedSecrets,
  reviewObserveParams,
} from './index.js';

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';
/** A Handle-shaped compact JWT; `.gitleaks.toml` allows its signature segment. */
const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';

describe('countSuspectedSecrets — the same detector as the scrubs', () => {
  it('counts secret-looking values inside strings, at any depth', () => {
    expect(countSuspectedSecrets({ cmd: `PGPASSWORD=${FAKE} psql` })).toBe(1);
    expect(
      countSuspectedSecrets({ steps: [{ run: `export API_TOKEN="${FAKE}"` }, `sk_live_${FAKE}`] }),
    ).toBe(2);
    expect(countSuspectedSecrets({ host: 'db.example.invalid', port: 5432, tags: ['a'] })).toBe(0);
  });

  it('with secretFields, also counts every string and number under a secret-named field', () => {
    const args = {
      user: 'ops',
      password: FAKE,
      nested: { apiKey0: FAKE, clientSecret: FAKE, pin: { secretCode: 1234 } },
      credentials: { user: 'u', pass: 'p' },
    };
    expect(countSuspectedSecrets(args)).toBe(0);
    expect(countSuspectedSecrets(args, { secretFields: true })).toBe(6);
  });

  it('a secret-named field that is blank, a boolean or null, or only names tokens as a quantity is not counted', () => {
    expect(
      countSuspectedSecrets(
        {
          password: '',
          token: '   ',
          apiKey: null,
          passwordRequired: true,
          max_tokens: 1024,
          tokenCount: 3,
          tokenizer: 'cl100k',
        },
        { secretFields: true },
      ),
    ).toBe(0);
  });

  it('a JSON Schema declaring a password property carries no value (documents leave secretFields off)', () => {
    const schema = { type: 'object', properties: { password: { type: 'string' } } };
    expect(countSuspectedSecrets(schema)).toBe(0);
  });

  it('a literal the schema carries for a secret-named property counts, even one no pattern knows', () => {
    const schema = {
      type: 'object',
      properties: {
        apiKey: { type: 'string', default: 'hunter2', examples: ['hunter3', ''] },
        password: { const: 'swordfish' },
        mode: { enum: ['fast', 'slow'], default: 'fast' },
        tokenType: { enum: ['bearer'] },
      },
    };
    expect(countSuspectedSecrets(schema)).toBe(3);
  });

  it('a schema literal that is an object or an array of objects is walked into', () => {
    const token = `sk_live_${FAKE}`;
    expect(countSuspectedSecrets({ properties: { apiKey: { default: { value: token } } } })).toBe(
      1,
    );
    expect(countSuspectedSecrets({ properties: { apiKey: { examples: [{ v: token }] } } })).toBe(1);
    expect(countSuspectedSecrets({ properties: { apiKey: { default: token } } })).toBe(1);
    expect(countSuspectedSecrets({ properties: { config: { default: { v: token } } } })).toBe(1);
    // A literal no pattern knows counts as well, inside an object literal too.
    expect(countSuspectedSecrets({ properties: { apiKey: { default: { v: 'hunter2' } } } })).toBe(
      1,
    );
  });

  it('counts a secret-named pair inside a string that is itself JSON', () => {
    expect(countSuspectedSecrets({ body: `{"apiKey0": "${FAKE}", "max_tokens": 10}` })).toBe(1);
  });
});

describe('findSuspectedSecrets — where, by field path only', () => {
  it('names each hit by its dot path, array items by index, never a value fragment', () => {
    const found = findSuspectedSecrets(
      {
        headers: { Authorization: `Bearer sk_live_${FAKE}` },
        steps: [{ run: 'ls' }, { run: `export API_TOKEN="${FAKE}"` }],
        password: FAKE,
        note: 'nothing here',
      },
      { secretFields: true },
    );
    expect(found.count).toBe(3);
    expect(found.paths).toEqual(['headers.Authorization', 'steps[1].run', 'password']);
    for (const path of found.paths) expect(path).not.toContain(FAKE);
  });

  it('a field name that itself looks like a secret is scrubbed in the path', () => {
    const found = findSuspectedSecrets(
      { [`sk_live_${FAKE}`]: { password: FAKE } },
      {
        secretFields: true,
      },
    );
    expect(found.count).toBe(1);
    expect(found.paths[0]).not.toContain(FAKE);
    expect(found.paths[0]).toMatch(/\.password$/);
  });

  it('keeps the count exact but lists at most 20 paths', () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`cmd${i}`, `PGPASSWORD=${FAKE} psql`]),
    );
    const found = findSuspectedSecrets(many, { secretFields: true });
    expect(found.count).toBe(25);
    expect(found.paths).toHaveLength(20);
  });
});

/** The paths where the console's mask put `[redacted]`, in the kernel's path notation. */
function maskedPaths(original: unknown, masked: unknown, path = ''): string[] {
  if (masked === '[redacted]' && original !== '[redacted]') return [path];
  if (Array.isArray(masked)) {
    return masked.flatMap((item, i) =>
      maskedPaths((original as unknown[])[i], item, `${path}[${i}]`),
    );
  }
  if (masked !== null && typeof masked === 'object') {
    return Object.entries(masked).flatMap(([key, inner]) =>
      maskedPaths(
        (original as Record<string, unknown>)[key],
        inner,
        path === '' ? key : `${path}.${key}`,
      ),
    );
  }
  return [];
}

describe('one rule: what the console hides = what the kernel counts = what the redactor replaces', () => {
  const keys = [
    'apiKey0',
    'api_key_2',
    'x-api-key',
    'password2',
    'PGPASSWORD',
    'tokenValue',
    'accessToken',
    'GITHUB_TOKEN',
    'secretRef',
    'authorizationHeader',
    'clientSecret',
    'credentials',
    'Cookie',
    'handle',
    'tokens',
    'apiTokens',
    'access_tokens',
    'maxTokens',
    'max_tokens',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'promptTokens',
    'completion_tokens',
    'cachedTokens',
    'tokenizer',
    'tokenCount',
    'note',
    'host',
  ];
  const values: readonly unknown[] = [
    'v1',
    '',
    7,
    true,
    null,
    { inner: 'v', flag: false, n: 3 },
    ['a', 2, false, { deep: 'd' }],
  ];
  const nestings: readonly ((key: string, value: unknown) => unknown)[] = [
    (key, value) => ({ [key]: value }),
    (key, value) => ({ outer: { [key]: value }, other: 'x' }),
    (key, value) => ({ list: [{ ok: 1 }, { [key]: value }] }),
  ];
  const fixtures = keys.flatMap((key) =>
    values.flatMap((value) => nestings.map((nest) => ({ key, value, params: nest(key, value) }))),
  );

  it.each(fixtures)('$key = $value', ({ params }) => {
    const hidden = maskedPaths(params, maskSecretFields(params));
    const counted = findSuspectedSecrets(params, { secretFields: true });
    const redacted = redactSecrets(params, {
      isSecretKey: namesASecretField,
      maxNodes: Number.POSITIVE_INFINITY,
    });
    expect(counted.count).toBe(hidden.length);
    expect([...counted.paths].sort()).toEqual([...hidden].sort());
    expect(redacted.redactedValues).toBe(counted.count);
    expect(redacted.value).toEqual(maskSecretFields(params));
    // The audit copy (dispatch.ts) is the same walk: same value, count and paths.
    const audited = redactSuspectedSecrets(params, { secretFields: true });
    expect(audited.value).toEqual(maskSecretFields(params));
    expect(audited.count).toBe(counted.count);
    expect(audited.paths).toEqual(counted.paths);
  });

  it('plural token names stay secret (as under #520), usage counts do not', () => {
    for (const key of ['tokens', 'apiTokens', 'access_tokens']) {
      expect(countSuspectedSecrets({ [key]: 'v' }, { secretFields: true })).toBe(1);
    }
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'completion_tokens']) {
      expect(countSuspectedSecrets({ [key]: 523 }, { secretFields: true })).toBe(0);
    }
  });

  it('the table covers both sides of the rule', () => {
    const hiddenSomewhere = fixtures.filter(
      ({ params }) => maskedPaths(params, maskSecretFields(params)).length > 0,
    );
    expect(hiddenSomewhere.length).toBeGreaterThan(100);
    expect(fixtures.length - hiddenSomewhere.length).toBeGreaterThan(100);
  });
});

const found = (count: number) => ({ count, paths: count > 0 ? ['x'] : [] });

describe('assertCredentialsReviewed', () => {
  it('passes with nothing to confirm, with or without the flag', () => {
    expect(() =>
      assertCredentialsReviewed('action_request', 'ar-1', found(0), undefined),
    ).not.toThrow();
    expect(() => assertCredentialsReviewed('action_request', 'ar-1', found(0), true)).not.toThrow();
  });

  it('refuses N > 0 unless the flag is exactly true, naming the subject and the count', () => {
    for (const flag of [undefined, false]) {
      expect(() => assertCredentialsReviewed('skill', 's-1@2', found(2), flag)).toThrow(
        CredentialReviewRequiredError,
      );
    }
    try {
      assertCredentialsReviewed('skill', 's-1@2', found(2), undefined);
    } catch (err) {
      expect(err).toMatchObject({
        code: 'credentials_review_required',
        details: { subject: 'skill', suspectedSecretValues: 2, suspectedSecretPaths: ['x'] },
      });
    }
    expect(() => assertCredentialsReviewed('skill', 's-1@2', found(2), true)).not.toThrow();
  });
});

describe('assertDraftCredentialsReviewed', () => {
  const draft = { markdown: `call it with --api-key=${FAKE}` };

  it('checks a person’s publish and returns the count', () => {
    expect(() =>
      assertDraftCredentialsReviewed('skill', 's-1@1', draft, { credentialsReviewed: undefined }),
    ).toThrow(CredentialReviewRequiredError);
    expect(
      assertDraftCredentialsReviewed('skill', 's-1@1', draft, { credentialsReviewed: true }),
    ).toBe(1);
  });

  it('an internal publish (no actor) confirms nothing', () => {
    expect(assertDraftCredentialsReviewed('skill', 's-1@1', draft, undefined)).toBe(0);
  });
});

describe('credentialReviewAudit', () => {
  it('records the confirmed count, and nothing when there was none', () => {
    expect(credentialReviewAudit(0)).toEqual({});
    expect(credentialReviewAudit(3)).toEqual({
      credentialReview: { suspectedSecretValues: 3, confirmed: true },
    });
  });
});

describe("redactSuspectedSecrets — the audit copy of a call's params", () => {
  it('replaces values under secret-named fields and secret-looking values anywhere, keeping the shape', () => {
    const params = {
      user: 'ops',
      password: 'hunter2',
      note: `Authorization: Bearer ${FAKE}`,
      query: { limit: 20, maxTokens: 1024, pageToken: 'cursor-2' },
      flag: true,
    };
    const audited = redactSuspectedSecrets(params, { secretFields: true });
    expect(audited.value).toEqual({
      user: 'ops',
      password: '[redacted]',
      note: 'Authorization: [redacted]',
      query: { limit: 20, maxTokens: 1024, pageToken: '[redacted]' },
      flag: true,
    });
    expect(audited.count).toBe(3);
    expect(audited.paths).toEqual(['password', 'note', 'query.pageToken']);
    expect(params.password).toBe('hunter2'); // the original is never touched
  });
});

/**
 * Legacy 175: an observe-class Operation's params. The table is the decision's two groups — a
 * value that is almost certainly a credential whatever field holds it is refused (a JWT, a vendor
 * key, a PEM key, a literal Bearer token, a URL's literal password); every other suspected value
 * passes and is recorded: a value under a secret-named field (a pagination cursor, a resource id),
 * and query text the other value patterns hit (a log search for failed Authorization, logfmt
 * `token=expired`, `$VAR` placeholders).
 */
describe('reviewObserveParams — refuse what is certainly a credential, record the rest', () => {
  const refused: readonly [string, Record<string, unknown>, readonly string[]][] = [
    ['a Handle-shaped JWT in an ordinary field', { q: HANDLE }, ['q']],
    ['a literal Bearer token', { header: `Bearer ${FAKE}` }, ['header']],
    [
      'a literal Bearer token in a curl line',
      { cmd: `curl -H "Authorization: Bearer ${FAKE}" https://api.example.invalid/v1/items` },
      ['cmd'],
    ],
    ['a vendor key, nested', { filter: { key: `sk-ant-${FAKE}` } }, ['filter.key']],
    ['a GitHub token in a list', { ids: ['repo-1', `ghp_${FAKE}`] }, ['ids[1]']],
    ['a URL with a password', { url: `postgres://ops:${FAKE}@db.example.invalid/app` }, ['url']],
    [
      'a PEM private key',
      { pem: `-----BEGIN PRIVATE KEY-----\n${FAKE}\n-----END PRIVATE KEY-----` },
      ['pem'],
    ],
    ['a JWT as an env assignment’s value', { cmd: `TOKEN=${HANDLE} ./probe` }, ['cmd']],
    [
      'a literal Bearer token under a secret-named field',
      { password: `Bearer ${FAKE}` },
      ['password'],
    ],
  ];

  it.each(refused)('refuses %s, naming the path and never the value', (_label, params, paths) => {
    let thrown: unknown;
    try {
      reviewObserveParams('inventory', 'list_items', params);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ObserveParamsCarryCredentialsError);
    const err = thrown as ObserveParamsCarryCredentialsError;
    expect(err.code).toBe('credentials_in_observe_params');
    expect(err.details).toEqual({ suspectedSecretValues: 1, suspectedSecretPaths: paths });
    expect(err.message).toContain('inventory.list_items');
    expect(err.message).toMatch(/Do not pass credentials/);
    expect(err.message).not.toContain(FAKE);
    expect(err.message).not.toContain(HANDLE);
  });

  const recorded: readonly [string, Record<string, unknown>, readonly string[]][] = [
    // Query text: a search for, or a placeholder of, a credential is not one.
    [
      'a LogQL search for failed Authorization',
      { q: '{app="api"} |= "Authorization: failed"' },
      ['q'],
    ],
    ['logfmt text with token=expired', { q: 'level=error msg="invalid token=expired"' }, ['q']],
    [
      'a Bearer $TOKEN placeholder in a curl line',
      { cmd: 'curl -H "Authorization: Bearer $TOKEN" https://api.example.invalid/v1/items' },
      ['cmd'],
    ],
    [
      'a --password=$VAR placeholder',
      { cmd: 'mysql --password=$MYSQL_PWD -h db -e "select 1"' },
      ['cmd'],
    ],
    [
      'a ${VAR} placeholder as a URL’s password',
      { url: 'postgres://ops:${PGPASS}@db/app' },
      ['url'],
    ],
    ['a $VAR placeholder as a URL’s password', { url: 'postgres://ops:$PGPASS@db/app' }, ['url']],
    [
      'a long word run after Bearer (no digit)',
      { q: 'Bearer authentication_failed_for_user' },
      ['q'],
    ],
    // Text patterns that can carry a literal secret too — recorded, and hidden in the audit copy.
    [
      'an Authorization header with another scheme',
      { raw: `Authorization: token ${FAKE}` },
      ['raw'],
    ],
    ['a Basic credential', { header: `Basic ${FAKE}` }, ['header']],
    ['an env assignment', { cmd: `PGPASSWORD=${FAKE} psql -h db` }, ['cmd']],
    ['a secret pair inside JSON text', { body: `{"apiKey": "${FAKE}"}` }, ['body']],
    ['a --password flag', { args: `--password ${FAKE}` }, ['args']],
    [
      'a page_token inside a next-page URL',
      { next: `https://api.example.invalid/items?page_token=${FAKE}` },
      ['next'],
    ],
    ['a pageToken inside a query string', { next: `/items?pageToken=${FAKE}` }, ['next']],
    // Secret-named fields: as often an ordinary cursor or resource id.
    ['pageToken', { pageToken: 'cursor-page-2', pageSize: 50 }, ['pageToken']],
    ['nextPageToken', { nextPageToken: 'opaque-cursor-42' }, ['nextPageToken']],
    ['page_token', { page_token: '3' }, ['page_token']],
    [
      'continuationToken, nested',
      { filter: { continuationToken: 'c-17' } },
      ['filter.continuationToken'],
    ],
    ['secretName (a resource id)', { secretName: 'prod/db-readonly' }, ['secretName']],
    ['accessKeyId (a resource id)', { accessKeyId: 'key-0042' }, ['accessKeyId']],
    ['apiKeyId (a resource id)', { apiKeyId: 'k-17' }, ['apiKeyId']],
    ['credentialId (a resource id)', { credentialId: 'cred-9' }, ['credentialId']],
    ['a password field', { password: 'hunter2' }, ['password']],
  ];

  it.each(recorded)('passes %s and records it for the audit row', (_label, params, paths) => {
    expect(reviewObserveParams('inventory', 'list_items', params)).toEqual({
      credentialReview: { suspectedSecretValues: paths.length, suspectedSecretPaths: paths },
    });
  });

  it.each([
    { query: 'status:open', limit: 20, since: '2026-10-01' },
    { maxTokens: 1024, tokenCount: 3, sort: 'name', page: 2 },
    { url: 'https://example.test/path?page=2&sort=name' },
    { passwordRequired: true, secretName: '', token: null },
    { header: 'Bearer $TOKEN', alt: 'Bearer ${TOKEN}' },
    { q: "select id from builds where sha = '0123456789abcdef0123456789abcdef01234567'" },
    {},
  ])('records nothing for ordinary params: %j', (params) => {
    expect(reviewObserveParams('inventory', 'list_items', params)).toEqual({});
  });

  it('the refused group is exactly the high-confidence patterns; whatever it finds is recorded too', () => {
    for (const [, params] of recorded) expect(findCredentialValues(params).count).toBe(0);
    for (const [, params] of refused) {
      expect(findCredentialValues(params).count).toBe(1);
      expect(findSuspectedSecrets(params, { secretFields: true }).count).toBeGreaterThan(0);
    }
  });

  it('a schema-literal-shaped param under a secret-named key is recorded, not refused', () => {
    const params = { apiKey: { default: 'x1' } };
    expect(findCredentialValues(params).count).toBe(0);
    expect(reviewObserveParams('inventory', 'list_items', params)).toEqual({
      credentialReview: { suspectedSecretValues: 1, suspectedSecretPaths: ['apiKey.default'] },
    });
  });
});
