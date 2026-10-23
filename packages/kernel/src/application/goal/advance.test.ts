import { describe, expect, it } from 'vitest';
import { defaultRetryBackoffMs, judgeFinishedAttempt, refusalPause } from './advance.js';

/** application/goal/advance (S11 GO2): the pure rules of an advance. The advance itself runs
 *  against Postgres in `advancer.integration.test.ts`. */

const clear = { kind: 'clear' } as const;
const refused = { kind: 'fail', failureCategory: 'action_refused' } as const;
const notDelivered = { kind: 'fail', failureCategory: 'transient' } as const;
const unconfirmed = { kind: 'fail', failureCategory: 'outcome_unknown' } as const;

describe('judgeFinishedAttempt', () => {
  it('a completed attempt succeeds unless one of its requests failed it', () => {
    expect(judgeFinishedAttempt({ status: 'completed', failureReason: null }, clear)).toEqual({
      kind: 'succeed',
    });
    expect(judgeFinishedAttempt({ status: 'completed', failureReason: null }, refused)).toEqual({
      kind: 'fail',
      category: 'action_refused',
      pause: 'needs_decision',
    });
    expect(
      judgeFinishedAttempt({ status: 'completed', failureReason: null }, notDelivered),
    ).toEqual({ kind: 'fail', category: 'transient', pause: null });
  });

  it('a refused request, or one found to have had no effect, decides a failed attempt before its failure reason does', () => {
    for (const failureReason of ['worker_failed', 'no_result', 'budget_exhausted', 'timeout']) {
      expect(judgeFinishedAttempt({ status: 'failed', failureReason }, refused)).toEqual({
        kind: 'fail',
        category: 'action_refused',
        pause: 'needs_decision',
      });
      expect(judgeFinishedAttempt({ status: 'failed', failureReason }, unconfirmed)).toEqual({
        kind: 'fail',
        category: 'outcome_unknown',
        pause: 'needs_decision',
      });
    }
  });

  it('no result is a contract violation; an exhausted attempt budget pauses the goal', () => {
    expect(judgeFinishedAttempt({ status: 'failed', failureReason: 'no_result' }, clear)).toEqual({
      kind: 'fail',
      category: 'contract_violation',
      pause: 'needs_decision',
    });
    expect(
      judgeFinishedAttempt({ status: 'failed', failureReason: 'budget_exhausted' }, notDelivered),
    ).toEqual({ kind: 'fail', category: 'transient', pause: 'budget_exhausted' });
  });

  it('every other failure is transient and left to the retry', () => {
    for (const failureReason of [
      'spawn_failed',
      'spawn_lost',
      'run_lost',
      'worker_failed',
      'timeout',
      'terminated',
      null,
    ]) {
      expect(judgeFinishedAttempt({ status: 'failed', failureReason }, clear)).toEqual({
        kind: 'fail',
        category: 'transient',
        pause: null,
      });
    }
  });

  it('a cancelled attempt is transient but needs a person', () => {
    for (const effect of [clear, refused, notDelivered]) {
      expect(judgeFinishedAttempt({ status: 'cancelled', failureReason: null }, effect)).toEqual({
        kind: 'fail',
        category: 'transient',
        pause: 'needs_decision',
      });
    }
  });
});

describe('refusalPause', () => {
  it('maps why an attempt could not start to why the goal pauses', () => {
    expect(refusalPause({ kind: 'authority_lost', reason: 'gates', detail: 'x' })).toBe(
      'authority_lost',
    );
    expect(refusalPause({ kind: 'unavailable', reason: 'definition', detail: 'x' })).toBe(
      'needs_decision',
    );
    expect(refusalPause({ kind: 'quota', code: 'concurrency_exceeded', detail: 'x' })).toBeNull();
    expect(refusalPause({ kind: 'quota', code: 'daily_cost_exceeded', detail: 'x' })).toBe(
      'budget_exhausted',
    );
    expect(refusalPause({ kind: 'quota', code: 'depth_exceeded', detail: 'x' })).toBe(
      'needs_decision',
    );
  });
});

describe('defaultRetryBackoffMs', () => {
  it('starts at 30 s, doubles, and stops at 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(defaultRetryBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
    expect(defaultRetryBackoffMs(0)).toBe(30_000);
  });
});
