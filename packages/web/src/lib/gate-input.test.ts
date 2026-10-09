import { describe, expect, it } from 'vitest';
import {
  deriveGateId,
  gateIdFromTarget,
  hasUrlScheme,
  isAbsoluteUrl,
  normalizeGateIdInput,
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
