import type { CidrRange } from './net-address.js';
import {
  canonicalizeIpLiteral,
  classifyAddress,
  isBareHostname,
  isIpLiteral,
  isUnspecifiedAddress,
  matchesSuffix,
  normalizeHostname,
} from './net-address.js';

/**
 * outbound-target: the one predicate for every kernel fetch of an **owner-supplied URL** (R-27 /
 * R-01, 2026-10-02 review) — `create_connection`'s `endpoint` and `manifestSource`, and every later
 * gate call to a self-connected gate's endpoint. The kernel sits on the platform's own `control` and
 * `workers` networks, so without this a workspace owner could aim it at a platform service
 * (`http://worker-supervisor:8081/task/<id>/terminate` was the review's example) and have the kernel
 * make the call for them. Gates the kernel provisioned itself (a `gate_instances` row: a packaged
 * gate or a gate-host instance) are not owner-supplied and never pass through here.
 *
 * Same rules as `@nexttime/egress-proxy`'s policy, from the same code (`net-address.ts`): a bare
 * hostname (no dot — a compose service name, `localhost`) is refused before any DNS lookup; a name is
 * resolved and **every** address it resolves to must be acceptable (the kernel's fetch re-resolves,
 * so one bad answer is enough to refuse); loopback, link-local (cloud metadata), the "this host"
 * addresses and the platform's own subnets are refused. Unlike the egress proxy, RFC 1918 / CGNAT /
 * IPv6 unique-local addresses are **allowed**: a self-connected gate typically runs on the owner's
 * own LAN, which is the whole point of connecting one, whereas the egress proxy keeps Workers on the
 * public internet. The platform's networks are what this predicate protects.
 *
 * `allowHosts` is the escape hatch for a self-connected gate that does run on the platform's
 * networks: the operator's `NEXTTIME_CONNECTION_ALLOW_HOSTS` (a gate deliberately run as a compose
 * service without making it a packaged gate) plus the kernel's fixed acceptance-fixture list
 * `NEXTTIME_CONNECTION_FIXTURE_HOSTS` (`scripts/accept_s2.sh`). A listed name matches as a suffix (`matchesSuffix`, the egress proxy's
 * allow-list rule); a listed IP literal matches only exactly. An allowed host skips every other
 * check.
 *
 * Pure apart from the injected `resolve` (no DNS, no `process.env`), like the egress proxy's
 * `decideEgress`, so every class is unit-testable — the kernel wires the real resolver and its env.
 * Residual, stated: the kernel's `fetch` resolves the name again, so a name whose answer changes
 * between this check and the connect (DNS rebinding with a zero TTL) is not caught; the platform's
 * own services also authenticate their internal routes (R-03), which is what bounds that case.
 */

export type OutboundTargetRefusalReason =
  /** Not an absolute `http:` / `https:` URL. */
  | 'invalid-url'
  /** A single-label name: a compose service name, `localhost`. */
  | 'bare-hostname'
  /** The name did not resolve (refused rather than letting the fetch try it). */
  | 'dns-error'
  | 'loopback'
  | 'link-local'
  /** `0.0.0.0/8` or `::` — reaches the local host. */
  | 'unspecified'
  /** Inside `NEXTTIME_SUBNET_CONTROL` / `NEXTTIME_SUBNET_WORKERS`. */
  | 'platform-subnet';

export type OutboundTargetDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: OutboundTargetRefusalReason;
      /** The hostname the decision is about (never the full URL — it may carry a query string). */
      readonly host: string;
    };

export interface OutboundTargetPolicy {
  /** The platform's own subnets, parsed (`parseCidr`). */
  readonly platformSubnets: readonly CidrRange[];
  /** Operator-allowed hosts (see the module doc comment). */
  readonly allowHosts?: readonly string[];
}

/** Resolves a hostname to every address it points at. Injected so tests never touch real DNS. */
export type OutboundTargetResolver = (hostname: string) => Promise<readonly string[]>;

/** One line per refusal reason, phrased for the owner who supplied the URL. */
export function describeOutboundTargetRefusal(reason: OutboundTargetRefusalReason): string {
  switch (reason) {
    case 'invalid-url':
      return 'it is not an absolute http:// or https:// URL';
    case 'bare-hostname':
      return 'a single-label host name (a platform service name, localhost) is not reachable from here — use the system’s full DNS name or IP address';
    case 'dns-error':
      return 'the host name does not resolve';
    case 'loopback':
      return 'it points at a loopback address';
    case 'link-local':
      return 'it points at a link-local address';
    case 'unspecified':
      return 'it points at an unspecified ("this host") address';
    case 'platform-subnet':
      return "it points into the platform's own networks";
  }
}

function refuse(reason: OutboundTargetRefusalReason, host: string): OutboundTargetDecision {
  return { allowed: false, reason, host };
}

function isAllowedHost(host: string, allowHosts: readonly string[] | undefined): boolean {
  if (!allowHosts || allowHosts.length === 0) return false;
  if (isIpLiteral(host)) {
    const canonical = canonicalizeIpLiteral(host);
    return allowHosts.some((entry) => canonicalizeIpLiteral(entry.trim()) === canonical);
  }
  return matchesSuffix(
    host,
    allowHosts.filter((entry) => !isIpLiteral(entry.trim())),
  );
}

/** The decision for `url` (see the module doc comment for the rules, in order). */
export async function decideOutboundTarget(
  url: string,
  policy: OutboundTargetPolicy,
  resolve: OutboundTargetResolver,
): Promise<OutboundTargetDecision> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('invalid-url', '');
  }
  // The WHATWG parser already lower-cases the host, canonicalizes every alternate IPv4 notation
  // (`0x7f000001` → `127.0.0.1`) and brackets IPv6 literals.
  const bracketed = parsed.hostname;
  const host = normalizeHostname(
    bracketed.startsWith('[') && bracketed.endsWith(']') ? bracketed.slice(1, -1) : bracketed,
  );
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || host === '') {
    return refuse('invalid-url', host);
  }
  if (isAllowedHost(host, policy.allowHosts)) return { allowed: true };

  let addresses: readonly string[];
  const literal = canonicalizeIpLiteral(host);
  if (literal !== null) {
    addresses = [literal];
  } else {
    if (isBareHostname(host)) return refuse('bare-hostname', host);
    try {
      addresses = await resolve(host);
    } catch {
      return refuse('dns-error', host);
    }
    if (addresses.length === 0) return refuse('dns-error', host);
  }

  for (const address of addresses) {
    if (isUnspecifiedAddress(address)) return refuse('unspecified', host);
    const addressClass = classifyAddress(address, policy.platformSubnets);
    if (addressClass === 'platform-subnet') return refuse('platform-subnet', host);
    if (addressClass === 'loopback') return refuse('loopback', host);
    if (addressClass === 'link-local') return refuse('link-local', host);
    if (addressClass === 'invalid') return refuse('dns-error', host);
  }
  return { allowed: true };
}
