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

  it('release frees a reserved key and never a completed one (R-04)', async () => {
    const store = makeStore();
    await store.reserve('k1', descriptorA);
    await store.release('k1');
    expect(await store.reserve('k1', descriptorB)).toEqual({ status: 'reserved' });

    await store.complete('k1', { data: { applied: true }, observedFacts: [] });
    await store.release('k1');
    expect(await store.reserve('k1', descriptorB)).toMatchObject({ status: 'replay' });
  });

  it('fail stores the failure: the same tuple gets it back, a different tuple conflicts, release never frees it (R-51)', async () => {
    const store = makeStore();
    await store.reserve('k1', descriptorA);
    await store.fail('k1', { message: 'target failed', outcomeUnknown: false });

    expect(await store.reserve('k1', descriptorA)).toEqual({
      status: 'failed',
      failure: { message: 'target failed', outcomeUnknown: false },
    });
    expect(await store.reserve('k1', descriptorB)).toEqual({ status: 'conflict' });
    await store.release('k1');
    expect(await store.reserve('k1', descriptorA)).toMatchObject({ status: 'failed' });
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

  // R-51 / D-11: the reservation is on disk before the transport runs, so a gate that dies
  // mid-call restarts knowing the key's outcome is unknown — it never frees it for a re-run.
  it('a reservation never completed survives a restart as outcome unknown, for that tuple only', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    await store1.reserve('k1', descriptorA);
    // The process dies here — never completed, failed or released.

    const store2 = new JsonFileIdempotencyStore(dir);
    expect(await store2.reserve('k1', descriptorA)).toEqual({ status: 'unknown' });
    expect(await store2.reserve('k1', descriptorB)).toEqual({ status: 'conflict' });
    await store2.release('k1');
    expect(await store2.reserve('k1', descriptorA)).toEqual({ status: 'unknown' });

    // Still unknown after yet another restart (store2 rewrote the file without losing it).
    await store2.reserve('k2', descriptorA);
    const store3 = new JsonFileIdempotencyStore(dir);
    expect(await store3.reserve('k1', descriptorA)).toEqual({ status: 'unknown' });
  });

  it('a released reservation is gone from disk too: free again after a restart', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    await store1.reserve('k1', descriptorA);
    await store1.release('k1');

    const store2 = new JsonFileIdempotencyStore(dir);
    expect(await store2.reserve('k1', descriptorA)).toEqual({ status: 'reserved' });
  });

  it('a stored failure survives a restart', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    await store1.reserve('k1', descriptorA);
    await store1.fail('k1', { message: 'timed out', outcomeUnknown: true });

    const store2 = new JsonFileIdempotencyStore(dir);
    expect(await store2.reserve('k1', descriptorA)).toEqual({
      status: 'failed',
      failure: { message: 'timed out', outcomeUnknown: true },
    });
  });

  it('overlapping writes land in order: the file always ends with the latest state of every key', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => {
        const key = `k${index}`;
        await store1.reserve(key, descriptorA);
        if (index % 2 === 0) {
          await store1.complete(key, { data: { index }, observedFacts: [] });
        } else {
          await store1.fail(key, { message: `failed ${index}`, outcomeUnknown: false });
        }
      }),
    );

    const store2 = new JsonFileIdempotencyStore(dir);
    for (let index = 0; index < 8; index++) {
      expect(await store2.reserve(`k${index}`, descriptorA)).toMatchObject({
        status: index % 2 === 0 ? 'replay' : 'failed',
      });
    }
  });
});
