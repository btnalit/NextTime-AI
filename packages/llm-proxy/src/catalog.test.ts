import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCatalog } from './catalog.js';
import type { ProviderConfig } from './config.js';
import { buildModelsJsonFromCatalog } from './gen-models-json.js';
import { ProviderStore } from './provider-store.js';

/**
 * catalog.test: the S6-B merge rules — store over file by name, file entries always enabled,
 * a disabled provider is unroutable, `overridesFile` tells the two store cases apart, and the
 * models.json derivation includes only enabled providers with pi's optional `name`.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshStore(): Promise<ProviderStore> {
  const dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-catalog-'));
  dirs.push(dir);
  const store = new ProviderStore(join(dir, 'providers.json'));
  await store.load();
  return store;
}

const fileOpenAi: ProviderConfig = {
  api: 'openai-completions',
  upstream_base_url: 'https://file.example.invalid',
  api_key_env: 'FILE_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
  models: [{ id: 'file-model' }],
};

const storeEntry = {
  api: 'anthropic-messages' as const,
  upstream_base_url: 'https://store.example.invalid',
  api_key_env: 'STORE_KEY',
  auth: { header: 'x-api-key' as const },
  models: [{ id: 'store-model', display_name: 'Store Model' }],
  enabled: true,
};

describe('ProviderCatalog', () => {
  it('lists file entries (enabled, source file) then store-only entries, in order', async () => {
    const store = await freshStore();
    await store.upsert('acme', storeEntry);
    const catalog = new ProviderCatalog({ openai: fileOpenAi }, store);

    const resolved = catalog.resolve();
    expect(resolved.map((p) => [p.id, p.source, p.enabled, p.overridesFile])).toEqual([
      ['openai', 'file', true, false],
      ['acme', 'store', true, false],
    ]);
    expect(resolved[0]?.createdAt).toBeNull();
    expect(resolved[1]?.displayName).toBe('acme');
    expect(catalog.getRoutable('openai')).toEqual(fileOpenAi);
    expect(catalog.getRoutable('acme')?.api).toBe('anthropic-messages');
  });

  it('a store entry overrides a same-named file entry completely and can disable it', async () => {
    const store = await freshStore();
    const catalog = new ProviderCatalog({ openai: fileOpenAi }, store);
    expect(catalog.hasFileEntry('openai')).toBe(true);

    await store.upsert('openai', { ...storeEntry, enabled: false });
    const overridden = catalog.get('openai');
    expect(overridden).toMatchObject({ source: 'store', overridesFile: true, enabled: false });
    expect(overridden?.config.upstream_base_url).toBe('https://store.example.invalid');
    // Disabled → not routable, and it vanishes from models.json.
    expect(catalog.getRoutable('openai')).toBeUndefined();
    expect(Object.keys(buildModelsJsonFromCatalog(catalog).providers)).toEqual([]);

    // Removing the override restores the file entry — no restart, no re-read.
    await store.remove('openai');
    expect(catalog.get('openai')).toMatchObject({
      source: 'file',
      overridesFile: false,
      enabled: true,
    });
    expect(catalog.getRoutable('openai')).toEqual(fileOpenAi);
  });

  it('derives models.json from enabled providers only, carrying display names as pi `name`', async () => {
    const store = await freshStore();
    await store.upsert('acme', storeEntry);
    await store.upsert('off', { ...storeEntry, enabled: false });
    const catalog = new ProviderCatalog({ openai: fileOpenAi }, store);

    const modelsJson = buildModelsJsonFromCatalog(catalog, { llmProxyPort: 8082 });
    expect(Object.keys(modelsJson.providers)).toEqual(['openai', 'acme']);
    expect(modelsJson.providers.acme?.baseUrl).toBe('http://llm-proxy:8082/acme');
    expect(modelsJson.providers.acme?.models).toEqual([{ id: 'store-model', name: 'Store Model' }]);
    expect(modelsJson.providers.openai?.models).toEqual([{ id: 'file-model' }]);
    expect(JSON.stringify(modelsJson)).not.toContain('STORE_KEY');
  });

  it('records a test outcome on the store entry, or in memory for a file-only provider', async () => {
    const store = await freshStore();
    await store.upsert('acme', storeEntry);
    const catalog = new ProviderCatalog({ openai: fileOpenAi }, store);
    const result = {
      model: 'x',
      completion: 'ok' as const,
      tool_call: 'error' as const,
      latency_ms: 3,
      error: 'HTTP 400',
      tested_at: '2026-09-19T00:00:00.000Z',
    };
    await catalog.recordTest('acme', result);
    await catalog.recordTest('openai', result);
    expect(store.get('acme')?.last_test).toEqual(result);
    expect(catalog.get('openai')?.lastTest).toEqual(result);
  });
});
