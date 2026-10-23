import type { GoalPlan, UnresolvedGoalActionWire } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { goalRun } from '../components/goals/goal-fixtures.test-helpers.js';
import {
  checkErrorLabel,
  exhaustedBudget,
  factCheckSentence,
  goalBudgetRows,
  goalStateNote,
  goalStepProgress,
  isStepAuthorityHint,
  observationSentence,
  planDiff,
  planHintKey,
  planHintText,
  predicateSentence,
  stepHintChipLabel,
  unresolvedActionText,
} from './goals.js';
import type { Translate } from './i18n.js';

const zh: Translate = (zhText) => zhText;

function unresolved(overrides: Partial<UnresolvedGoalActionWire> = {}): UnresolvedGoalActionWire {
  return {
    actionRequestId: 'ar-1',
    stepRunId: 'sr-1',
    stepKey: 'apply',
    gatekeeperId: 'gk-1',
    actionKindTag: 'cert.replace',
    failedAt: '2026-10-20T00:05:00.000Z',
    needs: 'finding',
    platformCheck: null,
    ...overrides,
  };
}

const en: Translate = (_zhText, enText) => enText;

describe('lib/goals', () => {
  it("reads the confirmation card's hints by step, a gate by its name where known", () => {
    const gateNames = new Map([['11111111-2222-4333-8444-555555555555', 'prod-cert-gate']]);
    const gate = {
      code: 'step_gate_not_held' as const,
      message: 'step "apply": …',
      stepKey: 'apply',
      gatekeeperIds: [
        '11111111-2222-4333-8444-555555555555',
        '99999999-8888-4777-8666-555555555555',
      ],
    };
    const zhText = planHintText(gate, zh, gateNames);
    // Each gate in 「」 joined by 、, an unnamed one by its short id; then what to do next.
    expect(zhText).toMatch(/^步骤「apply」的 Worker 要操作门「prod-cert-gate」、「99999999」，/);
    expect(zhText).not.toContain('99999999-8888-4777-8666-555555555555');
    expect(zhText).toContain('可以请工作区所有者在「成员与授权」给请求人开通，或者驳回');
    expect(planHintText(gate, en, gateNames)).toMatch(
      /^Step “apply”: its Worker acts on gates “prod-cert-gate”, “99999999”, .* A workspace owner can grant it in Members/,
    );
    expect(
      planHintText({ code: 'step_definition_excluded', message: 'm', stepKey: 'build' }, zh),
    ).toMatch(/步骤「build」.*请求人可以在「我的智能体」里调整设置。$/);
    expect(planHintText({ code: 'requester_cannot_start_workers', message: 'm' }, en)).toMatch(
      /^The requester cannot start Workers now.* in Members\.$/,
    );
    // The permissions a step's Worker lacks, by their console names; an unknown one as it is.
    const capability = {
      code: 'step_capability_not_held' as const,
      message: 'm',
      stepKey: 'apply',
      capabilityNames: ['request_action', 'cert-gate.renew:execute'],
    };
    expect(planHintText(capability, zh)).toMatch(
      /^步骤「apply」的 Worker 需要执行权限「发起动作请求」、「cert-gate\.renew:execute」，请求人现在没有：/,
    );
    expect(planHintText(capability, en)).toMatch(
      /^Step “apply”: its Worker needs the execute permissions “Request action”, “cert-gate\.renew:execute”, /,
    );
    // An older kernel sends none: the hint still reads, without a list.
    expect(planHintText({ ...capability, capabilityNames: undefined }, zh)).toMatch(
      /^步骤「apply」的 Worker 需要请求人现在没有的执行权限：/,
    );
    // A step's authority hints go to the steps card, each with a chip on its row; the hint about
    // how the goal is verified stays with acceptance.
    expect(isStepAuthorityHint(gate)).toBe(true);
    expect(isStepAuthorityHint({ code: 'requester_confirm_only', message: 'm' })).toBe(false);
    expect(stepHintChipLabel(gate, zh)).toBe('请求人无权限');
    expect(stepHintChipLabel(capability, zh)).toBe('请求人无权限');
    expect(
      stepHintChipLabel({ code: 'step_definition_excluded', message: 'm', stepKey: 'b' }, zh),
    ).toBe('智能体设置已排除');
    expect(stepHintChipLabel({ code: 'requester_cannot_start_workers', message: 'm' }, zh)).toBe(
      null,
    );
    // Two steps' hints of one code are two items of the list.
    expect(planHintKey({ code: 'step_capability_not_held', message: 'm', stepKey: 'a' })).not.toBe(
      planHintKey({ code: 'step_capability_not_held', message: 'm', stepKey: 'b' }),
    );
  });

  it('reads a predicate as a sentence: leaves, all / any / not', () => {
    expect(predicateSentence({ path: 'state', op: 'eq', value: 'running' }, zh)).toBe(
      'state 等于 "running"',
    );
    expect(predicateSentence({ path: 'items', op: 'exists' }, zh)).toBe('items 有值');
    expect(
      predicateSentence(
        {
          all: [
            { path: 'a', op: 'gte', value: 1 },
            { not: { path: 'b', op: 'contains', value: 'x' } },
          ],
        },
        zh,
      ),
    ).toBe('以下全部成立：a 不小于 1；并非（b 包含 "x"）');
    expect(predicateSentence({ any: [{ path: 'c', op: 'lt', value: 2 }] }, zh)).toBe(
      '以下任一成立：c 小于 2',
    );
  });

  it('reads a Fact check by its objects, without showing a full id', () => {
    const sentence = factCheckSentence(
      {
        linkType: 'runs_on',
        source: { objectType: 'Service', identity: { name: 'web' } },
        target: { objectId: '33333333-3333-4333-8333-333333333333' },
      },
      zh,
    );
    expect(sentence).toContain('Service（name="web"）');
    expect(sentence).toContain('33333333');
    expect(sentence).not.toContain('33333333-3333');
  });

  it('diffs two plans by step key, and says whether the acceptance changed', () => {
    const worker = { definitionId: 'wd', version: 1 };
    const before: GoalPlan = {
      steps: [
        { key: 'a', worker },
        { key: 'b', worker, input: { n: 1 } },
      ],
    };
    const after: GoalPlan = {
      steps: [
        { key: 'b', worker, input: { n: 2 } },
        { key: 'c', worker },
      ],
      acceptance: [{ kind: 'requester_confirm', key: 'ok', prompt: '好了吗' }],
    };
    expect(planDiff(before, after)).toEqual({
      added: ['c'],
      removed: ['a'],
      changed: ['b'],
      acceptanceChanged: true,
    });
    expect(planDiff(before, before)).toEqual({
      added: [],
      removed: [],
      changed: [],
      acceptanceChanged: false,
    });
  });

  it('counts the steps of the plan in force, superseded ones left out', () => {
    expect(
      goalStepProgress(
        goalRun({
          stepCounts: {
            pending: 1,
            ready: 0,
            running: 0,
            waiting: 0,
            succeeded: 2,
            failed: 0,
            superseded: 4,
            cancelled: 0,
            skipped: 1,
          },
        }),
      ),
    ).toEqual({ done: 3, total: 4 });
  });

  it('a goal paused for a check says it can go on once every finding is recorded', () => {
    const goal = goalRun({ status: 'paused', pauseReason: 'awaiting_reconcile' });
    const budget = goalBudgetRows(goal, zh);
    expect(goalStateNote(goal, [], budget, zh)).toEqual({
      tone: 'info',
      text: '核对已记录，可以继续。',
    });
    expect(goalStateNote(goal, [unresolved()], budget, zh)?.tone).toBe('warn');
    // Not read yet: it does not claim the checks are recorded.
    expect(goalStateNote(goal, undefined, budget, zh)?.text).not.toBe('核对已记录，可以继续。');
  });

  it("an owner's pause reads as a hold the requester cannot lift", () => {
    const goal = goalRun({
      status: 'paused',
      pauseReason: 'requested',
      pausedBy: 'p-owner',
      pausedByAuthority: 'owner',
    });
    expect(goalStateNote(goal, undefined, goalBudgetRows(goal, zh), zh)?.text).toMatch(
      /已被工作区所有者锁定.*要等所有者解除锁定才能继续.*仍可以改计划、结束或取消/,
    );
  });

  it('a budget pause names the dimension used up', () => {
    const goal = goalRun({
      status: 'paused',
      pauseReason: 'budget_exhausted',
      usage: { tokens: 100000, steps: 2, revisions: 0 },
    });
    // Half an hour after confirmation: the two hours of wall clock are not used up.
    const budget = goalBudgetRows(goal, zh, Date.parse('2026-10-20T00:31:00.000Z'));
    expect(budget.find((row) => row.key === 'wallClock')?.usedText).toBe('30 分钟');
    expect(exhaustedBudget(budget).map((row) => row.key)).toEqual(['tokens']);
    expect(goalStateNote(goal, undefined, budget, zh)?.text).toMatch(/^预算用完（Token）/);
  });

  it('a cancel that left work running says so; a clean cancel says nothing', () => {
    const cancelled = goalRun({ status: 'cancelled', endedAt: '2026-10-20T01:00:00.000Z' });
    expect(goalStateNote(cancelled, undefined, goalBudgetRows(cancelled, zh), zh)).toBeNull();
    const left = goalRun({ ...cancelled, cleanupPending: true });
    expect(goalStateNote(left, undefined, goalBudgetRows(left, zh), zh)?.text).toMatch(/有残留/);
  });

  it('a pending platform check of a paused goal waits for it to go on', () => {
    const action = unresolved({
      platformCheck: {
        status: 'pending',
        attempts: 1,
        lastError: null,
        observationId: null,
        nextAttemptAt: null,
      },
    });
    expect(unresolvedActionText(action, true, zh).check).toBe('核对已暂停，继续后再核对。');
    expect(unresolvedActionText(action, false, zh).check).toMatch(/^平台核对中/);
  });

  it('an action with no platform check says why a person checks it (a deletion leaves nothing to see)', () => {
    const text = unresolvedActionText(unresolved(), false, zh);
    expect(text.needs).toMatch(/生效了吗/);
    expect(text.check).toMatch(/删除/);
    expect(unresolvedActionText(unresolved({ needs: 'decision' }), false, zh).needs).toMatch(
      /重新执行，或者改计划/,
    );
  });

  it('names an observation’s params, a secret-named field masked', () => {
    const check = {
      gatekeeperId: '66000000-0000-4000-8000-0000000000d1',
      operation: 'cert.list',
      expect: { path: 'expiring', op: 'eq' as const, value: 0 },
    };
    expect(observationSentence(check, 'cert-gate', zh)).toBe(
      '在门「cert-gate」上观察 cert.list，期望 expiring 等于 0',
    );
    const withParams = observationSentence(
      { ...check, params: { host: 'web-1', token: 'not-a-real-value' } },
      'cert-gate',
      zh,
    );
    expect(withParams).toMatch(/以参数 .*"host":"web-1"/);
    expect(withParams).not.toMatch(/not-a-real-value/);
  });

  it('a check’s last error reads in words where the code is known, as its code otherwise', () => {
    expect(checkErrorLabel('predicate_unsatisfied', zh)).toBe('结果不符合期望');
    expect(checkErrorLabel('fact_not_observed', zh)).toMatch(/^没看到能作证据的事实/);
    expect(checkErrorLabel('gate_timeout', zh)).toBe('上次没成功（代码 gate_timeout）');
  });
});
