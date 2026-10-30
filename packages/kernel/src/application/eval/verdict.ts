import {
  DRAFT_EVALUATION_RULES,
  type DraftEvaluationMeasureWire,
  type DraftEvaluationReason,
  type DraftEvaluationSplitMeasureWire,
  type DraftEvaluationStageName,
  type DraftEvaluationVerdict,
  type EvalArm,
  type EvalCaseSplit,
  mechanismBaselineMaxPassed,
} from '@nexttime/shared';

/**
 * application/eval/verdict: how a draft evaluation's stage reads its trials (S10 E3-2b;
 * docs/s10-evolution-plan-2026-10-04.md §5.5 怎么判). Pure: the trials in, the stage's measure and
 * outcome out — the runner records the outcome when the stage's run finishes, and every read
 * recomputes the measure from the same trials, so what the console shows is what decided.
 *
 * In order, the first that holds ends the evaluation:
 *   1. `contaminated` — a trial's Worker was withheld evaluation content at its start
 *      (`content_withheld`), or reported a suite's canary (`canary_reported`);
 *   2. `unmeasured` — a scored trial's environment is unknown (`environment_unknown`), or the
 *      evaluation's scored trials ran in more than one (`environment_differs`, I-E2: the two arms
 *      are compared only within one environment);
 *   3. `inconclusive`/`errored_trials` — more than a quarter of the stage's trials errored;
 *   4. the stage's own rule (regression, mechanism, confirm — `@nexttime/shared`
 *      draft-evaluation.ts holds their numbers). An errored trial counts as not passed, in either
 *      arm.
 * A stage that passes its rule moves the evaluation on; confirm always decides.
 */

/** One trial as the verdict reads it. */
export interface VerdictTrial {
  readonly arm: EvalArm;
  readonly caseId: string;
  readonly split: EvalCaseSplit;
  readonly status: 'queued' | 'running' | 'scored' | 'errored';
  readonly passed: boolean;
  readonly error: string | null;
  /** Whether what it reported carries one of the evaluation's suite's canaries. */
  readonly reportedCanary: boolean;
  readonly environmentDigest: string | null;
}

export type StageOutcome =
  | { readonly kind: 'passed' }
  | {
      readonly kind: 'decided';
      readonly verdict: DraftEvaluationVerdict;
      readonly reason: DraftEvaluationReason;
    };

/** z for a one-sided bound at `confidence` (0.95 → 1.6449). Only the confidence the rules name. */
function oneSidedZ(confidence: number): number {
  if (Math.abs(confidence - 0.95) < 1e-9) return 1.6448536269514722;
  if (Math.abs(confidence - 0.9) < 1e-9) return 1.2815515655446004;
  if (Math.abs(confidence - 0.975) < 1e-9) return 1.959963984540054;
  throw new Error(`verdict: no z for confidence ${confidence}`);
}

/** Wilson score interval of `passed` out of `trials` at `z`. */
function wilson(passed: number, trials: number, z: number): { lower: number; upper: number } {
  const p = passed / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/**
 * The one-sided lower bound of p₁ − p₂ (candidate − baseline) at `confidence`: Newcombe's hybrid
 * score interval (Newcombe 1998, method 10) — Wilson intervals of each rate, combined. Trials are
 * taken as independent (a case tried several times is not, so the bound is optimistic when cases
 * differ much; the holdout check is the second look). `null` without a trial in either arm.
 */
export function differenceLowerBound(
  candidatePassed: number,
  candidateTrials: number,
  baselinePassed: number,
  baselineTrials: number,
  confidence: number,
): number | null {
  if (candidateTrials === 0 || baselineTrials === 0) return null;
  const z = oneSidedZ(confidence);
  const p1 = candidatePassed / candidateTrials;
  const p2 = baselinePassed / baselineTrials;
  const w1 = wilson(candidatePassed, candidateTrials, z);
  const w2 = wilson(baselinePassed, baselineTrials, z);
  return p1 - p2 - Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2);
}

function splitMeasure(
  trials: readonly VerdictTrial[],
  split: EvalCaseSplit,
): DraftEvaluationSplitMeasureWire {
  const of = (arm: EvalArm) => trials.filter((t) => t.arm === arm && t.split === split);
  const candidate = of('candidate');
  const baseline = of('baseline');
  const candidatePassed = candidate.filter((t) => t.passed).length;
  const baselinePassed = baseline.filter((t) => t.passed).length;
  const measurable = candidate.length > 0 && baseline.length > 0;
  return {
    candidatePassed,
    candidateTrials: candidate.length,
    baselinePassed,
    baselineTrials: baseline.length,
    difference: measurable
      ? candidatePassed / candidate.length - baselinePassed / baseline.length
      : null,
    lowerBound: differenceLowerBound(
      candidatePassed,
      candidate.length,
      baselinePassed,
      baseline.length,
      DRAFT_EVALUATION_RULES.confidence,
    ),
  };
}

