import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DENY_HOSTS, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies every documented default with an empty env', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      proxyPort: 3128,
      adminPort: 3129,
      kernelUrl: undefined,
      denyHosts: [...DEFAULT_DENY_HOSTS],
      platformSubnets: [],
      sourceMapFile: undefined,
      maxTunnelsPerSource: 32,
      idleTimeoutMs: 120_000,
      connectTimeoutMs: 10_000,
      allowLoopbackForTests: false,
    });
  });

  it('reads every var from the given env', () => {
    const config = loadConfig({
      PROXY_PORT: '4000',
      ADMIN_PORT: '4001',
      KERNEL_URL: 'http://kernel.internal:8080',
      DENY_HOSTS: 'kernel, postgres , custom-service',
      SOURCE_MAP_FILE: '/data/config/egress-sources.json',
      MAX_TUNNELS_PER_SOURCE: '8',
      IDLE_TIMEOUT_MS: '5000',
      CONNECT_TIMEOUT_MS: '2000',
      ALLOW_LOOPBACK_FOR_TESTS: '1',
    });
    expect(config).toMatchObject({
      proxyPort: 4000,
      adminPort: 4001,
      kernelUrl: 'http://kernel.internal:8080',
      denyHosts: ['kernel', 'postgres', 'custom-service'],
      sourceMapFile: '/data/config/egress-sources.json',
      maxTunnelsPerSource: 8,
      idleTimeoutMs: 5000,
      connectTimeoutMs: 2000,
      allowLoopbackForTests: true,
    });
  });

  it('parses platform subnets from CIDR env vars', () => {
    const config = loadConfig({
      NEXTTIME_SUBNET_CONTROL: '198.51.100.0/24',
      NEXTTIME_SUBNET_WORKERS: '203.0.113.0/24',
    });
    expect(config.platformSubnets).toHaveLength(2);
  });

  it('parses EGRESS_TRUSTED_RESOLVED_CIDRS as a comma-separated list, dropping invalid entries', () => {
    const config = loadConfig({
      EGRESS_TRUSTED_RESOLVED_CIDRS: ' 198.18.0.0/15 , not-a-cidr, 198.51.100.0/24 ',
    });
    expect(config.trustedResolvedCidrs).toHaveLength(2);
    expect(loadConfig({}).trustedResolvedCidrs).toEqual([]);
  });

  it('logs and ignores an invalid subnet instead of throwing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = loadConfig({ NEXTTIME_SUBNET_CONTROL: 'not-a-cidr' });
    expect(config.platformSubnets).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('falls back to defaults for non-numeric or non-positive port/limit values', () => {
    const config = loadConfig({ PROXY_PORT: 'not-a-number', MAX_TUNNELS_PER_SOURCE: '-1' });
    expect(config.proxyPort).toBe(3128);
    expect(config.maxTunnelsPerSource).toBe(32);
  });
});
