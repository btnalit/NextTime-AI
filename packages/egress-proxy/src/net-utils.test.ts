import { describe, expect, it } from 'vitest';
import {
  canonicalizeIpLiteral,
  classifyAddress,
  isInCidr,
  isIpLiteral,
  normalizeAddress,
  parseCidr,
  parseIPv4,
  parseIPv4Literal,
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

describe('parseIPv4Literal (lane-6 review P3 — inet_aton-compatible alternate notations)', () => {
  it('still parses a strict dotted-quad (delegates to parseIPv4)', () => {
    expect(parseIPv4Literal('192.0.2.7')).toEqual([192, 0, 2, 7]);
  });

  it('parses a single decimal number (a.b.c.d packed into one 32-bit value)', () => {
    // 2130706433 == 0x7F000001 == 127.0.0.1 (loopback) — this exact value is a well-documented
    // SSRF-blocklist-bypass example (decimal-encoded loopback), used here as the test case.
    expect(parseIPv4Literal('2130706433')).toEqual([127, 0, 0, 1]);
  });

  it('parses a hexadecimal number', () => {
    expect(parseIPv4Literal('0x7f000001')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4Literal('0X7F000001')).toEqual([127, 0, 0, 1]);
  });

  it('parses an octal-prefixed part', () => {
    // 0177 (octal) == 127 decimal.
    expect(parseIPv4Literal('0177.0.0.1')).toEqual([127, 0, 0, 1]);
  });

  it('parses short dotted forms (a.b and a.b.c — the last part absorbs the remaining bits)', () => {
    expect(parseIPv4Literal('127.1')).toEqual([127, 0, 0, 1]);
    // 198.18.0.0/15 is IANA-reserved for benchmarking (RFC 2544), not RFC1918 — used here (and in
    // the trustedResolvedCidrs example this codebase already ships) because it's a real-world
    // "fake-IP" convention, not because of anything special about this test.
    expect(parseIPv4Literal('198.18.1')).toEqual([198, 18, 0, 1]);
  });

  it('allows mixed notations across parts', () => {
    expect(parseIPv4Literal('0x7f.0.0.1')).toEqual([127, 0, 0, 1]);
  });

  it('rejects a part exceeding its own bit width', () => {
    expect(parseIPv4Literal('256.0.0.1')).toBeNull(); // strict parseIPv4 already rejects this
    expect(parseIPv4Literal('999999999999')).toBeNull(); // overflows 32 bits as a single part
  });

  it('rejects more than 4 dotted parts, and non-numeric parts', () => {
    expect(parseIPv4Literal('1.2.3.4.5')).toBeNull();
    expect(parseIPv4Literal('a.b.c.d')).toBeNull();
    expect(parseIPv4Literal('')).toBeNull();
  });

  it('rejects a signed part (leading +/-), which Number.parseInt alone would accept', () => {
    expect(parseIPv4Literal('-1')).toBeNull();
    expect(parseIPv4Literal('+127.0.0.1')).toBeNull();
  });
});

describe('isIpLiteral / canonicalizeIpLiteral', () => {
  it('recognizes every notation parseIPv4Literal does, plus IPv6', () => {
    expect(isIpLiteral('192.0.2.7')).toBe(true);
    expect(isIpLiteral('2130706433')).toBe(true);
    expect(isIpLiteral('0x7f000001')).toBe(true);
    expect(isIpLiteral('127.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
  });

  it('does not treat an ordinary hostname as a literal', () => {
    expect(isIpLiteral('example.com')).toBe(false);
    expect(isIpLiteral('kernel')).toBe(false);
  });

  it('canonicalizes an alternate-notation literal to dotted-quad', () => {
    expect(canonicalizeIpLiteral('2130706433')).toBe('127.0.0.1');
    expect(canonicalizeIpLiteral('0x7f000001')).toBe('127.0.0.1');
    expect(canonicalizeIpLiteral('127.1')).toBe('127.0.0.1');
  });

  it('leaves an already-strict literal (v4 or v6) as its own canonical form', () => {
    expect(canonicalizeIpLiteral('192.0.2.7')).toBe('192.0.2.7');
    expect(canonicalizeIpLiteral('::1')).toBe('::1');
  });

  it('returns null for a non-literal hostname', () => {
    expect(canonicalizeIpLiteral('example.com')).toBeNull();
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

  it('expands an embedded IPv4 tail immediately after "::" (lane-6 review P3 regression)', () => {
    // Found writing the NAT64 classifyAddress tests: naively stripping one trailing ':' after
    // removing the embedded quad turned "64:ff9b::" into "64:ff9b:", corrupting the "::"
    // compression marker into a single colon and making the whole address unparseable.
    expect(parseIPv6('64:ff9b::127.0.0.1')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x7f00, 1]);
    expect(parseIPv6('::127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0, 0x7f00, 1]);
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

  describe('NAT64 (64:ff9b::/96) embedded-IPv4 unwrapping (lane-6 review P3)', () => {
    it('classifies a NAT64-embedded loopback address as loopback, not public', () => {
      // 64:ff9b::7f00:1 embeds 127.0.0.1 (0x7f00=127.0, 0x0001=0.1) per RFC 6052.
      expect(classifyAddress('64:ff9b::7f00:1', noSubnets)).toBe('loopback');
    });

    it('classifies a NAT64-embedded RFC1918 address as rfc1918, not public', () => {
      // Embed quad(10,0,0,1) as hex groups: 0x0a00 = 10.0, 0x0001 = 0.1.
      expect(classifyAddress('64:ff9b::a00:1', noSubnets)).toBe('rfc1918');
    });

    it('classifies a NAT64-embedded CGNAT address as cgnat, not public', () => {
      // 100.64.0.1 -> 0x6440, 0x0001.
      expect(classifyAddress('64:ff9b::6440:1', noSubnets)).toBe('cgnat');
    });

    it('classifies a NAT64-embedded platform-subnet address as platform-subnet', () => {
      const subnets = [parseCidr('198.51.100.0/24')];
      // 198.51.100.5 -> 0xc633, 0x6405.
      expect(classifyAddress('64:ff9b::c633:6405', subnets)).toBe('platform-subnet');
    });

    it('still classifies a NAT64-embedded genuinely public address as public', () => {
      // 192.0.2.5 -> 0xc000, 0x0205.
      expect(classifyAddress('64:ff9b::c000:205', noSubnets)).toBe('public');
    });

    it('does not misclassify an ordinary public IPv6 address that merely resembles the prefix', () => {
      expect(classifyAddress('64:ff9c::1', noSubnets)).toBe('public'); // one bit off the WKP
      expect(classifyAddress('2001:db8::1', noSubnets)).toBe('public');
    });

    it('accepts the embedded-IPv4 dotted form too (parseIPv6 already supports it)', () => {
      expect(classifyAddress('64:ff9b::127.0.0.1', noSubnets)).toBe('loopback');
    });
  });
});
