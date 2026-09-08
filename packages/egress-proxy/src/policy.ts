import type { CidrRange } from './net-utils.js';
import { classifyAddress, isInCidr, parseIPv4, parseIPv6 } from './net-utils.js';

/**
 * Egress decision policy (design doc §7.9, §5.4 I10). Pure aside from the injected `resolve`
 * callback: no global state, no direct DNS/network calls, no reads from `process.env`. Callers
 * (`proxy.ts`) supply everything — deny-host set, platform subnets, and a resolver — so this
 * module is exhaustively unit-testable, including DNS-rebinding scenarios (inject a resolver
 * that maps a public-looking hostname to a private address).
 */

/** Per-source allow/deny lists, as read from `SOURCE_MAP_FILE` (or a future supervisor registry). */
export interface SourcePolicy {
  sourceId: string;
  allow?: string[];
  deny?: string[];
}

export interface PolicyConfig {
  /** Internal service hostnames to always deny (`DENY_HOSTS`), matched as suffix patterns. */
  denyHosts: readonly string[];
  /** `NEXTTIME_SUBNET_CONTROL` / `NEXTTIME_SUBNET_WORKERS`, parsed. */
  platformSubnets: readonly CidrRange[];
  /**
   * `EGRESS_TRUSTED_RESOLVED_CIDRS`, parsed: address ranges owned by a transparent ("fake-IP")
   * proxy on the host's network. Some networks hand out DNS answers from a private range for
   * *every* public name and let a local transparent proxy map that fake address back to the real
   * destination; to this proxy's rebinding check such an answer is indistinguishable from an
   * attack, so without this list every public egress on such a host is denied.
   *
   * Semantics, deliberately narrow: a range listed here is treated as public **only for an
   * address obtained by resolving a hostname**. A literal-IP request into the range is still
   * denied (nothing legitimate targets a fake address by number), the platform's own subnets are
   * still denied even if a listed range happens to cover them (checked first), and every other
   * private/loopback/link-local/CGNAT range keeps its normal treatment. The trust this expresses
   * is exactly "connections into this range go to the transparent proxy, never to a real internal
   * host" — the operator asserts that about their network by setting the variable; it is unset
   * by default. Host-specific values belong in `.env`, never in the repo.
   */
  trustedResolvedCidrs?: readonly CidrRange[];
  /**
   * Test-only escape hatch (`ALLOW_LOOPBACK_FOR_TESTS`): treat loopback addresses as allowed so
   * integration tests can point a resolved hostname at a local upstream. Must never be set in
   * production — see README.md.
   */
  allowLoopbackForTests?: boolean;
  /**
   * `EGRESS_DENY_UNKNOWN_SOURCE` (lane-6 review P2-7). `resolveSource(clientIp)` returning
   * `undefined` means no `SourcePolicy` was ever registered for that client IP at all — distinct
   * from a *registered* source with an empty `allow`/`deny` (which is treated as "no per-source
   * restriction", per steps 1/4 below). Before this fix the two were indistinguishable to
   * `decideEgress`: an unregistered source got exactly the same treatment as a known, unrestricted
   * one — full public egress, attributed to `sourceId: 'unknown'` in every observation
   * (`proxy.ts`'s `recordObservation`). That is a fail-*open* posture for whatever traffic this
   * proxy cannot attribute to a specific principal/Task at all (a registration race, a bug in the
   * caller, or a container that was never registered in the first place).
   *
   * Defaults to `true` (fail-closed) in `config.ts`'s `loadConfig` — set `false` only if
   * `SOURCE_MAP_FILE` registration is unreliable enough on a given host that fail-closed would
   * cut off legitimate containers' egress outright (see `packages/worker-supervisor/src/
   * resident-service.ts`'s own doc comment on its best-effort `registerEgress`/`unregisterEgress`
   * — host verification found a real EACCES class of failure there). Flip this back to `false`
   * only as a temporary escape hatch while fixing that underlying reliability issue, not as a
   * permanent posture.
   */
  denyUnknownSource?: boolean;
}

export type PolicyDenyReason =
  | 'unknown-source'
  | 'source-deny'
  | 'deny-host'
  | 'bare-hostname'
  | 'not-in-allow-list'
  | 'dns-error'
  | 'private-address';

