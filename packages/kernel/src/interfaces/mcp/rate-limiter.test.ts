import { describe, expect, it } from 'vitest';
import { PerHandleRateLimiter } from './rate-limiter.js';

describe('PerHandleRateLimiter', () => {
  it('allows up to `limit` requests per jti within one window, then rejects', () => {
    const limiter = new PerHandleRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.tryConsume('jti-1')).toBe(true);
    expect(limiter.tryConsume('jti-1')).toBe(true);
    expect(limiter.tryConsume('jti-1')).toBe(true);
    expect(limiter.tryConsume('jti-1')).toBe(false);
  });

  it('tracks each jti independently — one Handle exhausting its window does not affect another', () => {
    const limiter = new PerHandleRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.tryConsume('jti-a')).toBe(true);
    expect(limiter.tryConsume('jti-a')).toBe(false);
    expect(limiter.tryConsume('jti-b')).toBe(true);
  });

  it('resets the count once the window elapses', () => {
    let nowMs = 0;
    const limiter = new PerHandleRateLimiter({ limit: 1, windowMs: 1000, now: () => nowMs });
    expect(limiter.tryConsume('jti-1')).toBe(true);
    expect(limiter.tryConsume('jti-1')).toBe(false);
    nowMs = 1000; // exactly at the boundary — a new window starts
    expect(limiter.tryConsume('jti-1')).toBe(true);
  });

  it('defaults to a generous limit/window when none is given', () => {
    const limiter = new PerHandleRateLimiter();
    for (let i = 0; i < 60; i += 1) {
      expect(limiter.tryConsume('jti-default')).toBe(true);
    }
    expect(limiter.tryConsume('jti-default')).toBe(false);
  });
});
