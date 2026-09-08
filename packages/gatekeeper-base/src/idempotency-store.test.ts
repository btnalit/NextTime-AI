import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type IdempotencyDescriptor,
  InMemoryIdempotencyStore,
  JsonFileIdempotencyStore,
  hashIdempotencyParams,
} from './idempotency-store.js';

const descriptorA: IdempotencyDescriptor = {
  operation: 'stock.adjust',
  paramsHash: hashIdempotencyParams({ qty: 1 }),
  onBehalfOf: 'user-a',
};

const descriptorB: IdempotencyDescriptor = {
  operation: 'stock.adjust',
  paramsHash: hashIdempotencyParams({ qty: 2 }),
  onBehalfOf: 'user-a',
};

describe('hashIdempotencyParams', () => {
  it('is stable across key order', () => {
    expect(hashIdempotencyParams({ a: 1, b: 2 })).toBe(hashIdempotencyParams({ b: 2, a: 1 }));
  });

  it('treats undefined and {} as the same params', () => {
    expect(hashIdempotencyParams(undefined)).toBe(hashIdempotencyParams({}));
  });

  it('differs for different values', () => {
    expect(hashIdempotencyParams({ qty: 1 })).not.toBe(hashIdempotencyParams({ qty: 2 }));
  });
});

const dirRef: { dir: string } = { dir: '' };

describe.each([
  ['JsonFileIdempotencyStore', () => new JsonFileIdempotencyStore(dirRef.dir)],
  ['InMemoryIdempotencyStore', () => new InMemoryIdempotencyStore()],
] as const)('%s', (_name, makeStore) => {
  beforeEach(async () => {
    dirRef.dir = await mkdtemp(join(tmpdir(), 'gatekeeper-idempotency-'));
  });

  afterEach(async () => {
    await rm(dirRef.dir, { recursive: true, force: true });
  });

  it('reserve on an unknown key returns reserved', async () => {
    const store = makeStore();
    expect(await store.reserve('k1', descriptorA)).toEqual({ status: 'reserved' });
  });

  it('reserve before complete for the same key returns conflict (never invoke twice)', async () => {
    const store = makeStore();
    expect(await store.reserve('k1', descriptorA)).toEqual({ status: 'reserved' });
    expect(await store.reserve('k1', descriptorA)).toEqual({ status: 'conflict' });
  });

  it('reserve for a different tuple on an already-completed key returns conflict', async () => {
    const store = makeStore();
    await store.reserve('k1', descriptorA);
    await store.complete('k1', { data: { applied: true }, observedFacts: [] });
    expect(await store.reserve('k1', descriptorB)).toEqual({ status: 'conflict' });
  });

  it('reserve for the same tuple on an already-completed key returns replay with the stored entry', async () => {
    const store = makeStore();
    await store.reserve('k1', descriptorA);
    await store.complete('k1', { data: { applied: true }, observedFacts: [{ x: 1 }] });
    const result = await store.reserve('k1', descriptorA);
    expect(result).toEqual({
      status: 'replay',
      entry: { ...descriptorA, data: { applied: true }, observedFacts: [{ x: 1 }] },
    });
  });
});

describe('JsonFileIdempotencyStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gatekeeper-idempotency-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists a completed entry across store instances (same file)', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    await store1.reserve('k1', descriptorA);
    await store1.complete('k1', { data: { applied: true }, observedFacts: [] });

    const store2 = new JsonFileIdempotencyStore(dir);
    expect(await store2.reserve('k1', descriptorA)).toEqual({
      status: 'replay',
      entry: { ...descriptorA, data: { applied: true }, observedFacts: [] },
    });
  });

  it('a reservation not yet completed does not survive a fresh store instance (no cross-process durability)', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    await store1.reserve('k1', descriptorA);
    // Never completed — nothing was ever flushed to disk.

    const store2 = new JsonFileIdempotencyStore(dir);
    expect(await store2.reserve('k1', descriptorA)).toEqual({ status: 'reserved' });
  });
});