export interface PolicyDecision {
  allowed: boolean;
  reason?: PolicyDenyReason;
  /** The specific resolved address the caller should connect to (only set when `allowed`). */
  address?: string;
}

/** Resolves a hostname to every address it points at. Injected so tests never touch real DNS. */
export type Resolver = (hostname: string) => Promise<string[]>;

function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * Whether `hostname` matches any pattern in `patterns` as a suffix: an exact match, or the
 * pattern preceded by a `.` (so `deny: ["example.com"]` also blocks `sub.example.com`).
 */
export function matchesSuffix(hostname: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const host = normalizeHostname(hostname);
  for (const raw of patterns) {
    const pattern = normalizeHostname(raw);
    if (pattern === '') continue;
    if (host === pattern || host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

/** Bare hostnames (no dot) can't be real public domains — they're internal/Docker DNS names. */
export function isBareHostname(hostname: string): boolean {
  return !normalizeHostname(hostname).includes('.');
}

export interface DecideEgressInput {
  hostname: string;
  source: SourcePolicy | undefined;
  config: PolicyConfig;
  resolve: Resolver;
}

/**
 * The full egress decision pipeline, in the order design doc I10 / §7.9 specify:
 *
 * 0. Unknown source — no `SourcePolicy` registered for this client IP at all — denied when
 *    `config.denyUnknownSource` is set (lane-6 review P2-7; not part of the original design doc
 *    order, checked first since it's a question about the *caller's* identity, prior to anything
 *    about the requested hostname).
 * 1. Per-source `deny` (beats `allow` — checked first).
 * 2. Global `DENY_HOSTS` (internal service names).
 * 3. Bare hostnames (no dot), unless the source's `allow` list explicitly names them.
 * 4. Per-source `allow` restriction, when the source declares one.
 * 5. DNS resolution *inside the proxy*, then classify every resolved address and only connect to
 *    one that isn't private/platform-internal — this defeats DNS rebinding because the caller
 *    connects to the address this function returns, never re-resolving the hostname itself.
 *
 * Steps 0–3 need no DNS lookup at all, so an obviously-denied hostname (an internal service name,
 * a source's deny list, or an unregistered source) is rejected before `resolve` is ever called.
 */
export async function decideEgress(input: DecideEgressInput): Promise<PolicyDecision> {
  const { source, config, resolve } = input;
  const hostname = normalizeHostname(input.hostname);

  if (source === undefined && config.denyUnknownSource) {
    return { allowed: false, reason: 'unknown-source' };
  }
  if (matchesSuffix(hostname, source?.deny)) {
    return { allowed: false, reason: 'source-deny' };
  }
  if (matchesSuffix(hostname, config.denyHosts)) {
    return { allowed: false, reason: 'deny-host' };
  }
  if (isBareHostname(hostname) && !matchesSuffix(hostname, source?.allow)) {
    return { allowed: false, reason: 'bare-hostname' };
  }
  if (source?.allow && source.allow.length > 0 && !matchesSuffix(hostname, source.allow)) {
    return { allowed: false, reason: 'not-in-allow-list' };
  }

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { allowed: false, reason: 'dns-error' };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: 'dns-error' };
  }

  // A literal-IP target never qualifies for the trusted-resolved-CIDR exemption (see
  // PolicyConfig.trustedResolvedCidrs): the exemption is about what the network's resolver
  // answered for a *name*, not about letting callers dial into that range directly.
  const targetIsLiteral = parseIPv4(hostname) !== null || parseIPv6(hostname) !== null;

  for (const address of addresses) {
    const addressClass = classifyAddress(address, config.platformSubnets);
    if (addressClass === 'public') return { allowed: true, address };
    if (addressClass === 'loopback' && config.allowLoopbackForTests) {
      return { allowed: true, address };
    }
    if (
      !targetIsLiteral &&
      addressClass !== 'platform-subnet' &&
      addressClass !== 'invalid' &&
      isInTrustedResolvedCidr(address, config.trustedResolvedCidrs)
    ) {
      return { allowed: true, address };
    }
  }

  return { allowed: false, reason: 'private-address' };
}

function isInTrustedResolvedCidr(
  address: string,
  ranges: readonly CidrRange[] | undefined,
): boolean {
  if (!ranges || ranges.length === 0) return false;
  return ranges.some((range) => isInCidr(address, range));
}
