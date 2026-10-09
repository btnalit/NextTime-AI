import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModelCatalog, readProviderHealth } from './models-catalog-handler.js';

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

  it('no health file: the catalog still answers, with no health on any model', async () => {
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
  ])('a malformed health file (%s) reads as unknown', async (_label, body) => {
    await writeFile(path.join(dir, 'provider-health.json'), body);
    expect((await readProviderHealth(env)).size).toBe(0);
    const catalog = await readModelCatalog(env);
    expect(catalog.every((entry) => entry.health === undefined)).toBe(true);
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
    expect(health.get('anthropic')?.status).toBe('ok');
  });
});
