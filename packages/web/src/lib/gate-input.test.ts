import { describe, expect, it } from 'vitest';
import {
  addressCarriesCredential,
  deriveGateId,
  gateIdFromTarget,
  hasUrlScheme,
  isAbsoluteUrl,
  normalizeGateIdInput,
  suggestedManifestSource,
  withDefaultScheme,
} from './gate-input.js';
import { GATE_ID_PATTERN } from './platform-errors.js';

describe('gate-input', () => {
  it('normalizes typed gate ids live without dropping a trailing hyphen', () => {
    expect(normalizeGateIdInput('My_Gate.Prod')).toBe('my-gate-prod');
    expect(normalizeGateIdInput('  --Billing API!')).toBe('billing-api');
    expect(normalizeGateIdInput('ops-')).toBe('ops-');
    expect(normalizeGateIdInput('a'.repeat(80))).toHaveLength(64);
  });

  it('derives a finished slug that passes the kernel rule, or nothing', () => {
    expect(deriveGateId('Billing_API v2.1')).toBe('billing-api-v2-1');
    expect(deriveGateId('a -- b --')).toBe('a-b');
    expect(deriveGateId('账单系统')).toBe('');
    expect(deriveGateId('x')).toBe('');
    expect(GATE_ID_PATTERN.test(deriveGateId(`${'a'.repeat(63)}-b`))).toBe(true);
  });

  it('suggests a gate id from a target host, with or without a scheme', () => {
    expect(gateIdFromTarget('https://billing.example.com:8443/api')).toBe('billing-example-com');
    expect(gateIdFromTarget('erp.internal')).toBe('erp-internal');
    expect(gateIdFromTarget('')).toBe('');
  });

  it('prepends a scheme only when there is none', () => {
    expect(withDefaultScheme(' billing.internal ', 'https')).toBe('https://billing.internal');
    expect(withDefaultScheme('gate-host:8080', 'http')).toBe('http://gate-host:8080');
    expect(withDefaultScheme('//host/x', 'https')).toBe('https://host/x');
    expect(withDefaultScheme('http://already', 'https')).toBe('http://already');
    expect(withDefaultScheme('   ', 'https')).toBe('');
    // Not a host: left alone, so a caller never reports "added https://" to it.
    expect(withDefaultScheme('://bad url', 'https')).toBe('://bad url');
    expect(withDefaultScheme(' ://x ', 'https')).toBe('://x');
    expect(withDefaultScheme('billing internal', 'https')).toBe('billing internal');
    expect(withDefaultScheme(':8080', 'http')).toBe(':8080');
    expect(gateIdFromTarget('://bad url')).toBe('');
    expect(hasUrlScheme('HTTPS://x')).toBe(true);
    expect(isAbsoluteUrl('https://not a url')).toBe(false);
    expect(isAbsoluteUrl('http://gate-host:8080')).toBe(true);
  });
});

/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

describe('addressCarriesCredential / suggestedManifestSource (review of #549)', () => {
  it.each([
    ['a plain URL', 'https://grafana.example'],
    ['a host without a scheme', 'grafana.example:3000/api'],
    ['a plain query', 'https://grafana.example/?version=3'],
    ['a format query', 'https://grafana.example/api?format=json'],
    ['words, not a URL', 'the billing system'],
  ])('a target that is %s carries no credential', (_name, value) => {
    expect(addressCarriesCredential(value)).toBe(false);
  });

  it.each([
    ['a user name and password', `https://ops:${FAKE}@grafana.example`],
    ['a user name alone', 'https://ops@grafana.example'],
    ['a token query', `https://grafana.example/?token=${FAKE}`],
    ['an access_token query', `grafana.example/api?access_token=${FAKE}`],
    ['an api_key query', `https://grafana.example/?v=1&api_key=${FAKE}`],
    ['a SAS signature', `https://store.blob.example/c?sv=2022-11-02&sig=${FAKE}`],
    ['a key query', `https://maps.example/api?key=${FAKE}`],
    ['an AWS signed URL', `https://b.s3.example/o?X-Amz-Signature=${FAKE}`],
  ])('a target with %s carries a credential', (_name, value) => {
    expect(addressCarriesCredential(value)).toBe(true);
  });

  it('suggests <origin><path>/openapi.json, never the query or fragment', () => {
    expect(suggestedManifestSource('https://billing.example.com/')).toBe(
      'https://billing.example.com/openapi.json',
    );
    expect(suggestedManifestSource('billing.example.com:8443/api')).toBe(
      'https://billing.example.com:8443/api/openapi.json',
    );
    expect(suggestedManifestSource('https://billing.example.com/api?version=3#top')).toBe(
      'https://billing.example.com/api/openapi.json',
    );
  });

  it.each([
    ['carries a password', `https://ops:${FAKE}@grafana.example`],
    ['carries a token', `https://grafana.example/?token=${FAKE}`],
    ['is empty', ''],
    ['is not http(s)', 'ssh://deploy@db-1'],
  ])('offers nothing when the target %s', (_name, value) => {
    expect(suggestedManifestSource(value)).toBe('');
  });
});
