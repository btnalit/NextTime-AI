import { describe, expect, it } from 'vitest';
import { UpstreamCallLimitError, createUpstreamCallLimiter } from './admin-limits.js';

/** admin-limits.test: the per-administrator concurrency queue and the upstream-call budget. */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createUpstreamCallLimiter', () => {
  it('runs at most maxConcurrent at once, queues the next ones in order, refuses beyond the queue', async () => {
    const limiter = createUpstreamCallLimiter({
      maxConcurrent: 1,
      maxQueued: 2,
      budget: 100,
      windowMs: 60_000,
    });
    const order: string[] = [];
    const gate = deferred();
    const first = limiter.run('admin', 1, async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = limiter.run('admin', 1, async () => {
      order.push('second');
    });
    const third = limiter.run('admin', 1, async () => {
      order.push('third');
    });
    await expect(limiter.run('admin', 1, async () => 'never')).rejects.toMatchObject({
      reason: 'busy',
    });
    // Another administrator is not held up.
    await expect(limiter.run('other', 1, async () => 'ok')).resolves.toBe('ok');

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
    // The queue drained: a new call runs straight away.
    await expect(limiter.run('admin', 1, async () => 'again')).resolves.toBe('again');
  });

  it('refuses a call the window budget cannot take, with the wait until it can', async () => {
    let clock = 0;
    const limiter = createUpstreamCallLimiter(
      { maxConcurrent: 2, maxQueued: 0, budget: 10, windowMs: 60_000 },
      () => clock,
    );
    await limiter.run('admin', 6, async () => {});
    clock = 20_000;
    await limiter.run('admin', 3, async () => {});
    clock = 30_000;
    let ran = false;
    const refused = await limiter
      .run('admin', 4, async () => {
        ran = true;
      })
      .catch((err: unknown) => err);
    expect(ran).toBe(false);
    expect(refused).toBeInstanceOf(UpstreamCallLimitError);
    // 9 of 10 spent; the 6 charged at t=0 rolls off at t=60 s → 30 s from now.
    expect(refused).toMatchObject({ reason: 'budget', retryAfterSeconds: 30 });
    // A call that fits the remaining 1 still runs.
    await expect(limiter.run('admin', 1, async () => 'fits')).resolves.toBe('fits');
    clock = 60_000;
    await expect(limiter.run('admin', 4, async () => 'later')).resolves.toBe('later');
  });

  it('releases the slot when the call throws', async () => {
    const limiter = createUpstreamCallLimiter({
      maxConcurrent: 1,
      maxQueued: 0,
      budget: 100,
      windowMs: 60_000,
    });
    await expect(
      limiter.run('admin', 1, async () => {
        throw new Error('upstream exploded');
      }),
    ).rejects.toThrow('upstream exploded');
    await expect(limiter.run('admin', 1, async () => 'ok')).resolves.toBe('ok');
  });

  it('a refused budget charge frees the running slot for the next caller', async () => {
    const limiter = createUpstreamCallLimiter({
      maxConcurrent: 1,
      maxQueued: 1,
      budget: 2,
      windowMs: 60_000,
    });
    await expect(limiter.run('admin', 3, async () => 'too big')).rejects.toMatchObject({
      reason: 'budget',
    });
    await expect(limiter.run('admin', 2, async () => 'ok')).resolves.toBe('ok');
  });
});
