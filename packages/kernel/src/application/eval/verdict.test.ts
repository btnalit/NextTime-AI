import { describe, expect, it } from 'vitest';
import { type VerdictTrial, differenceLowerBound, measureStage, stageOutcome } from './verdict.js';

/**
 * application/eval/verdict: how a draft evaluation's stage reads its trials (S10 E3-2b) — the
 * order of the checks (contaminated, unmeasured, errored, the stage's rule) and each rule's numbers.
 */

function trial(
  arm: 'baseline' | 'candidate',
  passed: boolean,
  extra: Partial<VerdictTrial> = {},
): VerdictTrial {
  return {
    arm,
    caseId: 'case-a',
    split: 'dev',
    status: 'scored',
    passed,
    error: null,
    reportedCanary: false,
    environmentDigest: 'v1:env',
    ...extra,
  };
}

function times(n: number, make: () => VerdictTrial): VerdictTrial[] {
  return Array.from({ length: n }, make);
}

const decided = (trials: VerdictTrial[], stage: 'regression' | 'mechanism' | 'confirm') =>
  stageOutcome(stage, trials, trials);

describe('differenceLowerBound (Newcombe hybrid score, one-sided)', () => {
  it('matches the hand-computed bound and is null without a try in an arm', () => {
    // 3/3 against 0/3 at 95% one-sided: 1 − √(2 × (1 − 0.5262)²) ≈ 0.330.
    expect(differenceLowerBound(3, 3, 0, 3, 0.95)).toBeCloseTo(0.33, 2);
    // Equal rates: the bound is below 0, and tightens with more tries.
    const few = differenceLowerBound(5, 10, 5, 10, 0.95) as number;
    const many = differenceLowerBound(50, 100, 50, 100, 0.95) as number;
    expect(few).toBeLessThan(0);
    expect(many).toBeLessThan(0);
    expect(many).toBeGreaterThan(few);
    expect(differenceLowerBound(0, 0, 1, 3, 0.95)).toBeNull();
  });
});

