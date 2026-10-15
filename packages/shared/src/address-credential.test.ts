import { describe, expect, it } from 'vitest';
import {
  ADDRESS_CREDENTIAL_SQL,
  ADDRESS_SECRET_QUERY_NAMES,
  addressCredential,
  queryParamNameCarriesCredential,
} from './address-credential.js';

/** Synthetic values only. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe('addressCredential', () => {
  it.each([
    [`https://ops:${FAKE}@grafana.example`, 'password'],
    [`ssh://deploy:${FAKE}@db-1.example`, 'password'],
    [`https://api.example/v1?token=${FAKE}`, 'query'],
    [`https://api.example/v1?format=json&access_token=${FAKE}`, 'query'],
    [`https://api.example/v1?api_key=${FAKE}`, 'query'],
    [`https://api.example/v1?apikey=${FAKE}`, 'query'],
    [`https://api.example/v1?Password=${FAKE}`, 'query'],
    [`https://api.example/v1?client_secret=${FAKE}`, 'query'],
    [`https://maps.example/api?key=${FAKE}`, 'query'],
    [`https://store.blob.example/c/b?sv=2022-11-02&sp=r&sig=${FAKE}`, 'query'],
    [`https://cdn.example/f?signature=${FAKE}`, 'query'],
    [
      `https://bucket.s3.example/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261010&X-Amz-Signature=${FAKE}`,
      'query',
    ],
    [`https://bucket.s3.example/o?x-amz-security-token=${FAKE}`, 'query'],
    [`https://storage.example/o?X-Goog-Signature=${FAKE}`, 'query'],
    [`https://storage.example/o?X-Goog-Credential=${FAKE}`, 'query'],
    [`https://app.example/cb#access_token=${FAKE}&token_type=bearer`, 'query'],
    [`https://api.example/v1;jsessionid=x?pwd=${FAKE}`, 'query'],
    [`grafana.example/api?auth=${FAKE}`, 'query'],
    [`https://api.example/v1?%74oken=${FAKE}`, 'query'],
  ] as const)('%s carries a credential (%s)', (address, kind) => {
    expect(addressCredential(address)).toBe(kind);
  });

  it.each([
    'https://grafana.example.com',
    'https://api.example/openapi.json?format=json',
    'https://api.example/openapi.json?version=3&lang=en',
    'https://api.example/v1?max_tokens=5',
    'https://api.example/v1?keyName=primary',
    'https://api.example/v1?token=',
    'https://api.example/v1?token',
    'https://grafana.example:8443/d/abc#panel-2',
    'ssh://deploy@db-1.example',
    'https://deploy@grafana.example',
    'deploy@db-1',
    '10.0.0.0/24',
    '',
  ])('%s carries none', (address) => {
    expect(addressCredential(address)).toBeNull();
  });

  it('judges query names by the shared field rule plus the short list', () => {
    for (const name of ADDRESS_SECRET_QUERY_NAMES) {
      expect(queryParamNameCarriesCredential(name)).toBe(true);
      expect(queryParamNameCarriesCredential(name.toUpperCase())).toBe(true);
    }
    expect(queryParamNameCarriesCredential('format')).toBe(false);
    expect(queryParamNameCarriesCredential('X-Amz-Algorithm')).toBe(false);
  });

  it('runs in linear time on a long or adversarial address', () => {
    const long = `https://api.example/?${'a=b&'.repeat(50_000)}x=${'='.repeat(50_000)}`;
    const started = Date.now();
    expect(addressCredential(long)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('ADDRESS_CREDENTIAL_SQL', () => {
  // PostgreSQL's `~*` with these patterns is checked against `addressCredential` on the same corpus
  // in the kernel's scrub integration test; here the JavaScript reading of the same text keeps a
  // fast signal for an edit that breaks the alternation.
  const password = new RegExp(ADDRESS_CREDENTIAL_SQL.password, 'i');
  const query = new RegExp(ADDRESS_CREDENTIAL_SQL.query, 'i');

  it('lists every short name', () => {
    for (const name of ADDRESS_SECRET_QUERY_NAMES) {
      expect(query.test(`https://h/?${name}=v`)).toBe(true);
    }
  });

  it('flags the userinfo password but not a user name or a port', () => {
    expect(password.test(`https://ops:${FAKE}@h`)).toBe(true);
    expect(password.test('https://ops@h')).toBe(false);
    expect(password.test('https://h:8443/x')).toBe(false);
  });

  it('keeps a plain query', () => {
    expect(query.test('https://h/openapi.json?format=json&version=3')).toBe(false);
    expect(query.test('https://h/x?keyName=a')).toBe(false);
  });
});
