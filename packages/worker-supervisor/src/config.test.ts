import { describe, expect, it } from 'vitest';
import {
  SpawnRequestSchema,
  StopRequestSchema,
  TaskSpawnRequestSchema,
  isImageAllowed,
  loadConfig,
} from './config.js';

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
    expect(config.taskMaxRuntimeSec).toBe(3600);
    expect(config.taskWorkdirRetentionHours).toBe(72);
    expect(config.taskImageAllowlist).toEqual(['nexttime-ai-worker-runtime']);
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
      TASK_MAX_RUNTIME_SEC: '600',
      TASK_WORKDIR_RETENTION_HOURS: '24',
      WORKER_IMAGE_ALLOWLIST: 'extra-image-a, extra-image-b',
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
      taskMaxRuntimeSec: 600,
      taskWorkdirRetentionHours: 24,
    });
    expect(config.taskImageAllowlist).toEqual(['custom-image', 'extra-image-a', 'extra-image-b']);
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

const validTaskSpawnBody = {
  taskId: 't1',
  workerRunId: 'r1',
  workspaceId: 'w1',
  onBehalfOf: 'alice',
  capabilityHandle: 'h1',
};

describe('TaskSpawnRequestSchema', () => {
  it('accepts the required fields alone', () => {
    expect(TaskSpawnRequestSchema.safeParse(validTaskSpawnBody).success).toBe(true);
  });

  it('accepts every optional field, including skills', () => {
    expect(
      TaskSpawnRequestSchema.safeParse({
        ...validTaskSpawnBody,
        image: 'custom-image',
        model: 'anthropic/claude-sonnet-5',
        timeoutSec: 120,
        skills: [{ name: 'inventory', hostPath: '/host/data/ontology/skills/inventory' }],
      }).success,
    ).toBe(true);
  });

  it('rejects missing required fields and unknown fields (strict)', () => {
    expect(TaskSpawnRequestSchema.safeParse({ taskId: 't1' }).success).toBe(false);
    expect(TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, extra: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects a non-positive or non-integer timeoutSec', () => {
    expect(TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, timeoutSec: 0 }).success).toBe(
      false,
    );
    expect(
      TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, timeoutSec: -5 }).success,
    ).toBe(false);
    expect(
      TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, timeoutSec: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects a skill name that is not a safe single path segment', () => {
    const withSkill = (name: string) =>
      TaskSpawnRequestSchema.safeParse({
        ...validTaskSpawnBody,
        skills: [{ name, hostPath: '/host/data/skill' }],
      }).success;
    expect(withSkill('..')).toBe(false);
    expect(withSkill('.')).toBe(false);
    expect(withSkill('a/b')).toBe(false);
    expect(withSkill('../../etc')).toBe(false);
    expect(withSkill('valid-name_1.2')).toBe(true);
  });
});

describe('isImageAllowed', () => {
  it('allows the default workerImage', () => {
    const config = loadConfig({ NEXTTIME_DATA: '/d' });
    expect(isImageAllowed(config, 'nexttime-ai-worker-runtime')).toBe(true);
  });

  it('rejects an image not in the allowlist', () => {
    const config = loadConfig({ NEXTTIME_DATA: '/d' });
    expect(isImageAllowed(config, 'some-random-image')).toBe(false);
  });

  it('additionally allows images from WORKER_IMAGE_ALLOWLIST without dropping the default', () => {
    const config = loadConfig({ NEXTTIME_DATA: '/d', WORKER_IMAGE_ALLOWLIST: 'extra-image' });
    expect(isImageAllowed(config, 'nexttime-ai-worker-runtime')).toBe(true);
    expect(isImageAllowed(config, 'extra-image')).toBe(true);
    expect(isImageAllowed(config, 'still-not-allowed')).toBe(false);
  });
});
