import type { GoalPlan } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { planHints, roundAcceptance } from './plan.js';
import { REVIEW_SEALED, sameModelOf, sealReviews, unsealPlannerPlan } from './review.js';

/**
 * Unit tests for S11 GO18's pure rules (`review.ts`, `plan.ts`): how a plan reads with its reviews
 * sealed for the goal planner (F5), what a planner's proposal stands for once unsealed (the
 * `[redacted]` rule, independent review N7), the same-model flag (N5), and what a plan checked by
 * reviews alone tells whoever confirms it (N4).
 */

const WORKER = { definitionId: '6f1c2d0e-5b7a-4c3e-9d21-0a1b2c3d4e5f', version: 1 };
const REVIEW = {
  kind: 'review' as const,
  key: 'quality',
  subjects: ['draft'],
  criteria: [
    { key: 'clear', description: 'A reader new to the topic follows it', weight: 3 },
    { key: 'complete', description: 'Every section the outline names is there', weight: 1 },
  ],
  passAt: 75,
};
const OBSERVE = {
  kind: 'observe_predicate' as const,
  key: 'published',
  check: {
    gatekeeperId: '0d7e6a51-2c34-4b8f-9e10-3f2a1b0c9d8e',
    operation: 'site.page',
    params: { slug: 'report' },
    expect: { path: 'status', op: 'eq' as const, value: 'live' },
  },
};
const PLAN: GoalPlan = {
  steps: [{ key: 'draft', worker: WORKER, input: { topic: 'q3' }, maxAttempts: 1 }],
  acceptance: [OBSERVE, REVIEW],
};

describe('sealReviews (S11 GO18 F5)', () => {
  it('replaces each review’s criteria and pass line, and keeps its key, subjects and every other check', () => {
    const sealed = sealReviews(PLAN);
    expect(sealed.acceptance).toEqual([
      OBSERVE,
      { ...REVIEW, criteria: REVIEW_SEALED, passAt: REVIEW_SEALED },
    ]);
    expect(JSON.stringify(sealed)).not.toContain('A reader new to the topic');
    // The plan it was given is left as it is.
    expect(PLAN.acceptance?.[1]).toBe(REVIEW);
  });

  it('leaves a plan with no review — or anything that is not a plan — as it is', () => {
    const plain = { ...PLAN, acceptance: [OBSERVE] };
    expect(sealReviews(plain)).toBe(plain);
    expect(sealReviews(null)).toBeNull();
    expect(sealReviews('cut short')).toBe('cut short');
  });
});

describe('unsealPlannerPlan (S11 GO18 F5, independent review N7)', () => {
  const read = sealReviews(PLAN);

  it('a sealed review sent back exactly as read is the stored one', () => {
    const proposed = { ...read, steps: [{ ...PLAN.steps[0], maxAttempts: 2 }] };
    const { plan, problems } = unsealPlannerPlan(PLAN, proposed);
    expect(problems).toEqual([]);
    expect((plan as GoalPlan).acceptance).toEqual([OBSERVE, REVIEW]);
  });

  it('a review left out stays out (a change to the goal’s acceptance, for the requester)', () => {
    const { plan, problems } = unsealPlannerPlan(PLAN, { ...read, acceptance: [OBSERVE] });
    expect(problems).toEqual([]);
    expect((plan as GoalPlan).acceptance).toEqual([OBSERVE]);
  });

  it('refuses a sealed review changed in any way, or under a key the plan has no review of', () => {
    const sealedReview = read.acceptance?.[1] as Record<string, unknown>;
    for (const changed of [
      { ...sealedReview, subjects: ['draft', 'other'] },
      { ...sealedReview, passAt: 10 },
      { ...sealedReview, model: 'some-model' },
      { ...sealedReview, key: 'renamed' },
    ]) {
      const { problems } = unsealPlannerPlan(PLAN, { ...read, acceptance: [OBSERVE, changed] });
      expect(problems).toEqual([
        {
          path: 'output.plan.acceptance.1',
          message: expect.stringContaining('the goal planner writes none'),
        },
      ]);
    }
  });

  it('refuses a review the planner writes itself — whole criteria included', () => {
    const own = { ...REVIEW, key: 'mine', passAt: 10 };
    const { problems } = unsealPlannerPlan(PLAN, {
      ...read,
      acceptance: [...(read.acceptance ?? []), own],
    });
    expect(problems.map((problem) => problem.path)).toEqual(['output.plan.acceptance.2']);
    // The stored review copied whole (the planner never reads it) is no different.
    const copied = unsealPlannerPlan(PLAN, { ...read, acceptance: [OBSERVE, REVIEW] });
    expect(copied.problems.map((problem) => problem.path)).toEqual(['output.plan.acceptance.1']);
  });

  it('passes anything that is not a plan through for the plan checks to refuse', () => {
    expect(unsealPlannerPlan(PLAN, 'not a plan')).toEqual({ plan: 'not a plan', problems: [] });
    expect(unsealPlannerPlan(PLAN, { steps: [] })).toEqual({ plan: { steps: [] }, problems: [] });
  });
});

describe('sameModelOf (S11 GO18, independent review N5)', () => {
  it('true when a reviewed step ran on the reviewer’s model — two defaults count as the same', () => {
    expect(sameModelOf('m-1', [{ model: 'm-2' }, { model: 'm-1' }])).toBe(true);
    expect(sameModelOf(null, [{ model: null }])).toBe(true);
  });

  it('null when one ran on the default and the other names a model — the default may be it', () => {
    expect(sameModelOf(null, [{ model: 'm-1' }])).toBeNull();
    expect(sameModelOf('m-1', [{ model: null }, { model: 'm-2' }])).toBeNull();
  });

  it('false when every model is named and none is the reviewer’s', () => {
    expect(sameModelOf('m-1', [{ model: 'm-2' }, { model: 'm-3' }])).toBe(false);
  });
});

describe('a plan checked by reviews (S11 GO18, independent review N4)', () => {
  const STATEMENT = 'publish the quarterly report';
  const asked = { kind: 'requester_confirm' as const, key: 'ok', prompt: 'Reads well?' };

  it('reviews alone: the round is the reviews, and the plan says the goal is achieved on a model’s scores', () => {
    const reviewsOnly = { ...PLAN, acceptance: [REVIEW] };
    expect(roundAcceptance(reviewsOnly, STATEMENT)).toEqual([REVIEW]);
    expect(planHints(reviewsOnly)).toEqual([
      { code: 'review_only', message: expect.stringContaining('on a model’s scores alone') },
    ]);
  });

  it('with a confirmation, it is achieved on the requester’s word; with a check the platform makes, no hint', () => {
    const confirmed = { ...PLAN, acceptance: [REVIEW, asked] };
    expect(roundAcceptance(confirmed, STATEMENT)).toEqual([REVIEW, asked]);
    expect(planHints(confirmed).map((hint) => hint.code)).toEqual(['requester_confirm_only']);
    expect(roundAcceptance(PLAN, STATEMENT)).toEqual([OBSERVE, REVIEW]);
    expect(planHints(PLAN)).toEqual([]);
  });
});
