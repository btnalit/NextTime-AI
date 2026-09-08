import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { buildTaskSpawnSpec, taskContainerName } from './task-spawn-spec.js';

const configEnv = {
  NEXTTIME_DATA: '/host/data',
  LOCAL_DATA_DIR: '/data',
  WORKER_IMAGE: 'nexttime-ai-worker-runtime',
  WORKER_RUNTIME: 'runsc',
  HTTP_PROXY_FOR_WORKERS: 'http://egress-proxy:3128',
  NO_PROXY_FOR_WORKERS: 'kernel,llm-proxy,localhost,127.0.0.1',
  WORKER_MEMORY_MB: '2048',
  WORKER_PIDS_LIMIT: '512',
  WORKER_TMPFS_MB: '512',
};
const config = loadConfig(configEnv);

describe('taskContainerName', () => {
  it('names the container after the workerRunId (not the taskId)', () => {
    expect(taskContainerName('run-1')).toBe('nexttime-task-run-1');
  });
});

describe('buildTaskSpawnSpec', () => {
  const spec = buildTaskSpawnSpec({
    config,
    taskId: 'task-1',
    workerRunId: 'run-1',
    workspaceId: 'ws-1',
    capabilityHandle: 'the-worker-handle-jwt',
    image: 'nexttime-ai-worker-runtime',
    networkName: 'nexttime-ai_workers',
  });

  it('names and images the container', () => {
    expect(spec.name).toBe('nexttime-task-run-1');
    expect(spec.image).toBe('nexttime-ai-worker-runtime');
    expect(spec.networkName).toBe('nexttime-ai_workers');
    expect(spec.runtime).toBe('runsc');
  });

  it('sets env to exactly the documented allowlist — nothing leaks, nothing missing', () => {
    const keys = spec.env.map((e) => e.split('=')[0]).sort();
    expect(keys).toEqual(
      [
        'CAPABILITY_HANDLE',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'KERNEL_LLM_URL',
        'KERNEL_URL',
        'NEXTTIME_MODE',
        'NO_PROXY',
        'TASK_ID',
        'WORKER_RUN_ID',
        'WORKSPACE_ID',
        // Lowercase proxy mirrors — see this module's doc comment (same httpoxy rationale as
        // spawn-spec.ts).
        'http_proxy',
        'https_proxy',
        'no_proxy',
      ].sort(),
    );
  });

  it('carries the correct values for each env var', () => {
    expect(spec.env).toContain('KERNEL_URL=http://kernel:8080');
    expect(spec.env).toContain('KERNEL_LLM_URL=http://llm-proxy:8082');
    expect(spec.env).toContain('CAPABILITY_HANDLE=the-worker-handle-jwt');
    expect(spec.env).toContain('TASK_ID=task-1');
    expect(spec.env).toContain('WORKSPACE_ID=ws-1');
    expect(spec.env).toContain('WORKER_RUN_ID=run-1');
    expect(spec.env).toContain('NEXTTIME_MODE=worker');
    expect(spec.env).toContain('HTTP_PROXY=http://egress-proxy:3128');
    expect(spec.env).toContain('HTTPS_PROXY=http://egress-proxy:3128');
    expect(spec.env).toContain('NO_PROXY=kernel,llm-proxy,localhost,127.0.0.1');
    expect(spec.env).toContain('http_proxy=http://egress-proxy:3128');
    expect(spec.env).toContain('https_proxy=http://egress-proxy:3128');
    expect(spec.env).toContain('no_proxy=kernel,llm-proxy,localhost,127.0.0.1');
  });

  it('never contains PI_CODING_AGENT_DIR or HOME — see this module doc comment for why', () => {
    const keys = spec.env.map((e) => e.split('=')[0]);
    expect(keys).not.toContain('PI_CODING_AGENT_DIR');
    expect(keys).not.toContain('HOME');
  });

  it('never leaks anything from this process env, even a *_API_KEY set on it', () => {
    process.env.SOME_API_KEY = 'super-secret';
    try {
      const leaky = buildTaskSpawnSpec({
        config,
        taskId: 'task-1',
        workerRunId: 'run-1',
        workspaceId: 'ws-1',
        capabilityHandle: 'h',
        image: 'nexttime-ai-worker-runtime',
        networkName: 'workers',
      });
      expect(leaky.env.some((e) => /API_KEY/i.test(e))).toBe(false);
      expect(leaky.env).not.toContain('SOME_API_KEY=super-secret');
    } finally {
      // biome-ignore lint/performance/noDelete: process.env coerces `= undefined` to the string "undefined" instead of unsetting the var; delete is the only way to make it actually absent.
      delete process.env.SOME_API_KEY;
    }
  });

  it('mounts exactly the host Task workspace dir and a read-only models.json', () => {
    expect(spec.binds).toEqual([
      '/host/data/workspaces/tasks/task-1:/workspace',
      '/host/data/config/models.json:/workspace/.pi/agent/models.json:ro',
    ]);
  });

  it('sets no CMD when model is omitted', () => {
    expect(spec.cmd).toBeUndefined();
  });

  it('sets CMD to ["--model", model] when model is given', () => {
    const withModel = buildTaskSpawnSpec({
      config,
      taskId: 'task-1',
      workerRunId: 'run-1',
      workspaceId: 'ws-1',
      capabilityHandle: 'h',
      image: 'nexttime-ai-worker-runtime',
      networkName: 'workers',
      model: 'anthropic/claude-sonnet-5',
    });
    expect(withModel.cmd).toEqual(['--model', 'anthropic/claude-sonnet-5']);
  });

  it('sets the resource limits from config', () => {
    expect(spec.memoryMb).toBe(2048);
    expect(spec.pidsLimit).toBe(512);
    expect(spec.tmpfsMb).toBe(512);
    expect(spec.cpus).toBe(2); // WORKER_CPUS default (P3)
  });

  it('carries WORKER_CPUS through when set', () => {
    const withCpus = buildTaskSpawnSpec({
      config: loadConfig({ ...configEnv, WORKER_CPUS: '0.5' }),
      taskId: 'task-1',
      workerRunId: 'run-1',
      workspaceId: 'ws-1',
      capabilityHandle: 'h',
      image: 'nexttime-ai-worker-runtime',
      networkName: 'workers',
    });
    expect(withCpus.cpus).toBe(0.5);
  });

  it('leaves dns undefined by default (WORKER_DNS_SINKHOLE unset)', () => {
    expect(spec.dns).toBeUndefined();
  });

  it('carries WORKER_DNS_SINKHOLE through as dns when set (P3 — documented and tested at spec level)', () => {
    const withDns = buildTaskSpawnSpec({
      config: loadConfig({ ...configEnv, WORKER_DNS_SINKHOLE: '198.51.100.53,198.51.100.54' }),
      taskId: 'task-1',
      workerRunId: 'run-1',
      workspaceId: 'ws-1',
      capabilityHandle: 'h',
      image: 'nexttime-ai-worker-runtime',
      networkName: 'workers',
    });
    expect(withDns.dns).toEqual(['198.51.100.53', '198.51.100.54']);
  });

  it('labels the container for reconciliation, role=worker (not entry)', () => {
    expect(spec.labels).toEqual({
      'nexttime.role': 'worker',
      'nexttime.task-id': 'task-1',
      'nexttime.worker-run-id': 'run-1',
      'nexttime.workspace-id': 'ws-1',
      'nexttime.egress-deny': '',
    });
  });

  it('stamps a comma-joined egressDeny onto the label when given (feat/egress-definition-lists)', () => {
    const withDeny = buildTaskSpawnSpec({
      config,
      taskId: 'task-1',
      workerRunId: 'run-1',
      workspaceId: 'ws-1',
      capabilityHandle: 'h',
      image: 'nexttime-ai-worker-runtime',
      networkName: 'workers',
      egressDeny: ['blocked.example.com', '.suffix.example.net'],
    });
    expect(withDeny.labels['nexttime.egress-deny']).toBe('blocked.example.com,.suffix.example.net');
  });

  it('places the given image (allowlist-checked by the caller, not here) verbatim', () => {
    const custom = buildTaskSpawnSpec({
      config,
      taskId: 'task-1',
      workerRunId: 'run-1',
      workspaceId: 'ws-1',
      capabilityHandle: 'h',
      image: 'some-other-allowlisted-image',
      networkName: 'workers',
    });
    expect(custom.image).toBe('some-other-allowlisted-image');
  });
});
