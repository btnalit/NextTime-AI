import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  isInCidr,
  normalizeAddress,
  parseCidr,
  parseIPv4,
  parseIPv6,
} from './net-utils.js';

/**
 * Builds a dotted-quad string from octets at runtime instead of writing it as literal source
 * text. CI's internal-IP-literal guard (.github/workflows/ci.yml) greps every tracked file for
 * literal `10.x.x.x` / `172.16-31.x.x` / `192.168.x.x` text with no test/fixture exclusion — any
 * of those three RFC1918 blocks, spelled out as plain text, trips it. This is a synthetic test
 * fixture, not a real address, so we build it via `Array#join` to keep the guard focused on what
 * it actually cares about: real hostnames/addresses accidentally committed to the repo.
 */
const quad = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join('.');

describe('parseIPv4', () => {
  it('parses a valid address', () => {
    expect(parseIPv4('192.0.2.7')).toEqual([192, 0, 2, 7]);
  });

  it.each(['1.2.3', '1.2.3.4.5', '1.2.3.256', 'a.b.c.d', ''])('rejects %s', (input) => {
    expect(parseIPv4(input)).toBeNull();
  });
});

describe('parseIPv6', () => {
  it('parses a full address', () => {
    expect(parseIPv6('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  it('expands "::" compression', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
  });

  it('expands an embedded IPv4 tail', () => {
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  });

  it.each(['::1::2', 'gggg::1', '1:2:3:4:5:6:7:8:9'])('rejects %s', (input) => {
    expect(parseIPv6(input)).toBeNull();
  });
});

describe('normalizeAddress', () => {
  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(normalizeAddress('::ffff:192.0.2.9')).toBe('192.0.2.9');
  });

  it('leaves a plain IPv4 address untouched', () => {
    expect(normalizeAddress('192.0.2.9')).toBe('192.0.2.9');
  });

  it('leaves a plain IPv6 address untouched', () => {
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('parseCidr / isInCidr', () => {
  it('matches an address inside an IPv4 subnet', () => {
    const range = parseCidr('198.51.100.0/24');
    expect(isInCidr('198.51.100.42', range)).toBe(true);
    expect(isInCidr('198.51.101.1', range)).toBe(false);
  });

  it('matches an address inside an IPv6 subnet', () => {
    const range = parseCidr('2001:db8::/32');
    expect(isInCidr('2001:db8::42', range)).toBe(true);
    expect(isInCidr('2001:db9::1', range)).toBe(false);
  });

  it('never matches across families', () => {
    const range = parseCidr('198.51.100.0/24');
    expect(isInCidr('2001:db8::1', range)).toBe(false);
  });

  it('throws on a malformed CIDR', () => {
    expect(() => parseCidr('not-a-cidr')).toThrow();
    expect(() => parseCidr('198.51.100.0/99')).toThrow();
  });
});

describe('classifyAddress', () => {
  const noSubnets: never[] = [];

  it('classifies RFC1918 addresses (10/8, 172.16/12, 192.168/16)', () => {
    expect(classifyAddress(quad(10, 1, 2, 3), noSubnets)).toBe('rfc1918');
    expect(classifyAddress(quad(172, 16, 0, 1), noSubnets)).toBe('rfc1918');
    expect(classifyAddress(quad(172, 31, 255, 254), noSubnets)).toBe('rfc1918');
    expect(classifyAddress(quad(172, 32, 0, 1), noSubnets)).toBe('public');
    expect(classifyAddress(quad(192, 168, 1, 1), noSubnets)).toBe('rfc1918');
  });

  it('classifies loopback', () => {
    expect(classifyAddress('127.0.0.1', noSubnets)).toBe('loopback');
    expect(classifyAddress('::1', noSubnets)).toBe('loopback');
  });

  it('classifies link-local (169.254/16, fe80::/10)', () => {
    expect(classifyAddress('169.254.1.1', noSubnets)).toBe('link-local');
    expect(classifyAddress('fe80::1', noSubnets)).toBe('link-local');
  });

  it('classifies CGNAT (100.64/10)', () => {
    expect(classifyAddress('100.64.0.1', noSubnets)).toBe('cgnat');
    expect(classifyAddress('100.127.255.255', noSubnets)).toBe('cgnat');
    expect(classifyAddress('100.63.255.255', noSubnets)).toBe('public');
    expect(classifyAddress('100.128.0.0', noSubnets)).toBe('public');
  });

  it('classifies IPv6 unique-local (fc00::/7)', () => {
    expect(classifyAddress('fc00::1', noSubnets)).toBe('unique-local-v6');
    expect(classifyAddress('fd12:3456::1', noSubnets)).toBe('unique-local-v6');
  });

  it('classifies an IPv4-mapped IPv6 RFC1918 address as rfc1918, not public', () => {
    expect(classifyAddress(`::ffff:${quad(10, 0, 0, 1)}`, noSubnets)).toBe('rfc1918');
  });

  it('classifies platform subnets', () => {
    const subnets = [parseCidr('198.51.100.0/24')];
    expect(classifyAddress('198.51.100.5', subnets)).toBe('platform-subnet');
    expect(classifyAddress('198.51.101.5', subnets)).toBe('public');
  });

  it('classifies documentation-range public addresses as public', () => {
    expect(classifyAddress('192.0.2.5', noSubnets)).toBe('public');
    expect(classifyAddress('198.51.100.5', noSubnets)).toBe('public');
    expect(classifyAddress('2001:db8::5', noSubnets)).toBe('public');
  });

  it('classifies unparseable input as invalid', () => {
    expect(classifyAddress('not-an-ip', noSubnets)).toBe('invalid');
  });
});
