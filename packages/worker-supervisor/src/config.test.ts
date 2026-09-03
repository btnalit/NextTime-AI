import { describe, expect, it } from 'vitest';
import {
  SpawnRequestSchema,
  StopRequestSchema,
  TaskSpawnRequestSchema,
  isImageAllowed,
  isSkillHostPathAllowed,
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
        workspaceId: '55555555-5555-4555-8555-555555555555',
        principalId: '66666666-6666-4666-8666-666666666666',
        handle: 'h1',
      }).success,
    ).toBe(true);
    expect(
      SpawnRequestSchema.safeParse({
        workspaceId: '55555555-5555-4555-8555-555555555555',
        principalId: '66666666-6666-4666-8666-666666666666',
        handle: 'h1',
        kernelUrl: 'http://k',
        llmUrl: 'http://l',
      }).success,
    ).toBe(true);
  });

  it('rejects missing fields and unknown fields', () => {
    expect(
      SpawnRequestSchema.safeParse({ workspaceId: '55555555-5555-4555-8555-555555555555' }).success,
    ).toBe(false);
    expect(
      SpawnRequestSchema.safeParse({
        workspaceId: '55555555-5555-4555-8555-555555555555',
        principalId: '66666666-6666-4666-8666-666666666666',
        handle: 'h1',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('StopRequestSchema', () => {
  it('requires exactly principalId', () => {
    expect(
      StopRequestSchema.safeParse({ principalId: '66666666-6666-4666-8666-666666666666' }).success,
    ).toBe(true);
    expect(StopRequestSchema.safeParse({}).success).toBe(false);
    // IdClaimSchema: a traversal-shaped id never validates (it would become a host path segment).
    expect(StopRequestSchema.safeParse({ principalId: '../../pgdata' }).success).toBe(false);
    expect(
      SpawnRequestSchema.safeParse({
        workspaceId: '55555555-5555-4555-8555-555555555555',
        principalId: '../../pgdata',
        handle: 'h1',
      }).success,
    ).toBe(false);
    expect(
      StopRequestSchema.safeParse({ principalId: '66666666-6666-4666-8666-666666666666', extra: 1 })
        .success,
    ).toBe(false);
  });
});

// taskId/workerRunId/workspaceId/onBehalfOf must be UUIDs (TaskSpawnRequestSchema's `idClaim`) —
// see the dedicated describe block below for the negative (non-UUID) cases.
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_RUN_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';
const ON_BEHALF_OF = '44444444-4444-4444-4444-444444444444';

const validTaskSpawnBody = {
  taskId: TASK_ID,
  workerRunId: WORKER_RUN_ID,
  workspaceId: WORKSPACE_ID,
  onBehalfOf: ON_BEHALF_OF,
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
    expect(TaskSpawnRequestSchema.safeParse({ taskId: TASK_ID }).success).toBe(false);
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

  describe('skillsInline (S2.14)', () => {
    const withSkillsInline = (skillsInline: unknown) =>
      TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, skillsInline }).success;

    it('accepts a valid single-file entry', () => {
      expect(
        withSkillsInline([
          { name: 'diagnose-network', files: { 'SKILL.md': '---\nname: x\n---\n\nbody\n' } },
        ]),
      ).toBe(true);
    });

    it('accepts a nested reference file alongside SKILL.md', () => {
      expect(
        withSkillsInline([
          {
            name: 'diagnose-network',
            files: {
              'SKILL.md': '---\nname: x\n---\n\nbody\n',
              'references/notes.md': 'extra',
            },
          },
        ]),
      ).toBe(true);
    });

    it('rejects an entry with no files', () => {
      expect(withSkillsInline([{ name: 'x', files: {} }])).toBe(false);
    });

    it('rejects an entry missing SKILL.md', () => {
      expect(withSkillsInline([{ name: 'x', files: { 'other.md': 'y' } }])).toBe(false);
    });

    it('rejects an unsafe skill name, same rule as skills[].name', () => {
      expect(withSkillsInline([{ name: '../../etc', files: { 'SKILL.md': 'y' } }])).toBe(false);
      expect(withSkillsInline([{ name: '..', files: { 'SKILL.md': 'y' } }])).toBe(false);
    });

    it('rejects a file name that escapes the skill directory', () => {
      expect(
        withSkillsInline([{ name: 'x', files: { 'SKILL.md': 'y', '../../etc/passwd': 'z' } }]),
      ).toBe(false);
      expect(
        withSkillsInline([{ name: 'x', files: { 'SKILL.md': 'y', '/etc/passwd': 'z' } }]),
      ).toBe(false);
    });

    it('rejects a file whose content exceeds the per-file byte cap', () => {
      expect(
        withSkillsInline([{ name: 'x', files: { 'SKILL.md': 'a'.repeat(512 * 1024 + 1) } }]),
      ).toBe(false);
    });

    it('rejects a set of files whose combined size exceeds the total byte cap', () => {
      const big = 'a'.repeat(500 * 1024);
      expect(
        withSkillsInline([
          {
            name: 'x',
            files: {
              'SKILL.md': big,
              'references/a.md': big,
              'references/b.md': big,
              'references/c.md': big,
              'references/d.md': big,
            },
          },
        ]),
      ).toBe(false);
    });
  });

  it('rejects a taskId that is not a UUID, including a path-traversal shape', () => {
    expect(TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, taskId: 't1' }).success).toBe(
      false,
    );
    expect(
      TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, taskId: '../../pgdata' }).success,
    ).toBe(false);
  });

  it('rejects a workerRunId/workspaceId/onBehalfOf that is not a UUID', () => {
    expect(
      TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, workerRunId: 'r1' }).success,
    ).toBe(false);
    expect(
      TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, workspaceId: 'w1' }).success,
    ).toBe(false);
    expect(
      TaskSpawnRequestSchema.safeParse({ ...validTaskSpawnBody, onBehalfOf: 'alice' }).success,
    ).toBe(false);
  });

  it('does not restrict capabilityHandle to a UUID shape (it is a JWT, not an id)', () => {
    expect(
      TaskSpawnRequestSchema.safeParse({
        ...validTaskSpawnBody,
        capabilityHandle: 'not-a-uuid-and-thats-fine.header.payload.sig',
      }).success,
    ).toBe(true);
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

describe('isSkillHostPathAllowed', () => {
  const config = loadConfig({ NEXTTIME_DATA: '/host/data' });

  it('accepts a path under the host data root', () => {
    expect(isSkillHostPathAllowed(config, '/host/data/ontology/ops-assets/skills/inventory')).toBe(
      true,
    );
  });

  it('accepts the root itself', () => {
    expect(isSkillHostPathAllowed(config, '/host/data')).toBe(true);
  });

  it('rejects a path outside the host data root', () => {
    expect(isSkillHostPathAllowed(config, '/var/run/docker.sock')).toBe(false);
    expect(isSkillHostPathAllowed(config, '/etc/passwd')).toBe(false);
    // A sibling directory that merely shares the root as a string prefix must still be rejected
    // (naive startsWith("/host/data") without the trailing slash would wrongly accept this).
    expect(isSkillHostPathAllowed(config, '/host/data-other/secret')).toBe(false);
  });

  it('rejects a path that escapes the root via .. even though it starts inside it', () => {
    expect(isSkillHostPathAllowed(config, '/host/data/../../etc')).toBe(false);
    expect(isSkillHostPathAllowed(config, '/host/data/skills/../../../etc/passwd')).toBe(false);
  });

  it('rejects a non-absolute path', () => {
    expect(isSkillHostPathAllowed(config, 'relative/path')).toBe(false);
    expect(isSkillHostPathAllowed(config, '')).toBe(false);
  });
});
