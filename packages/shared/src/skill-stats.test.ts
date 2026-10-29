import { describe, expect, it } from 'vitest';
import { TASK_FAILURE_REASON_VALUES } from './enums.js';
import { SKILL_REVIEW_STREAK, suggestsReview, taskFailureCategory } from './skill-stats.js';

describe('taskFailureCategory', () => {
  it('maps every reason the kernel writes', () => {
    expect(
      TASK_FAILURE_REASON_VALUES.map((reason) => [reason, taskFailureCategory(reason)]),
    ).toEqual([
      ['timeout', 'limit_reached'],
      ['no_result', 'no_result'],
      ['worker_failed', 'worker_error'],
      ['spawn_failed', 'platform'],
      ['spawn_lost', 'platform'],
      ['run_lost', 'platform'],
      ['budget_exhausted', 'limit_reached'],
      ['terminated', 'platform'],
    ]);
  });

  it('puts an unknown, missing or inherited-property reason under other', () => {
    expect(taskFailureCategory('container exited 137')).toBe('other');
    expect(taskFailureCategory(null)).toBe('other');
    expect(taskFailureCategory(undefined)).toBe('other');
    expect(taskFailureCategory('')).toBe('other');
    expect(taskFailureCategory('toString')).toBe('other');
  });
});

describe('suggestsReview', () => {
  it('needs the latest three primary outcomes all not achieved', () => {
    expect(SKILL_REVIEW_STREAK).toBe(3);
    expect(suggestsReview(['not_achieved', 'not_achieved', 'not_achieved'])).toBe(true);
    expect(
      suggestsReview(['not_achieved', 'not_achieved', 'not_achieved', 'achieved', 'achieved']),
    ).toBe(true);
  });

  it('does not with fewer than three outcomes, or an achieved one among the latest three', () => {
    expect(suggestsReview([])).toBe(false);
    expect(suggestsReview(['not_achieved', 'not_achieved'])).toBe(false);
    expect(suggestsReview(['achieved', 'not_achieved', 'not_achieved', 'not_achieved'])).toBe(
      false,
    );
    expect(suggestsReview(['not_achieved', 'not_achieved', 'achieved'])).toBe(false);
  });
});
