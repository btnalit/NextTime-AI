import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileIdempotencyStore } from './idempotency-store.js';

describe('JsonFileIdempotencyStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gatekeeper-idempotency-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for an unknown key', async () => {
    const store = new JsonFileIdempotencyStore(dir);
    expect(await store.get('missing')).toBeUndefined();
  });

  it('persists a value across store instances (same file)', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    await store1.set('k1', { applied: true });

    const store2 = new JsonFileIdempotencyStore(dir);
    expect(await store2.get('k1')).toEqual({ applied: true });
  });

  it('a repeat set for the same key does not overwrite the first value', async () => {
    const store = new JsonFileIdempotencyStore(dir);
    await store.set('k1', { attempt: 1 });
    await store.set('k1', { attempt: 2 });
    expect(await store.get('k1')).toEqual({ attempt: 1 });
  });
});
