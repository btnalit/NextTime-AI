import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderHealthFileSchema } from '@nexttime/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCatalog } from './catalog.js';
import type { ProviderConfig } from './config.js';
import {
  buildProviderHealthFile,
  providerHealthOutFile,
  writeProviderHealthAtomic,
} from './provider-health-file.js';
import { ProviderStore } from './provider-store.js';

/**
 * provider-health-file.test (console audit P0-2): where `provider-health.json` goes, what it holds
 * per provider (a status kind and a time — the shared `providerHealth` rule over the same wire the
 * admin page reads) and that it is written atomically, world-readable for the kernel's read-only
 * mount.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexttime-provider-health-'));
  dirs.push(dir);
  return dir;
}

const PROVIDER: ProviderConfig = {
  api: 'openai-completions',
  upstream_base_url: 'https://file.example.invalid',
  api_key_env: 'FILE_KEY',
  auth: { header: 'authorization', scheme: 'Bearer' },
  models: [{ id: 'file-model' }],
};

async function catalogOf(providers: Record<string, ProviderConfig>): Promise<ProviderCatalog> {
  const store = new ProviderStore(join(tempDir(), 'providers.json'));
  await store.load();
  return new ProviderCatalog(providers, store);
}

describe('providerHealthOutFile', () => {
  it('sits next to models.json unless PROVIDER_HEALTH_OUT_FILE says otherwise', () => {
    expect(providerHealthOutFile('/data/models/models.json', {})).toBe(
      '/data/models/provider-health.json',
    );
    expect(
      providerHealthOutFile('/data/models/models.json', {
        PROVIDER_HEALTH_OUT_FILE: '/elsewhere/h.json',
      }),
    ).toBe('/elsewhere/h.json');
  });
});

describe('buildProviderHealthFile', () => {
  it('applies the shared rule to each provider from its credential facts', async () => {
    const catalog = await catalogOf({ ok: PROVIDER, nokey: PROVIDER, badkey: PROVIDER });
    const file = buildProviderHealthFile(
      catalog,
      (provider) =>
        provider.id === 'nokey'
          ? { source: 'none', present: false, invalid: false }
          : { source: 'env', present: true, invalid: provider.id === 'badkey' },
      () => new Date('2026-10-09T00:00:00.000Z'),
    );
    expect(ProviderHealthFileSchema.parse(file)).toEqual({
      version: 1,
      writtenAt: '2026-10-09T00:00:00.000Z',
      providers: {
        ok: { status: 'untested', testedAt: null },
        nokey: { status: 'key_missing', testedAt: null },
        badkey: { status: 'key_invalid', testedAt: null },
      },
    });
  });
});

describe('writeProviderHealthAtomic', () => {
  it('writes the file 0644 with no temporary debris left behind', async () => {
    const dir = tempDir();
    const out = join(dir, 'provider-health.json');
    const health = {
      version: 1 as const,
      writtenAt: '2026-10-09T00:00:00.000Z',
      providers: { a: { status: 'ok' as const, testedAt: '2026-10-09T00:00:00.000Z' } },
    };
    await writeProviderHealthAtomic(out, health);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(health);
    expect(statSync(out).mode & 0o777).toBe(0o644 & ~process.umask());
    expect(readdirSync(dir)).toEqual(['provider-health.json']);
  });

  it('fails into a directory that does not exist, leaving nothing behind', async () => {
    const dir = tempDir();
    await expect(
      writeProviderHealthAtomic(join(dir, 'missing', 'provider-health.json'), {
        version: 1,
        writtenAt: 'x',
        providers: {},
      }),
    ).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
