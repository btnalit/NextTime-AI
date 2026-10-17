import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS,
  DEFAULT_RECONCILE_CHECK_MAX_DURATION_MS,
  RECONCILE_CHECK_MAX_BACKOFF_MS,
  defaultReconcileCheckBackoffMs,
  reconcileRetryDelayMs,
} from './reconcile-check.js';

describe('reconcileRetryDelayMs — when a check that did not settle tries again (S11 GO3d)', () => {
  const t0 = new Date('2026-10-17T00:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('backs off 30 s, doubling, at most five minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(defaultReconcileCheckBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
    expect(defaultReconcileCheckBackoffMs(20)).toBe(RECONCILE_CHECK_MAX_BACKOFF_MS);
  });

  it('with the defaults: five attempts within 7½ minutes, the fifth is the last', () => {
    expect(DEFAULT_RECONCILE_CHECK_MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_RECONCILE_CHECK_MAX_DURATION_MS).toBe(15 * 60 * 1000);
    let now = t0;
    const delays: Array<number | null> = [];
    for (let attempts = 1; attempts <= 5; attempts += 1) {
      const delay = reconcileRetryDelayMs({ attempts, firstAttemptAt: t0 }, now);
      delays.push(delay);
      if (delay !== null) now = at(now.getTime() - t0.getTime() + delay);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, null]);
    expect(now.getTime() - t0.getTime()).toBe(450_000);
  });

  it('stops at maxAttempts, and at a retry that would start past maxDurationMs from the first', () => {
    const options = { maxAttempts: 3, maxDurationMs: 100_000, backoffMs: () => 40_000 };
    expect(reconcileRetryDelayMs({ attempts: 1, firstAttemptAt: t0 }, t0, options)).toBe(40_000);
    expect(reconcileRetryDelayMs({ attempts: 3, firstAttemptAt: t0 }, at(1), options)).toBeNull();
    // 60 s in, the next would start at 100 s: still inside; 61 s in, it would not be.
    expect(reconcileRetryDelayMs({ attempts: 2, firstAttemptAt: t0 }, at(60_000), options)).toBe(
      40_000,
    );
    expect(
      reconcileRetryDelayMs({ attempts: 2, firstAttemptAt: t0 }, at(61_000), options),
    ).toBeNull();
    // A run paused past the cap: the attempt made on its resume is the last.
    expect(
      reconcileRetryDelayMs({ attempts: 2, firstAttemptAt: t0 }, at(3_600_000), options),
    ).toBeNull();
  });
});
