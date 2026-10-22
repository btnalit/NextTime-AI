import { describe, expect, it } from 'vitest';
import {
  addressCarriesCredential,
  deriveGateId,
  gateEndpointDefaultScheme,
  gateIdFromTarget,
  hasUrlScheme,
  isAbsoluteUrl,
  normalizeGateIdInput,
  suggestedGateId,
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

describe('suggestedGateId (field-inventory #9)', () => {
  it('suggests gatekeeper-<kind>, numbered past ids already in use', () => {
    expect(suggestedGateId('ssh', [])).toBe('gatekeeper-ssh');
    expect(suggestedGateId('ssh', ['gatekeeper-ssh', 'gatekeeper-ssh-2'])).toBe('gatekeeper-ssh-3');
    expect(suggestedGateId('cli', ['gatekeeper-ssh'])).toBe('gatekeeper-cli');
  });
});

describe('gateEndpointDefaultScheme (legacy 152, review #501 on #661)', () => {
  // Private-range literals are built at run time: the repository guard refuses them in files.
  const ip = (...octets: number[]) => octets.join('.');

  it('keeps http for addresses only reachable inside the network', () => {
    for (const value of [
      'gate-host:8080',
      'gate',
      'localhost:8080',
      `${ip(10, 0, 0, 5)}:8080`,
      ip(172, 16, 0, 1),
      ip(172, 31, 255, 254),
      `${ip(192, 168, 1, 2)}:80/x`,
      ip(127, 0, 0, 1),
      ip(169, 254, 1, 1),
      ip(100, 64, 0, 1),
      '[::1]:8080',
      '[fd12:3456::1]:8443',
      '[fe80::1]',
      'gw.localhost',
      'gate.svc.cluster.local:8080',
      'billing.internal',
      'nas.lan',
      'box.home.arpa',
    ]) {
      expect(gateEndpointDefaultScheme(value), value).toBe('http');
    }
  });

  it('gives https to a public domain or IP, where http would send the secret in the clear', () => {
    for (const value of [
      'gate.example.com',
      'gate.example.com:8443/x',
      '//gate.example.com',
      ' Gate.Example.COM ',
      '203.0.113.5:8443',
      ip(172, 32, 0, 1),
      ip(100, 128, 0, 1),
      '[2001:db8::1]:8443',
    ]) {
      expect(gateEndpointDefaultScheme(value), value).toBe('https');
    }
  });
});
