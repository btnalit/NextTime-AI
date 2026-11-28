import { describe, expect, it } from 'vitest';
import {
  BUDGET_HINT_TEXT,
  BudgetTracker,
  HINT_CALLS,
  chargedTokens,
  compactionEstimate,
} from './budget.js';

/** pi's `Usage` for one call. */
function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe('chargedTokens (what the kernel charges a Task today)', () => {
  it('is the four counts in full, as recordWorkerRunUsage sums them', () => {
    expect(chargedTokens(usage(100, 20, 3000, 400))).toBe(3520);
  });

  it('reads a missing, negative or non-numeric count as 0, and anything not an object as no usage', () => {
    expect(chargedTokens({ input: 10, output: -5, cacheRead: Number.NaN, cacheWrite: '9' })).toBe(
      10,
    );
    expect(chargedTokens(undefined)).toBe(0);
    expect(chargedTokens([1, 2])).toBe(0);
  });
});

describe('compactionEstimate (a compaction pi reports no usage for)', () => {
  it('is the context before compaction plus the summary call’s output cap', () => {
    expect(
      compactionEstimate({
        tokensBefore: 150_000,
        isSplitTurn: false,
        messagesToSummarize: [{}],
        turnPrefixMessages: [],
        settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
      }),
    ).toBe(158_000);
  });

  it('counts two calls for a split turn that also summarizes history, one when only the turn prefix is', () => {
    const split = {
      tokensBefore: 1000,
      isSplitTurn: true,
      turnPrefixMessages: [{}],
      settings: { reserveTokens: 1000 },
    };
    expect(compactionEstimate({ ...split, messagesToSummarize: [{}] })).toBe(2 * 1800);
    expect(compactionEstimate({ ...split, messagesToSummarize: [] })).toBe(1800);
  });

  it('takes pi’s default reserve when the settings carry none', () => {
    expect(compactionEstimate({ tokensBefore: 0 })).toBe(Math.floor(0.8 * 16_384));
    expect(compactionEstimate(undefined)).toBe(0);
  });
});

