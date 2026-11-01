import type { PlanHint } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  inheritedBaseFields,
  specListAgainst,
  stepAdmissionReasons,
  stepAdmissionText,
  stepAdmissionView,
  workerSpecBaseOf,
} from './worker-spec-detail.js';

const zh: Translate = (text) => text;

const trial = {
  specDigest: 'sha256:spec',
  drafts: [
    {
      skillId: '00000000-0000-4000-8000-000000000001',
      version: 2,
      name: 'triage',
      draftDigest: 'sha256:draft',
      proposedBy: '00000000-0000-4000-8000-000000000002',
    },
  ],
};

describe('a WorkerSpec against its definition (S11 GO15a)', () => {
  it('reads what the definition sets, and leaves out what it does not or cannot be read', () => {
    expect(
      workerSpecBaseOf({
        systemPrompt: 'You renew certificates.',
        name: 'renewer',
        model: 'model-a',
        skills: ['triage'],
        gates: 'not-a-list',
        capabilities: [],
      }),
    ).toEqual({ name: 'renewer', model: 'model-a', skills: ['triage'], capabilities: [] });
    expect(workerSpecBaseOf({ systemPrompt: 'x', name: '', model: '' })).toEqual({ name: null });
  });

  it('says what a list keeps, drops and adds, each in its own list’s order', () => {
    expect(specListAgainst(['a', 'b', 'c'], ['c', 'd', 'a'])).toEqual({
      kept: ['c', 'a'],
      removed: ['b'],
      added: ['d'],
    });
    expect(specListAgainst(undefined, ['a'])).toEqual({ kept: [], removed: [], added: ['a'] });
  });

  it('keeps from the definition only the fields it sets and the step leaves alone', () => {
    const base = workerSpecBaseOf({ systemPrompt: 'x', model: 'model-a', skills: ['triage'] });
    expect(inheritedBaseFields({ skills: ['renew'] }, base)).toEqual(['model']);
    expect(inheritedBaseFields({ model: 'model-b', skills: [] }, base)).toEqual([]);
  });
});

describe('the step’s admission verdict (S11 GO15a)', () => {
  const refused: PlanHint = { code: 'step_model_not_allowed', message: 'm', stepKey: 'a' };
  const draft: PlanHint = { code: 'step_skill_draft', message: 'm', stepKey: 'a', trial };

  it('is the kernel’s verdict for a step the read checked', () => {
    const view = stepAdmissionView({ hints: [refused], checkedStepKeys: ['a'] }, 'a', null, []);
    expect(view).toEqual({ kind: 'checked', admission: { verdict: 'refused', hints: [refused] } });
    expect(stepAdmissionText(view, zh)).toBe('准入：现在不会开始');
    expect(stepAdmissionReasons(view, zh)).toEqual(['模型不允许']);
    const approval = stepAdmissionView({ hints: [draft], checkedStepKeys: ['a'] }, 'a', null, []);
    expect(stepAdmissionText(approval, zh)).toBe('准入：要有人批准试用它的 Skill 草稿才会开始');
    expect(stepAdmissionReasons(approval, zh)).toEqual(['Skill 还是草稿']);
    const run = stepAdmissionView({ hints: [refused], checkedStepKeys: ['b'] }, 'b', null, []);
    expect(stepAdmissionText(run, zh)).toBe('准入：可以开始');
    expect(stepAdmissionReasons(run, zh)).toEqual([]);
  });

  it('a step the read did not check says it was admitted when it started, or is checked then', () => {
    const none = { hints: [], checkedStepKeys: [] };
    const started = stepAdmissionView(none, 'a', { attemptCount: 1 }, []);
    expect(stepAdmissionText(started, zh)).toBe('准入：第 1 次尝试开始时已准入');
    const trialled = stepAdmissionView(none, 'a', { attemptCount: 2 }, [{ state: 'used' }]);
    expect(stepAdmissionText(trialled, zh)).toBe('准入：第 1 次尝试开始时，经试用批准后准入');
    expect(stepAdmissionText(stepAdmissionView(none, 'a', { attemptCount: 0 }, []), zh)).toBe(
      '准入：开始时由平台检查（现在不检查）',
    );
    expect(stepAdmissionText(stepAdmissionView(none, 'a', null, [{ state: 'used' }]), zh)).toBe(
      '准入：开始时由平台检查（现在不检查）',
    );
  });

  it('names the plan-wide refusal that stops every step', () => {
    const view = stepAdmissionView(
      {
        hints: [{ code: 'requester_cannot_start_workers', message: 'm' }],
        checkedStepKeys: ['a'],
      },
      'a',
      null,
      [],
    );
    expect(stepAdmissionReasons(view, zh)).toEqual([
      expect.stringMatching(/^请求人现在不能启动 Worker$/),
    ]);
  });
});
