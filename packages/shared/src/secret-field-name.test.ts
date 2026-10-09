import { describe, expect, it } from 'vitest';
import { isSecretFieldValue, maskSecretFields, namesASecretField } from './secret-field-name.js';

describe('namesASecretField', () => {
  it.each([
    'password',
    'password2',
    'dbpassword',
    'PGPASSWORD',
    'passwd',
    'passphrase',
    'secret',
    'secretRef',
    'clientSecret',
    'client.secret',
    'credentials',
    'authorization',
    'authorizationHeader',
    'Proxy-Authorization',
    'apiKey',
    'apiKey0',
    'api_key_2',
    'x-api-key',
    'X-Api-Key',
    'APIKEY',
    'privateKey',
    'private_key',
    'accessKey',
    'token',
    'token2',
    'tokenValue',
    'accessToken',
    'access_token',
    'refreshtoken',
    'idToken',
    'GITHUB_TOKEN',
    'x-auth-token',
    'Cookie',
    'set-cookie',
    'bearer',
    'handle',
    'CAPABILITY_HANDLE',
    'capabilityHandle',
  ])('%s names a secret', (name) => {
    expect(namesASecretField(name)).toBe(true);
  });

  it.each([
    'max_tokens',
    'maxTokens',
    'max_token',
    'tokens',
    'tokenizer',
    'tokenCount',
    'token_limit',
    'tokenType',
    'inputTokens',
    'prompt_tokens',
    'cookieConsent',
    'fileHandle',
    'handler',
    'key',
    'keyName',
    'monkey',
    'author',
    'auth',
    'user',
    'host',
  ])('%s does not', (name) => {
    expect(namesASecretField(name)).toBe(false);
  });

  it('runs in linear time on a long or adversarial name', () => {
    const started = performance.now();
    namesASecretField('A'.repeat(100_000));
    namesASecretField('aB'.repeat(100_000));
    namesASecretField(`${'_'.repeat(100_000)}x`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('isSecretFieldValue', () => {
  it('a non-blank string or a finite number is a secret value; the rest shows', () => {
    expect(isSecretFieldValue('s')).toBe(true);
    expect(isSecretFieldValue(123456)).toBe(true);
    expect(isSecretFieldValue('  ')).toBe(false);
    expect(isSecretFieldValue(true)).toBe(false);
    expect(isSecretFieldValue(null)).toBe(false);
    expect(isSecretFieldValue(Number.NaN)).toBe(false);
  });
});

describe('maskSecretFields', () => {
  it('masks every string and number under a secret-named field, at any depth, keeping the shape', () => {
    expect(
      maskSecretFields({
        a: 1,
        maxTokens: 4096,
        nested: { apiKey0: 's', list: [{ password: 'p', ok: 2 }] },
        credentials: { user: 'u', pin: 1234, enabled: true, note: '' },
        apiKeys: ['a', 'b'],
      }),
    ).toEqual({
      a: 1,
      maxTokens: 4096,
      nested: { apiKey0: '[redacted]', list: [{ password: '[redacted]', ok: 2 }] },
      credentials: { user: '[redacted]', pin: '[redacted]', enabled: true, note: '' },
      apiKeys: ['[redacted]', '[redacted]'],
    });
  });

  it('keeps a "__proto__" key as a field', () => {
    const out = maskSecretFields(JSON.parse('{"__proto__": {"token": "t"}}')) as object;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"token":"[redacted]"}}');
  });
});
