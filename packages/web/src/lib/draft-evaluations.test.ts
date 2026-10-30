import {
  DRAFT_CHECK_VALUES,
  DRAFT_EVALUATION_REASON_VALUES,
  DRAFT_EVALUATION_SKIP_VALUES,
  DRAFT_EVALUATION_STAGE_VALUES,
  type EvalCaseSummaryWire,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  budgetShortfallOf,
  draftCheckProblemText,
  draftCheckProblemsOf,
  draftEvaluationOutcome,
  draftEvaluationPlan,
  passRateText,
  pointsText,
  skipReasonText,
  stageName,
  stageResult,
  stageRuleText,
  suiteMechanisms,
  verdictReasonText,
} from './draft-evaluations.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { statusChipStyle } from './status-tone.js';

const zhT: Translate = (zh) => zh;
const enT: Translate = (_zh, en) => en;

type CaseRow = Pick<EvalCaseSummaryWire, 'partition' | 'mechanism'>;
const regression = (): CaseRow => ({ partition: 'regression', mechanism: null });
const full = (): CaseRow => ({ partition: 'full', mechanism: null });
const aimed = (mechanism: string): CaseRow => ({ partition: 'mechanism', mechanism });

const budget = (spentUsd: number, trialCostUsd: number | null = 0.01) => ({
  monthlyBudgetUsd: 1,
  spentUsd,
  trialCostUsd,
});

describe('draftEvaluationPlan', () => {
  const cases = [regression(), regression(), aimed('asks first'), aimed(' asks first '), full()];

  it('plans each stage as the kernel does: k, trials, estimates, and skips foreseen', () => {
    const plan = draftEvaluationPlan(cases, 'asks first', budget(0));
    expect(plan.stages).toEqual([
      // 2 cases × 2 tries × 2 arms.
      {
        stage: 'regression',
        caseCount: 2,
        k: 2,
        trials: 8,
        estimateUsd: 0.08,
        skip: null,
        covered: true,
      },
      // 10 tries per arm over 2 cases: 5 each.
      {
        stage: 'mechanism',
        caseCount: 2,
        k: 5,
        trials: 20,
        estimateUsd: 0.2,
        skip: null,
        covered: true,
      },
      {
        stage: 'confirm',
        caseCount: 1,
        k: 3,
        trials: 6,
        estimateUsd: 0.06,
        skip: null,
        covered: true,
      },
    ]);
    expect(plan.trials).toBe(34);
    expect(plan.estimateUsd).toBeCloseTo(0.34);
    expect(plan).toMatchObject({
      nothingToRun: false,
      firstNotCovered: false,
      laterMayBeSkipped: false,
    });

    const none = draftEvaluationPlan(cases, null, budget(0));
    expect(none.stages[1]).toMatchObject({ skip: 'no_mechanism', trials: 0 });
    expect(none.trials).toBe(14);
    expect(draftEvaluationPlan([full()], null, budget(0)).stages[0]).toMatchObject({
      skip: 'no_cases',
    });
    expect(draftEvaluationPlan([aimed('x')], null, budget(0)).nothingToRun).toBe(true);
  });

  it('says when the first stage does not fit, and when a later one may be skipped', () => {
    // 0.34 left covers all three exactly (0.08 + 0.2 + 0.06).
    const exact = draftEvaluationPlan(cases, 'asks first', budget(0.66));
    expect(exact.stages.map((stage) => stage.covered)).toEqual([true, true, true]);
    // 0.15 left: regression fits; the evaluation would stop at mechanism, confirm never reached.
    const short = draftEvaluationPlan(cases, 'asks first', budget(0.85));
    expect(short.stages.map((stage) => stage.covered)).toEqual([true, false, false]);
    expect(short).toMatchObject({ firstNotCovered: false, laterMayBeSkipped: true });
    const spent = draftEvaluationPlan(cases, 'asks first', budget(0.95));
    expect(spent).toMatchObject({ firstNotCovered: true });
    // No priced trial yet: nothing is estimated, and the kernel lets it through.
    const unknown = draftEvaluationPlan(cases, null, budget(0.95, null));
    expect(unknown.estimateUsd).toBeNull();
    expect(unknown.stages.every((stage) => stage.covered === null)).toBe(true);
    expect(unknown.firstNotCovered).toBe(false);
  });
});

