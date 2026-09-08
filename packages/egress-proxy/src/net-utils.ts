/**
 * Pure IPv4/IPv6 parsing and address classification (design doc §7.9, §5.4 I10). No IO — every
 * function here is a deterministic function of its arguments so `policy.ts` can unit-test every
 * deny class without a real network or DNS resolver.
 *
 * Well-known deny classes (RFC1918, loopback, link-local, CGNAT, IPv6 unique-local/link-local)
 * are matched via direct octet/bit comparisons rather than parsed CIDR string literals. This
 * isn't just style: three of those literal ranges (10/8, 172.16/12, 192.168/16), if ever written
 * out as dotted-quad text anywhere in this repo, trip CI's internal-IP-literal guard
 * (.github/workflows/ci.yml "Internal IP literal guard"), which has no path/test exclusions.
 * Numeric range checks never spell the literal out, so the guard and the policy coexist cleanly.
 * The platform subnets (`NEXTTIME_SUBNET_CONTROL`/`WORKERS`) are only ever CIDR strings that
 * arrive at runtime via env vars, so `parseCidr`/`isInCidr` below is safe to keep general.
 *
 * Two hardening additions (lane-6 review P3), both closing gaps between what this proxy's own
 * *strict* parsers recognized and what a real resolver/HTTP client stack does: `parseIPv4Literal`/
 * `isIpLiteral`/`canonicalizeIpLiteral` recognize every legacy `inet_aton`-compatible IPv4
 * notation (decimal, hex, octal, short dotted forms) as a literal address, not just dotted-quad —
 * see `parseIPv4Literal`'s own doc comment for the SSRF-bypass class this closes. `classifyAddress`
 * unwraps a NAT64 `64:ff9b::/96` address (RFC 6052) to its embedded IPv4 address before
 * classifying, instead of treating every NAT64-synthesized address as `'public'` regardless of
 * what it actually points at.
 */

export type AddressFamily = 4 | 6;

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'link-local'
  | 'rfc1918'
  | 'cgnat'
  | 'unique-local-v6'
  | 'platform-subnet'
  | 'invalid';

/** Parsed CIDR range, kept as a family tag + BigInt network address + prefix length. */
export interface CidrRange {
  family: AddressFamily;
  network: bigint;
  prefixLen: number;
}

/** Parse a dotted-quad IPv4 address into its four octets, or `null` if malformed. */
export function parseIPv4(input: string): [number, number, number, number] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/** One `inet_aton`-style dotted-part: decimal, `0x`-prefixed hex, or leading-zero octal — the
 *  same three notations `parseIPv4Literal` below decomposes an address into. `null` for anything
 *  else (including a leading `+`/`-`, which `Number.parseInt` would otherwise silently accept). */
