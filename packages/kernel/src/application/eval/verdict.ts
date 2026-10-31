import {
  DRAFT_EVALUATION_RULES,
  DRAFT_EVALUATION_STAGE_VALUES,
  type DraftEvaluationDevVerdict,
  type DraftEvaluationMeasureWire,
  type DraftEvaluationReason,
  type DraftEvaluationSplitMeasureWire,
  type DraftEvaluationStageName,
  type DraftEvaluationVerdict,
  type EvalArm,
  type EvalCaseSplit,
  mechanismBaselineMaxPassed,
  trialHasOutcome,
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
 *   3. `inconclusive`/`errored_trials` — more than a quarter of either arm's trials in the stage
 *      have no outcome (`trialHasOutcome`: it could not start, was lost, terminated or crashed);
 *   4. the stage's own rule (regression, mechanism, confirm — `@nexttime/shared`
 *      draft-evaluation.ts holds their numbers). A trial errored by its own Worker (timeout, no
 *      report, token budget) counts as not passed. A trial without an outcome could have gone
 *      either way: regression and mechanism decide only what holds whichever way it would have
 *      gone, else `inconclusive`/`errored_trials` (#833 review: one container that did not start
 *      must not read as a regression); confirm leaves it out of its rates.
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

/** How a verdict reads one ended trial: passed, not passed, or no outcome. */
type TrialReading = 'passed' | 'failed' | 'none';

function readingOf(trial: VerdictTrial): TrialReading {
  if (!trialHasOutcome(trial)) return 'none';
  return trial.status === 'scored' && trial.passed ? 'passed' : 'failed';
}

/** Passes, failures and trials without an outcome among `trials`. */
function count(trials: readonly VerdictTrial[]): {
  passed: number;
  failed: number;
  none: number;
} {
  const counts = { passed: 0, failed: 0, none: 0 };
  for (const trial of trials) counts[readingOf(trial)] += 1;
  return counts;
}

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

/** One split of the confirm stage, over the trials with an outcome: those without one are left
 *  out of the rates (counted apart), so trials lost in one arm cannot tilt the difference. */
