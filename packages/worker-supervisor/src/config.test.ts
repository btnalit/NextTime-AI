import { describe, expect, it } from 'vitest';
import { SpawnRequestSchema, StopRequestSchema, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('throws when NEXTTIME_DATA is not set', () => {
    expect(() => loadConfig({})).toThrow(/NEXTTIME_DATA/);
  });

  it('applies documented defaults', () => {
    const config = loadConfig({ NEXTTIME_DATA: '/data-host' });
    expect(config.port).toBe(8081);
    expect(config.workerImage).toBe('nexttime-ai-worker-runtime');
    expect(config.workerRuntime).toBe('runc');
    expect(config.nextTimeData).toBe('/data-host');
    expect(config.localDataDir).toBe('/data');
    expect(config.networkWorkers).toBeUndefined();
    expect(config.kernelUrl).toBe('http://kernel:8080');
    expect(config.kernelLlmUrl).toBe('http://llm-proxy:8082');
    expect(config.httpProxyForWorkers).toBe('http://egress-proxy:3128');
    expect(config.noProxyForWorkers).toBe('kernel,llm-proxy,localhost,127.0.0.1');
    expect(config.workerMemoryMb).toBe(2048);
    expect(config.workerPidsLimit).toBe(512);
    expect(config.workerTmpfsMb).toBe(512);
    expect(config.entryIdleTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.egressSourceMapFile).toBe('/data/config/egress-sources.json');
    expect(config.dockerSocketPath).toBe('/var/run/docker.sock');
  });

  it('honors every override', () => {
    const config = loadConfig({
      NEXTTIME_DATA: '/data-host',
      LOCAL_DATA_DIR: '/local',
      SUPERVISOR_PORT: '9090',
      WORKER_IMAGE: 'custom-image',
      WORKER_RUNTIME: 'runsc',
      NETWORK_WORKERS: 'my_workers_net',
      KERNEL_URL: 'http://k:1',
      KERNEL_LLM_URL: 'http://l:2',
      HTTP_PROXY_FOR_WORKERS: 'http://p:3',
      NO_PROXY_FOR_WORKERS: 'a,b',
      WORKER_MEMORY_MB: '4096',
      WORKER_PIDS_LIMIT: '256',
      WORKER_TMPFS_MB: '128',
      ENTRY_IDLE_TIMEOUT_MS: '1000',
      EGRESS_SOURCE_MAP_FILE: '/x/sources.json',
      DOCKER_SOCKET_PATH: '/tmp/docker.sock',
    });
    expect(config).toMatchObject({
      port: 9090,
      workerImage: 'custom-image',
      workerRuntime: 'runsc',
      localDataDir: '/local',
      networkWorkers: 'my_workers_net',
      kernelUrl: 'http://k:1',
      kernelLlmUrl: 'http://l:2',
      httpProxyForWorkers: 'http://p:3',
      noProxyForWorkers: 'a,b',
      workerMemoryMb: 4096,
      workerPidsLimit: 256,
      workerTmpfsMb: 128,
      entryIdleTimeoutMs: 1000,
      egressSourceMapFile: '/x/sources.json',
      dockerSocketPath: '/tmp/docker.sock',
    });
  });

  it('ignores non-numeric overrides and falls back to the default', () => {
    const config = loadConfig({ NEXTTIME_DATA: '/d', SUPERVISOR_PORT: 'not-a-number' });
    expect(config.port).toBe(8081);
  });
});

describe('SpawnRequestSchema', () => {
  it('accepts the required fields plus optional overrides', () => {
    expect(
      SpawnRequestSchema.safeParse({
        workspaceId: 'w1',
        principalId: 'p1',
        handle: 'h1',
      }).success,
    ).toBe(true);
    expect(
      SpawnRequestSchema.safeParse({
        workspaceId: 'w1',
        principalId: 'p1',
        handle: 'h1',
        kernelUrl: 'http://k',
        llmUrl: 'http://l',
      }).success,
    ).toBe(true);
  });

  it('rejects missing fields and unknown fields', () => {
    expect(SpawnRequestSchema.safeParse({ workspaceId: 'w1' }).success).toBe(false);
    expect(
      SpawnRequestSchema.safeParse({
        workspaceId: 'w1',
        principalId: 'p1',
        handle: 'h1',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('StopRequestSchema', () => {
  it('requires exactly principalId', () => {
    expect(StopRequestSchema.safeParse({ principalId: 'p1' }).success).toBe(true);
    expect(StopRequestSchema.safeParse({}).success).toBe(false);
    expect(StopRequestSchema.safeParse({ principalId: 'p1', extra: 1 }).success).toBe(false);
  });
});
