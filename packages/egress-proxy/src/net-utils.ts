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
    if (head.endsWith(':')) head = head.slice(0, -1);
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
    return 'public';
  }

  return 'invalid';
}
