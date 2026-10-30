import { describe, expect, it } from 'vitest';
import { type VerdictTrial, differenceLowerBound, measureStage, stageOutcome } from './verdict.js';

/**
 * application/eval/verdict: how a draft evaluation's stage reads its trials (S10 E3-2b) — the
 * order of the checks (contaminated, unmeasured, trials without an outcome, the stage's rule), each
 * rule's numbers, and how trials without an outcome leave a verdict open.
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
      unsettledCaseIds: [],
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
    // An errored trial has no environment to compare; more than a quarter of an arm's trials
    // without an outcome proves nothing — counted per arm, so one arm's losses are not diluted.
    const lostTrials = (n: number, arm: 'baseline' | 'candidate' = 'candidate') =>
      times(n, () =>
        trial(arm, false, { status: 'errored', error: 'spawn_failed', environmentDigest: null }),
      );
    expect(
      decided(
        [
          ...times(9, () => trial('baseline', true)),
          ...times(6, () => trial('candidate', true)),
          ...lostTrials(3),
        ],
        'regression',
      ),
    ).toMatchObject({ verdict: 'inconclusive', reason: 'errored_trials' });
    // Exactly a quarter of the arm is not more than a quarter; the baseline failed both tries, so
    // the candidate holds the case whichever way its lost try would have gone.
    expect(
      decided(
        [
          ...times(4, () => trial('baseline', false)),
          ...times(3, () => trial('candidate', true)),
          ...lostTrials(1),
        ],
        'regression',
      ),
    ).toEqual({ kind: 'passed' });
  });

  // #833 review (#493 P2-2): a trial that could not start, was lost or crashed says nothing of the
  // Skill — a verdict holds only whichever way it would have gone.
  describe('trials without an outcome', () => {
    const lost = (arm: 'baseline' | 'candidate', extra: Partial<VerdictTrial> = {}) =>
      trial(arm, false, {
        status: 'errored',
        error: 'spawn_failed',
        environmentDigest: null,
        ...extra,
      });

    it('regression: one candidate try that did not start leaves the case unsettled, not lost', () => {
      // 4 cases × 2 tries, the baseline passes all; the candidate passes all but one that did not
      // start (1 of 8 in its arm).
      const cases = ['a', 'b', 'c', 'd'];
      const trials = cases.flatMap((caseId) => [
        trial('baseline', true, { caseId }),
        trial('baseline', true, { caseId }),
        trial('candidate', true, { caseId }),
        caseId === 'a' ? lost('candidate', { caseId }) : trial('candidate', true, { caseId }),
      ]);
      expect(decided(trials, 'regression')).toEqual({
        kind: 'decided',
        verdict: 'inconclusive',
        reason: 'errored_trials',
      });
      expect(measureStage('regression', trials)).toEqual({
        stage: 'regression',
        lostCaseIds: [],
        unsettledCaseIds: ['a'],
      });
      // The same try timing out is the candidate's own failure: the case is lost.
      const timedOut = trials.map((t) =>
        t.status === 'errored' ? { ...t, error: 'timeout', environmentDigest: 'v1:env' } : t,
      );
      expect(decided(timedOut, 'regression')).toMatchObject({ verdict: 'regressed' });
      // A case the candidate loses even had its lost try passed is lost.
      const clearlyLost = [
        trial('baseline', true),
        trial('baseline', true),
        trial('candidate', false),
        lost('candidate'),
        ...times(6, () => trial('baseline', true, { caseId: 'b' })),
        ...times(6, () => trial('candidate', true, { caseId: 'b' })),
      ];
      expect(decided(clearlyLost, 'regression')).toMatchObject({ verdict: 'regressed' });
      // A lost baseline try could tip a case the candidate only matched.
      const baselineLost = [
        trial('baseline', true),
        lost('baseline'),
        trial('candidate', true),
        trial('candidate', false),
        ...times(6, () => trial('baseline', true, { caseId: 'b' })),
        ...times(6, () => trial('candidate', true, { caseId: 'b' })),
      ];
      expect(decided(baselineLost, 'regression')).toMatchObject({
        verdict: 'inconclusive',
        reason: 'errored_trials',
      });
    });

    it('mechanism: a candidate try that did not start is not a refutation', () => {
      const oneLost = [
        ...times(9, () => trial('candidate', true)),
        lost('candidate'),
        ...times(10, () => trial('baseline', false)),
      ];
      expect(decided(oneLost, 'mechanism')).toEqual({
        kind: 'decided',
        verdict: 'inconclusive',
        reason: 'errored_trials',
      });
      expect(measureStage('mechanism', oneLost)).toMatchObject({
        candidatePassed: 9,
        candidateTrials: 9,
        candidateNoOutcome: 1,
        baselineMaxPassed: 4,
      });
      // Its own failure (no report) refutes it.
      const noReport = [
        ...times(9, () => trial('candidate', true)),
        lost('candidate', { error: 'no_result' }),
        ...times(10, () => trial('baseline', false)),
      ];
      expect(decided(noReport, 'mechanism')).toMatchObject({ verdict: 'refuted' });
      // Lost baseline tries that could have passed past the limit leave it open.
      const baselineOpen = [
        ...times(10, () => trial('candidate', true)),
        ...times(4, () => trial('baseline', true)),
        ...times(2, () => lost('baseline')),
        ...times(4, () => trial('baseline', false)),
      ];
      expect(decided(baselineOpen, 'mechanism')).toMatchObject({ reason: 'errored_trials' });
    });

    it('confirm: lost trials leave the rates, so losses in the baseline alone cannot read as better', () => {
      // Both arms pass everything they ran. 14 of 72 trials did not start, all in the baseline
      // (14 of 36 — over a quarter of that arm, though under a quarter of the stage).
      const arm = (a: 'baseline' | 'candidate', passed: number, none: number, split = 'dev') => [
        ...times(passed, () => trial(a, true, { split: split as 'dev' | 'holdout' })),
        ...times(none, () => lost(a, { split: split as 'dev' | 'holdout' })),
      ];
      const skewed = [
        ...arm('candidate', 30, 0),
        ...arm('baseline', 16, 14),
        ...arm('candidate', 6, 0, 'holdout'),
        ...arm('baseline', 6, 0, 'holdout'),
      ];
      expect(decided(skewed, 'confirm')).toEqual({
        kind: 'decided',
        verdict: 'inconclusive',
        reason: 'errored_trials',
      });
      // Under the arm's limit, the lost trials are left out of the rate rather than counted as
      // failures: equal arms read as equal.
      const fewLost = [
        ...arm('candidate', 30, 0),
        ...arm('baseline', 24, 6),
        ...arm('candidate', 6, 0, 'holdout'),
        ...arm('baseline', 6, 0, 'holdout'),
      ];
      expect(decided(fewLost, 'confirm')).not.toMatchObject({ verdict: 'better' });
      expect(measureStage('confirm', fewLost)).toMatchObject({
        dev: {
          candidatePassed: 30,
          candidateTrials: 30,
          candidateNoOutcome: 0,
          baselinePassed: 24,
          baselineTrials: 24,
          baselineNoOutcome: 6,
          difference: 0,
        },
      });
    });
  });
});
