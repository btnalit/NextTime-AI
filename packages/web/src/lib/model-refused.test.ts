import { describe, expect, it } from 'vitest';
import { formatTime } from './format.js';
import type { Translate } from './i18n.js';
import { taskFailureReasonText } from './labels.js';
import { budgetRaiseText, dailyBudgetsResetText, localTimeOfUtcMidnight } from './model-refused.js';

const zh: Translate = (text) => text;
const en: Translate = (_zh, text) => text;

describe('model-refused copy (legacy 589, UX acceptance of #910)', () => {
  it('names the next 00:00 UTC on the reader’s clock', () => {
    const now = Date.parse('2026-11-01T22:30:00.000Z');
    expect(localTimeOfUtcMidnight(now)).toBe(formatTime('2026-11-02T00:00:00.000Z'));
    expect(localTimeOfUtcMidnight(now)).toMatch(/^\d\d:\d\d$/);
  });

  it('says who raises which budget, and where', () => {
    expect(budgetRaiseText('workspace_daily_cost', zh)).toBe(
      '工作区所有者也可以在「模型与配额」里调高「每工作区日成本」。',
    );
    expect(budgetRaiseText('workspace_daily_tokens', zh)).toBe('平台管理员也可以调高它。');
    expect(budgetRaiseText(null, en)).toBe('An administrator can also raise it.');
  });

  it('a refused Task’s detail ends with when the budgets reset and who raises each', () => {
    const now = Date.parse('2026-11-01T22:30:00.000Z');
    const local = localTimeOfUtcMidnight(now);
    expect(dailyBudgetsResetText(zh, now)).toBe(
      `预算每天 UTC 0 点（本地 ${local}）重置；费用预算可以由工作区所有者在「模型与配额」里调高「每工作区日成本」，token 预算由平台管理员调高。`,
    );
    const detail = taskFailureReasonText('model_refused', zh).detail;
    expect(detail).toMatch(
      /^工作区当天的模型预算用完了，平台拒绝了这个 Worker 的每一次模型调用，它什么都没做。预算每天 UTC 0 点（本地 \d\d:\d\d）重置；/,
    );
    expect(taskFailureReasonText('model_refused', en).detail).toMatch(
      /it did nothing\. The budgets reset every day at 00:00 UTC \(\d\d:\d\d local\);/,
    );
    expect(taskFailureReasonText('model_refused', zh).short).toBe('模型调用被平台拒绝');
  });
});
