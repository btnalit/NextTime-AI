import { REVIEW_SCORE_MAX, REVIEW_WEIGHT_MAX, reviewDerivation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  planReviewModelMatch,
  reviewMaxPoints,
  reviewPointsText,
  reviewPointsToPass,
} from './goal-review.js';
import type { Translate } from './i18n.js';

const t: Translate = (zhText) => zhText;

describe('lib/goal-review (S11 GO18b)', () => {
  it('says exactly the points the platform passes at — never fewer, never more — for every line and every weight', () => {
    for (let weight = 1; weight <= REVIEW_WEIGHT_MAX; weight += 1) {
      const criteria = [
        { key: 'a', description: 'A', weight },
        { key: 'b', description: 'B', weight: 1 },
      ];
      const max = reviewMaxPoints(criteria);
      expect(max).toBe(REVIEW_SCORE_MAX * (weight + 1));
      for (let passAt = 1; passAt <= 100; passAt += 1) {
        const needed = reviewPointsToPass(passAt, max);
        // Every way the two criteria can score: the kernel's verdict passes exactly from `needed`.
        for (let a = 0; a <= REVIEW_SCORE_MAX; a += 1) {
          for (let b = 0; b <= REVIEW_SCORE_MAX; b += 1) {
            const { points, verdict } = reviewDerivation(criteria, passAt, [
              { criterion: 'a', score: a, reason: 'r' },
              { criterion: 'b', score: b, reason: 'r' },
            ]);
            expect(verdict === 'passed', `${passAt}% ${a}×${weight}+${b}`).toBe(points >= needed);
          }
        }
      }
    }
  });

  it('reads the points against the line, rounding the percentage down so it never looks like a pass it is not', () => {
    expect(reviewPointsText({ points: 11, maxPoints: 16, passAt: 75 }, t)).toBe(
      '得分 11 / 16（68%），至少 12 分（75%）通过',
    );
    expect(reviewPointsText({ points: 12, maxPoints: 16, passAt: 75 }, t)).toBe(
      '得分 12 / 16（75%），至少 12 分（75%）通过',
    );
  });

  it('tells a reviewer that names the model of a step it reviews, one that names another, and one the plan cannot tell apart', () => {
    const plan = {
      steps: [
        { key: 'draft', worker: { definitionId: 'w', version: 1 }, spec: { model: 'model-a' } },
        { key: 'polish', worker: { definitionId: 'w', version: 1 } },
      ],
    };
    expect(planReviewModelMatch({ subjects: ['draft'], model: 'model-a' }, plan)).toBe('same');
    expect(planReviewModelMatch({ subjects: ['draft', 'polish'], model: 'model-a' }, plan)).toBe(
      'same',
    );
    expect(planReviewModelMatch({ subjects: ['draft'], model: 'model-b' }, plan)).toBe('different');
    // `polish` runs on its Worker's model, which the plan does not show.
    expect(planReviewModelMatch({ subjects: ['draft', 'polish'], model: 'model-b' }, plan)).toBe(
      'unknown',
    );
    // The review takes the requester's model.
    expect(planReviewModelMatch({ subjects: ['draft'] }, plan)).toBe('unknown');
  });
});
