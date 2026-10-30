import type { EvalBudgetWire } from '@nexttime/shared';
import { useCallback } from 'react';
import { type Resource, useResource } from '../../hooks/useResource.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { budgetStanding, formatUsd } from '../../lib/eval-runs.js';
import { formatDateTime } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { DashboardCard } from '../kit/section.js';
import { SkeletonRows } from '../kit/skeleton.js';

/** This UTC month's evaluation budget (`get_eval_budget`). */
export function useEvalBudget(http: CapabilityCaller): Resource<EvalBudgetWire> {
  const load = useCallback(() => http.call<EvalBudgetWire>('get_eval_budget', {}), [http]);
  return useResource(load);
}

/** Whether the reader is the workspace's owner — the one who sets the evaluation budget. */
export function useIsOwner(http: CapabilityCaller): boolean {
  const identity = useWorkspaceIdentity(http);
  return identity.role.kind === 'known' && identity.role.role === 'owner';
}

/** "Spent $x of $y, $z left" — one line. */
export function budgetLine(budget: EvalBudgetWire, t: Translate): string {
  const standing = budgetStanding(budget);
  return t(
    `本月已用 ${formatUsd(budget.spentUsd)} / ${formatUsd(budget.monthlyBudgetUsd)}，剩余 ${formatUsd(standing.remainingUsd)}`,
    `${formatUsd(budget.spentUsd)} of ${formatUsd(budget.monthlyBudgetUsd)} spent this month, ${formatUsd(standing.remainingUsd)} left`,
  );
}

/** What one trial is estimated to cost, or why there is no estimate yet. */
export function trialEstimateLine(budget: EvalBudgetWire, t: Translate): string {
  return budget.trialCostUsd === null
    ? t(
        '还没有算得出费用的试跑，暂时估不出一次试跑要多少。',
        'No trial with a known cost yet, so there is no estimate of what one costs.',
      )
    : t(
        `按最近试跑的平均，一次试跑约 ${formatUsd(budget.trialCostUsd)}。`,
        `One trial costs about ${formatUsd(budget.trialCostUsd)}, averaged over recent trials.`,
      );
}

/** Why no trial can start once the budget is spent. A budget of $0 is an owner turning evaluation
 *  off, not a month used up, so it says that instead. */
export function budgetSpentText(budget: EvalBudgetWire, t: Translate): string {
  return budget.monthlyBudgetUsd === 0
    ? t(
        '本月评测预算是 $0，不能试跑。',
        'This month’s evaluation budget is $0, so no trial can start.',
      )
    : t(
        '本月的评测预算已经用完，下个月（UTC）重置前不能再试跑。',
        'This month’s evaluation budget is spent; no trial can start until it resets next month (UTC).',
      );
}

/** Where an owner raises the budget, or whom a reader asks. */
export function RaiseBudgetHint({ isOwner }: { readonly isOwner: boolean }) {
  const t = useT();
  return isOwner ? (
    <span>
      {t('可以在', 'Raise it under ')}
      <RouteLink href={hrefs.models()} className="link-inline" testId="eval-budget-raise">
        {t('「模型与配额」', 'Models')}
      </RouteLink>
      {t('调高「评测月度预算」。', ' (Monthly evaluation budget).')}
    </span>
  ) : (
    <span>
      {t(
        '需要的话，请工作区所有者在「模型与配额」调高「评测月度预算」。',
        'If needed, ask a workspace owner to raise the monthly evaluation budget under Models.',
      )}
    </span>
  );
}

/**
 * components/evaluation/EvalBudget (S10 E3-2a; coordinator 2026-10-30): the month's evaluation
 * budget on 治理 → 评测 — spent and left of `evaluation.monthly_cost_budget_usd`, what one trial
 * costs on average, when the month resets, and, once it is spent, that nothing more can start
 * (a run is refused before it starts, never stopped part-way).
 */
export function EvalBudgetCard({
  budget,
  isOwner,
}: {
  readonly budget: Resource<EvalBudgetWire>;
  readonly isOwner: boolean;
}) {
  const t = useT();
  const state = budget.state;
  return (
    <DashboardCard
      title={t('本月评测预算', 'Evaluation budget this month')}
      data-testid="eval-budget"
    >
      {state.status === 'loading' ? (
        <SkeletonRows count={1} label={t('正在读取评测预算', 'Loading the evaluation budget')} />
      ) : state.status === 'error' ? (
        <ErrorBanner
          error={state.error}
          title={t('无法读取评测预算', 'Could not load the evaluation budget')}
          onRetry={() => void budget.reload()}
          testId="eval-budget-error"
        />
      ) : (
        <BudgetBody budget={state.data} isOwner={isOwner} />
      )}
    </DashboardCard>
  );
}

function BudgetBody({
  budget,
  isOwner,
}: {
  readonly budget: EvalBudgetWire;
  readonly isOwner: boolean;
}) {
  const t = useT();
  const standing = budgetStanding(budget);
  const pct =
    budget.monthlyBudgetUsd > 0
      ? Math.min(100, Math.round((budget.spentUsd / budget.monthlyBudgetUsd) * 100))
      : 100;
  return (
    <div className="stack-s">
      <span className="tabular" data-testid="eval-budget-line">
        {budgetLine(budget, t)}
      </span>
      <span
        className={`quota-bar${pct >= 80 ? ' quota-bar-warn' : ''}`}
        role="img"
        aria-label={t(`已用 ${pct}%`, `${pct}% spent`)}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="text-3 text-small" data-testid="eval-budget-estimate">
        {trialEstimateLine(budget, t)}{' '}
        {t(
          `预算按 UTC 自然月计，${formatDateTime(budget.periodEnd)} 重置；评测的花费同时计入「每工作区日成本」。`,
          `The budget runs by UTC calendar month and resets ${formatDateTime(budget.periodEnd)}; evaluation spending also counts toward the daily cost budget.`,
        )}
      </span>
      {budget.unpricedTrials > 0 ? (
        <span className="text-3 text-small" data-testid="eval-budget-unpriced">
          {t(
            `本月有 ${budget.unpricedTrials} 次试跑用的模型没有价格，它们的花费不在「已用」里。`,
            `${budget.unpricedTrials} trial(s) this month used a model with no price; their cost is not in what is spent.`,
          )}
        </span>
      ) : null}
      {standing.exhausted ? (
        <Notice tone="warn" testId="eval-budget-exhausted">
          {budgetSpentText(budget, t)} <RaiseBudgetHint isOwner={isOwner} />
        </Notice>
      ) : isOwner ? (
        <span className="text-3 text-small">
          <RaiseBudgetHint isOwner />
        </span>
      ) : null}
    </div>
  );
}
