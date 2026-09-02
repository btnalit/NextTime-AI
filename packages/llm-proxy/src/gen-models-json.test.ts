import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProvidersFile } from './config.js';
import { buildModelsJson, generateModelsJson } from './gen-models-json.js';

const EXAMPLE_YAML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'config',
  'llm-providers.example.yaml',
);

describe('buildModelsJson', () => {
  it('derives the pi models.json shape from config/llm-providers.example.yaml', async () => {
    const providersFile = await loadProvidersFile(EXAMPLE_YAML);
    const modelsJson = buildModelsJson(providersFile, { llmProxyPort: 8082 });

    expect(Object.keys(modelsJson.providers)).toEqual(['example-openai', 'example-anthropic']);

    const openai = modelsJson.providers['example-openai'];
    expect(openai?.api).toBe('openai-completions');
    // openai-completions/openai-responses: baseUrl ends in /v1 (the `openai` SDK does not append
    // it itself — see gen-models-json.ts's doc comment).
    expect(openai?.baseUrl).toBe('http://llm-proxy:8082/example-openai/v1');
    expect(openai?.apiKey).toBe('$CAPABILITY_HANDLE');
    expect(openai?.models.map((m) => m.id)).toEqual(['example-gpt-large', 'example-gpt-small']);
    expect(openai?.models[0]?.cost).toEqual({
      input: 2.5,
      output: 10,
      cacheRead: 0.25,
      cacheWrite: 3.75,
    });
    expect(openai?.models[1]?.cost).toBeUndefined();

    const anthropic = modelsJson.providers['example-anthropic'];
    expect(anthropic?.api).toBe('anthropic-messages');
    // anthropic-messages: baseUrl does NOT end in /v1 (@anthropic-ai/sdk appends /v1/messages
    // itself).
    expect(anthropic?.baseUrl).toBe('http://llm-proxy:8082/example-anthropic');
  });

  it('never leaks upstream_base_url, api_key_env, or auth into the output', async () => {
    const providersFile = await loadProvidersFile(EXAMPLE_YAML);
    const modelsJson = buildModelsJson(providersFile);
    const serialized = JSON.stringify(modelsJson);
    expect(serialized).not.toContain('api_key_env');
    expect(serialized).not.toContain('upstream_base_url');
    expect(serialized).not.toContain('example-openai-compatible.invalid');
  });

  it('respects a custom host/port/env-var-name', () => {
    const modelsJson = buildModelsJson(
      {
        providers: {
          p: {
            api: 'openai-responses',
            upstream_base_url: 'https://x.invalid',
            api_key_env: 'X',
            auth: { header: 'authorization', scheme: 'Bearer' },
            models: [{ id: 'm' }],
          },
        },
      },
      { llmProxyHost: 'custom-host', llmProxyPort: 9999, capabilityHandleEnvVar: 'MY_HANDLE' },
    );
    expect(modelsJson.providers.p?.baseUrl).toBe('http://custom-host:9999/p/v1');
    expect(modelsJson.providers.p?.apiKey).toBe('$MY_HANDLE');
  });
});

describe('generateModelsJson', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the example yaml and writes a valid models.json file', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'nexttime-gen-models-json-test-'));
    const outFile = path.join(dir, 'models.json');

    const result = await generateModelsJson({
      providersFile: EXAMPLE_YAML,
      outFile,
      llmProxyPort: 8082,
    });

    const written = JSON.parse(readFileSync(outFile, 'utf8'));
    expect(written).toEqual(result);
    expect(Object.keys(written.providers)).toEqual(['example-openai', 'example-anthropic']);
  });
});
