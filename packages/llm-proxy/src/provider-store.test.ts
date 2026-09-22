import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from './config.js';
import { ProviderStore, ProviderStoreError, storeProviderToConfig } from './provider-store.js';

/**
 * provider-store.test: filesystem-level unit tests of the S6-B console-managed store — empty on
 * a missing file, atomic `.tmp` + rename writes with no debris, reserved names refused, a corrupt
 * file fails loudly, and an unwritable directory is reported (503 at the admin API) rather than
 * silently losing the write.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexttime-llm-proxy-store-'));
  dirs.push(dir);
  return dir;
}

const ENTRY = {
  api: 'openai-completions' as const,
  upstream_base_url: 'https://api.example.invalid',
  api_key_env: 'EXAMPLE_API_KEY',
  auth: { header: 'authorization' as const, scheme: 'Bearer' as const },
  models: [{ id: 'm1', display_name: 'Model One' }],
  enabled: true,
};

describe('ProviderStore', () => {
  it('loads an empty store when the file does not exist', async () => {
    const store = new ProviderStore(join(tempDir(), 'providers.json'));
    await store.load();
    expect(store.entries()).toEqual([]);
  });

  it('upsert persists atomically (tmp + rename, no debris) and stamps created_at / updated_at', async () => {
    const dir = tempDir();
    const file = join(dir, 'providers.json');
    const store = new ProviderStore(file);
    await store.load();

    const t0 = new Date('2026-09-19T00:00:00.000Z');
    const created = await store.upsert('acme', ENTRY, t0);
    expect(created.created_at).toBe(t0.toISOString());
    expect(created.updated_at).toBe(t0.toISOString());
    expect(readdirSync(dir)).toEqual(['providers.json']);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.providers.acme.api_key_env).toBe('EXAMPLE_API_KEY');
    expect(JSON.stringify(onDisk)).not.toContain('sk-');

    const t1 = new Date('2026-09-19T01:00:00.000Z');
    const updated = await store.upsert('acme', { ...ENTRY, enabled: false }, t1);
    expect(updated.created_at).toBe(t0.toISOString());
    expect(updated.updated_at).toBe(t1.toISOString());

    // A fresh instance reads back exactly what was written.
    const reread = new ProviderStore(file);
    await reread.load();
    expect(reread.get('acme')?.enabled).toBe(false);
    expect(reread.get('acme')?.models[0]?.display_name).toBe('Model One');
  });

  it('storeProviderToConfig strips the lifecycle fields so the yaml-strict ProviderConfig shape holds', async () => {
    const store = new ProviderStore(join(tempDir(), 'providers.json'));
    await store.load();
    const entry = await store.upsert('acme', ENTRY);
    const config: ProviderConfig = storeProviderToConfig(entry);
    expect(Object.keys(config).sort()).toEqual([
      'api',
      'api_key_env',
      'auth',
      'models',
      'upstream_base_url',
    ]);
  });

  it('refuses a reserved provider name without touching the file', async () => {
    const dir = tempDir();
    const store = new ProviderStore(join(dir, 'providers.json'));
    await store.load();
    await expect(store.upsert('admin', ENTRY)).rejects.toMatchObject({
      name: 'ProviderStoreError',
      code: 'reserved_name',
    });
    expect(existsSync(join(dir, 'providers.json'))).toBe(false);
  });

  it('remove drops the entry and reports false for an unknown id', async () => {
    const store = new ProviderStore(join(tempDir(), 'providers.json'));
    await store.load();
    await store.upsert('acme', ENTRY);
    expect(await store.remove('acme')).toBe(true);
    expect(await store.remove('acme')).toBe(false);
    expect(store.entries()).toEqual([]);
  });

  it('recordTest attaches a test outcome to an existing entry only', async () => {
    const store = new ProviderStore(join(tempDir(), 'providers.json'));
    await store.load();
    const result = {
      model: 'm1',
      completion: 'ok' as const,
      tool_call: 'ok' as const,
      latency_ms: 12,
      error: null,
      tested_at: '2026-09-19T00:00:00.000Z',
    };
    expect(await store.recordTest('acme', result)).toBe(false);
    await store.upsert('acme', ENTRY);
    expect(await store.recordTest('acme', result)).toBe(true);
    expect(store.get('acme')?.last_test).toEqual(result);
  });

  it('fails loudly on a corrupt or mis-shaped file', async () => {
    const dir = tempDir();
    const file = join(dir, 'providers.json');
    writeFileSync(file, '{not json');
    await expect(new ProviderStore(file).load()).rejects.toBeInstanceOf(ProviderStoreError);
    writeFileSync(file, JSON.stringify({ version: 1, providers: { x: { api: 'nope' } } }));
    await expect(new ProviderStore(file).load()).rejects.toMatchObject({ code: 'invalid' });
  });

  it('concurrent upserts on different ids never lose a write (Mutex serializes them, S6-B leftover 50)', async () => {
    const dir = tempDir();
    const store = new ProviderStore(join(dir, 'providers.json'));
    await store.load();

    await Promise.all([
      store.upsert('acme', ENTRY),
      store.upsert('other', { ...ENTRY, api_key_env: 'OTHER_KEY' }),
      store.upsert('third', { ...ENTRY, api_key_env: 'THIRD_KEY' }),
    ]);

    expect(store.get('acme')).toBeDefined();
    expect(store.get('other')?.api_key_env).toBe('OTHER_KEY');
    expect(store.get('third')?.api_key_env).toBe('THIRD_KEY');

    const onDisk = JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8'));
    expect(Object.keys(onDisk.providers).sort()).toEqual(['acme', 'other', 'third']);
  });

  it('reports an unwritable directory and turns a write into a store_unwritable error', async () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const dir = tempDir();
    const locked = join(dir, 'locked');
    const store = new ProviderStore(join(locked, 'providers.json'));
    await store.load();
    // Create the directory read-only so mkdir -p succeeds but writes do not.
    await store.writable();
    chmodSync(locked, 0o500);
    const fresh = new ProviderStore(join(locked, 'providers.json'));
    await fresh.load();
    expect(await fresh.writable()).toBe(false);
    await expect(fresh.upsert('acme', ENTRY)).rejects.toMatchObject({ code: 'unwritable' });
    chmodSync(locked, 0o700);
  });
});
