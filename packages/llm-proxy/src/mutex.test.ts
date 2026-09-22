import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex.js';

describe('Mutex', () => {
  it('serializes concurrent runExclusive calls — no interleaving of the critical section', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    async function critical(label: string, delayMs: number): Promise<void> {
      await mutex.runExclusive(async () => {
        order.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(`${label}:end`);
      });
    }

    // Started "concurrently" (no await between them); the second must not begin until the first
    // (slower) one has fully finished.
    await Promise.all([critical('a', 20), critical('b', 0)]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('a rejection in one call never blocks the next queued caller', async () => {
    const mutex = new Mutex();
    const first = mutex.runExclusive(async () => {
      throw new Error('boom');
    });
    const second = mutex.runExclusive(async () => 'ok');

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
  });

  it('returns fn’s own resolved value', async () => {
    const mutex = new Mutex();
    await expect(mutex.runExclusive(async () => 42)).resolves.toBe(42);
  });
});