/** What a stage measured, from its ended trials. */
export function measureStage(
  stage: DraftEvaluationStageName,
  trials: readonly VerdictTrial[],
): DraftEvaluationMeasureWire {
  if (stage === 'regression') {
    const passes = new Map<string, { baseline: number; candidate: number }>();
    for (const trial of trials) {
      const entry = passes.get(trial.caseId) ?? { baseline: 0, candidate: 0 };
      if (trial.passed) entry[trial.arm] += 1;
      passes.set(trial.caseId, entry);
    }
    return {
      stage,
      lostCaseIds: [...passes.entries()]
        .filter(([, entry]) => entry.candidate < entry.baseline)
        .map(([caseId]) => caseId),
    };
  }
  if (stage === 'mechanism') {
    const candidate = trials.filter((t) => t.arm === 'candidate');
    const baseline = trials.filter((t) => t.arm === 'baseline');
    return {
      stage,
      candidatePassed: candidate.filter((t) => t.passed).length,
      candidateTrials: candidate.length,
      baselinePassed: baseline.filter((t) => t.passed).length,
      baselineTrials: baseline.length,
      baselineMaxPassed: mechanismBaselineMaxPassed(baseline.length),
    };
  }
  const hasHoldout = trials.some((t) => t.split === 'holdout');
  return {
    stage,
    delta: DRAFT_EVALUATION_RULES.delta,
    confidence: DRAFT_EVALUATION_RULES.confidence,
    dev: splitMeasure(trials, 'dev'),
    holdout: hasHoldout ? splitMeasure(trials, 'holdout') : null,
  };
}

/** How the stage's rule reads its measure. */
function ruleOutcome(measure: DraftEvaluationMeasureWire): StageOutcome {
  if (measure.stage === 'regression') {
    return measure.lostCaseIds.length > 0
      ? { kind: 'decided', verdict: 'regressed', reason: 'regression_case_lost' }
      : { kind: 'passed' };
  }
  if (measure.stage === 'mechanism') {
    const shown =
      measure.candidateTrials > 0 &&
      measure.candidatePassed === measure.candidateTrials &&
      measure.baselinePassed <= measure.baselineMaxPassed;
    return shown
      ? { kind: 'passed' }
      : { kind: 'decided', verdict: 'refuted', reason: 'mechanism_not_shown' };
  }
  const { dev, holdout, delta } = measure;
  if (dev.difference === null || dev.lowerBound === null) {
    return { kind: 'decided', verdict: 'inconclusive', reason: 'too_few_trials' };
  }
  if (dev.difference < -delta) {
    return { kind: 'decided', verdict: 'worse', reason: 'below_margin' };
  }
  const leaning: 'better' | 'non_inferior' | null =
    dev.lowerBound > 0 ? 'better' : dev.lowerBound > -delta ? 'non_inferior' : null;
  if (leaning === null) {
    return { kind: 'decided', verdict: 'inconclusive', reason: 'too_few_trials' };
  }
  if (holdout === null || holdout.difference === null) {
    return { kind: 'decided', verdict: 'inconclusive', reason: 'no_holdout_cases' };
  }
  const agrees = leaning === 'better' ? holdout.difference >= 0 : holdout.difference >= -delta;
  if (!agrees) {
    return { kind: 'decided', verdict: 'inconclusive', reason: 'holdout_disagrees' };
  }
  return leaning === 'better'
    ? { kind: 'decided', verdict: 'better', reason: 'above_baseline' }
    : { kind: 'decided', verdict: 'non_inferior', reason: 'within_margin' };
}

/**
 * The outcome of a stage whose trials have all ended. `evaluationTrials` is every ended trial of
 * the evaluation so far, this stage's included — environments are compared across all of them.
 */
export function stageOutcome(
  stage: DraftEvaluationStageName,
  stageTrials: readonly VerdictTrial[],
  evaluationTrials: readonly VerdictTrial[],
): StageOutcome {
  if (stageTrials.some((t) => t.status === 'errored' && t.error === 'withheld')) {
    return { kind: 'decided', verdict: 'contaminated', reason: 'content_withheld' };
  }
  if (stageTrials.some((t) => t.reportedCanary)) {
    return { kind: 'decided', verdict: 'contaminated', reason: 'canary_reported' };
  }
  const scored = evaluationTrials.filter((t) => t.status === 'scored');
  if (scored.some((t) => t.environmentDigest === null)) {
    return { kind: 'decided', verdict: 'unmeasured', reason: 'environment_unknown' };
  }
  if (new Set(scored.map((t) => t.environmentDigest)).size > 1) {
    return { kind: 'decided', verdict: 'unmeasured', reason: 'environment_differs' };
  }
  const errored = stageTrials.filter((t) => t.status === 'errored').length;
  if (
    stageTrials.length > 0 &&
    errored / stageTrials.length > DRAFT_EVALUATION_RULES.maxErroredShare
  ) {
    return { kind: 'decided', verdict: 'inconclusive', reason: 'errored_trials' };
  }
  return ruleOutcome(measureStage(stage, stageTrials));
}