function parseAtonPart(part: string): number | null {
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = Number.parseInt(part, 8);
  } else if (/^(0|[1-9]\d*)$/.test(part)) {
    value = Number.parseInt(part, 10);
  } else {
    return null;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parses every legacy `inet_aton`-compatible IPv4 literal notation `parseIPv4` (strict dotted-
 * quad only) does not: decimal (`2130706433`), hexadecimal (`0x7f000001`), octal (a part with a
 * leading `0`, e.g. `0177.0.0.1`), and short dotted forms (`a`, `a.b`, `a.b.c` — the last part
 * absorbs the octets a full dotted-quad would otherwise need, exactly as BSD `inet_aton` and the
 * `getaddrinfo`/`inet_pton` family many HTTP clients and resolvers still fall back to for a
 * "hostname" that looks numeric). Individual parts may mix notations (`0x7f.0.0.1` is valid).
 *
 * This exists to close a well-documented SSRF bypass class (see e.g. the PayloadsAllTheThings
 * SSRF cheat sheet's "IP address" section): a policy that only recognizes strict dotted-quad as
 * "this is a literal IP address" can be fooled into treating one of these forms as an opaque
 * hostname needing DNS resolution — `policy.ts`'s `decideEgress` uses this (via `isIpLiteral`
 * below) so, e.g., a caller can never bypass its "a literal IP into `trustedResolvedCidrs` is
 * still denied" rule (`PolicyConfig.trustedResolvedCidrs`'s own doc comment) by spelling the
 * target in a form the strict parser doesn't recognize as literal.
 */
export function parseIPv4Literal(input: string): [number, number, number, number] | null {
  const strict = parseIPv4(input);
  if (strict) return strict;
  if (input.length === 0) return null;

  const parts = input.split('.');
  if (parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    const value = parseAtonPart(part);
    if (value === null) return null;
    values.push(value);
  }

  const n = values.length;
  // Every part but the last must fit in one octet; the last absorbs whatever bit width remains
  // (32 bits total, 8 bits per non-last part).
  for (let i = 0; i < n - 1; i++) {
    if ((values[i] as number) > 0xff) return null;
  }
  const lastMax = 2 ** (8 * (4 - (n - 1))) - 1; // n=1 -> 2^32-1, n=2 -> 2^24-1, ..., n=4 -> 2^8-1
  const lastValue = values[n - 1] as number;
  if (lastValue > lastMax) return null;

  let total = lastValue;
  for (let i = 0; i < n - 1; i++) {
    total += (values[i] as number) * 2 ** (8 * (4 - 1 - i));
  }
  if (total > 0xffffffff) return null;

  return [
    Math.floor(total / 16777216) % 256,
    Math.floor(total / 65536) % 256,
    Math.floor(total / 256) % 256,
    total % 256,
  ];
}

/** Whether `input` is any IP literal this proxy must treat as "already an address, not a
 *  hostname to resolve": strict dotted-quad/colon-hex (`parseIPv4`/`parseIPv6`) plus every
 *  `inet_aton`-compatible alternate IPv4 form `parseIPv4Literal` recognizes. */
export function isIpLiteral(input: string): boolean {
  return parseIPv4Literal(input) !== null || parseIPv6(input) !== null;
}

/**
 * Canonical form of `input` when it's any recognized IP literal (`isIpLiteral`), else `null`.
 * `proxy.ts`'s default resolver uses this to short-circuit an alternate-notation literal straight
 * to its dotted-quad form instead of asking the OS resolver to interpret a numeric "hostname" it
 * may or may not handle the same way this proxy's own policy does.
 */
export function canonicalizeIpLiteral(input: string): string | null {
  const v4 = parseIPv4Literal(input);
  if (v4) return v4.join('.');
  return parseIPv6(input) !== null ? input : null;
}

/**
 * Parse an IPv6 address (including `::` compression and a trailing embedded IPv4 tail, e.g.
 * `::ffff:127.0.0.1`) into its eight 16-bit groups, or `null` if malformed. Zone IDs (`%eth0`)
 * are stripped and ignored.
 */
export function parseIPv6(input: string): number[] | null {
  const withoutZone = input.split('%')[0] ?? input;

  let head = withoutZone;
  let v4Tail: number[] = [];
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(withoutZone);
  if (embedded?.[1] !== undefined) {
    const v4 = parseIPv4(embedded[1]);
    if (!v4) return null;
    v4Tail = [((v4[0] << 8) | v4[1]) >>> 0, ((v4[2] << 8) | v4[3]) >>> 0];
    head = withoutZone.slice(0, withoutZone.length - embedded[1].length);
    // Strip the single ':' separator between the last hex group and the embedded quad (e.g.
    // "::ffff:127.0.0.1" -> head "::ffff:" -> "::ffff") — but never when that would eat into the
    // "::" compression marker itself (lane-6 review P3, found writing a NAT64 test case: "64:
    // ff9b::127.0.0.1" -> naively stripping one trailing ':' from "64:ff9b::" turns it into
    // "64:ff9b:", corrupting the "::" into a single colon and making the address unparseable).
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }

  const sides = head.split('::');
  if (sides.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    const result: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      result.push(Number.parseInt(g, 16));
    }
    return result;
  };

  if (sides.length === 1) {
    const groups = parseGroups(sides[0] ?? '');
    if (!groups) return null;
    const full = [...groups, ...v4Tail];
    return full.length === 8 ? full : null;
  }

  const headGroups = parseGroups(sides[0] ?? '');
  const tailGroups = parseGroups(sides[1] ?? '');
  if (!headGroups || !tailGroups) return null;
  const combinedTail = [...tailGroups, ...v4Tail];
  const missing = 8 - headGroups.length - combinedTail.length;
  if (missing < 0) return null;
  const zeros: number[] = new Array(missing).fill(0);
  return [...headGroups, ...zeros, ...combinedTail];
}

/**
 * Strip an IPv4-mapped IPv6 wrapper (`::ffff:x.x.x.x`, however Node happened to render it) down
 * to the plain IPv4 dotted string, so classification always sees the real embedded address
 * instead of being fooled by the v6 wrapper. Returns the input unchanged for every other shape.
 */
export function normalizeAddress(input: string): string {
  const trimmed = input.trim();
  const v6 = parseIPv6(trimmed);
  if (
    v6 &&
    v6[0] === 0 &&
    v6[1] === 0 &&
    v6[2] === 0 &&
    v6[3] === 0 &&
    v6[4] === 0 &&
    v6[5] === 0xffff
  ) {
    const g6 = v6[6] ?? 0;
    const g7 = v6[7] ?? 0;
    return [g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff].join('.');
  }
  return trimmed;
}

function isRfc1918V4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isLoopbackV4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 127;
}

function isLinkLocalV4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 169 && octets[1] === 254;
}

