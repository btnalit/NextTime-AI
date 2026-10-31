import {
  GOAL_RUN_CHANGE_VALUES,
  type GoalDetailWire,
  type GoalPlan,
  type OutputSchema,
  type StepAttemptWire,
  type UnresolvedGoalActionWire,
  outputContractProblems,
  validateOutput,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { goalDetail, goalRun, stepRun } from '../components/goals/goal-fixtures.test-helpers.js';
import {
  type GoalMilestone,
  absenceOperationKey,
  actionFailureCodeText,
  checkErrorLabel,
  checkErrorReason,
  checkKindLabel,
  confirmRefusedText,
  exhaustedBudget,
  factCheckSentence,
  goalBudgetRows,
  goalFirstAttemptAt,
  goalMilestoneText,
  goalStateNote,
  goalStepProgress,
  isStepAuthorityHint,
  observationSentence,
  outputProblemText,
  planAbsenceChecks,
  planCheckSentence,
  planDiff,
  planHintKey,
  planHintText,
  predicateSentence,
  reconcileAbsenceCheckOf,
  reconcileCheckSentence,
  retriedStepKeys,
  skillRefShown,
  skillVersionShown,
  stepHintChipLabel,
  unresolvedActionText,
  unresolvedCheckErrorText,
  workerSpecCombination,
  workerSpecFields,
  workerSpecSummary,
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
    expect(zhText).toContain('请求人现在没有这些门的权限');
    expect(zhText).toContain('可以请工作区所有者在「成员与授权」给请求人开通，或者驳回');
    // Under a revision the requester made there is nothing to turn down: revise again instead.
    const revised = planHintText(gate, zh, gateNames, 'revision');
    expect(revised).toContain('或者再修订计划，换掉或移除这一步。');
    expect(revised).not.toContain('驳回');
    expect(planHintText(gate, en, gateNames, 'revision')).toMatch(
      /or revise the plan again to change or remove the step\.$/,
    );
    // One gate reads as one in Chinese too.
    expect(
      planHintText(
        { ...gate, gatekeeperIds: ['11111111-2222-4333-8444-555555555555'] },
        zh,
        gateNames,
      ),
    ).toContain('请求人现在没有这个门的权限');
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

  it('legacy 513: a step on a gate where the requester has not connected their own account — who connects it, where, and what comes next', () => {
    const gateNames = new Map([['11111111-2222-4333-8444-555555555555', 'mail-gate']]);
    const hint = {
      code: 'step_account_not_connected' as const,
      message: 'step "send": …',
      stepKey: 'send',
      gatekeeperIds: ['11111111-2222-4333-8444-555555555555'],
    };
    const proposal = planHintText(hint, zh, gateNames);
    expect(proposal).toMatch(
      /^步骤「send」要用请求人自己的账户操作门「mail-gate」，请求人还没有在这个门上连接账户：/,
    );
    // Approving does not help: only the requester's own credential does.
    expect(proposal).toContain('批准也改变不了');
    expect(proposal).toContain(
      '请求人可以先在「系统与授权」里给这个门「录入我的凭证」再确认，或者驳回',
    );
    const revised = planHintText(hint, zh, gateNames, 'revision');
    expect(revised).toContain('或者再修订计划，换掉或移除这一步。');
    expect(revised).not.toContain('驳回');
    expect(planHintText(hint, en, gateNames)).toMatch(
      /^Step “send” acts on gate “mail-gate” with the requester’s own account, .*Enter my credential/,
    );
    expect(isStepAuthorityHint(hint)).toBe(true);
    expect(stepHintChipLabel(hint, zh)).toBe('请求人未连接账户');
  });

  it('S11 GO8a: what the admission of a step’s WorkerSpec says, with what to do next where it is read', () => {
    const draft = {
      code: 'step_skill_draft' as const,
      message: 'step "draft": …',
      stepKey: 'draft',
      skillRefs: ['cert-rotation', '33333333-4444-4555-8666-777777777777'],
    };
    const proposal = planHintText(draft, zh);
    // Each Skill as the plan names it, an id cut short; the step would not start; who moves it.
    expect(proposal).toMatch(
      /^步骤「draft」的 Worker 要用 Skill「cert-rotation」、「33333333」，它们还只是草稿，没有发布：这一步不会开始，/,
    );
    expect(proposal).not.toContain('33333333-4444-4555-8666-777777777777');
    expect(proposal).toContain('有发布权的人可以先在「能力目录」发布它们再确认，或者驳回');
    const revised = planHintText(
      { ...draft, skillRefs: ['cert-rotation'] },
      zh,
      new Map(),
      'revision',
    );
    expect(revised).toContain('它还只是草稿');
    // The console's 「修订计划…」 keeps a WorkerSpec as it is: the entry agent changes it (UX P3-3).
    expect(revised).toContain(
      '发布它，或者在对话里让入口智能体修订计划换掉它，或者在「修订计划…」里移除这一步。',
    );
    expect(revised).not.toContain('驳回');
    expect(planHintText(draft, en)).toMatch(
      /^Step “draft”: its Worker uses Skills “cert-rotation”, “33333333”, which are only drafts, not published — .* in Catalog before you confirm, or turn the plan down/,
    );

    const deprecated = {
      code: 'step_skill_deprecated' as const,
      message: 'm',
      stepKey: 'old',
      skillRefs: ['legacy-scan'],
    };
    expect(planHintText(deprecated, zh)).toMatch(
      /^步骤「old」的 Worker 要用的 Skill「legacy-scan」已经弃用，没有能用的版本：这一步不会开始，.*可以驳回，让助手换一个已发布的 Skill。$/,
    );
    expect(planHintText(deprecated, zh, new Map(), 'revision')).toMatch(
      /可以在对话里让入口智能体修订计划，换一个已发布的 Skill，或者在「修订计划…」里移除这一步。$/,
    );

    const model = {
      code: 'step_model_not_allowed' as const,
      message: 'm',
      stepKey: 'think',
      model: 'big-model',
    };
    expect(planHintText(model, zh)).toMatch(
      /^步骤「think」给 Worker 设定的模型「big-model」不在这个工作区允许的模型里：.*平台管理员可以在「平台 → 工作区」里允许它，或者驳回/,
    );
    expect(planHintText(model, en, new Map(), 'revision')).toMatch(
      /Platform → Workspaces, or ask the entry agent in chat to revise the plan and change it, or remove the step under “Revise plan…”\.$/,
    );
    // A model the catalog no longer offers (a paused run's read): offered again, or the plan changes.
    const notOffered = { ...model, code: 'step_model_not_offered' as const };
    expect(planHintText(notOffered, zh, new Map(), 'revision')).toMatch(
      /^步骤「think」给 Worker 设定的模型「big-model」已经不在模型目录里：这一步不会开始，.*平台管理员可以在「平台 → 模型与供应商」里重新提供它，或者在对话里让入口智能体修订计划换掉它/,
    );
    expect(planHintText(notOffered, en, new Map(), 'revision')).toMatch(
      /which the model catalog no longer offers — .* under Platform → Models & providers, or ask the entry agent/,
    );
    // On a proposal (the catalog dropped it since it was proposed): confirming would be refused
    // (UX P3-5 on #853).
    expect(planHintText(notOffered, zh)).toBe(
      '步骤「think」给 Worker 设定的模型「big-model」已经不在模型目录里：现在确认会被拒绝。平台管理员可以在「平台 → 模型与供应商」里重新提供它再确认，或者驳回，让助手换个做法。',
    );
    expect(planHintText(notOffered, en)).toMatch(
      /no longer offers — confirming would be refused now\. .* before you confirm, or turn the plan down/,
    );
    // Confirming it refused: the models named once, offered again it can be confirmed; nothing
    // to say for a refusal the hints do not explain.
    expect(confirmRefusedText([notOffered, { ...notOffered, stepKey: 'other' }], en)).toBe(
      'The plan sets model “big-model”, which the model catalog does not offer now, so confirming was refused. Once a platform administrator offers it again under Platform → Models & providers, confirm again; or turn the plan down so the assistant tries another way.',
    );
    expect(confirmRefusedText([model, draft], zh)).toBeNull();
    // A step waiting to be tried again would not be tried again, as the pause note says (UX P3-6).
    expect(planHintText(model, zh, new Map(), 'revision', true)).toMatch(
      /不在这个工作区允许的模型里：这一步不会再试，目标会停在这里等人处理。/,
    );
    expect(planHintText(model, en, new Map(), 'revision', true)).toMatch(
      /does not allow — the step would not be tried again, and the goal would pause there/,
    );
    expect(
      planHintText(
        { code: 'step_gate_not_held', message: 'm', stepKey: 'a', gatekeeperIds: ['g'] },
        zh,
        new Map([['g', '防火墙']]),
        'revision',
        true,
      ),
    ).toMatch(/请求人现在没有这个门的权限：这一步不会再试，/);

    // Each is a step's hint, with its own chip; none shows a code.
    for (const hint of [draft, deprecated, model, notOffered]) {
      expect(isStepAuthorityHint(hint)).toBe(true);
      expect(planHintText(hint, zh)).not.toMatch(/step_|skill_draft|model_not_/);
    }
    expect(stepHintChipLabel(notOffered, zh)).toBe('模型不在目录里');
    expect(stepHintChipLabel(draft, zh)).toBe('Skill 还是草稿');
    expect(stepHintChipLabel(deprecated, zh)).toBe('Skill 已弃用');
    expect(stepHintChipLabel(model, en)).toBe('Model not allowed');
    expect(skillRefShown('cert-rotation')).toBe('cert-rotation');
  });

  it('S11 GO8a: what a step’s WorkerSpec sets, in the order a reader takes it in', () => {
    const spec = { tokenBudget: 5000, instructions: 'Rotate only the expiring ones.', skills: [] };
    expect(workerSpecFields(spec)).toEqual(['instructions', 'skills', 'tokenBudget']);
    expect(workerSpecSummary(spec, zh)).toBe(
      '这一步对 Worker 的调整：职责说明、Skill、每次尝试的 Token 上限',
    );
    expect(workerSpecSummary(spec, en)).toBe(
      'Set differently for this step: Responsibility, Skills, Token cap per attempt',
    );
    // How it combines with the Worker: said only of the fields set (UX P3-1).
    expect(workerSpecCombination(spec, zh)).toBe(
      'Skill 替换 Worker 原有的设定；职责说明加在 Worker 原有的系统提示之后；Token 上限不会超出目标剩下的预算。',
    );
    expect(workerSpecCombination({ model: 'p/m1' }, zh)).toBe('模型替换 Worker 原有的设定。');
    expect(workerSpecCombination({ model: 'p/m1' }, en)).toBe(
      'The model replaces the Worker’s own.',
    );
    expect(
      workerSpecCombination(
        { gates: [], capabilities: ['observe_operation'], observeScope: [] },
        en,
      ),
    ).toBe(
      'The gates and the capabilities replace the Worker’s own; the observation scope is the gatekeepers this step’s task may read through; what the step may do never goes past what a Worker may hold and what the requester holds now.',
    );
  });

  it('S11 GO8a: a paused run names the step that did not start, and why', () => {
    const budget = goalBudgetRows(goalRun(), zh);
    const paused = (
      reason: 'needs_decision' | 'authority_lost',
      hints: GoalDetailWire['planRevision']['hints'],
      steps = [
        stepRun({ id: 'sr-a', stepKey: 'a', status: 'ready', attemptCount: 0, attempts: [] }),
      ],
    ) => {
      const detail = goalDetail();
      return {
        ...detail,
        status: 'paused' as const,
        pauseReason: reason,
        steps,
        planRevision: { ...detail.planRevision, hints },
      };
    };
    const draft = {
      code: 'step_skill_draft' as const,
      message: 'm',
      stepKey: 'a',
      skillRefs: ['cert-rotation'],
    };
    expect(goalStateNote(paused('needs_decision', [draft]), undefined, budget, zh)?.text).toBe(
      '需要人决定：步骤「a」的 Worker 要用的 Skill「cert-rotation」还只是草稿，这一步没有开始。在「能力目录」发布之后按「继续」，或者在对话里让入口智能体修订计划换掉它，见下面「步骤」里的说明。',
    );
    expect(goalStateNote(paused('needs_decision', [draft]), undefined, budget, en)?.text).toMatch(
      /^A person must decide: the Worker of step “a” uses Skill “cert-rotation”, still a draft, so the step did not start\./,
    );
    expect(
      goalStateNote(
        paused('needs_decision', [
          { code: 'step_model_not_allowed', message: 'm', stepKey: 'a', model: 'big-model' },
        ]),
        undefined,
        budget,
        en,
      )?.text,
    ).toMatch(/^A person must decide: step “a” sets its Worker’s model to “big-model”/);
    expect(
      goalStateNote(
        paused('needs_decision', [{ ...draft, code: 'step_skill_deprecated' }]),
        undefined,
        budget,
        zh,
      )?.text,
    ).toMatch(
      /Skill「cert-rotation」已经弃用，这一步没有开始。在对话里让入口智能体修订计划，换一个已发布的 Skill/,
    );
    // One step with several reasons: every one named, not only the one its attempt was refused for
    // (UX P3-2).
    expect(
      goalStateNote(
        paused('needs_decision', [
          { code: 'step_model_not_allowed', message: 'm', stepKey: 'a', model: 'big-model' },
          draft,
        ]),
        undefined,
        budget,
        zh,
      )?.text,
    ).toBe(
      '需要人决定：步骤「a」不能照计划往下做：模型不允许、Skill 还是草稿。见下面「步骤」里的说明。',
    );
    // A step waiting to be tried again (review #493 P2): its model is checked again, and the note
    // says it was not tried again.
    const retried = paused(
      'needs_decision',
      [{ code: 'step_model_not_offered', message: 'm', stepKey: 'a', model: 'gone-model' }],
      [stepRun({ id: 'sr-a', stepKey: 'a', status: 'ready', attemptCount: 1 })],
    );
    expect(goalStateNote(retried, undefined, budget, zh)?.text).toBe(
      '需要人决定：步骤「a」给 Worker 设定的模型「gone-model」已经不在模型目录里，这一步没有再试。见下面「步骤」里的说明。',
    );
    expect(goalStateNote(retried, undefined, budget, en)?.text).toMatch(
      /which the model catalog no longer offers, so the step was not tried again\./,
    );
    // The steps card says the same of the step (UX P3-6): ready after an attempt, in force.
    expect([...retriedStepKeys(retried)]).toEqual(['a']);
    expect([
      ...retriedStepKeys({
        steps: [
          stepRun({ id: 'sr-a', stepKey: 'a', status: 'ready', attemptCount: 0, attempts: [] }),
          stepRun({ id: 'sr-b', stepKey: 'b', status: 'running', attemptCount: 1 }),
          stepRun({
            id: 'sr-c',
            stepKey: 'c',
            status: 'ready',
            attemptCount: 1,
            supersededInRevision: 2,
          }),
        ],
      }),
    ]).toEqual([]);
    expect(
      goalStateNote(
        paused('needs_decision', [
          { code: 'step_definition_excluded', message: 'm', stepKey: 'a' },
        ]),
        undefined,
        budget,
        zh,
      )?.text,
    ).toMatch(/^需要人决定：请求人的智能体设置排除了步骤「a」的 Worker/);
    // Two steps that would not start: both named, the notes under Steps say why.
    const two = paused(
      'needs_decision',
      [draft, { ...draft, stepKey: 'b' }],
      [
        stepRun({ id: 'sr-a', stepKey: 'a', status: 'ready', attemptCount: 0, attempts: [] }),
        stepRun({ id: 'sr-b', stepKey: 'b', status: 'ready', attemptCount: 0, attempts: [] }),
      ],
    );
    expect(goalStateNote(two, undefined, budget, zh)?.text).toBe(
      '需要人决定：步骤「a」、「b」不能照计划往下做。见下面「步骤」里的说明。',
    );
    // A step still waiting for others is not why the run paused: the general note stays.
    const pending = paused(
      'needs_decision',
      [draft],
      [stepRun({ id: 'sr-a', stepKey: 'a', status: 'pending', attemptCount: 0, attempts: [] })],
    );
    expect(goalStateNote(pending, undefined, budget, zh)?.text).toMatch(
      /^需要人决定：验收没通过、动作被拒绝或过期/,
    );
    // Nor is a draft while another step failed.
    const failed = paused(
      'needs_decision',
      [draft],
      [
        stepRun({ id: 'sr-a', stepKey: 'a', status: 'ready', attemptCount: 0, attempts: [] }),
        stepRun({ id: 'sr-b', stepKey: 'b', status: 'failed', failureCategory: 'action_refused' }),
      ],
    );
    expect(goalStateNote(failed, undefined, budget, zh)?.text).toMatch(
      /^需要人决定：验收没通过、动作被拒绝或过期/,
    );

    // authority_lost: the step whose gate the requester lost, or the requester as a whole.
    const gate = {
      code: 'step_gate_not_held' as const,
      message: 'm',
      stepKey: 'a',
      gatekeeperIds: ['11111111-2222-4333-8444-555555555555'],
    };
    expect(goalStateNote(paused('authority_lost', [gate]), undefined, budget, zh)?.text).toBe(
      '请求人已经没有步骤「a」需要的授权，这一步没有开始，目标暂停了。授权恢复或改计划之后才能继续，见下面「步骤」里的说明。',
    );
    expect(
      goalStateNote(
        paused(
          'authority_lost',
          [gate],
          [stepRun({ id: 'sr-a', stepKey: 'a', status: 'ready', attemptCount: 2 })],
        ),
        undefined,
        budget,
        en,
      )?.text,
    ).toMatch(/needs, so it was not tried again and the goal is paused/);
    expect(
      goalStateNote(
        paused('authority_lost', [{ code: 'requester_cannot_start_workers', message: 'm' }]),
        undefined,
        budget,
        zh,
      )?.text,
    ).toMatch(/^请求人现在不能启动 Worker（角色不允许，或已被停用），目标暂停了。/);
    // Read without the plan (a list row), or with no hint: the general note.
    expect(goalStateNote(paused('authority_lost', []), undefined, budget, zh)?.text).toBe(
      '请求人已经没有下一步需要的授权，目标暂停了。授权恢复或改计划之后才能继续。',
    );
  });

  it('legacy 544: a step pinned to a Worker or Skill version no longer published is named', () => {
    const worker = { code: 'step_worker_unavailable' as const, message: 'm', stepKey: 'scan' };
    expect(planHintText(worker, zh)).toBe(
      '步骤「scan」用的 Worker 版本已经不再发布（弃用了，或者不存在）：现在确认会被拒绝。可以驳回，让助手换一个已发布的 Worker。',
    );
    expect(planHintText(worker, en, new Map(), 'revision')).toMatch(
      /^Step “scan” uses a Worker version that is no longer published \(deprecated, or not there\) — the step would not start, and the goal would pause there for a person\. You can ask the entry agent in chat to revise the plan and change it/,
    );
    expect(stepHintChipLabel(worker, zh)).toBe('Worker 已不再发布');
    expect(stepHintChipLabel(worker, en)).toBe('Worker no longer published');
    // Confirming it was refused: the proposal cannot be confirmed any more, whatever else it says.
    expect(confirmRefusedText([worker], zh)).toBe(
      '步骤「scan」用的 Worker 版本已经不再发布，确认没有通过，这个提议不能再确认了。驳回它，或者在对话里让入口智能体重新提一个目标。',
    );
    expect(
      confirmRefusedText(
        [
          worker,
          { ...worker, stepKey: 'fix' },
          { code: 'step_model_not_offered', message: 'm', stepKey: 'x', model: 'gone' },
        ],
        en,
      ),
    ).toMatch(
      /^Steps “scan”, “fix” use Worker versions no longer published, so confirming was refused/,
    );

    // A step tried again mounts its last attempt's Skill versions, named by name and version — a
    // version whose row is gone by its id, cut short.
    const version = {
      code: 'step_skill_version_unavailable' as const,
      message: 'm',
      stepKey: 'scan',
      skillRefs: ['cert-rotation v2', '11111111-2222-4333-8444-555555555555 v1'],
    };
    expect(skillVersionShown('cert-rotation v2')).toBe('cert-rotation v2');
    expect(skillVersionShown('11111111-2222-4333-8444-555555555555 v1')).toBe('11111111 v1');
    expect(skillVersionShown('11111111-2222-4333-8444-555555555555')).toBe('11111111');
    expect(planHintText(version, zh, new Map(), 'revision', true)).toBe(
      '步骤「scan」上一次尝试用的 Skill「cert-rotation v2」、「11111111 v1」现在不能再用了（已弃用，或者试用的草稿改过、被丢弃或弃用）。重试要用同一个版本，所以这一步不会再试，目标会停在这里等人处理。在对话里让入口智能体修订计划改动这一步，它会按现在的 Skill 重新开始；或者在「修订计划…」里移除这一步。',
    );
    expect(planHintText(version, en, new Map(), 'revision', true)).toMatch(
      /^Step “scan”: the Skill versions “cert-rotation v2”, “11111111 v1” its last attempt used can no longer be used .* A retry uses the same versions, so the step would not be tried again/,
    );
    expect(stepHintChipLabel(version, zh)).toBe('上次的 Skill 版本不可用');
    expect(confirmRefusedText([version], zh)).toBeNull();

    // The pause names them, one reason each, or every reason of one step.
    const budget = goalBudgetRows(goalRun(), zh);
    const detail = goalDetail();
    const paused = (hints: GoalDetailWire['planRevision']['hints']) => ({
      ...detail,
      status: 'paused' as const,
      pauseReason: 'needs_decision' as const,
      steps: [stepRun({ id: 'sr-a', stepKey: 'scan', status: 'ready', attemptCount: 1 })],
      planRevision: { ...detail.planRevision, hints },
    });
    expect(goalStateNote(paused([version]), undefined, budget, zh)?.text).toBe(
      '需要人决定：步骤「scan」上一次尝试用的 Skill「cert-rotation v2」、「11111111 v1」现在不能再用了，重试要用同一个版本，所以这一步没有再试。在对话里让入口智能体修订计划改动这一步，它会按现在的 Skill 重新开始；或者在「修订计划…」里移除这一步，见下面「步骤」里的说明。',
    );
    expect(goalStateNote(paused([worker]), undefined, budget, en)?.text).toBe(
      'A person must decide: step “scan” uses a Worker version that is no longer published, so the step was not tried again. Ask the entry agent in chat to revise the plan to a published Worker, or remove the step under “Revise plan…”. See the note under Steps.',
    );
    expect(goalStateNote(paused([worker, version]), undefined, budget, zh)?.text).toBe(
      '需要人决定：步骤「scan」不能照计划往下做：Worker 已不再发布、上次用的 Skill 版本不可用。见下面「步骤」里的说明。',
    );
  });

  it("legacy 513: a step's refused action reads by its code, never as the code itself", () => {
    expect(actionFailureCodeText('credential_unavailable', zh)).toContain('录入我的凭证');
    expect(actionFailureCodeText('credential_unavailable', en)).not.toContain(
      'credential_unavailable',
    );
    expect(actionFailureCodeText('gate_unreachable', zh)).toBe('连不上门');
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

  it('names an Object given by id by its name and type once it is read (legacy 470)', () => {
    const sentence = factCheckSentence(
      {
        linkType: 'runs_on',
        source: { objectType: 'Service', identity: { name: 'web' } },
        target: { objectId: '33333333-3333-4333-8333-333333333333' },
      },
      zh,
      new Map([['33333333-3333-4333-8333-333333333333', 'host-1 · Host']]),
    );
    expect(sentence).toBe('图谱里出现从 Service（name="web"） 到 host-1 · Host 的「runs_on」事实');
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

  it('a decision pause on a look before the work that did not see the thing says so (S11 「门确认不存在」 B-c)', () => {
    const goal = goalRun({ status: 'paused', pauseReason: 'needs_decision' });
    const budget = goalBudgetRows(goal, zh);
    const look = (status: 'seen_present' | 'never_seen_present' | 'unavailable') => ({
      stepKey: null,
      checkKey: 'gone',
      take: 1,
      look: 1,
      status,
      attempts: 1,
      lastError: null,
      observationId: null,
      createdAt: '2026-10-20T00:00:00.000Z',
      settledAt: '2026-10-20T00:01:00.000Z',
    });
    const acceptance = (status: 'seen_present' | 'never_seen_present' | 'unavailable') => ({
      rounds: [],
      steps: [],
      absenceBaselines: [look(status)],
      overriddenChecks: [],
    });
    for (const status of ['never_seen_present', 'unavailable'] as const) {
      expect(
        goalStateNote({ ...goal, acceptance: acceptance(status) }, undefined, budget, zh)?.text,
      ).toMatch(/^需要人决定：平台事先看某条“不存在”检查要删的东西时，没看到它在/);
    }
    for (const read of [goal, { ...goal, acceptance: acceptance('seen_present') }]) {
      expect(goalStateNote(read, undefined, budget, zh)?.text).toMatch(/^需要人决定：验收没通过/);
    }
  });

  it('when the run’s first attempt started — of any step, superseded ones too — or null before any (#786 review #501)', () => {
    const [first] = stepRun().attempts;
    const attempt = (createdAt: string) => ({ ...(first as StepAttemptWire), createdAt });
    expect(goalFirstAttemptAt({ steps: [] })).toBeNull();
    expect(goalFirstAttemptAt({ steps: [stepRun({ attempts: [] })] })).toBeNull();
    expect(
      goalFirstAttemptAt({
        steps: [
          stepRun({ attempts: [attempt('2026-10-20T00:05:00.000Z')] }),
          stepRun({
            supersededInRevision: 2,
            attempts: [attempt('2026-10-20T00:09:00.000Z'), attempt('2026-10-20T00:02:00.000Z')],
          }),
        ],
      }),
    ).toBe('2026-10-20T00:02:00.000Z');
  });

  it('a decision pause on the goal’s own checks points at Acceptance, not at steps none of which is marked (#780 UX P3-5)', () => {
    const goal = goalRun({ status: 'paused', pauseReason: 'needs_decision' });
    const budget = goalBudgetRows(goal, zh);
    const round = (status: 'failed' | 'unavailable' | 'passed') => ({
      round: 1,
      planRevision: 1,
      openedAt: '2026-10-20T01:00:00.000Z',
      checks: [{ checkKey: 'keep', kind: 'observe_absent' as const, status }],
    });
    const acceptance = (status: 'failed' | 'unavailable' | 'passed') =>
      ({
        rounds: [round(status)],
        steps: [],
        absenceBaselines: [],
        overriddenChecks: [],
      }) as unknown as GoalDetailWire['acceptance'];
    for (const status of ['failed', 'unavailable'] as const) {
      expect(
        goalStateNote({ ...goal, acceptance: acceptance(status), steps: [] }, undefined, budget, zh)
          ?.text,
      ).toBe('需要人决定：目标的验收检查没通过，或者做不了。见下面「验收」里标出的检查。');
    }
    // A failed step is what the person decides on: the steps are marked.
    const failedStep = { status: 'failed' } as unknown as GoalDetailWire['steps'][number];
    expect(
      goalStateNote(
        { ...goal, acceptance: acceptance('failed'), steps: [failedStep] },
        undefined,
        budget,
        zh,
      )?.text,
    ).toMatch(/^需要人决定：验收没通过/);
    expect(
      goalStateNote({ ...goal, acceptance: acceptance('passed'), steps: [] }, undefined, budget, zh)
        ?.text,
    ).toMatch(/^需要人决定：验收没通过/);
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

  it('an action with no platform check says a person checks it, and how a removal could be checked by the platform', () => {
    const text = unresolvedActionText(unresolved(), false, zh);
    expect(text.needs).toMatch(/生效了吗/);
    expect(text.check).toMatch(
      /^这一步没有为它声明平台核对，只能由人核对。删除这类动作也能交给平台核对：在这一步加一条核对声明/,
    );
    // #799 review #501 P3-2: both halves — the step's own reconcile declaration and the check.
    expect(text.check).toMatch(/计划里还要有同一个调用的“不存在”验收检查/);
    expect(unresolvedActionText(unresolved({ needs: 'decision' }), false, zh).needs).toMatch(
      /重新执行，或者改计划/,
    );
  });

  it('a platform check that never saw the thing before the action says so (S11 「门确认不存在」 reconcile)', () => {
    const check = (lastError: string) =>
      unresolved({
        platformCheck: {
          status: 'unavailable',
          attempts: 0,
          lastError,
          observationId: null,
          nextAttemptAt: null,
        },
      });
    expect(unresolvedActionText(check('never_seen_present'), false, zh).check).toBe(
      '平台核对不了：动作之前平台没有看到过它在，就算门回答它不在，也证明不了是这个动作删掉的，所以平台没有去问门。要有人核对后记下结果。',
    );
    expect(unresolvedActionText(check('gate_unreachable'), false, zh).check).toMatch(
      /^平台核对不了（观察被拒绝或一直没有答复）/,
    );
    // #799 UX P2-2: the line under it names the code only where the sentence has not said it —
    // never_seen_present there is the runner not asking the gate, not an acceptance check's look.
    expect(unresolvedCheckErrorText(check('never_seen_present'), zh)).toBeNull();
    expect(unresolvedCheckErrorText(check('gate_unreachable'), zh)).toBe(
      checkErrorLabel('gate_unreachable', zh),
    );
    expect(unresolvedCheckErrorText(unresolved(), zh)).toBeNull();
  });

  it('reads a reconcile absence call as what it asks, a predicate as an observation (#799 UX P3-2)', () => {
    const gatekeeperId = '66000000-0000-4000-8000-0000000000d1';
    const absence = { gatekeeperId, operation: 'vm.get', params: { name: 'old' } };
    expect(reconcileCheckSentence(absence, 'vm-gate', zh)).toBe(
      '在门「vm-gate」上以参数 {"name":"old"} 调用 vm.get，看要查的东西还在不在',
    );
    expect(reconcileCheckSentence({ gatekeeperId, operation: 'vm.get' }, 'vm-gate', zh)).toBe(
      '在门「vm-gate」上调用 vm.get，看要查的东西还在不在',
    );
    expect(reconcileCheckSentence(absence, 'vm-gate', zh)).not.toMatch(/才算通过/);
    const predicate = { ...absence, expect: { path: 'state', op: 'eq' as const, value: 'gone' } };
    expect(reconcileCheckSentence(predicate, 'vm-gate', zh)).toBe(
      observationSentence(predicate, 'vm-gate', zh),
    );
  });

  it('names the absence check whose look a reconcile absence call goes by — the step’s, else the goal’s', () => {
    const gatekeeperId = '66000000-0000-4000-8000-0000000000d1';
    const call = { gatekeeperId, operation: 'vm.get', params: { name: 'old', zone: 'a' } };
    // The same call, its params in another order.
    const reordered = { params: { zone: 'a', name: 'old' }, operation: 'vm.get', gatekeeperId };
    const goalCheck = { kind: 'observe_absent' as const, key: 'gone', check: reordered };
    const stepCheck = { kind: 'observe_absent' as const, key: 'removed', check: call };
    expect(reconcileAbsenceCheckOf([goalCheck], [stepCheck], call)).toEqual({
      key: 'removed',
      ofGoal: false,
    });
    expect(reconcileAbsenceCheckOf([goalCheck], [], call)).toEqual({ key: 'gone', ofGoal: true });
    expect(
      reconcileAbsenceCheckOf([goalCheck], [], { ...call, params: { name: 'other' } }),
    ).toBeNull();
    expect(
      reconcileAbsenceCheckOf([goalCheck], [stepCheck], {
        ...call,
        expect: { path: 'state', op: 'eq', value: 'gone' },
      }),
    ).toBeNull();
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

  it('an absence check reads as the gate answering “not there”, in both languages (S11 「门确认不存在」 B)', () => {
    const check = { gatekeeperId: '66000000-0000-4000-8000-0000000000d1', operation: 'svc.lookup' };
    expect(observationSentence(check, 'svc-gate', zh)).toBe(
      '在门「svc-gate」上调用 svc.lookup，门回答“要查的东西不存在”才算通过',
    );
    expect(observationSentence({ ...check, params: { name: 'old-web' } }, 'svc-gate', en)).toBe(
      'Call svc.lookup with {"name":"old-web"} on gate “svc-gate”; passes only when the gate answers that the thing looked up does not exist',
    );
    expect(
      planCheckSentence(
        { kind: 'observe_absent', key: 'gone', check },
        new Map([[check.gatekeeperId, 'svc-gate']]),
        zh,
      ),
    ).toMatch(/^在门「svc-gate」上调用 svc\.lookup，门回答/);
    expect(checkKindLabel('observe_absent', zh)).toBe('平台确认不存在');
    expect(checkKindLabel('observe_absent', en)).toBe('Platform confirms it is not there');
    expect(checkErrorLabel('presence_not_confirmed', zh)).toBe(
      '门回答了，但回答里看不出它在（空结果，或者不符合 Operation 声明的结果映射）',
    );
    expect(checkErrorLabel('target_still_present', zh)).toBe(
      '它还在：门返回了它，而不是回答它不存在',
    );
    expect(checkErrorLabel('absence_not_declared', zh)).toMatch(/没有声明哪些回答表示不存在/);
    expect(checkErrorLabel('absence_not_reviewed', en)).toMatch(/^Nobody confirmed/);
  });

  it('lists the plan’s absence checks, the goal’s before each step’s, and keys them by gate and Operation', () => {
    const gone = { gatekeeperId: '66000000-0000-4000-8000-0000000000d1', operation: 'svc.lookup' };
    const plan: GoalPlan = {
      steps: [
        {
          key: 'remove',
          worker: { definitionId: '66000000-0000-4000-8000-0000000000e1', version: 1 },
          input: {},
          dependsOn: [],
          acceptance: [
            { kind: 'observe_absent', key: 'step-gone', check: { ...gone, operation: 'svc.find' } },
            {
              kind: 'observe_predicate',
              key: 'seen',
              check: { ...gone, expect: { path: 'n', op: 'eq', value: 0 } },
            },
          ],
        },
      ],
      acceptance: [
        { kind: 'requester_confirm', key: 'ok', prompt: 'Looks right?' },
        { kind: 'observe_absent', key: 'gone', check: gone },
      ],
    };
    expect(planAbsenceChecks(plan)).toEqual([
      { key: 'gone', stepKey: null, check: gone },
      { key: 'step-gone', stepKey: 'remove', check: { ...gone, operation: 'svc.find' } },
    ]);
    expect(absenceOperationKey(gone)).toBe('66000000-0000-4000-8000-0000000000d1::svc.lookup');
    expect(planAbsenceChecks({ steps: [] })).toEqual([]);
  });

  it('a check’s last error reads in words where the code is known, as its code otherwise', () => {
    expect(checkErrorLabel('predicate_unsatisfied', zh)).toBe('结果不符合期望');
    expect(checkErrorLabel('fact_not_observed', zh)).toMatch(/^没看到能作证据的事实/);
    expect(checkErrorLabel('gate_timeout', zh)).toBe('上次没成功（代码 gate_timeout）');
    // #786 UX P3: inside a sentence that already says the try failed, only why.
    expect(checkErrorReason('gate_timeout', en)).toBe('code gate_timeout');
    expect(checkErrorReason('gate_unreachable', zh)).toBe('连不上门');
    expect(checkErrorLabel('gate_unreachable', zh)).toBe('连不上门');
  });
});

describe('outputProblemText (S11 GO5d-1)', () => {
  const SCHEMA: OutputSchema = {
    type: 'object',
    properties: {
      hosts: {
        type: 'array',
        items: { type: 'string', minLength: 2, maxLength: 3 },
        minItems: 1,
        maxItems: 1,
      },
      count: { type: 'integer', minimum: 0, maximum: 9 },
      mode: { enum: ['fast', 'safe'] },
      kind: { const: 'cert' },
      flag: { type: ['boolean', 'null'] },
    },
    required: ['hosts', 'count'],
    additionalProperties: false,
  };

  it('puts every message the kernel writes in Chinese, and leaves the English as sent', () => {
    const messages = [
      ...validateOutput(SCHEMA, {
        hosts: ['a', 'abcd', 7],
        mode: 'slow',
        kind: 'key',
        flag: 1,
        extra: true,
      }).problems,
      ...validateOutput(SCHEMA, { hosts: [], count: -1 }).problems,
      ...validateOutput(SCHEMA, { hosts: ['ab', 'cd'], count: 10 }).problems,
      ...validateOutput(
        { type: 'object', properties: { xs: { type: 'array', items: {} } } },
        {
          xs: Array.from({ length: 10_001 }, () => 0),
        },
      ).problems,
      ...outputContractProblems(SCHEMA, undefined).problems,
    ].map((problem) => problem.message);
    expect(new Set(messages).size).toBeGreaterThanOrEqual(13);
    for (const message of messages) {
      const text = outputProblemText(message, zh);
      expect(text, message).not.toBe(message);
      expect(text, message).toMatch(/^[\u4e00-\u9fff]/);
      expect(outputProblemText(message, en)).toBe(message);
    }
    expect(outputProblemText('expected boolean or null, got integer', zh)).toBe(
      '应为是/否或空值，实际是整数',
    );
    expect(outputProblemText('required, missing', zh)).toBe('必填，但没有');
    expect(outputProblemText('something new', zh)).toBe('something new');
  });
});

describe('goalMilestoneText (S11 GO5e-2)', () => {
  const en: Translate = (_zh, enText) => enText;
  const base: GoalMilestone = {
    change: null,
    status: 'running',
    pauseReason: null,
    heldByOwner: false,
    outcome: null,
    outcomeBasis: null,
    cleanupPending: false,
    revision: null,
  };

  it('every change has its own sentence in both languages', () => {
    for (const translate of [zh, en]) {
      const texts = GOAL_RUN_CHANGE_VALUES.map((change) =>
        goalMilestoneText({ ...base, change }, translate),
      );
      expect(new Set(texts).size).toBe(GOAL_RUN_CHANGE_VALUES.length);
      expect(texts).not.toContain(goalMilestoneText(base, translate));
    }
  });

  it('a lifted hold says the goal is still paused, and why, when the pause it took over stays (#737 UX P3-1)', () => {
    expect(
      goalMilestoneText(
        { ...base, change: 'release_hold', status: 'paused', pauseReason: 'authority_lost' },
        zh,
      ),
    ).toBe('锁定已解除；目标仍暂停：请求人缺少授权');
    expect(goalMilestoneText({ ...base, change: 'release_hold', status: 'paused' }, zh)).toBe(
      '锁定已解除，你可以继续这个目标',
    );
  });

  it('a pause says why, a completion how it ended and on what, a revision its number', () => {
    expect(goalMilestoneText({ ...base, change: 'pause', pauseReason: 'needs_decision' }, zh)).toBe(
      '目标已暂停：需要人决定',
    );
    expect(
      goalMilestoneText(
        { ...base, change: 'complete', outcome: 'not_achieved', outcomeBasis: 'requester' },
        en,
      ),
    ).toBe('Goal ended as not achieved · On the requester’s word');
    expect(
      goalMilestoneText(
        { ...base, change: 'complete', outcome: 'not_achieved', outcomeBasis: 'requester' },
        zh,
      ),
    ).toBe('目标按未达成结束 · 依据请求人确认');
    expect(
      goalMilestoneText(
        { ...base, change: 'complete', outcome: 'achieved', outcomeBasis: 'verified_by_check' },
        zh,
      ),
    ).toBe('目标已达成 · 依据平台验收检查');
    expect(goalMilestoneText({ ...base, change: 'complete' }, zh)).toBe('目标已结束');
    expect(goalMilestoneText({ ...base, change: 'revise', revision: 3 }, zh)).toContain('第 3 版');
    expect(goalMilestoneText({ ...base, change: 'finish_cancel', cleanupPending: true }, zh)).toBe(
      '目标已取消，还有遗留要清理',
    );
  });
});
