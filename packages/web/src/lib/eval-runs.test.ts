import type { EvalBudgetWire, EvalTrialCallWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  budgetStanding,
  callAnswerText,
  callTargetText,
  formatUsd,
  reportSummary,
  trialErrorText,
  trialOutcomeStatus,
  trialStartErrors,
} from './eval-runs.js';
import type { Translate } from './i18n.js';

const zhT: Translate = (zh) => zh;
const GATE = '22222222-2222-4222-8222-222222222222';

function budget(extra: Partial<EvalBudgetWire> = {}): EvalBudgetWire {
  return {
    monthlyBudgetUsd: 10,
    spentUsd: 2.5,
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    trialCostUsd: 0.4,
    unpricedTrials: 0,
    ...extra,
  };
}

function trialCall(extra: Partial<EvalTrialCallWire> = {}): EvalTrialCallWire {
  return {
    seq: 1,
    gatekeeperId: GATE,
    gate: 'inventory',
    operation: 'hosts.get',
    mode: 'observe',
    params: { host: 'web-1' },
    ruleIndex: 0,
    answer: 'data',
    at: '2026-10-30T00:00:00.000Z',
    ...extra,
  };
}

describe('eval-runs (S10 E3-2a)', () => {
  it('formats USD to the cent, and a sliver as <$0.01', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(10)).toBe('$10.00');
  });

  it('reads a trial’s outcome as one status', () => {
    expect(trialOutcomeStatus({ status: 'running', verdict: null })).toBe('running');
    expect(trialOutcomeStatus({ status: 'errored', verdict: null })).toBe('errored');
    expect(trialOutcomeStatus({ status: 'scored', verdict: 'passed' })).toBe('passed');
    expect(trialOutcomeStatus({ status: 'scored', verdict: 'failed' })).toBe('failed');
  });

  it('says why a trial ended without a verdict', () => {
    expect(trialErrorText('cancelled', zhT)).toMatch(/被取消/);
    expect(trialErrorText('withheld', zhT)).toMatch(/holdout 原文或用例集的 canary/);
    expect(trialErrorText('withheld', zhT)).toMatch(/系统提示词/);
    expect(trialErrorText('no_result', zhT)).toMatch(/没有汇报结果/);
    // Any other: the Task's own failure reason, short and in detail.
    expect(trialErrorText('timeout', zhT)).toContain('：');
  });

  it('says what answered each fixture call', () => {
    expect(callAnswerText(trialCall(), zhT)).toBe('规则 1 作答：返回数据');
    expect(
      callAnswerText(trialCall({ mode: 'execute', operation: 'hosts.restart', ruleIndex: 2 }), zhT),
    ).toBe('规则 3 作答：模拟执行成功（没有真的执行）');
    expect(callAnswerText(trialCall({ answer: 'absent', ruleIndex: 1 }), zhT)).toBe(
      '规则 2 作答：确认不存在',
    );
    expect(callAnswerText(trialCall({ answer: 'error' }), zhT)).toBe('规则 1 作答：返回错误');
    expect(callAnswerText(trialCall({ answer: 'unanswered', ruleIndex: null }), zhT)).toMatch(
      /没有规则匹配/,
    );
    expect(callTargetText(trialCall())).toBe('inventory · hosts.get');
  });

  it('reads the report’s summary when it has one', () => {
    expect(reportSummary({ summary: 'Restarted web-1.' })).toBe('Restarted web-1.');
    expect(reportSummary({ summary: '  ' })).toBeNull();
    expect(reportSummary({ output: {} })).toBeNull();
    expect(reportSummary(null)).toBeNull();
    expect(reportSummary(['summary'])).toBeNull();
  });

  it('stands the budget against a start: left, spent, and too little left for the estimate', () => {
    expect(budgetStanding(budget())).toEqual({
      remainingUsd: 7.5,
      exhausted: false,
      trialEstimateUsd: 0.4,
      short: false,
    });
    // Estimates scale with the trials a run would hold.
    expect(budgetStanding(budget(), 3).trialEstimateUsd).toBeCloseTo(1.2, 9);
    expect(budgetStanding(budget({ spentUsd: 9.8 }))).toMatchObject({
      remainingUsd: expect.closeTo(0.2, 9),
      exhausted: false,
      short: true,
    });
    expect(budgetStanding(budget({ spentUsd: 10.3 }))).toMatchObject({
      remainingUsd: 0,
      exhausted: true,
      short: false,
    });
    // No estimate yet: never "short".
    expect(budgetStanding(budget({ spentUsd: 9.99, trialCostUsd: null }))).toMatchObject({
      trialEstimateUsd: null,
      short: false,
    });
    // A budget of 0 is spent before anything runs.
    expect(budgetStanding(budget({ monthlyBudgetUsd: 0, spentUsd: 0 })).exhausted).toBe(true);
  });

  it('words a refused start beyond the kernel’s text', () => {
    const overrides = trialStartErrors(zhT);
    expect(overrides.version_changed).toMatch(/什么也没有启动/);
    expect(overrides.conflict).toMatch(/不在用例集里/);
    expect(overrides.concurrency_exceeded).toMatch(/评测服务主体/);
  });
});
