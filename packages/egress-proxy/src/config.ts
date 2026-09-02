import type { CidrRange } from './net-utils.js';
import { parseCidr } from './net-utils.js';

/** Default `DENY_HOSTS` (design doc §7.9 task spec): internal platform service names. */
export const DEFAULT_DENY_HOSTS = [
  'kernel',
  'postgres',
  'llm-proxy',
  'egress-proxy',
  'worker-supervisor',
  'agent-host',
  'caddy',
] as const;

export interface EgressProxyConfig {
  proxyPort: number;
  adminPort: number;
  kernelUrl: string | undefined;
  denyHosts: string[];
  platformSubnets: CidrRange[];
  /** `EGRESS_TRUSTED_RESOLVED_CIDRS` — see `PolicyConfig.trustedResolvedCidrs` (policy.ts). */
  trustedResolvedCidrs: CidrRange[];
  sourceMapFile: string | undefined;
  maxTunnelsPerSource: number;
  idleTimeoutMs: number;
  connectTimeoutMs: number;
  allowLoopbackForTests: boolean;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSubnetEnv(value: string | undefined, name: string): CidrRange | undefined {
  if (!value) return undefined;
  try {
    return parseCidr(value);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: `egress-proxy: invalid ${name}`,
        value,
        error: String(err),
      }),
    );
    return undefined;
  }
}

/** Loads config from `process.env`, applying every default from the task spec (design doc §7.9). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EgressProxyConfig {
  const denyHosts = env.DENY_HOSTS
    ? env.DENY_HOSTS.split(',')
        .map((h) => h.trim())
        .filter((h) => h.length > 0)
    : [...DEFAULT_DENY_HOSTS];

  const platformSubnets: CidrRange[] = [];
  const control = parseSubnetEnv(env.NEXTTIME_SUBNET_CONTROL, 'NEXTTIME_SUBNET_CONTROL');
  const workers = parseSubnetEnv(env.NEXTTIME_SUBNET_WORKERS, 'NEXTTIME_SUBNET_WORKERS');
  if (control) platformSubnets.push(control);
  if (workers) platformSubnets.push(workers);
  if (platformSubnets.length === 0) {
    // Not necessarily fatal — RFC1918/loopback/link-local/CGNAT/unique-local-v6 are still denied
    // regardless — but I10 also expects the platform's own subnets denied, and those aren't
    // always inside a well-known private block (.env.example uses the RFC5737 203.0.113.0/24
    // documentation range, which classifies as public on its own). Cheap insurance: say so.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'egress-proxy: no platform subnets configured (NEXTTIME_SUBNET_CONTROL / NEXTTIME_SUBNET_WORKERS unset or invalid) — only well-known private/CGNAT ranges are denied',
      }),
    );
  }

  // Comma-separated CIDRs; each parsed independently so one bad entry is logged and dropped
  // (same policy as an invalid platform subnet) rather than silently disabling the whole list
  // or, worse, crashing a proxy every agent container depends on.
  const trustedResolvedCidrs: CidrRange[] = (env.EGRESS_TRUSTED_RESOLVED_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseSubnetEnv(s, 'EGRESS_TRUSTED_RESOLVED_CIDRS'))
    .filter((r): r is CidrRange => r !== undefined);
  if (trustedResolvedCidrs.length > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'egress-proxy: EGRESS_TRUSTED_RESOLVED_CIDRS set — hostnames resolving into these ranges are treated as public (transparent-proxy fake-IP ranges); literal IPs and platform subnets are still denied',
        count: trustedResolvedCidrs.length,
      }),
    );
  }

  return {
    proxyPort: parseIntEnv(env.PROXY_PORT, 3128),
    adminPort: parseIntEnv(env.ADMIN_PORT, 3129),
    kernelUrl: env.KERNEL_URL,
    denyHosts,
    platformSubnets,
    trustedResolvedCidrs,
    sourceMapFile: env.SOURCE_MAP_FILE,
    maxTunnelsPerSource: parseIntEnv(env.MAX_TUNNELS_PER_SOURCE, 32),
    idleTimeoutMs: parseIntEnv(env.IDLE_TIMEOUT_MS, 120_000),
    connectTimeoutMs: parseIntEnv(env.CONNECT_TIMEOUT_MS, 10_000),
    allowLoopbackForTests: env.ALLOW_LOOPBACK_FOR_TESTS === '1',
  };
}
