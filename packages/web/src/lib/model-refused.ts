import type { LlmRefusalScope } from '@nexttime/shared';
import { formatTime } from './format.js';
import type { Translate } from './i18n.js';

/**
 * Legacy 589 (UX acceptance of #910, P3-1 / P3-2): what every "the platform refused the model
 * calls" sentence ends with, in one place — when the budget resets, on the reader's own clock,
 * and who can raise which budget, where. The two budgets llm-proxy enforces are both daily and
 * reset at 00:00 UTC: the cost budget is the workspace's 「每工作区日成本」 (`task.daily_cost_budget_usd`,
 * a workspace owner's setting under 「模型与配额」), the token budget the platform deployment's
 * `LLM_DAILY_TOKEN_BUDGET` (a platform administrator's).
 */

/** The reader's clock time (`HH:mm`) of the next 00:00 UTC — the daily budgets' reset. */
export function localTimeOfUtcMidnight(now: number = Date.now()): string {
  const d = new Date(now);
  return formatTime(
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(),
  );
}

/** Who can raise `scope`'s budget, and where — one sentence; a scope this console does not know
 *  names no setting. */
export function budgetRaiseText(scope: LlmRefusalScope | null, t: Translate): string {
  switch (scope) {
    case 'workspace_daily_cost':
      return t(
        '工作区所有者也可以在「模型与配额」里调高「每工作区日成本」。',
        'A workspace owner can also raise the daily cost budget under Models.',
      );
    case 'workspace_daily_tokens':
      return t('平台管理员也可以调高它。', 'A platform administrator can also raise it.');
    default:
      return t('管理员也可以调高它。', 'An administrator can also raise it.');
  }
}

/** For a run that does not know which of the two daily budgets refused it (a Task, a goal step,
 *  an evaluation trial): when they reset, and who raises each. */
export function dailyBudgetsResetText(t: Translate, now: number = Date.now()): string {
  const local = localTimeOfUtcMidnight(now);
  return t(
    `预算每天 UTC 0 点（本地 ${local}）重置；费用预算可以由工作区所有者在「模型与配额」里调高「每工作区日成本」，token 预算由平台管理员调高。`,
    `The budgets reset every day at 00:00 UTC (${local} local); a workspace owner can raise the daily cost budget under Models, a platform administrator the token budget.`,
  );
}
