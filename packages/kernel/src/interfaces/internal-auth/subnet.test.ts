import { describe, expect, it } from 'vitest';
import { InvalidCidrError, createSubnetMatcher } from './subnet.js';

/**
 * interfaces/internal-auth/subnet.test: pure unit tests over the CIDR matcher the internal-plane
 * guard uses for its `NEXTTIME_SUBNET_WORKERS` rule. Only RFC 5737 / RFC 3849 documentation ranges
 * appear here (CI's internal-IP-literal guard forbids RFC 1918 literals in every tracked file).
 */

describe('createSubnetMatcher', () => {
  it('matches IPv4 peers inside the subnet and rejects those outside', () => {
    const inWorkers = createSubnetMatcher('203.0.113.0/24');
    expect(inWorkers('203.0.113.1')).toBe(true);
    expect(inWorkers('203.0.113.254')).toBe(true);
    expect(inWorkers('203.0.112.255')).toBe(false);
    expect(inWorkers('203.0.114.1')).toBe(false);
    expect(inWorkers('198.51.100.7')).toBe(false);
  });

  it('treats an IPv4-mapped IPv6 peer (kernel bound to ::) as its embedded IPv4 address', () => {
    const inWorkers = createSubnetMatcher('203.0.113.0/24');
    expect(inWorkers('::ffff:203.0.113.9')).toBe(true);
    expect(inWorkers('::ffff:198.51.100.9')).toBe(false);
  });

  it('supports an IPv6 subnet', () => {
    const inRange = createSubnetMatcher('2001:db8:abcd::/48');
    expect(inRange('2001:db8:abcd:1::5')).toBe(true);
    expect(inRange('2001:db8:abce::1')).toBe(false);
    expect(inRange('203.0.113.1')).toBe(false);
  });

  it('never matches something that is not an IP address', () => {
    const inWorkers = createSubnetMatcher('203.0.113.0/24');
    expect(inWorkers('')).toBe(false);
    expect(inWorkers('not-an-ip')).toBe(false);
    expect(inWorkers('kernel')).toBe(false);
  });

  it('accepts surrounding whitespace and a /0 or full-length prefix', () => {
    expect(createSubnetMatcher(' 203.0.113.0/24 ')('203.0.113.1')).toBe(true);
    expect(createSubnetMatcher('0.0.0.0/0')('198.51.100.1')).toBe(true);
    expect(createSubnetMatcher('203.0.113.7/32')('203.0.113.7')).toBe(true);
    expect(createSubnetMatcher('203.0.113.7/32')('203.0.113.8')).toBe(false);
  });

  it('throws InvalidCidrError for a malformed value instead of silently matching nothing', () => {
    for (const bad of [
      '',
      '203.0.113.0',
      '203.0.113.0/',
      '203.0.113.0/33',
      '203.0.113.0/-1',
      '203.0.113.0/24/8',
      'not-an-ip/24',
      '2001:db8::/129',
    ]) {
      expect(() => createSubnetMatcher(bad), bad).toThrow(InvalidCidrError);
    }
  });
});
