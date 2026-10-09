import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MODELS_JSON_MAX_BYTES,
  ModelsCatalogUnavailableError,
  PROVIDER_HEALTH_MAX_BYTES,
  readModelCatalog,
  readModelCatalogWithHealth,
  readProviderHealth,
  readSmallRegularFile,
} from './models-catalog-handler.js';

const VALID_HEALTH = {
  version: 1,
  writtenAt: '2026-10-09T00:00:00.000Z',
  providers: { deepseek: { status: 'ok', testedAt: '2026-10-09T00:00:00.000Z' } },
};

/**
 * models-catalog-handler.test.ts (console audit P0-2): the model projection carries each
 * provider's health from `provider-health.json` next to `models.json`, and an absent or malformed
 * health file leaves the catalog answering with health unknown.
 */

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'models-catalog-'));
  env = { MODELS_JSON_FILE: path.join(dir, 'models.json') };
  await writeFile(
    path.join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        deepseek: { apiKey: '$CAPABILITY_HANDLE', models: [{ id: 'chat' }, { id: 'coder' }] },
        anthropic: { apiKey: '$CAPABILITY_HANDLE', models: [{ id: 'sonnet' }] },
      },
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function writeHealth(body: unknown): Promise<void> {
  return writeFile(path.join(dir, 'provider-health.json'), JSON.stringify(body));
}

describe('readModelCatalog — provider health', () => {
  it('attaches each provider’s health to every one of its models; a provider the file omits stays unknown', async () => {
    await writeHealth({
      version: 1,
      writtenAt: '2026-10-09T00:00:00.000Z',
      providers: {
        deepseek: { status: 'key_rejected', testedAt: '2026-10-09T00:00:00.000Z' },
      },
    });
    const catalog = await readModelCatalog(env);
    expect(catalog).toEqual([
      {
        id: 'deepseek/chat',
        provider: 'deepseek',
        model: 'chat',
        health: { status: 'key_rejected', testedAt: '2026-10-09T00:00:00.000Z' },
      },
      {
        id: 'deepseek/coder',
        provider: 'deepseek',
        model: 'coder',
        health: { status: 'key_rejected', testedAt: '2026-10-09T00:00:00.000Z' },
      },
      { id: 'anthropic/sonnet', provider: 'anthropic', model: 'sonnet' },
    ]);
  });

  it('no health file: the catalog still answers, with no health on any model, and says the file is missing', async () => {
    expect((await readModelCatalogWithHealth(env)).healthFile).toBe('missing');
    const catalog = await readModelCatalog(env);
    expect(catalog.map((entry) => entry.id)).toEqual([
      'deepseek/chat',
      'deepseek/coder',
      'anthropic/sonnet',
    ]);
    expect(catalog.every((entry) => entry.health === undefined)).toBe(true);
  });

  it.each([
    ['not JSON', '{'],
    ['a future version', JSON.stringify({ version: 2, writtenAt: 'x', providers: {} })],
    [
      'an unknown status',
      JSON.stringify({
        version: 1,
        writtenAt: 'x',
        providers: { deepseek: { status: 'great', testedAt: null } },
      }),
    ],
    [
      'an extra field (an error text must never ride along)',
      JSON.stringify({
        version: 1,
        writtenAt: 'x',
        providers: { deepseek: { status: 'test_failed', testedAt: null, error: 'HTTP 500' } },
      }),
    ],
    [
      'too large',
      JSON.stringify({
        version: 1,
        writtenAt: 'x',
        providers: {},
        pad: 'x'.repeat(PROVIDER_HEALTH_MAX_BYTES),
      }),
    ],
  ])('a malformed health file (%s) reads as unknown, never as working', async (_label, body) => {
    await writeFile(path.join(dir, 'provider-health.json'), body);
    expect(await readProviderHealth(env)).toEqual({ state: 'invalid', providers: new Map() });
    const catalog = await readModelCatalogWithHealth(env);
    expect(catalog.healthFile).toBe('invalid');
    expect(catalog.items.every((entry) => entry.health === undefined)).toBe(true);
  });

  // Review S2: the kernel reads files another process writes — it follows no symlink, reads no
  // FIFO / directory (and does not block on a FIFO), and refuses an oversized models.json.
  it('a symlinked health file is refused, even when it points at a valid file', async () => {
    const real = path.join(dir, 'real-health.json');
    await writeFile(real, JSON.stringify(VALID_HEALTH));
    await symlink(real, path.join(dir, 'provider-health.json'));
    expect((await readProviderHealth(env)).state).toBe('invalid');
    await expect(
      readSmallRegularFile(path.join(dir, 'provider-health.json'), 1024),
    ).rejects.toMatchObject({
      reason: 'symlink',
    });
  });

  it('a directory or a FIFO in place of the health file is refused without blocking', async () => {
    await mkdir(path.join(dir, 'provider-health.json'));
    expect((await readProviderHealth(env)).state).toBe('invalid');
    await rm(path.join(dir, 'provider-health.json'), { recursive: true });
    execFileSync('mkfifo', [path.join(dir, 'provider-health.json')]);
    await expect(
      readSmallRegularFile(path.join(dir, 'provider-health.json'), 1024),
    ).rejects.toMatchObject({
      reason: 'not_regular',
    });
    expect((await readProviderHealth(env)).state).toBe('invalid');
  });

  it('models.json gets the same checks: a symlink or an oversized file is unavailable, not parsed', async () => {
    const real = path.join(dir, 'real-models.json');
    await rename(path.join(dir, 'models.json'), real);
    await symlink(real, path.join(dir, 'models.json'));
    await expect(readModelCatalog(env)).rejects.toBeInstanceOf(ModelsCatalogUnavailableError);
    await rm(path.join(dir, 'models.json'));
    await writeFile(path.join(dir, 'models.json'), ' '.repeat(MODELS_JSON_MAX_BYTES + 1));
    await expect(readModelCatalog(env)).rejects.toBeInstanceOf(ModelsCatalogUnavailableError);
  });

  it('withHealth: false reads only models.json (the membership checks)', async () => {
    await writeFile(path.join(dir, 'provider-health.json'), JSON.stringify(VALID_HEALTH));
    const catalog = await readModelCatalog(env, { withHealth: false });
    expect(catalog.every((entry) => entry.health === undefined)).toBe(true);
    expect(catalog).toHaveLength(3);
  });

  it('PROVIDER_HEALTH_FILE overrides the location', async () => {
    const elsewhere = path.join(dir, 'elsewhere.json');
    await writeFile(
      elsewhere,
      JSON.stringify({
        version: 1,
        writtenAt: 'x',
        providers: { anthropic: { status: 'ok', testedAt: '2026-10-09T00:00:00.000Z' } },
      }),
    );
    const health = await readProviderHealth({ ...env, PROVIDER_HEALTH_FILE: elsewhere });
    expect(health.state).toBe('ok');
    expect(health.providers.get('anthropic')?.status).toBe('ok');
  });
});
