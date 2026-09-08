import { BlockList, isIP } from 'node:net';

/**
 * interfaces/internal-auth/subnet: the one CIDR check the internal-plane guard needs — "is this
 * TCP peer inside `NEXTTIME_SUBNET_WORKERS`?" (guard.ts). Built on `node:net`'s `BlockList` rather
 * than a hand-rolled parser: it already handles IPv4, IPv6 and IPv4-mapped IPv6 peers (`::ffff:
 * a.b.c.d`, what a socket reports when the kernel is bound to `::` instead of `0.0.0.0`) against an
 * IPv4 subnet, which is exactly the shape a compose network's `ipam` subnet has. Kept general
 * (any family, any prefix) so it never needs to spell out a private-range literal here — CI's
 * internal-IP-literal guard (.github/workflows/ci.yml) has no path exclusions.
 */

/** `(peerAddress) => boolean`; `false` for anything that is not a parseable IP address. */
export type SubnetMatcher = (address: string) => boolean;

/** Thrown for a malformed CIDR — the value comes from configuration, so this is a startup failure,
 *  never something to degrade past silently (a defense-in-depth rule that quietly turned itself
 *  off would be worse than a crash-loop the operator sees). */
export class InvalidCidrError extends Error {
  constructor(cidr: string, detail: string) {
    super(`invalid CIDR "${cidr}": ${detail}`);
    this.name = 'InvalidCidrError';
  }
}

/** Parses `a.b.c.d/n` or `<ipv6>/n` into a matcher over peer addresses. */
export function createSubnetMatcher(cidr: string): SubnetMatcher {
  const trimmed = cidr.trim();
  const parts = trimmed.split('/');
  const address = parts[0] ?? '';
  const prefixRaw = parts[1];
  if (parts.length !== 2 || prefixRaw === undefined || prefixRaw.length === 0) {
    throw new InvalidCidrError(cidr, 'expected <address>/<prefix-length>');
  }
  const family = isIP(address);
  if (family === 0) {
    throw new InvalidCidrError(cidr, 'address part is not an IPv4 or IPv6 address');
  }
  if (!/^\d{1,3}$/.test(prefixRaw)) {
    throw new InvalidCidrError(cidr, 'prefix length must be a non-negative integer');
  }
  const prefix = Number.parseInt(prefixRaw, 10);
  const maxPrefix = family === 4 ? 32 : 128;
  if (prefix > maxPrefix) {
    throw new InvalidCidrError(cidr, `prefix length must be 0..${maxPrefix}`);
  }

  const list = new BlockList();
  list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');

  return (peer: string): boolean => {
    const peerFamily = isIP(peer);
    if (peerFamily === 0) return false;
    return list.check(peer, peerFamily === 4 ? 'ipv4' : 'ipv6');
  };
}