describe('stageOutcome', () => {
  it('regression: a case the candidate passed fewer times than the baseline is regressed', () => {
    const kept = [
      trial('baseline', true),
      trial('baseline', false),
      trial('candidate', true),
      trial('candidate', false),
    ];
    expect(decided(kept, 'regression')).toEqual({ kind: 'passed' });
    const lost = [
      trial('baseline', true),
      trial('baseline', true),
      trial('candidate', true),
      trial('candidate', false),
      trial('baseline', false, { caseId: 'case-b' }),
      trial('candidate', true, { caseId: 'case-b' }),
    ];
    expect(decided(lost, 'regression')).toEqual({
      kind: 'decided',
      verdict: 'regressed',
      reason: 'regression_case_lost',
    });
    expect(measureStage('regression', lost)).toEqual({
      stage: 'regression',
      lostCaseIds: ['case-a'],
    });
  });

  it('mechanism: the candidate passes every try and the baseline at most 4 of 10', () => {
    const shown = [
      ...times(10, () => trial('candidate', true)),
      ...times(4, () => trial('baseline', true)),
      ...times(6, () => trial('baseline', false)),
    ];
    expect(decided(shown, 'mechanism')).toEqual({ kind: 'passed' });
    expect(measureStage('mechanism', shown)).toMatchObject({ baselineMaxPassed: 4 });
    const baselineToo = [
      ...times(10, () => trial('candidate', true)),
      ...times(5, () => trial('baseline', true)),
      ...times(5, () => trial('baseline', false)),
    ];
    expect(decided(baselineToo, 'mechanism')).toMatchObject({ verdict: 'refuted' });
    const candidateMissed = [
      ...times(9, () => trial('candidate', true)),
      trial('candidate', false),
      ...times(10, () => trial('baseline', false)),
    ];
    expect(decided(candidateMissed, 'mechanism')).toMatchObject({
      verdict: 'refuted',
      reason: 'mechanism_not_shown',
    });
  });

  it('confirm: worse below −δ, better above 0, non-inferior within δ, and holdout must agree', () => {
    const arm = (a: 'baseline' | 'candidate', passed: number, of: number, split = 'dev') =>
      Array.from({ length: of }, (_, i) =>
        trial(a, i < passed, { split: split as 'dev' | 'holdout' }),
      );
    const holdout = (c: number, b: number) => [
      ...arm('candidate', c, 10, 'holdout'),
      ...arm('baseline', b, 10, 'holdout'),
    ];
    const worse = [...arm('candidate', 5, 30), ...arm('baseline', 20, 30), ...holdout(5, 5)];
    expect(decided(worse, 'confirm')).toMatchObject({ verdict: 'worse', reason: 'below_margin' });

    const better = [...arm('candidate', 28, 30), ...arm('baseline', 10, 30), ...holdout(8, 5)];
    expect(decided(better, 'confirm')).toMatchObject({
      verdict: 'better',
      reason: 'above_baseline',
    });
    // The same dev numbers, holdout pointing the other way.
    const disagrees = [...arm('candidate', 28, 30), ...arm('baseline', 10, 30), ...holdout(4, 6)];
    expect(decided(disagrees, 'confirm')).toMatchObject({
      verdict: 'inconclusive',
      reason: 'holdout_disagrees',
    });
    const noHoldout = [...arm('candidate', 28, 30), ...arm('baseline', 10, 30)];
    expect(decided(noHoldout, 'confirm')).toMatchObject({ reason: 'no_holdout_cases' });

    const level = [...arm('candidate', 290, 300), ...arm('baseline', 290, 300), ...holdout(9, 9)];
    expect(decided(level, 'confirm')).toMatchObject({
      verdict: 'non_inferior',
      reason: 'within_margin',
    });
    const fewTries = [...arm('candidate', 2, 3), ...arm('baseline', 2, 3), ...holdout(2, 2)];
    expect(decided(fewTries, 'confirm')).toMatchObject({
      verdict: 'inconclusive',
      reason: 'too_few_trials',
    });
    expect(measureStage('confirm', better)).toMatchObject({
      stage: 'confirm',
      delta: 0.1,
      confidence: 0.95,
      dev: { candidatePassed: 28, candidateTrials: 30, baselinePassed: 10, baselineTrials: 30 },
      holdout: { candidatePassed: 8, baselinePassed: 5 },
    });
  });

  it('contamination, then environments, then errored trials come before any rule', () => {
    const base = [trial('baseline', true), trial('candidate', true)];
    expect(
      decided(
        [...base, trial('candidate', false, { status: 'errored', error: 'withheld' })],
        'regression',
      ),
    ).toMatchObject({ verdict: 'contaminated', reason: 'content_withheld' });
    expect(
      decided([...base, trial('candidate', true, { reportedCanary: true })], 'regression'),
    ).toMatchObject({ verdict: 'contaminated', reason: 'canary_reported' });
    expect(
      decided([...base, trial('candidate', true, { environmentDigest: null })], 'regression'),
    ).toMatchObject({ verdict: 'unmeasured', reason: 'environment_unknown' });
    // Environments are compared across the evaluation, not the stage alone.
    const earlier = [trial('baseline', true, { environmentDigest: 'v1:other' })];
    expect(stageOutcome('regression', base, [...earlier, ...base])).toMatchObject({
      verdict: 'unmeasured',
      reason: 'environment_differs',
    });
    // An errored trial has no environment to compare; more than a quarter errored proves nothing.
    const errored = (n: number) =>
      times(n, () =>
        trial('candidate', false, {
          status: 'errored',
          error: 'spawn_failed',
          environmentDigest: null,
        }),
      );
    expect(
      decided(
        [
          ...times(3, () => trial('baseline', true)),
          ...times(3, () => trial('candidate', true)),
          ...errored(3),
        ],
        'regression',
      ),
    ).toMatchObject({ verdict: 'inconclusive', reason: 'errored_trials' });
    // Exactly a quarter is not more than a quarter: errored counts as not passed.
    expect(
      decided(
        [
          ...times(3, () => trial('baseline', false)),
          ...times(3, () => trial('candidate', true)),
          ...errored(2),
        ],
        'regression',
      ),
    ).toEqual({ kind: 'passed' });
  });
});