describe('BudgetTracker', () => {
  it('gives no notice without a budget, or when get_task’s numbers cannot be read', () => {
    for (const task of [
      { tokenBudget: null, tokensUsed: 0 },
      { tokenBudget: 1000 },
      { tokenBudget: 1000, tokensUsed: -1 },
      { tokenBudget: 0, tokensUsed: 0 },
      { tokenBudget: '1000', tokensUsed: 0 },
      {},
    ]) {
      const tracker = new BudgetTracker();
      tracker.start(task);
      tracker.recordCall(usage(5000, 5000));
      expect(tracker.shouldHint()).toBe(false);
      expect(tracker.limit).toBeUndefined();
    }
    const unread = new BudgetTracker();
    unread.recordCall(usage(5000, 5000));
    expect(unread.shouldHint()).toBe(false);
  });

  it(`starts from the kernel’s count and gives the notice once less than ${HINT_CALLS} times the last call’s charge is left`, () => {
    const tracker = new BudgetTracker();
    tracker.start({ tokenBudget: 10_000, tokensUsed: 4000 });
    expect(tracker.shouldHint()).toBe(false);
    tracker.recordCall(usage(500, 100, 400, 0)); // 1000: 5000 left, 3 × 1000 = 3000
    expect(tracker.charged).toBe(5000);
    expect(tracker.shouldHint()).toBe(false);
    tracker.recordCall(usage(500, 100, 1200, 200)); // 2000: 3000 left, 3 × 2000 = 6000
    expect(tracker.charged).toBe(7000);
    expect(tracker.shouldHint()).toBe(true);
  });

  it('is exactly at the line: left equal to three calls is still no notice', () => {
    const tracker = new BudgetTracker();
    tracker.start({ tokenBudget: 4000, tokensUsed: 0 });
    tracker.recordCall(usage(1000, 0));
    expect(tracker.shouldHint()).toBe(false);
    tracker.recordCall(usage(0, 1));
    // The last call that carried usage sets the size: 1 token now, so 2999 left is plenty.
    expect(tracker.shouldHint()).toBe(false);
  });

  it('keeps the notice on once given, whatever is counted after', () => {
    const tracker = new BudgetTracker();
    tracker.start({ tokenBudget: 1000, tokensUsed: 900 });
    tracker.recordCall(usage(50, 0));
    expect(tracker.shouldHint()).toBe(true);
    tracker.recordCall(usage(1, 0));
    expect(tracker.shouldHint()).toBe(true);
  });

  it('gives the notice when the kernel’s count is already at the budget, before any call of this run', () => {
    const tracker = new BudgetTracker();
    tracker.start({ tokenBudget: 1000, tokensUsed: 1000 });
    expect(tracker.shouldHint()).toBe(true);
  });

  it('a call without usage (an error, an abort) adds nothing and leaves the last call’s size as it was', () => {
    const tracker = new BudgetTracker();
    tracker.start({ tokenBudget: 10_000, tokensUsed: 0 });
    tracker.recordCall(usage(2000, 0));
    tracker.recordCall(usage(0, 0));
    expect(tracker.charged).toBe(2000);
    tracker.recordCall(usage(1000, 0)); // 7000 left; the size is 1000 now
    expect(tracker.shouldHint()).toBe(false);
  });

  it('counts calls made before get_task was read on top of the kernel’s count (an earlier notice, never a later one)', () => {
    const tracker = new BudgetTracker();
    tracker.recordCall(usage(1000, 0));
    tracker.start({ tokenBudget: 5000, tokensUsed: 1000 });
    expect(tracker.charged).toBe(2000);
  });

  it('counts a compaction by its usage when pi has it, by the estimate when it has none or fails', () => {
    const preparation = { tokensBefore: 5000, settings: { reserveTokens: 1000 } };
    const withUsage = new BudgetTracker();
    withUsage.start({ tokenBudget: 1_000_000, tokensUsed: 0 });
    withUsage.compactionStarting(preparation);
    withUsage.compactionEnded(usage(4000, 300));
    expect(withUsage.charged).toBe(4300);

    const without = new BudgetTracker();
    without.start({ tokenBudget: 1_000_000, tokensUsed: 0 });
    without.compactionStarting(preparation);
    without.compactionEnded(undefined);
    expect(without.charged).toBe(5800);
    without.compactionStarting(preparation);
    without.compactionEnded(usage(0, 0));
    expect(without.charged).toBe(11_600);

    const failed = new BudgetTracker();
    failed.start({ tokenBudget: 1_000_000, tokensUsed: 0 });
    failed.compactionStarting(preparation);
    failed.compactionFailed();
    expect(failed.charged).toBe(5800);
    // A failure pi reports with no compaction started (nothing to compact) adds nothing.
    failed.compactionFailed();
    expect(failed.charged).toBe(5800);
  });

  it('a compaction is not the size of the next call: the notice still goes by the last model call', () => {
    const tracker = new BudgetTracker();
    tracker.start({ tokenBudget: 100_000, tokensUsed: 0 });
    tracker.recordCall(usage(1000, 0));
    tracker.compactionStarting({ tokensBefore: 50_000, settings: { reserveTokens: 1000 } });
    tracker.compactionEnded(undefined);
    // 100,000 − 51,800 = 48,200 left; three calls of 1000 fit.
    expect(tracker.shouldHint()).toBe(false);
  });

  it('counts a cache-warming refresh as a read of the last request’s prompt plus one output token', () => {
    const tracker = new BudgetTracker();
    tracker.start({ tokenBudget: 100_000, tokensUsed: 0 });
    tracker.warmingRefresh();
    expect(tracker.charged).toBe(1);
    tracker.recordCall(usage(100, 50, 3000, 200));
    tracker.warmingRefresh();
    expect(tracker.charged).toBe(1 + 3350 + 3301);
  });

  it('the notice is one fixed text that names report_result and findings and carries no number', () => {
    expect(BUDGET_HINT_TEXT).toContain('report_result');
    expect(BUDGET_HINT_TEXT).toContain('findings');
    expect(BUDGET_HINT_TEXT).not.toMatch(/\d/);
  });
});
