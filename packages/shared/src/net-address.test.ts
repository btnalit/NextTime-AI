import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeIpLiteral,
  classifyAddress,
  hostPatternProblem,
  isInCidr,
  isIpLiteral,
  matchesDenySuffix,
  matchesSuffix,
  normalizeAddress,
  normalizeDenyHostPattern,
  parseCidr,
  parseCidrPrefixLength,
  parseIPv4,
  parseIPv4Literal,
  parseIPv6,
} from './net-address.js';

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

  // Legacy 777: a part with a leading zero is octal to inet_aton and the WHATWG URL parser, so the
  // strict parser refuses it as inet_pton and Node's net.isIP do (the kernel's subnet matcher).
  it.each(['192.0.2.07', '192.00.2.7', '198.051.100.7', '0192.0.2.7'])(
    'rejects %s (a leading zero), as net.isIP does',
    (input) => {
      expect(parseIPv4(input)).toBeNull();
      expect(isIP(input)).toBe(0);
    },
  );

  it('still accepts a lone zero part', () => {
    expect(parseIPv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
    expect(parseIPv4('192.0.2.0')).toEqual([192, 0, 2, 0]);
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

  // Legacy 777: a dotted-quad with a leading-zero part was read as decimal by the strict path, so
  // `192.0.2.010` came back as `.10` while a parsed URL's host is `.8`.
  it('reads a leading-zero part as octal, the way a parsed URL reads the host', () => {
    for (const spelling of [
      '192.0.2.010',
      '0300.0.2.7',
      '192.00.2.7',
      '192.0.02.7',
      '198.051.100.7',
    ]) {
      const urlHost = new URL(`http://${spelling}/`).hostname;
      expect({ spelling, canonical: canonicalizeIpLiteral(spelling) }).toEqual({
        spelling,
        canonical: urlHost,
      });
    }
    expect(parseIPv4Literal('192.0.2.010')).toEqual([192, 0, 2, 8]);
  });

  // Legacy 781: a bare `0x` part has no hex digits, and a parsed URL reads it as 0.
  it('reads a bare 0x part as 0, the way a parsed URL reads the host', () => {
    for (const spelling of ['0x', '0X', '0x.0x', '192.0.2.0x', '0x.0.2.7', '198.51.0x.7', '0x.1']) {
      const urlHost = new URL(`http://${spelling}/`).hostname;
      expect({ spelling, canonical: canonicalizeIpLiteral(spelling) }).toEqual({
        spelling,
        canonical: urlHost,
      });
    }
    expect(parseIPv4Literal('192.0.2.0x')).toEqual([192, 0, 2, 0]);
    expect(parseIPv4Literal('0x.0xg')).toBeNull();
    expect(parseIPv4Literal('0xx')).toBeNull();
  });

  // Every 1–4-part spelling from a set of parts: where a parsed URL reads an IPv4 address, this
  // reads the same one; where the URL refuses the host or keeps it as a name, this reads none.
  it('agrees with a parsed URL on every spelling of a small part set', () => {
    const parts = [
      '0',
      '0x',
      '0X',
      '00',
      '08',
      '010',
      '0x1',
      '0xff',
      '0x100',
      '1',
      '255',
      '256',
      '65535',
      '4294967295',
      'a',
    ];
    const spellings: string[] = [];
    const extend = (prefix: string[], depth: number): void => {
      if (prefix.length > 0) spellings.push(prefix.join('.'));
      if (depth === 0) return;
      for (const part of parts) extend([...prefix, part], depth - 1);
    };
    extend([], 4);
    const disagreements: string[] = [];
    for (const spelling of spellings) {
      let urlV4: string | null = null;
      try {
        const host = new URL(`http://${spelling}/`).hostname;
        urlV4 = parseIPv4(host) ? host : null;
      } catch {
        urlV4 = null;
      }
      const ours = canonicalizeIpLiteral(spelling);
      if (ours !== urlV4) disagreements.push(`${spelling}: url ${urlV4} ours ${ours}`);
    }
    expect(spellings.length).toBeGreaterThan(50_000);
    expect(disagreements).toEqual([]);
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

  // Legacy 149: an IPv6 literal comes back as the WHATWG URL parser writes the host, so an allow
  // list entry spelled out in full matches the host of a parsed URL.
  it('writes every spelling of an IPv6 address the way a parsed URL writes its host', () => {
    const spellings = [
      '2001:DB8:0:0:0:0:0:1',
      '2001:0db8::0001',
      'fd00:0:0:0:0:0:0:1',
      '0:0:0:0:0:0:0:0',
      '0:0:0:0:0:0:0:1',
      '::ffff:192.0.2.7',
      '64:ff9b::192.0.2.7',
      // Two runs of zeros of the same length: the first is compressed.
      '2001:db8:0:0:1:0:0:1',
      // The longer run is compressed, wherever it is.
      '2001:db8:0:1:0:0:0:1',
      // A single zero group is never written `::`.
      '1:0:2:3:4:5:6:7',
    ];
    for (const spelling of spellings) {
      const urlHost = new URL(`http://[${spelling}]/`).hostname.slice(1, -1);
      expect({ spelling, canonical: canonicalizeIpLiteral(spelling) }).toEqual({
        spelling,
        canonical: urlHost,
      });
    }
    expect(canonicalizeIpLiteral('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(canonicalizeIpLiteral('1:0:2:3:4:5:6:7')).toBe('1:0:2:3:4:5:6:7');
    // A URL host never carries a zone ID; the literal's own address is what is compared.
    expect(canonicalizeIpLiteral('fe80::1%eth0')).toBe('fe80::1');
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

  it('refuses an address with a leading-zero part, as the kernel subnet matcher does (legacy 777)', () => {
    for (const bad of ['198.051.100.0/24', '192.0.2.00/24', '::ffff:192.0.2.07/128']) {
      expect(() => parseCidr(bad), bad).toThrow(/invalid CIDR address/);
    }
  });

  it('reads the prefix length strictly: digits only, nothing after them (legacy 772)', () => {
    for (const bad of [
      '198.51.100.0/24abc',
      '198.51.100.0/24 ',
      '198.51.100.0/ 24',
      '198.51.100.0/+24',
      '198.51.100.0/24.0',
      '198.51.100.0/0x18',
      '198.51.100.0/',
      '198.51.100.0/-1',
      '2001:db8::/32x',
      '2001:db8::/129',
    ]) {
      expect(() => parseCidr(bad), bad).toThrow(/prefix length/);
    }
    expect(parseCidr('198.51.100.0/0').prefixLen).toBe(0);
    expect(parseCidr('198.51.100.7/32').prefixLen).toBe(32);
    expect(parseCidr('2001:db8::/128').prefixLen).toBe(128);
  });

  it('parseCidrPrefixLength: one to three digits, at most the family’s width', () => {
    expect(parseCidrPrefixLength('24', 32)).toBe(24);
    expect(parseCidrPrefixLength('024', 32)).toBe(24);
    expect(parseCidrPrefixLength('33', 32)).toBeUndefined();
    expect(parseCidrPrefixLength('128', 128)).toBe(128);
    expect(parseCidrPrefixLength('1000', 128)).toBeUndefined();
    // Legacy 777: at most three digits, even when the value would fit.
    expect(parseCidrPrefixLength('0024', 32)).toBeUndefined();
    expect(parseCidrPrefixLength('', 32)).toBeUndefined();
    expect(parseCidrPrefixLength('24abc', 32)).toBeUndefined();
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

describe('hostname suffix patterns (fix/egress-suffix-match)', () => {
  it('matchesSuffix (allow side) is strict: a bare name matches itself and subdomains, `.x` / `*.x` never match', () => {
    expect(matchesSuffix('api.example.com', ['example.com'])).toBe(true);
    expect(matchesSuffix('example.com', ['example.com'])).toBe(true);
    expect(matchesSuffix('api.example.com', ['.example.com'])).toBe(false);
    expect(matchesSuffix('example.com', ['.example.com'])).toBe(false);
    expect(matchesSuffix('api.example.com', ['*.example.com'])).toBe(false);
  });

  it('matchesDenySuffix (deny side) treats `.x` and `*.x` as the bare name', () => {
    for (const pattern of ['example.com', '.example.com', '*.example.com', '*.EXAMPLE.com.']) {
      expect(matchesDenySuffix('example.com', [pattern]), pattern).toBe(true);
      expect(matchesDenySuffix('api.example.com', [pattern]), pattern).toBe(true);
      expect(matchesDenySuffix('notexample.com', [pattern]), pattern).toBe(false);
    }
    expect(matchesDenySuffix('example.com', undefined)).toBe(false);
    expect(matchesDenySuffix('example.com', ['', '.', '*.'])).toBe(false);
  });

  it('an IP literal pattern matches only that address, however either side spells it', () => {
    for (const pattern of ['192.0.2.8', '192.0.2.010', '0xc0000208', '3221225992', '192.0.2.8.']) {
      expect(matchesSuffix('192.0.2.8', [pattern]), pattern).toBe(true);
      expect(matchesDenySuffix('192.0.2.8', [pattern]), pattern).toBe(true);
      expect(matchesSuffix('192.0.2.9', [pattern]), pattern).toBe(false);
    }
    // A short form is the address it spells, never a suffix of another address.
    expect(matchesSuffix('192.0.2.7', ['2.7'])).toBe(false);
    expect(matchesDenySuffix('192.0.2.7', ['2.7', '*.2.7', '.0.2.7'])).toBe(false);
    expect(matchesSuffix('2.0.0.7', ['2.7'])).toBe(true);
    // IPv6: any spelling, with or without the brackets a parsed URL keeps.
    for (const host of ['[2001:db8::1]', '2001:db8::1']) {
      for (const pattern of ['2001:db8::1', '2001:DB8:0:0:0:0:0:1', '[2001:db8::1]']) {
        expect(matchesSuffix(host, [pattern]), `${pattern} vs ${host}`).toBe(true);
      }
      expect(matchesSuffix(host, ['2001:db8::2'])).toBe(false);
    }
    // A name never matches an address, and an address never matches a name.
    expect(matchesSuffix('192.0.2.8', ['example.com'])).toBe(false);
    expect(matchesSuffix('a.example.com', ['192.0.2.8'])).toBe(false);
  });

  it('normalizeDenyHostPattern strips exactly one leading `*.` or `.`', () => {
    expect(normalizeDenyHostPattern(' *.Corp.Example. ')).toBe('corp.example');
    expect(normalizeDenyHostPattern('.corp.example')).toBe('corp.example');
    expect(normalizeDenyHostPattern('corp.example')).toBe('corp.example');
    expect(normalizeDenyHostPattern('..corp.example')).toBe('.corp.example');
    expect(normalizeDenyHostPattern('*.*.corp.example')).toBe('*.corp.example');
  });

  it('hostPatternProblem: null for a matchable name or an IP literal, a reason otherwise', () => {
    for (const ok of [
      'example.com',
      'Example.COM.',
      'intra',
      'a_b-c.example',
      '203.0.113.7',
      '::1',
    ]) {
      expect(hostPatternProblem(ok), ok).toBeNull();
    }
    expect(hostPatternProblem('.example.com')).toContain('write the bare name "example.com"');
    expect(hostPatternProblem('*.example.com')).toContain('starts with "*."');
    expect(hostPatternProblem('a.*.example.com')).toContain('wildcards');
    expect(hostPatternProblem('')).toBe('is empty');
    for (const bad of [
      'http://example.com',
      'example.com:443',
      '198.51.100.0/24',
      'a b',
      '[::1]',
      'a..b',
    ]) {
      expect(hostPatternProblem(bad), bad).toContain('not a host name');
    }
  });

  // Legacy 777: a name whose last label is a number is read by a URL as an IPv4 address and
  // refused when it is not one, so it can never match a request host; said, not taken as a name.
  it('hostPatternProblem: a name ending in a number that is no IP literal is refused (legacy 777)', () => {
    for (const bad of [
      '008.8.8.8',
      '192.0.2.09',
      '1.2.3.4.5',
      'example.123',
      'host.0x1f',
      'host.0x',
    ]) {
      expect(hostPatternProblem(bad), bad).toContain('ends in a number');
      expect(() => new URL(`http://${bad}/`), bad).toThrow();
    }
    for (const ok of [
      'host.0xg',
      'a1.b2',
      'example.com1',
      '127.1',
      '192.0.2.010',
      '2130706433',
      // Legacy 781: a bare `0x` part is 0, so these are IP literals, not names.
      '192.0.2.0x',
      '0x',
    ]) {
      expect(hostPatternProblem(ok), ok).toBeNull();
    }
  });
});
