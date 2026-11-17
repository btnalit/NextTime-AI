import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCatalog } from './catalog.js';
import type { ProviderConfig } from './config.js';
import { buildModelsJsonFromCatalog } from './gen-models-json.js';
import { currentProviderKey } from './provider-keys.js';
import { ProviderStore, type StoreTestResult } from './provider-store.js';
import { TestedKeys } from './tested-keys.js';

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
    await catalog.recordTest('acme', result, 'sk-tested');
    await catalog.recordTest('openai', result, 'sk-tested');
    expect(store.get('acme')?.last_test).toEqual(result);
    expect(catalog.get('openai')?.lastTest).toEqual(result);
  });
});

describe('ProviderCatalog — saved base URLs that break the bare-base rule (#510)', () => {
  it('loads them but never routes them or writes them to models.json, and lists them', async () => {
    const store = await freshStore();
    await store.upsert('legacy', {
      ...storeEntry,
      upstream_base_url: 'https://store.example.invalid/x#',
    });
    const yamlBad: ProviderConfig = {
      ...fileOpenAi,
      upstream_base_url: 'https://file.example.invalid/y?z=',
    };
    const catalog = new ProviderCatalog({ openai: fileOpenAi, yamlbad: yamlBad }, store);

    expect(catalog.resolve().map((p) => p.id)).toEqual(['openai', 'yamlbad', 'legacy']);
    expect(catalog.getRoutable('legacy')).toBeUndefined();
    expect(catalog.getRoutable('yamlbad')).toBeUndefined();
    expect(catalog.getRoutable('openai')).toEqual(fileOpenAi);
    expect(Object.keys(buildModelsJsonFromCatalog(catalog).providers)).toEqual(['openai']);
    expect(catalog.unsafeBaseUrls()).toEqual([
      { id: 'yamlbad', problem: 'must not contain a query string (?)' },
      { id: 'legacy', problem: 'must not contain a fragment (#)' },
    ]);
  });
});