describe('suiteMechanisms', () => {
  it('lists each mechanism its mechanism cases name, trimmed, with how many name it', () => {
    expect(
      suiteMechanisms([aimed('asks first'), regression(), aimed(' asks first'), aimed('retries')]),
    ).toEqual([
      { mechanism: 'asks first', caseCount: 2 },
      { mechanism: 'retries', caseCount: 1 },
    ]);
    expect(suiteMechanisms([regression(), { partition: 'mechanism', mechanism: '  ' }])).toEqual(
      [],
    );
  });
});

describe('refusals', () => {
  it('reads the failed checks a draft_check_failed carried, dropping what is not one', () => {
    const err = new HttpError('capability_error', 'refused', 'draft_check_failed', {
      problems: [
        { check: 'credential_like', count: 2, limit: null },
        { check: 'not_a_check', count: 1, limit: null },
        { check: 'edit_budget', count: 250, limit: 200 },
      ],
    });
    expect(draftCheckProblemsOf(err)).toEqual([
      { check: 'credential_like', count: 2, limit: null },
      { check: 'edit_budget', count: 250, limit: 200 },
    ]);
    expect(draftCheckProblemsOf(new HttpError('capability_error', 'x', 'conflict'))).toBeNull();
    expect(draftCheckProblemsOf(new Error('x'))).toBeNull();
  });

  it('reads an evaluation_budget_insufficient’s numbers', () => {
    const err = new HttpError('capability_error', 'x', 'evaluation_budget_insufficient', {
      budgetUsd: 10,
      spentUsd: 9.9,
      estimateUsd: 0.4,
    });
    expect(budgetShortfallOf(err)).toEqual({ budgetUsd: 10, spentUsd: 9.9, estimateUsd: 0.4 });
    expect(
      budgetShortfallOf(new HttpError('capability_error', 'x', 'evaluation_budget_insufficient')),
    ).toBeNull();
  });
});

describe('copy', () => {
  it('names every stage, rule, reason, skip and check in both languages', () => {
    for (const stage of DRAFT_EVALUATION_STAGE_VALUES) {
      expect(stageName(stage, zhT)).not.toBe(stageName(stage, enT));
      expect(stageRuleText(stage, zhT).length).toBeGreaterThan(20);
      expect(stageRuleText(stage, enT).length).toBeGreaterThan(20);
    }
    for (const reason of DRAFT_EVALUATION_REASON_VALUES) {
      expect(verdictReasonText(reason, zhT)).not.toBe(verdictReasonText(reason, enT));
    }
    for (const skip of DRAFT_EVALUATION_SKIP_VALUES) {
      expect(skipReasonText(skip, zhT)).not.toBe(skipReasonText(skip, enT));
    }
    for (const check of DRAFT_CHECK_VALUES) {
      const problem = { check, count: 3, limit: 200 };
      expect(draftCheckProblemText(problem, zhT)).not.toBe(draftCheckProblemText(problem, enT));
    }
    expect(stageRuleText('mechanism', zhT)).toContain('10 次里 4 次');
    expect(stageRuleText('confirm', enT)).toContain('−10 points');
    expect(draftCheckProblemText({ check: 'edit_budget', count: 250, limit: 200 }, zhT)).toContain(
      '250 行',
    );
  });

  it('reads an evaluation’s state as one status, and an ended stage as passed or deciding', () => {
    expect(draftEvaluationOutcome({ status: 'running', verdict: null })).toBe('running');
    expect(draftEvaluationOutcome({ status: 'cancelled', verdict: null })).toBe('cancelled');
    expect(draftEvaluationOutcome({ status: 'finished', verdict: 'better' })).toBe('better');
    expect(statusChipStyle('draftEvaluation', 'refuted').unknown).toBe(false);
    expect(statusChipStyle('draftEvaluationStage', 'not_run').unknown).toBe(false);
    expect(statusChipStyle('evalTrial', 'queued').unknown).toBe(false);
    expect(stageResult({ stage: 'regression', status: 'ended' }, { decidedBy: 'confirm' })).toBe(
      'passed',
    );
    expect(stageResult({ stage: 'confirm', status: 'ended' }, { decidedBy: 'confirm' })).toBe(
      'decided',
    );
    expect(stageResult({ stage: 'confirm', status: 'running' }, { decidedBy: null })).toBeNull();
  });

  it('writes pass rates and differences', () => {
    expect(passRateText(28, 30)).toBe('28/30 (93%)');
    expect(passRateText(0, 0)).toBe('—');
    expect(pointsText(0.1534)).toBe('+15.3');
    expect(pointsText(-0.1)).toBe('−10.0');
    expect(pointsText(0)).toBe('0.0');
    expect(pointsText(null)).toBe('—');
  });
});
