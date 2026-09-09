import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('throws ConfigError when KERNEL_URL is unset', () => {
    expect(() => loadConfig({ env: {}, argv: [] })).toThrow(ConfigError);
  });

  it('strips a trailing slash from KERNEL_URL', () => {
    const config = loadConfig({ env: { KERNEL_URL: 'http://kernel:8080/' }, argv: [] });
    expect(config.kernelUrl).toBe('http://kernel:8080');
  });

  it('applies documented defaults when optional env vars are unset', () => {
    const config = loadConfig({ env: { KERNEL_URL: 'http://kernel:8080' }, argv: [] });
    expect(config.handleTokenFile).toBe('/run/secrets/collector_host_inventory_token');
    expect(config.runSystemdPath).toBe('/run/systemd');
    expect(config.repositoryPaths).toEqual([]);
    expect(config.once).toBe(false);
    expect(config.intervalMs).toBe(15 * 60 * 1000);
    expect(config.sourceName).toBe('host-inventory');
    expect(config.sourceKind).toBe('host-inventory-collector');
  });

  it('parses --once from argv', () => {
    const config = loadConfig({ env: { KERNEL_URL: 'http://kernel:8080' }, argv: ['--once'] });
    expect(config.once).toBe(true);
  });

  it('parses HOST_INVENTORY_REPOSITORY_PATHS as a colon-separated list', () => {
    const config = loadConfig({
      env: { KERNEL_URL: 'http://kernel:8080', HOST_INVENTORY_REPOSITORY_PATHS: '/repo-a:/repo-b' },
      argv: [],
    });
    expect(config.repositoryPaths).toEqual(['/repo-a', '/repo-b']);
  });

  it('throws ConfigError for a non-numeric HOST_INVENTORY_INTERVAL_MS', () => {
    expect(() =>
      loadConfig({
        env: { KERNEL_URL: 'http://kernel:8080', HOST_INVENTORY_INTERVAL_MS: 'not-a-number' },
        argv: [],
      }),
    ).toThrow(ConfigError);
  });

  it('throws ConfigError for a non-positive HOST_INVENTORY_INTERVAL_MS', () => {
    expect(() =>
      loadConfig({
        env: { KERNEL_URL: 'http://kernel:8080', HOST_INVENTORY_INTERVAL_MS: '0' },
        argv: [],
      }),
    ).toThrow(ConfigError);
  });

  it('honors every override env var', () => {
    const config = loadConfig({
      env: {
        KERNEL_URL: 'http://kernel:8080',
        NEXTTIME_HANDLE_TOKEN_FILE: '/custom/token',
        DOCKER_HOST: 'tcp://docker-socket-proxy-collector:2375',
        HOST_INVENTORY_RUN_SYSTEMD_PATH: '/custom/run-systemd',
        HOST_INVENTORY_INTERVAL_MS: '5000',
        HOST_INVENTORY_SOURCE_STATE_FILE: '/custom/state.json',
        HOST_INVENTORY_SOURCE_NAME: 'custom-name',
        HOST_INVENTORY_SOURCE_KIND: 'custom-kind',
      },
      argv: [],
    });
    expect(config).toMatchObject({
      handleTokenFile: '/custom/token',
      dockerHost: 'tcp://docker-socket-proxy-collector:2375',
      runSystemdPath: '/custom/run-systemd',
      intervalMs: 5000,
      sourceStateFile: '/custom/state.json',
      sourceName: 'custom-name',
      sourceKind: 'custom-kind',
    });
  });
});
