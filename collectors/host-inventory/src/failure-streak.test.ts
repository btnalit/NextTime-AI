import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FAILURE_STREAK_ALERT,
  INITIAL_FAILURE_STREAK,
  describeFailure,
  parseFailureStreakAlert,
  recordFailure,
  recordSuccess,
} from './failure-streak.js';
import { KernelClientError } from './kernel-client.js';

describe('failure-streak (S6, leftover 41 後半)', () => {
  it('counts consecutive failures and resets on success', () => {
    let state = INITIAL_FAILURE_STREAK;
    state = recordFailure(state);
    state = recordFailure(state);
    expect(state.consecutiveFailures).toBe(2);
    state = recordSuccess(state);
    expect(state.consecutiveFailures).toBe(0);
  });

  it('logs warn below the alert threshold and error ("collector failing repeatedly") at it', () => {
    const one = describeFailure(new Error('boom'), { consecutiveFailures: 1 });
    expect(one).toEqual({
      level: 'warn',
      message: 'collection cycle failed',
      error: 'boom',
      consecutiveFailures: 1,
    });
    const three = describeFailure(new Error('boom'), {
      consecutiveFailures: DEFAULT_FAILURE_STREAK_ALERT,
    });
    expect(three.level).toBe('error');
    expect(three.message).toBe('collector failing repeatedly');
    expect(describeFailure(new Error('x'), { consecutiveFailures: 2 }, 2).level).toBe('error');
  });

  it('carries the kernel status and error code for a refused kernel call (the 401 signature)', () => {
    const err = new KernelClientError('register_source', 401, 'unauthorized', 'handle revoked');
    const line = describeFailure(err, { consecutiveFailures: 4 });
    expect(line.kernelStatus).toBe(401);
    expect(line.kernelErrorCode).toBe('unauthorized');
    expect(line.error).toContain('register_source');
    expect(describeFailure('not an Error', { consecutiveFailures: 1 })).toMatchObject({
      error: 'not an Error',
    });
  });

  it('parseFailureStreakAlert: default when unset, positive integers only', () => {
    expect(parseFailureStreakAlert(undefined)).toBe(DEFAULT_FAILURE_STREAK_ALERT);
    expect(parseFailureStreakAlert('')).toBe(DEFAULT_FAILURE_STREAK_ALERT);
    expect(parseFailureStreakAlert('8')).toBe(8);
    for (const bad of ['0', '-1', 'x', '1.5']) {
      expect(() => parseFailureStreakAlert(bad)).toThrow(/positive integer/);
    }
  });
});
