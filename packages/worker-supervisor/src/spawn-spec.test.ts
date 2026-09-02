import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { buildSpawnSpec, entryContainerName } from './spawn-spec.js';

const config = loadConfig({
  NEXTTIME_DATA: '/host/data',
  LOCAL_DATA_DIR: '/data',
  WORKER_IMAGE: 'nexttime-ai-worker-runtime',
  WORKER_RUNTIME: 'runsc',
  HTTP_PROXY_FOR_WORKERS: 'http://egress-proxy:3128',
  NO_PROXY_FOR_WORKERS: 'kernel,llm-proxy,localhost,127.0.0.1',
  WORKER_MEMORY_MB: '2048',
  WORKER_PIDS_LIMIT: '512',
  WORKER_TMPFS_MB: '512',
});

describe('entryContainerName', () => {
  it('names the container after the principal', () => {
    expect(entryContainerName('alice')).toBe('nexttime-entry-alice');
  });
});

describe('buildSpawnSpec', () => {
  const spec = buildSpawnSpec({
    config,
    workspaceId: 'ws-1',
    principalId: 'alice',
    handle: 'the-handle-jwt',
    networkName: 'nexttime-ai_workers',
    restarts: 0,
  });

  it('names and images the container', () => {
    expect(spec.name).toBe('nexttime-entry-alice');
    expect(spec.image).toBe('nexttime-ai-worker-runtime');
    expect(spec.networkName).toBe('nexttime-ai_workers');
    expect(spec.runtime).toBe('runsc');
  });

  it('sets env to exactly the documented list — nothing leaks, nothing missing', () => {
    const keys = spec.env.map((e) => e.split('=')[0]).sort();
    expect(keys).toEqual(
      [
        'CAPABILITY_HANDLE',
        'HOME',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'KERNEL_LLM_URL',
        'KERNEL_URL',
        'NEXTTIME_MODE',
        'NO_PROXY',
        'PI_CODING_AGENT_DIR',
        'WORKSPACE_ID',
        // Lowercase proxy mirrors — see spawn-spec.ts's doc comment (httpoxy mitigation: most
        // HTTP clients only honor lowercase http_proxy for plain http:// requests).
        'http_proxy',
        'https_proxy',
        'no_proxy',
      ].sort(),
    );
  });

  it('carries the correct values for each env var', () => {
    expect(spec.env).toContain('KERNEL_URL=http://kernel:8080');
    expect(spec.env).toContain('KERNEL_LLM_URL=http://llm-proxy:8082');
    expect(spec.env).toContain('CAPABILITY_HANDLE=the-handle-jwt');
    expect(spec.env).toContain('WORKSPACE_ID=ws-1');
    expect(spec.env).toContain('NEXTTIME_MODE=entry');
    expect(spec.env).toContain('HTTP_PROXY=http://egress-proxy:3128');
    expect(spec.env).toContain('HTTPS_PROXY=http://egress-proxy:3128');
    expect(spec.env).toContain('NO_PROXY=kernel,llm-proxy,localhost,127.0.0.1');
    expect(spec.env).toContain('http_proxy=http://egress-proxy:3128');
    expect(spec.env).toContain('https_proxy=http://egress-proxy:3128');
    expect(spec.env).toContain('no_proxy=kernel,llm-proxy,localhost,127.0.0.1');
    expect(spec.env).toContain('PI_CODING_AGENT_DIR=/workspace/.pi/agent');
    expect(spec.env).toContain('HOME=/workspace');
  });

  it('overrides KERNEL_URL/KERNEL_LLM_URL from the request when given', () => {
    const overridden = buildSpawnSpec({
      config,
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      kernelUrl: 'http://kernel-override:9',
      llmUrl: 'http://llm-override:9',
      networkName: 'workers',
      restarts: 0,
    });
    expect(overridden.env).toContain('KERNEL_URL=http://kernel-override:9');
    expect(overridden.env).toContain('KERNEL_LLM_URL=http://llm-override:9');
  });

  it('mounts exactly the host workspace dir and a read-only models.json', () => {
    expect(spec.binds).toEqual([
      '/host/data/workspaces/alice:/workspace',
      '/host/data/config/models.json:/workspace/.pi/agent/models.json:ro',
    ]);
  });

  it('sets the resource limits from config', () => {
    expect(spec.memoryMb).toBe(2048);
    expect(spec.pidsLimit).toBe(512);
    expect(spec.tmpfsMb).toBe(512);
  });

  it('labels the container for reconciliation and restart tracking', () => {
    expect(spec.labels).toEqual({
      'nexttime.role': 'entry',
      'nexttime.principal': 'alice',
      'nexttime.workspace': 'ws-1',
      'nexttime.restarts': '0',
    });
  });

  it('carries forward a non-zero restarts count into the label', () => {
    const recreated = buildSpawnSpec({
      config,
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      networkName: 'workers',
      restarts: 3,
    });
    expect(recreated.labels['nexttime.restarts']).toBe('3');
  });
});
