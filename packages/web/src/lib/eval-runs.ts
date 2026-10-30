import {
  type EvalBudgetWire,
  type EvalTrialCallWire,
  type EvalTrialError,
  type EvalTrialWire,
  trialVoided,
} from '@nexttime/shared';
import type { ErrorOverrides } from './errors.js';
import { shownName } from './evaluation.js';
import { actionKindTagText } from './format.js';
import type { Translate } from './i18n.js';
import { taskFailureReasonText } from './labels.js';
import type { EvalTrialOutcome } from './status-tone.js';

/**
 * lib/eval-runs (S10 E3-2a): what the console says about evaluation runs — a 试跑's outcome, its
 * assertions and fixture calls, and the month's evaluation budget. No React, no capability calls
 * (`components/evaluation/CaseTrials.tsx` and `EvalBudgetCard.tsx` do those).
 */

/** A USD amount as the budget card and a trial show it: cents, and "<$0.01" for a sliver. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}

/** A trial's outcome as one status (`kit/status-chip`'s `evalTrial` machine). */
export function trialOutcomeStatus(
  trial: Pick<EvalTrialWire, 'status' | 'verdict' | 'error' | 'taskId'>,
): EvalTrialOutcome {
  if (trial.status === 'queued') return 'queued';
  if (trial.status === 'running') return 'running';
  if (trialVoided(trial)) return 'voided';
  if (trial.status === 'errored') return 'errored';
  return trial.verdict === 'passed' ? 'passed' : 'failed';
}

/** Why an `errored` trial ended without a verdict, in a sentence. */
export function trialErrorText(error: EvalTrialError, t: Translate): string {
  switch (error) {
    case 'cancelled':
      return t(
        '评测任务被取消了，没有判分。',
        'The evaluation task was cancelled, so it was not scored.',
      );
    case 'withheld':
      return t(
        'Worker 没有启动：要交给它的内容里有评测保留的部分（别的用例的 holdout 原文或用例集的 canary），平台拦下了它。检查钉住的 Worker 的系统提示词和它加载的 Skill。',
        'The Worker was not started: what it would start with held text evaluation keeps back (another case’s holdout text or a suite’s canary), so the platform stopped it. Check the pinned Worker’s system prompt and the Skills it loads.',
      );
    case 'paused':
      return t(
        '跑的时候评测防泄漏暂停了评测自己的智能体，它的调用被拦下，所以没有判分，也不算这一边没通过。',
        'The evaluation seal paused the evaluation’s own agents while this ran and its calls were refused, so it was not scored and does not count against its side.',
      );
    case 'no_result':
      return t(
        'Worker 结束了，但没有汇报结果，所以没法用断言判分。',
        'The Worker ended without reporting a result, so the assertions had nothing to judge.',
      );
    default: {
      const reason = taskFailureReasonText(error, t);
      return `${reason.short}：${reason.detail}`;
    }
  }
}

/** What answered a fixture call, in a sentence. */
export function callAnswerText(call: EvalTrialCallWire, t: Translate): string {
  if (call.ruleIndex === null || call.answer === 'unanswered') {
    return t('没有规则匹配，得到“夹具没有答案”', 'No rule matched: “the fixture has no answer”');
  }
  const rule = call.ruleIndex + 1;
  switch (call.answer) {
    case 'data':
      return call.mode === 'execute'
        ? t(
            `规则 ${rule} 作答：模拟执行成功（没有真的执行）`,
            `Rule ${rule} answered: simulated as executed (nothing ran)`,
          )
        : t(`规则 ${rule} 作答：返回数据`, `Rule ${rule} answered with data`);
    case 'absent':
      return t(`规则 ${rule} 作答：确认不存在`, `Rule ${rule} answered: confirmed absent`);
    case 'error':
      return t(`规则 ${rule} 作答：返回错误`, `Rule ${rule} answered with an error`);
  }
}

/** A fixture call's gate and Operation, as its tool list showed them. */
export function callTargetText(call: EvalTrialCallWire): string {
  return `${shownName(call.gate)} · ${actionKindTagText(call.operation)}`;
}

/** The text a Worker's report carries in `summary`, when it has one. */
export function reportSummary(result: unknown): string | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.trim() !== '' ? summary : null;
}

export interface BudgetStanding {
  /** What is left this month (never below 0). */
  readonly remainingUsd: number;
  /** What is left once the trials not ended yet are paid for (never below 0) — what a start
   *  can count on. */
  readonly freeUsd: number;
  /** The month's budget is spent: nothing can start. */
  readonly exhausted: boolean;
  /** What one trial costs on average, when the workspace has priced trials. */
  readonly trialEstimateUsd: number | null;
  /** What is free is less than `trials` trials cost on average: a start may go over. */
  readonly short: boolean;
}

/** The budget as a start sees it: spent, or too little left for `trials` trials once the trials
 *  not ended yet (`committedUsd`) are paid for. */
export function budgetStanding(budget: EvalBudgetWire, trials = 1): BudgetStanding {
  const remainingUsd = Math.max(0, budget.monthlyBudgetUsd - budget.spentUsd);
  const freeUsd = Math.max(0, remainingUsd - budget.committedUsd);
  const exhausted = budget.spentUsd >= budget.monthlyBudgetUsd;
  const trialEstimateUsd =
    budget.trialCostUsd === null ? null : budget.trialCostUsd * Math.max(1, trials);
  return {
    remainingUsd,
    freeUsd,
    exhausted,
    trialEstimateUsd,
    short: !exhausted && trialEstimateUsd !== null && trialEstimateUsd > freeUsd,
  };
}

/** What a 试跑's refusals say on the console, beyond the kernel's own text. */
export function trialStartErrors(t: Translate): ErrorOverrides {
  return {
    version_changed: t(
      '用例集在你打开之后被改过，什么也没有启动。已重新读取最新内容，看过后再试跑。',
      'The suite changed after you opened it, and nothing was started. The latest version has been loaded; look it over and try again.',
    ),
    conflict: t(
      '这条用例已经不在用例集里（退役了，或被编辑后换成了新的一条），或者钉住的 Worker 版本已经不再发布，什么也没有启动。刷新后在用例集现在的用例上试跑。',
      'This case is no longer in the suite (retired, or replaced by an edit), or the pinned Worker version is no longer published, so nothing was started. Refresh and try the case as the suite holds it now.',
    ),
    concurrency_exceeded: t(
      '同时在跑的评测任务已经到了工作区的「每用户并发 WorkerRun 数」（所有评测共用一个评测服务主体），什么也没有启动。等正在跑的试跑结束后再试。',
      'As many evaluation tasks are running as the workspace’s concurrent WorkerRuns per user allows (every evaluation runs for one evaluation service principal), so nothing was started. Wait for the running trials to finish, then try again.',
    ),
  };
}
