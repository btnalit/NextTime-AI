import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_PROXY_PORT,
  LlmProxyConfigError,
  loadConfig,
  loadProvidersFile,
} from './config.js';

describe('loadConfig', () => {
  it('applies every documented default with an empty env', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: DEFAULT_LLM_PROXY_PORT,
      kernelUrl: undefined,
      handlePublicKeyFile: '/data/config/handle.pub',
      providersFile: '/data/config/llm-providers.yaml',
      revocationSyncIntervalMs: 15_000,
      revocationSyncOverlapMs: 60_000,
      usageFlushIntervalMs: 2000,
      usageMaxFlushIntervalMs: 60_000,
      usageMaxQueueSize: 1000,
      maxRequestBodyBytes: 10 * 1024 * 1024,
      upstreamIdleTimeoutMs: 300_000,
      upstreamConnectTimeoutMs: 10_000,
    });
  });

  it('reads every var from the given env', () => {
    const config = loadConfig({
      LLM_PROXY_PORT: '9000',
      KERNEL_URL: 'http://kernel:8080',
      HANDLE_PUBLIC_KEY_FILE: '/custom/handle.pub',
      LLM_PROVIDERS_FILE: '/custom/llm-providers.yaml',
      REVOCATION_SYNC_INTERVAL_MS: '5000',
      REVOCATION_SYNC_OVERLAP_MS: '1000',
      USAGE_FLUSH_INTERVAL_MS: '500',
      USAGE_MAX_FLUSH_INTERVAL_MS: '30000',
      USAGE_MAX_QUEUE_SIZE: '50',
      MAX_REQUEST_BODY_BYTES: '1024',
      UPSTREAM_IDLE_TIMEOUT_MS: '9000',
      UPSTREAM_CONNECT_TIMEOUT_MS: '3000',
    });
    expect(config).toMatchObject({
      port: 9000,
      kernelUrl: 'http://kernel:8080',
      handlePublicKeyFile: '/custom/handle.pub',
      providersFile: '/custom/llm-providers.yaml',
      revocationSyncIntervalMs: 5000,
      revocationSyncOverlapMs: 1000,
      usageFlushIntervalMs: 500,
      usageMaxFlushIntervalMs: 30_000,
      usageMaxQueueSize: 50,
      maxRequestBodyBytes: 1024,
      upstreamIdleTimeoutMs: 9000,
      upstreamConnectTimeoutMs: 3000,
    });
  });

  it('falls back to defaults for non-numeric or non-positive values', () => {
    const config = loadConfig({ LLM_PROXY_PORT: 'not-a-number', USAGE_MAX_QUEUE_SIZE: '-5' });
    expect(config.port).toBe(DEFAULT_LLM_PROXY_PORT);
    expect(config.usageMaxQueueSize).toBe(1000);
  });
});

describe('loadProvidersFile', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    dir = mkdtempSync(path.join(tmpdir(), 'nexttime-llm-providers-test-'));
    const file = path.join(dir, 'llm-providers.yaml');
    writeFileSync(file, content, 'utf8');
    return file;
  }

  it('loads and validates a well-formed provider file', async () => {
    const file = writeYaml(`
providers:
  example-openai:
    api: openai-completions
    upstream_base_url: https://api.example.invalid
    api_key_env: EXAMPLE_OPENAI_API_KEY
    auth:
      header: authorization
      scheme: Bearer
    models:
      - id: example-model-1
        cost:
          input: 1
          output: 2
          cacheRead: 0.5
          cacheWrite: 1.5
  example-anthropic:
    api: anthropic-messages
    upstream_base_url: https://api.anthropic.invalid
    api_key_env: EXAMPLE_ANTHROPIC_API_KEY
    auth:
      header: x-api-key
    models:
      - id: example-model-2
`);
    const config = await loadProvidersFile(file);
    expect(Object.keys(config.providers)).toEqual(['example-openai', 'example-anthropic']);
    expect(config.providers['example-openai']?.auth).toEqual({
      header: 'authorization',
      scheme: 'Bearer',
    });
    expect(config.providers['example-anthropic']?.auth).toEqual({ header: 'x-api-key' });
  });

  it('throws LlmProxyConfigError for a missing file', async () => {
    await expect(loadProvidersFile('/does/not/exist.yaml')).rejects.toThrow(LlmProxyConfigError);
  });

  it('throws LlmProxyConfigError for invalid YAML', async () => {
    const file = writeYaml('providers: [this is not: valid: yaml');
    await expect(loadProvidersFile(file)).rejects.toThrow(LlmProxyConfigError);
  });

  it('throws LlmProxyConfigError when the schema does not match (e.g. unknown api kind)', async () => {
    const file = writeYaml(`
providers:
  bad:
    api: not-a-real-kind
    upstream_base_url: https://api.example.invalid
    api_key_env: X
    auth:
      header: authorization
    models:
      - id: m
`);
    await expect(loadProvidersFile(file)).rejects.toThrow(LlmProxyConfigError);
  });

  it('rejects a provider with zero models', async () => {
    const file = writeYaml(`
providers:
  bad:
    api: openai-completions
    upstream_base_url: https://api.example.invalid
    api_key_env: X
    auth:
      header: authorization
    models: []
`);
    await expect(loadProvidersFile(file)).rejects.toThrow(LlmProxyConfigError);
  });
});