function isCgnatV4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function isLoopbackV6(groups: readonly number[]): boolean {
  return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

function isLinkLocalV6(groups: readonly number[]): boolean {
  return (groups[0] ?? 0) >>> 6 === 0b1111111010;
}

function isUniqueLocalV6(groups: readonly number[]): boolean {
  return (groups[0] ?? 0) >>> 9 === 0b1111110;
}

/** RFC 6052's "Well-Known Prefix" `64:ff9b::/96` — NAT64 synthesizes an IPv6 address for an IPv4
 *  destination by embedding the full 32-bit IPv4 address in the low 32 bits under this fixed
 *  96-bit prefix. `classifyAddress` below unwraps it and re-classifies using the *embedded* IPv4
 *  address, instead of falling through to `'public'` for every NAT64-synthesized address
 *  regardless of what it actually points at (lane-6 review P3: an embedded RFC1918/loopback/CGNAT
 *  address was previously classified `'public'`, since none of the v6-specific checks above ever
 *  matched a NAT64 address's actual bit pattern). */
const NAT64_WELL_KNOWN_PREFIX = [0x0064, 0xff9b, 0, 0, 0, 0] as const;

/** Extracts the embedded IPv4 address from a `64:ff9b::/96` NAT64 address's last two 16-bit
 *  groups, or `null` when `groups` isn't in that prefix at all. */
function nat64EmbeddedV4(groups: readonly number[]): [number, number, number, number] | null {
  for (let i = 0; i < NAT64_WELL_KNOWN_PREFIX.length; i++) {
    if ((groups[i] ?? -1) !== NAT64_WELL_KNOWN_PREFIX[i]) return null;
  }
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  return [g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff];
}

function ipv4ToBigInt(octets: readonly [number, number, number, number]): bigint {
  return octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
}

function ipv6ToBigInt(groups: readonly number[]): bigint {
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

/** Parse a CIDR string (`a.b.c.d/n` or `xxxx::/n`) into a {@link CidrRange}. Throws on malformed input. */
export function parseCidr(cidr: string): CidrRange {
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) throw new Error(`invalid CIDR (missing prefix length): ${cidr}`);
  const address = cidr.slice(0, slash);
  const prefixLen = Number.parseInt(cidr.slice(slash + 1), 10);

  const v4 = parseIPv4(address);
  if (v4) {
    if (!(prefixLen >= 0 && prefixLen <= 32))
      throw new Error(`invalid IPv4 prefix length: ${cidr}`);
    return { family: 4, network: ipv4ToBigInt(v4), prefixLen };
  }
  const v6 = parseIPv6(address);
  if (v6) {
    if (!(prefixLen >= 0 && prefixLen <= 128))
      throw new Error(`invalid IPv6 prefix length: ${cidr}`);
    return { family: 6, network: ipv6ToBigInt(v6), prefixLen };
  }
  throw new Error(`invalid CIDR address: ${cidr}`);
}

/** Whether `ip` falls inside a parsed {@link CidrRange}. Families that don't match never overlap. */
export function isInCidr(ip: string, range: CidrRange): boolean {
  const width = range.family === 4 ? 32 : 128;
  const shift = BigInt(width - range.prefixLen);
  const v4 = parseIPv4(ip);
  if (range.family === 4) {
    if (!v4) return false;
    const value = ipv4ToBigInt(v4);
    return range.prefixLen === 0 || value >> shift === range.network >> shift;
  }
  const v6 = parseIPv6(ip);
  if (!v6) return false;
  const value = ipv6ToBigInt(v6);
  return range.prefixLen === 0 || value >> shift === range.network >> shift;
}

/**
 * Classify a single address against every deny class from design doc I10: RFC1918, loopback,
 * IPv4/IPv6 link-local, CGNAT (100.64/10), IPv6 unique-local (fc00::/7), and the platform's own
 * `control`/`workers` subnets. `'invalid'` means the string isn't a parseable address at all.
 */
export function classifyAddress(
  rawIp: string,
  platformSubnets: readonly CidrRange[],
): AddressClass {
  const ip = normalizeAddress(rawIp);

  for (const subnet of platformSubnets) {
    if (isInCidr(ip, subnet)) return 'platform-subnet';
  }

  const v4 = parseIPv4(ip);
  if (v4) {
    if (isLoopbackV4(v4)) return 'loopback';
    if (isLinkLocalV4(v4)) return 'link-local';
    if (isRfc1918V4(v4)) return 'rfc1918';
    if (isCgnatV4(v4)) return 'cgnat';
    return 'public';
  }

  const v6 = parseIPv6(ip);
  if (v6) {
    if (isLoopbackV6(v6)) return 'loopback';
    if (isLinkLocalV6(v6)) return 'link-local';
    if (isUniqueLocalV6(v6)) return 'unique-local-v6';

    const nat64V4 = nat64EmbeddedV4(v6);
    if (nat64V4) {
      const embeddedDotted = nat64V4.join('.');
      for (const subnet of platformSubnets) {
        if (subnet.family === 4 && isInCidr(embeddedDotted, subnet)) return 'platform-subnet';
      }
      if (isLoopbackV4(nat64V4)) return 'loopback';
      if (isLinkLocalV4(nat64V4)) return 'link-local';
      if (isRfc1918V4(nat64V4)) return 'rfc1918';
      if (isCgnatV4(nat64V4)) return 'cgnat';
      // A NAT64-embedded address that's itself public is legitimately public — fall through.
    }
    return 'public';
  }

  return 'invalid';
}