function splitMeasure(
  trials: readonly VerdictTrial[],
  split: EvalCaseSplit,
): DraftEvaluationSplitMeasureWire {
  const of = (arm: EvalArm) => count(trials.filter((t) => t.arm === arm && t.split === split));
  const candidate = of('candidate');
  const baseline = of('baseline');
  const candidateTrials = candidate.passed + candidate.failed;
  const baselineTrials = baseline.passed + baseline.failed;
  const measurable = candidateTrials > 0 && baselineTrials > 0;
  return {
    candidatePassed: candidate.passed,
    candidateTrials,
    candidateNoOutcome: candidate.none,
    baselinePassed: baseline.passed,
    baselineTrials,
    baselineNoOutcome: baseline.none,
    difference: measurable
      ? candidate.passed / candidateTrials - baseline.passed / baselineTrials
      : null,
    lowerBound: differenceLowerBound(
      candidate.passed,
      candidateTrials,
      baseline.passed,
      baselineTrials,
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
    const byCase = new Map<string, { baseline: VerdictTrial[]; candidate: VerdictTrial[] }>();
    for (const trial of trials) {
      const entry = byCase.get(trial.caseId) ?? { baseline: [], candidate: [] };
      entry[trial.arm].push(trial);
      byCase.set(trial.caseId, entry);
    }
    const lostCaseIds: string[] = [];
    const unsettledCaseIds: string[] = [];
    for (const [caseId, entry] of byCase) {
      const candidate = count(entry.candidate);
      const baseline = count(entry.baseline);
      // Lost even had each candidate try without an outcome passed; held even had each baseline
      // one passed; anything between is the trials without an outcome's to tip.
      if (candidate.passed + candidate.none < baseline.passed) lostCaseIds.push(caseId);
      else if (candidate.passed < baseline.passed + baseline.none) unsettledCaseIds.push(caseId);
    }
    return { stage, lostCaseIds, unsettledCaseIds };
  }
  if (stage === 'mechanism') {
    const candidate = count(trials.filter((t) => t.arm === 'candidate'));
    const baseline = count(trials.filter((t) => t.arm === 'baseline'));
    return {
      stage,
      candidatePassed: candidate.passed,
      candidateTrials: candidate.passed + candidate.failed,
      candidateNoOutcome: candidate.none,
      baselinePassed: baseline.passed,
      baselineTrials: baseline.passed + baseline.failed,
      baselineNoOutcome: baseline.none,
      // The limit is of every try the arm ran, with an outcome or not.
      baselineMaxPassed: mechanismBaselineMaxPassed(
        baseline.passed + baseline.failed + baseline.none,
      ),
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

/** What the confirmation's `dev` split says alone: below the baseline by more than δ is `worse`;
 *  the difference's lower bound above 0 leans `better`, above −δ `non_inferior`; anything else —
 *  no try in an arm, or a bound not above −δ — does not decide. The rule below adds the holdout
 *  check to a leaning; {@link devVerdictOf} gives it as it is. */
function confirmOnDev(
  dev: DraftEvaluationSplitMeasureWire,
  delta: number,
): 'worse' | 'better' | 'non_inferior' | 'inconclusive' {
  if (dev.difference === null || dev.lowerBound === null) return 'inconclusive';
  if (dev.difference < -delta) return 'worse';
  if (dev.lowerBound > 0) return 'better';
  return dev.lowerBound > -delta ? 'non_inferior' : 'inconclusive';
}

/** Whether more than a quarter of either arm's `trials` have no outcome. */
function tooManyWithoutOutcome(trials: readonly VerdictTrial[]): boolean {
  for (const arm of ['baseline', 'candidate'] as const) {
    const armTrials = trials.filter((t) => t.arm === arm);
    const none = count(armTrials).none;
    if (armTrials.length > 0 && none / armTrials.length > DRAFT_EVALUATION_RULES.maxErroredShare) {
      return true;
    }
  }
  return false;
}

/** How the stage's rule reads its measure. */
function ruleOutcome(measure: DraftEvaluationMeasureWire): StageOutcome {
  if (measure.stage === 'regression') {
    if (measure.lostCaseIds.length > 0) {
      return { kind: 'decided', verdict: 'regressed', reason: 'regression_case_lost' };
    }
    return measure.unsettledCaseIds.length > 0
      ? { kind: 'decided', verdict: 'inconclusive', reason: 'errored_trials' }
      : { kind: 'passed' };
  }
  if (measure.stage === 'mechanism') {
    if (measure.candidateTrials + measure.candidateNoOutcome === 0) {
      return { kind: 'decided', verdict: 'inconclusive', reason: 'too_few_trials' };
    }
    // Not shown whichever way the trials without an outcome would have gone: the candidate failed
    // a try, or the baseline passed more than it may even with each of its others failed.
    if (
      measure.candidatePassed < measure.candidateTrials ||
      measure.baselinePassed > measure.baselineMaxPassed
    ) {
      return { kind: 'decided', verdict: 'refuted', reason: 'mechanism_not_shown' };
    }
    const shown =
      measure.candidateNoOutcome === 0 &&
      measure.baselinePassed + measure.baselineNoOutcome <= measure.baselineMaxPassed;
    return shown
      ? { kind: 'passed' }
      : { kind: 'decided', verdict: 'inconclusive', reason: 'errored_trials' };
  }
  const { dev, holdout, delta } = measure;
  const leaning = confirmOnDev(dev, delta);
  if (leaning === 'worse') {
    return { kind: 'decided', verdict: 'worse', reason: 'below_margin' };
  }
  if (leaning === 'inconclusive') {
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
  if (tooManyWithoutOutcome(stageTrials)) {
    return { kind: 'decided', verdict: 'inconclusive', reason: 'errored_trials' };
  }
  return ruleOutcome(measureStage(stage, stageTrials));
}

/**
 * What the draft's proposer is told of an evaluation that finished with `verdict` (S10 E3-3; §3.3
 * I-E4, §5.5 封闭 — `@nexttime/shared` wire/eval.ts `DraftEvaluationDevVerdict` says what it
 * means): the stages it ran, read again in order on their `dev` trials alone, by the rules above —
 * more than a quarter of an arm's without an outcome, then the stage's rule — with the
 * confirmation read on `dev` as it is ({@link confirmOnDev}), no holdout check. A stage with no
 * `dev` trial (not run, skipped, or every case held out) is passed over; reaching the end without
 * a confirmation read on `dev` does not decide. Nothing a `holdout` trial did enters: a held-out
 * case lost, the holdout disagreeing, a suite with no holdout case — each reads as the `dev` cases
 * say, or `inconclusive` where they say nothing (the same as a budget that ended it early).
 *
 * The evaluation's own `contaminated` is `inconclusive` here: it means the draft carried a suite's
 * canary or a held-out case's text, and saying so would answer a probe for one. `unmeasured` (its
 * trials did not run in one known environment, I-E2) is `unmeasured`: nothing about the cases.
 *
 * `stageTrials`: each stage's ended trials, both splits (this keeps the `dev` ones).
 */
export function devVerdictOf(
  verdict: DraftEvaluationVerdict,
  stageTrials: Readonly<Partial<Record<DraftEvaluationStageName, readonly VerdictTrial[]>>>,
): DraftEvaluationDevVerdict {
  if (verdict === 'unmeasured') return 'unmeasured';
  if (verdict === 'contaminated') return 'inconclusive';
  for (const stage of DRAFT_EVALUATION_STAGE_VALUES) {
    const dev = (stageTrials[stage] ?? []).filter((t) => t.split === 'dev');
    if (dev.length === 0) continue;
    if (tooManyWithoutOutcome(dev)) return 'inconclusive';
    const measure = measureStage(stage, dev);
    if (measure.stage === 'confirm') return confirmOnDev(measure.dev, measure.delta);
    const outcome = ruleOutcome(measure);
    if (outcome.kind === 'passed') continue;
    return outcome.verdict === 'regressed' || outcome.verdict === 'refuted'
      ? outcome.verdict
      : 'inconclusive';
  }
  return 'inconclusive';
}

/**
 * The cases whoever publishes the draft acknowledges one by one (S10 E3-3; §5.5 结果去哪) when
 * `verdict` came from this stage's `trials`, in the order of `caseIds` (the stage's):
 *   - `regressed`: the regression cases lost (the measure's `lostCaseIds`);
 *   - `worse`: the confirmation's dev cases the candidate passed at a lower rate than the baseline,
 *     over the tries with an outcome as the rates are — or, should none be lower case by case
 *     (tries without an outcome spread unevenly over cases can tip the total alone), every dev
 *     case the candidate failed;
 *   - any other verdict: none — it is shown, not confirmed.
 */
export function casesToAcknowledge(
  verdict: DraftEvaluationVerdict,
  caseIds: readonly string[],
  trials: readonly VerdictTrial[],
): string[] {
  if (verdict === 'regressed') {
    const measure = measureStage('regression', trials);
    if (measure.stage !== 'regression') return [];
    const lost = new Set(measure.lostCaseIds);
    return caseIds.filter((caseId) => lost.has(caseId));
  }
  if (verdict !== 'worse') return [];
  const dev = trials.filter((t) => t.split === 'dev');
  const rate = (caseId: string, arm: EvalArm): number | null => {
    const c = count(dev.filter((t) => t.caseId === caseId && t.arm === arm));
    const tries = c.passed + c.failed;
    return tries === 0 ? null : c.passed / tries;
  };
  const devCaseIds = caseIds.filter((caseId) => dev.some((t) => t.caseId === caseId));
  const lower = devCaseIds.filter((caseId) => {
    const candidate = rate(caseId, 'candidate');
    const baseline = rate(caseId, 'baseline');
    return candidate !== null && baseline !== null && candidate < baseline;
  });
  if (lower.length > 0) return lower;
  return devCaseIds.filter((caseId) =>
    dev.some((t) => t.caseId === caseId && t.arm === 'candidate' && readingOf(t) === 'failed'),
  );
}
