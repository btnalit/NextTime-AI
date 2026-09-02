import { describe, expect, it, vi } from 'vitest';
import { parseCidr } from './net-utils.js';
import type { PolicyConfig, Resolver, SourcePolicy } from './policy.js';
import { decideEgress, isBareHostname, matchesSuffix } from './policy.js';

/** See net-utils.test.ts: avoids writing a literal RFC1918 address into this file's source text. */
const quad = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join('.');

const DEFAULT_DENY_HOSTS = [
  'kernel',
  'postgres',
  'llm-proxy',
  'egress-proxy',
  'worker-supervisor',
  'agent-host',
  'caddy',
];

function baseConfig(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { denyHosts: DEFAULT_DENY_HOSTS, platformSubnets: [], ...overrides };
}

/** A resolver that always returns the given address(es), never touching real DNS. */
function resolverReturning(...addresses: string[]): Resolver {
  return async () => addresses;
}

/** A resolver that fails the test if it's ever called — proves a decision was made without DNS. */
function unreachableResolver(): Resolver {
  return async (hostname: string) => {
    throw new Error(`resolve() must not be called for a hostname denied before DNS: ${hostname}`);
  };
}

describe('matchesSuffix', () => {
  it('matches an exact hostname', () => {
    expect(matchesSuffix('example.com', ['example.com'])).toBe(true);
  });

  it('matches a subdomain as a suffix', () => {
    expect(matchesSuffix('api.example.com', ['example.com'])).toBe(true);
  });

  it('does not match an unrelated hostname that merely ends similarly', () => {
    expect(matchesSuffix('notexample.com', ['example.com'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesSuffix('API.Example.COM', ['example.com'])).toBe(true);
  });

  it('returns false for an empty or undefined pattern list', () => {
    expect(matchesSuffix('example.com', [])).toBe(false);
    expect(matchesSuffix('example.com', undefined)).toBe(false);
  });
});

describe('isBareHostname', () => {
  it('flags a hostname with no dot', () => {
    expect(isBareHostname('kernel')).toBe(true);
  });

  it('does not flag a hostname with a dot', () => {
    expect(isBareHostname('example.com')).toBe(false);
  });
});

describe('decideEgress', () => {
  it('allows a public hostname with no source policy (unknown source -> default public allow)', async () => {
    const decision = await decideEgress({
      hostname: 'example.com',
      source: undefined,
      config: baseConfig(),
      resolve: resolverReturning('192.0.2.10'),
    });
    expect(decision).toEqual({ allowed: true, address: '192.0.2.10' });
  });

  it('denies every RFC1918 block (10/8, 172.16/12, 192.168/16)', async () => {
    for (const addr of [quad(10, 1, 2, 3), quad(172, 20, 0, 1), quad(192, 168, 0, 1)]) {
      const decision = await decideEgress({
        hostname: 'example.com',
        source: undefined,
        config: baseConfig(),
        resolve: resolverReturning(addr),
      });
      expect(decision).toEqual({ allowed: false, reason: 'private-address' });
    }
  });

  it('denies loopback', async () => {
    const decision = await decideEgress({
      hostname: 'example.com',
      source: undefined,
      config: baseConfig(),
      resolve: resolverReturning('127.0.0.1'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'private-address' });
  });

  it('denies link-local (IPv4 and IPv6)', async () => {
    for (const addr of ['169.254.1.1', 'fe80::1']) {
      const decision = await decideEgress({
        hostname: 'example.com',
        source: undefined,
        config: baseConfig(),
        resolve: resolverReturning(addr),
      });
      expect(decision).toEqual({ allowed: false, reason: 'private-address' });
    }
  });

  it('denies CGNAT (100.64/10)', async () => {
    const decision = await decideEgress({
      hostname: 'example.com',
      source: undefined,
      config: baseConfig(),
      resolve: resolverReturning('100.70.0.1'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'private-address' });
  });

  it('denies IPv6 unique-local (fc00::/7)', async () => {
    const decision = await decideEgress({
      hostname: 'example.com',
      source: undefined,
      config: baseConfig(),
      resolve: resolverReturning('fc00::1'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'private-address' });
  });

  it('denies an address inside a platform subnet', async () => {
    const config = baseConfig({ platformSubnets: [parseCidr('198.51.100.0/24')] });
    const decision = await decideEgress({
      hostname: 'example.com',
      source: undefined,
      config,
      resolve: resolverReturning('198.51.100.5'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'private-address' });
  });

  it('allows loopback only when allowLoopbackForTests is set', async () => {
    const config = baseConfig({ allowLoopbackForTests: true });
    const decision = await decideEgress({
      hostname: 'example.com',
      source: undefined,
      config,
      resolve: resolverReturning('127.0.0.1'),
    });
    expect(decision).toEqual({ allowed: true, address: '127.0.0.1' });
  });

  it('denies a configured internal service name (DENY_HOSTS) before resolving DNS', async () => {
    const decision = await decideEgress({
      hostname: 'postgres',
      source: undefined,
      config: baseConfig(),
      resolve: unreachableResolver(),
    });
    expect(decision).toEqual({ allowed: false, reason: 'deny-host' });
  });

  it('DENY_HOSTS also blocks a subdomain of a denied host', async () => {
    const decision = await decideEgress({
      hostname: 'sub.kernel',
      source: undefined,
      config: baseConfig(),
      resolve: unreachableResolver(),
    });
    expect(decision).toEqual({ allowed: false, reason: 'deny-host' });
  });

  it('denies a bare hostname (no dot) before resolving DNS', async () => {
    const decision = await decideEgress({
      hostname: 'printer',
      source: undefined,
      config: baseConfig(),
      resolve: unreachableResolver(),
    });
    expect(decision).toEqual({ allowed: false, reason: 'bare-hostname' });
  });

  it('allows a bare hostname only when explicitly present in the source allow list', async () => {
    const source: SourcePolicy = { sourceId: 'src-1', allow: ['printer'] };
    const decision = await decideEgress({
      hostname: 'printer',
      source,
      config: baseConfig(),
      resolve: resolverReturning('192.0.2.20'),
    });
    expect(decision).toEqual({ allowed: true, address: '192.0.2.20' });
  });

  it('restricts to the source allow list when one is present', async () => {
    const source: SourcePolicy = { sourceId: 'src-1', allow: ['allowed.example.com'] };
    const denied = await decideEgress({
      hostname: 'other.example.com',
      source,
      config: baseConfig(),
      resolve: unreachableResolver(),
    });
    expect(denied).toEqual({ allowed: false, reason: 'not-in-allow-list' });

    const allowed = await decideEgress({
      hostname: 'allowed.example.com',
      source,
      config: baseConfig(),
      resolve: resolverReturning('192.0.2.30'),
    });
    expect(allowed).toEqual({ allowed: true, address: '192.0.2.30' });
  });

  it('source deny beats source allow (deny-precedence)', async () => {
    const source: SourcePolicy = {
      sourceId: 'src-1',
      allow: ['example.com'],
      deny: ['example.com'],
    };
    const decision = await decideEgress({
      hostname: 'example.com',
      source,
      config: baseConfig(),
      resolve: unreachableResolver(),
    });
    expect(decision).toEqual({ allowed: false, reason: 'source-deny' });
  });

  it('source deny is checked before any DNS resolution, even for an otherwise-allowed public host', async () => {
    const source: SourcePolicy = { sourceId: 'src-1', deny: ['example.com'] };
    const resolve = vi.fn(resolverReturning('192.0.2.10'));
    const decision = await decideEgress({
      hostname: 'example.com',
      source,
      config: baseConfig(),
      resolve,
    });
    expect(decision).toEqual({ allowed: false, reason: 'source-deny' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('source deny suffix-matches subdomains', async () => {
    const source: SourcePolicy = { sourceId: 'src-1', deny: ['example.com'] };
    const decision = await decideEgress({
      hostname: 'evil.example.com',
      source,
      config: baseConfig(),
      resolve: unreachableResolver(),
    });
    expect(decision).toEqual({ allowed: false, reason: 'source-deny' });
  });

  it('denies when DNS rebinding maps a public-looking hostname to a private address', async () => {
    // The hostname itself has a dot and isn't on any deny list — it "looks public" — but the
    // injected resolver (standing in for real DNS under attacker control) resolves it straight
    // to an RFC1918 address. The proxy must connect to *this* resolved address, never trust the
    // hostname string, so this must be denied exactly like a directly-requested private IP.
    const decision = await decideEgress({
      hostname: 'looks-public.example.com',
      source: undefined,
      config: baseConfig(),
      resolve: resolverReturning(quad(10, 9, 8, 7)),
    });
    expect(decision).toEqual({ allowed: false, reason: 'private-address' });
  });

  it('allows when at least one resolved address is public, ignoring a private one in the same answer', async () => {
    const decision = await decideEgress({
      hostname: 'multi.example.com',
      source: undefined,
      config: baseConfig(),
      resolve: resolverReturning(quad(10, 0, 0, 1), '192.0.2.50'),
    });
    expect(decision).toEqual({ allowed: true, address: '192.0.2.50' });
  });

  it('denies with dns-error when resolution throws', async () => {
    const decision = await decideEgress({
      hostname: 'broken.example.com',
      source: undefined,
      config: baseConfig(),
      resolve: async () => {
        throw new Error('boom');
      },
    });
    expect(decision).toEqual({ allowed: false, reason: 'dns-error' });
  });

  it('denies with dns-error when resolution returns no addresses', async () => {
    const decision = await decideEgress({
      hostname: 'nxdomain.example.com',
      source: undefined,
      config: baseConfig(),
      resolve: resolverReturning(),
    });
    expect(decision).toEqual({ allowed: false, reason: 'dns-error' });
  });
});