describe('ProviderCatalog — a test result applies only to the key it ran with (legacy 202, 203)', () => {
  /** A restartable llm-proxy state directory: each `start` is a new process reading the same
   *  providers.json and tested-keys.json, with whatever keys the environment and console hold. */
  async function stateDir() {
    const dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-catalog-keys-'));
    dirs.push(dir);
    return {
      dir,
      start: async (keys: { env?: Record<string, string>; console?: Record<string, string> }) => {
        const store = new ProviderStore(join(dir, 'providers.json'));
        await store.load();
        const testedKeys = new TestedKeys(join(dir, 'tested-keys.json'), () => {});
        await testedKeys.load();
        const catalog = new ProviderCatalog({ openai: fileOpenAi }, store, {
          store: testedKeys,
          currentKey: (id, apiKeyEnv) =>
            currentProviderKey(
              id,
              apiKeyEnv,
              (providerId) => keys.console?.[providerId],
              (name) => keys.env?.[name],
            ),
        });
        return { store, catalog, testedKeys };
      },
    };
  }

  const passed = (testedAt: string): StoreTestResult => ({
    model: 'store-model',
    completion: 'ok',
    tool_call: 'ok',
    latency_ms: 5,
    error: null,
    tested_at: testedAt,
  });

  it('an env or key-file key rotated by a restart leaves the old result unshown; the same key keeps it', async () => {
    const state = await stateDir();
    const first = `sk-${randomUUID()}`;
    const second = `sk-${randomUUID()}`;
    const result = passed('2026-11-17T00:00:00.000Z');

    const before = await state.start({ env: { STORE_KEY: first } });
    await before.store.upsert('acme', storeEntry);
    await before.catalog.recordTest('acme', result, first);
    expect(before.catalog.get('acme')?.lastTest).toEqual(result);

    // Restarted with the same key: still applies.
    const same = await state.start({ env: { STORE_KEY: first } });
    expect(same.catalog.get('acme')?.lastTest).toEqual(result);

    // Restarted after the key file was rotated: the result is about the old key.
    const rotated = await state.start({ env: { STORE_KEY: second } });
    expect(rotated.catalog.get('acme')?.lastTest).toBeNull();
    // Nothing was deleted: rotating back shows it again.
    expect(rotated.store.get('acme')?.last_test).toEqual(result);
    const back = await state.start({ env: { STORE_KEY: first } });
    expect(back.catalog.get('acme')?.lastTest).toEqual(result);

    // No key at all now: nothing it says applies.
    const none = await state.start({});
    expect(none.catalog.get('acme')?.lastTest).toBeNull();
  });

  it('a console key wins over the env key, as in a request: a result tested with the env key is unshown once a console key is set', async () => {
    const state = await stateDir();
    const envKey = `sk-${randomUUID()}`;
    const result = passed('2026-11-17T00:00:00.000Z');
    const run = await state.start({ env: { FILE_KEY: envKey } });
    await run.catalog.recordTest('openai', result, envKey);
    expect(run.catalog.get('openai')?.lastTest).toEqual(result);

    const withConsole = await state.start({
      env: { FILE_KEY: envKey },
      console: { openai: `sk-${randomUUID()}` },
    });
    // A file provider's result lives in memory only; record it again in this process.
    await withConsole.catalog.recordTest('openai', result, envKey);
    expect(withConsole.catalog.get('openai')?.lastTest).toBeNull();
  });

  it('a test still running when the key changed records a result that is not shown for the new key', async () => {
    const state = await stateDir();
    const keys = { console: { acme: `sk-${randomUUID()}` } };
    const run = await state.start(keys);
    await run.store.upsert('acme', storeEntry);
    const ranWith = keys.console.acme;

    // The key changes mid-test: admin-api.ts sets it and drops the last test.
    keys.console.acme = `sk-${randomUUID()}`;
    await run.catalog.clearTest('acme');
    // Then the test that started with the old key finishes.
    const late = passed('2026-11-17T00:00:01.000Z');
    await run.catalog.recordTest('acme', late, ranWith);
    expect(run.store.get('acme')?.last_test).toEqual(late);
    expect(run.catalog.get('acme')?.lastTest).toBeNull();

    // A test with the new key is shown.
    const fresh = passed('2026-11-17T00:00:02.000Z');
    await run.catalog.recordTest('acme', fresh, keys.console.acme);
    expect(run.catalog.get('acme')?.lastTest).toEqual(fresh);
  });

  it('a result recorded before tested-keys.json existed is shown as before, until the next test or key change', async () => {
    const state = await stateDir();
    const key = `sk-${randomUUID()}`;
    const old = passed('2026-11-01T00:00:00.000Z');
    // As an older llm-proxy left it: the result in providers.json, no tested-keys.json.
    const legacy = new ProviderStore(join(state.dir, 'providers.json'));
    await legacy.load();
    await legacy.upsert('acme', storeEntry);
    await legacy.recordTest('acme', old);

    const run = await state.start({ env: { STORE_KEY: `sk-${randomUUID()}` } });
    expect(run.catalog.get('acme')?.lastTest).toEqual(old);

    await run.catalog.recordTest('acme', passed('2026-11-17T00:00:00.000Z'), key);
    expect(run.catalog.get('acme')?.lastTest).toBeNull();
  });

  it('a result written without its own key entry (a crash between the two writes) is not shown', async () => {
    const state = await stateDir();
    const key = `sk-${randomUUID()}`;
    const run = await state.start({ env: { STORE_KEY: key } });
    await run.store.upsert('acme', storeEntry);
    await run.catalog.recordTest('acme', passed('2026-11-17T00:00:00.000Z'), key);
    // The result write lands; the process dies before tested-keys.json says which key it ran
    // with — the entry still describes the earlier result.
    const orphan = passed('2026-11-17T00:00:05.000Z');
    await run.store.recordTest('acme', orphan);

    const restarted = await state.start({ env: { STORE_KEY: key } });
    expect(restarted.catalog.get('acme')?.lastTest).toBeNull();
  });

  it('two tests finishing together leave the later result beside its own key entry', async () => {
    const state = await stateDir();
    const key = `sk-${randomUUID()}`;
    const run = await state.start({ env: { STORE_KEY: key } });
    await run.store.upsert('acme', storeEntry);
    // The first test's key entry is slow to write; the second test finishes meanwhile.
    const record = run.testedKeys.record.bind(run.testedKeys);
    let calls = 0;
    run.testedKeys.record = async (...args) => {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 50));
      return record(...args);
    };
    const second = passed('2026-11-17T00:00:01.000Z');
    await Promise.all([
      run.catalog.recordTest('acme', passed('2026-11-17T00:00:00.000Z'), key),
      run.catalog.recordTest('acme', second, key),
    ]);
    expect(run.store.get('acme')?.last_test).toEqual(second);
    expect(run.catalog.get('acme')?.lastTest).toEqual(second);
  });

  it('a provider first tested on this version is tracked before its result is written: a crash between the writes shows nothing', async () => {
    const state = await stateDir();
    const key = `sk-${randomUUID()}`;
    const run = await state.start({ env: { STORE_KEY: key } });
    await run.store.upsert('acme', storeEntry);
    // The process dies after the result write, before tested-keys.json names its key.
    run.testedKeys.record = async () => {};
    await run.catalog.recordTest('acme', passed('2026-11-17T00:00:00.000Z'), key);

    const restarted = await state.start({ env: { STORE_KEY: `sk-${randomUUID()}` } });
    expect(restarted.store.get('acme')?.last_test).not.toBeNull();
    expect(restarted.catalog.get('acme')?.lastTest).toBeNull();
  });
});
