import { describe, expect, it, vi } from 'vitest';
import { parseCidr } from './net-address.js';
import type { OutboundTargetPolicy, OutboundTargetResolver } from './outbound-target.js';
import { decideOutboundTarget, describeOutboundTargetRefusal } from './outbound-target.js';

/** See net-address.test.ts: avoids writing a literal RFC1918 address into this file's source text. */
const quad = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join('.');

const CONTROL = `${quad(10, 77, 0, 0)}/24`;
const WORKERS = `${quad(10, 78, 0, 0)}/24`;
const POLICY: OutboundTargetPolicy = {
  platformSubnets: [parseCidr(CONTROL), parseCidr(WORKERS)],
};
const PUBLIC_ADDRESS = '93.184.216.34';

function resolverReturning(addresses: readonly string[]) {
  return vi.fn<OutboundTargetResolver>(async () => addresses);
}

describe('decideOutboundTarget (R-27: one predicate for every owner-supplied URL)', () => {
  it('refuses the review scenario — a compose service name — before any DNS lookup', async () => {
    const resolve = resolverReturning([quad(10, 77, 0, 9)]);
    const decision = await decideOutboundTarget(
      'http://worker-supervisor:8081/task/1f0c/terminate',
      POLICY,
      resolve,
    );
    expect(decision).toEqual({
      allowed: false,
      reason: 'bare-hostname',
      host: 'worker-supervisor',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['http://localhost:8080/mcp', 'bare-hostname'],
    ['http://kernel./api/health', 'bare-hostname'],
    ['http://127.0.0.1:9/', 'loopback'],
    ['http://[::1]:9/', 'loopback'],
    ['http://0x7f000001/', 'loopback'],
    ['http://[::ffff:127.0.0.1]/', 'loopback'],
    ['http://0.0.0.0:8081/', 'unspecified'],
    ['http://[::]/', 'unspecified'],
    ['http://169.254.169.254/latest/meta-data', 'link-local'],
    [`http://${quad(10, 77, 0, 5)}:8081/task/x/terminate`, 'platform-subnet'],
    [`http://${quad(10, 78, 0, 5)}/`, 'platform-subnet'],
    ['ftp://example.com/openapi.json', 'invalid-url'],
    ['file:///etc/passwd', 'invalid-url'],
    ['not a url', 'invalid-url'],
  ])('refuses %s (%s)', async (url, reason) => {
    const resolve = resolverReturning([PUBLIC_ADDRESS]);
    const decision = await decideOutboundTarget(url, POLICY, resolve);
    expect(decision).toMatchObject({ allowed: false, reason });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows a normal external host', async () => {
    const resolve = resolverReturning([PUBLIC_ADDRESS]);
    await expect(
      decideOutboundTarget('https://api.example.com/openapi.json', POLICY, resolve),
    ).resolves.toEqual({ allowed: true });
    expect(resolve).toHaveBeenCalledWith('api.example.com');
  });

  it("allows an address on the owner's LAN (RFC 1918 outside the platform subnets)", async () => {
    await expect(
      decideOutboundTarget(`http://${quad(192, 168, 1, 20)}:8090`, POLICY, resolverReturning([])),
    ).resolves.toEqual({ allowed: true });
  });

  it('refuses a dotted name that resolves into a platform subnet (a network alias)', async () => {
    const decision = await decideOutboundTarget(
      'http://worker-supervisor.nexttime_control:8081/',
      POLICY,
      resolverReturning([quad(10, 77, 0, 9)]),
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'platform-subnet' });
  });

  it('refuses when any one resolved address is refused (the fetch re-resolves)', async () => {
    const decision = await decideOutboundTarget(
      'https://mixed.example.com/',
      POLICY,
      resolverReturning([PUBLIC_ADDRESS, '127.0.0.1']),
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'loopback' });
  });

  it('refuses a name that does not resolve', async () => {
    const resolve = vi.fn<OutboundTargetResolver>(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(
      decideOutboundTarget('https://nowhere.example.invalid/', POLICY, resolve),
    ).resolves.toMatchObject({ allowed: false, reason: 'dns-error' });
    await expect(
      decideOutboundTarget('https://empty.example.com/', POLICY, resolverReturning([])),
    ).resolves.toMatchObject({ allowed: false, reason: 'dns-error' });
  });

  it('lets an operator-allowed host through every check (names by suffix, IPs exactly)', async () => {
    const policy: OutboundTargetPolicy = {
      ...POLICY,
      allowHosts: ['accept-s2-ssh-gate', 'lab.example', '127.0.0.1'],
    };
    const resolve = resolverReturning([quad(10, 77, 0, 9)]);
    await expect(
      decideOutboundTarget('http://accept-s2-ssh-gate:8090', policy, resolve),
    ).resolves.toEqual({ allowed: true });
    await expect(
      decideOutboundTarget('http://gate.lab.example:8090', policy, resolve),
    ).resolves.toEqual({ allowed: true });
    await expect(decideOutboundTarget('http://127.0.0.1:4000', policy, resolve)).resolves.toEqual({
      allowed: true,
    });
    await expect(
      decideOutboundTarget('http://worker-supervisor:8081', policy, resolve),
    ).resolves.toMatchObject({ allowed: false, reason: 'bare-hostname' });
    // An IP entry is never a suffix: `0.0.1` must not admit `127.0.0.1`.
    await expect(
      decideOutboundTarget('http://127.0.0.2/', { ...POLICY, allowHosts: ['0.0.2'] }, resolve),
    ).resolves.toMatchObject({ allowed: false, reason: 'loopback' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('has an owner-facing sentence for every reason', () => {
    for (const reason of [
      'invalid-url',
      'bare-hostname',
      'dns-error',
      'loopback',
      'link-local',
      'unspecified',
      'platform-subnet',
    ] as const) {
      expect(describeOutboundTargetRefusal(reason).length).toBeGreaterThan(10);
    }
  });
});
