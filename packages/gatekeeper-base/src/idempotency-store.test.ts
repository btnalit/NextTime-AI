import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

  it('the first load sweeps temp files an interrupted earlier process left (#530 review)', async () => {
    const uuid = '0b9e4f8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    await writeFile(join(dir, `.idempotency-store.json.${uuid}.tmp`), 'leftover');
    await writeFile(join(dir, `idempotency-store.json.${uuid}.tmp`), 'leftover');
    const store = new JsonFileIdempotencyStore(dir);
    await store.reserve('k1', descriptorA);
    expect(await readdir(dir)).toEqual(['idempotency-store.json']);
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

/**
 * Legacy 287 (review of #586, #493 P2): `lookup` answers what a key holds without reserving it,
 * and closes a key that holds nothing — once the kernel was told "not received", an `apply` for
 * the key that only arrives now is refused, never run.
 */
describe.each([
  ['InMemoryIdempotencyStore', async () => new InMemoryIdempotencyStore()],
  [
    'JsonFileIdempotencyStore',
    async () => new JsonFileIdempotencyStore(await mkdtemp(join(tmpdir(), 'gatekeeper-lookup-'))),
  ],
])('%s lookup (legacy 287)', (_name, makeStore) => {
  it('a key that holds nothing is absent, and closed: a later reserve is refused', async () => {
    const store = await makeStore();
    expect(await store.lookup('k1', descriptorA)).toEqual({ status: 'absent' });
    expect(await store.lookup('k1', descriptorA)).toEqual({ status: 'absent' });
    const late = await store.reserve('k1', descriptorA);
    expect(late).toMatchObject({ status: 'failed', failure: { outcomeUnknown: false } });
    expect(late.status === 'failed' && late.failure.message).toMatch(
      /arrived after the kernel was told this gate never received it/,
    );
    expect(await store.reserve('k1', descriptorB)).toEqual({ status: 'conflict' });
  });

  it('answers what ran, without reserving anything', async () => {
    const store = await makeStore();
    await store.reserve('done', descriptorA);
    await store.complete('done', { data: { ok: 1 }, observedFacts: [] });
    expect(await store.lookup('done', descriptorA)).toEqual({
      status: 'replay',
      entry: { ...descriptorA, data: { ok: 1 }, observedFacts: [] },
    });

    await store.reserve('failed', descriptorA);
    await store.fail('failed', { message: 'refused', outcomeUnknown: false });
    expect(await store.lookup('failed', descriptorA)).toEqual({
      status: 'failed',
      failure: { message: 'refused', outcomeUnknown: false },
    });

    await store.reserve('running', descriptorA);
    expect(await store.lookup('running', descriptorA)).toEqual({ status: 'pending' });
    // Still this call's: the lookup took nothing from it.
    await store.complete('running', { data: 2, observedFacts: [] });
    expect(await store.lookup('running', descriptorA)).toMatchObject({ status: 'replay' });

    expect(await store.lookup('done', descriptorB)).toEqual({ status: 'conflict' });
  });
});

describe('JsonFileIdempotencyStore lookup across a restart (legacy 287)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gatekeeper-lookup-restart-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a closed key stays closed, and an orphaned reservation reads as unknown', async () => {
    const store1 = new JsonFileIdempotencyStore(dir);
    expect(await store1.lookup('closed', descriptorA)).toEqual({ status: 'absent' });
    await store1.reserve('orphan', descriptorA);
    // The process dies here.

    const store2 = new JsonFileIdempotencyStore(dir);
    expect(await store2.lookup('closed', descriptorA)).toEqual({ status: 'absent' });
    expect(await store2.reserve('closed', descriptorA)).toMatchObject({ status: 'failed' });
    expect(await store2.lookup('orphan', descriptorA)).toEqual({ status: 'unknown' });
  });
});
