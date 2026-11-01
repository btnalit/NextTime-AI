import { describe, expect, it } from 'vitest';
import {
  GATE_ID,
  WORKER_ID,
  goalDetail,
  stepRun,
} from '../components/goals/goal-fixtures.test-helpers.js';
import {
  type PlanDraft,
  budgetOf,
  draftFromDetail,
  draftProblems,
  emptyStep,
  fieldOfProblem,
  fieldOfRefusal,
  planOf,
  removalsOf,
  requesterConfirmDraft,
  supersededLiveSteps,
} from './goal-plan-draft.js';
import { planDiff } from './goals.js';
import type { Translate } from './i18n.js';

const zh: Translate = (zhText) => zhText;
// Confirmed a few minutes ago, so the wall-clock budget is not spent yet.
const paused = (overrides: Parameters<typeof goalDetail>[0] = {}) =>
  goalDetail({
    status: 'paused',
    pauseReason: 'requested',
    confirmedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  });

const withStep = (draft: PlanDraft, key: string, patch: Partial<PlanDraft['steps'][number]>) => ({
  ...draft,
  steps: draft.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
});

describe('lib/goal-plan-draft', () => {
  it('seeded from the plan in force and left alone, it is that plan: nothing changes, no budget sent', () => {
    const detail = paused();
    const draft = draftFromDetail(detail);
    const plan = planOf(draft);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(planDiff(detail.planRevision.plan, plan)).toEqual({
      added: [],
      removed: [],
      changed: [],
      acceptanceChanged: false,
    });
    expect(budgetOf(draft, detail.budget)).toBeNull();
    expect(draftProblems(draft, detail, zh).size).toBe(0);
  });

  it('a chosen field changes only its step; a removed step and a new one read as such', () => {
    const detail = paused();
    let draft = withStep(draftFromDetail(detail), 'apply', { maxAttempts: '4' });
    draft = withStep(draft, 'fetch', { removed: true });
    draft = withStep(draft, 'apply', { dependsOn: [] });
    draft = {
      ...draft,
      steps: [
        ...draft.steps,
        { ...emptyStep(), key: 'notify', definitionId: WORKER_ID, version: '2' },
      ],
    };
    const plan = planOf(draft);
    if (plan === null) throw new Error('plan');
    expect(planDiff(detail.planRevision.plan, plan)).toMatchObject({
      added: ['notify'],
      removed: ['fetch'],
      changed: ['apply'],
    });
    const apply = plan.steps.find((step) => step.key === 'apply');
    expect(apply?.maxAttempts).toBe(4);
    expect(apply?.dependsOn).toBeUndefined();
  });

  it('keeps an unchanged dependency list in its own order', () => {
    const detail = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          steps: [
            { key: 'a', worker: { definitionId: WORKER_ID, version: 1 } },
            { key: 'b', worker: { definitionId: WORKER_ID, version: 1 } },
            { key: 'c', worker: { definitionId: WORKER_ID, version: 1 }, dependsOn: ['b', 'a'] },
          ],
        },
      },
      steps: [],
    });
    const draft = withStep(draftFromDetail(detail), 'c', { dependsOn: ['a', 'b'] });
    expect(planOf(draft)?.steps[2]?.dependsOn).toEqual(['b', 'a']);
  });

  it('flags on its field what the kernel would refuse, a masked text among them', () => {
    const detail = paused({
      usage: { tokens: 0, steps: 0, revisions: 3, plannerTokens: 0 },
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          steps: [
            {
              key: 'fetch',
              worker: { definitionId: WORKER_ID, version: 2 },
              input: { auth: '[redacted]' },
            },
            { key: 'apply', worker: { definitionId: WORKER_ID, version: 2 } },
          ],
        },
      },
    });
    let draft = draftFromDetail(detail);
    const uid = (key: string) => draft.steps.find((step) => step.key === key)?.uid ?? '';
    let problems = draftProblems(draft, detail, zh);
    // Left as read, the masked input is sent as it is: the kernel keeps the original (GO5c).
    expect(problems.get(`step:${uid('fetch')}:input`)).toBeUndefined();
    expect(problems.get('budget:maxRevisions')).toMatch(/这是第 4 次修订，上限至少要 4/);

    // Changed, it must not keep the mark.
    draft = withStep(draft, 'fetch', { inputText: '{"auth": "[redacted]", "hosts": 3}' });
    problems = draftProblems(draft, detail, zh);
    expect(problems.get(`step:${uid('fetch')}:input`)).toMatch(/此处原文已遮蔽，请重新填写/);

    draft = withStep(draft, 'fetch', { inputText: '{"auth": "the deploy key"}' });
    draft = withStep(draft, 'apply', { key: 'bad key', dependsOn: ['gone'] });
    problems = draftProblems(draft, detail, zh);
    expect(problems.get(`step:${uid('fetch')}:input`)).toBeUndefined();
    expect(problems.get(`step:${uid('bad key')}:key`)).toMatch(/步骤名用字母或数字开头/);
    expect(problems.get(`step:${uid('bad key')}:dependsOn`)).toMatch(/gone/);

    draft = withStep(draft, 'bad key', { key: 'apply', dependsOn: ['fetch'] });
    draft = withStep(draft, 'fetch', { dependsOn: ['apply'] });
    expect([...draftProblems(draft, detail, zh).values()].join()).toMatch(/依赖成环/);
  });

  it('an ended step whose input reads masked is kept as it is', () => {
    const detail = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          steps: [
            {
              key: 'fetch',
              worker: { definitionId: WORKER_ID, version: 2 },
              input: { auth: '[redacted]' },
            },
            { key: 'apply', worker: { definitionId: WORKER_ID, version: 2 } },
          ],
        },
      },
      steps: [stepRun({ status: 'succeeded' })],
    });
    const draft = draftFromDetail(detail);
    expect(draftProblems(draft, detail, zh).size).toBe(0);
    expect(planOf(draft)?.steps[0]?.input).toEqual({ auth: '[redacted]' });
  });

  it('a requester confirmation is written here, its prompt required', () => {
    const detail = paused();
    const draft = draftFromDetail(detail);
    const confirm = requesterConfirmDraft(draft);
    const next = { ...draft, acceptance: [...draft.acceptance, confirm] };
    expect(draftProblems(next, detail, zh).get(`check:${confirm.uid}:prompt`)).toMatch(
      /写上要请求人确认什么/,
    );
    const written = {
      ...next,
      acceptance: next.acceptance.map((check) =>
        check.uid === confirm.uid ? { ...check, prompt: '三台主机都换好了' } : check,
      ),
    };
    expect(planOf(written)?.acceptance?.[1]).toEqual({
      kind: 'requester_confirm',
      key: 'requester-confirm',
      prompt: '三台主机都换好了',
    });
  });

  it('a changed budget is sent whole; wall clock typed in minutes', () => {
    const detail = paused();
    const draft = draftFromDetail(detail);
    expect(draft.budget.maxWallClockMinutes).toBe('120');
    expect(
      budgetOf({ ...draft, budget: { ...draft.budget, maxWallClockMinutes: '90' } }, detail.budget),
    ).toEqual({ maxTokens: 100000, maxSteps: 10, maxRevisions: 3, maxWallClockSeconds: 5400 });
  });

  it('asks about live steps it supersedes, and sends only the ones let to finish', () => {
    const detail = paused({
      steps: [
        stepRun({
          actions: [
            {
              actionRequestId: 'ar-1',
              status: 'pending_approval',
              failureKind: null,
              failureCode: null,
              reconciliation: null,
            },
          ],
        }),
        stepRun({ id: 'sr-apply', stepKey: 'apply', status: 'pending', attempts: [] }),
      ],
    });
    let draft = withStep(draftFromDetail(detail), 'fetch', { removed: true });
    draft = withStep(draft, 'apply', { removed: true });
    draft = {
      ...draft,
      steps: [...draft.steps, { ...emptyStep(), key: 'n', definitionId: WORKER_ID, version: '2' }],
    };
    expect(supersededLiveSteps(draft, detail)).toEqual(['fetch']);
    expect(removalsOf(draft, detail)).toBeNull();
    const finish = {
      ...draft,
      removals: {
        fetch: { mode: 'let_finish' as const, release: ['ar-1'] },
        apply: { mode: 'let_finish' as const },
      },
    };
    expect(removalsOf(finish, detail)).toEqual({
      fetch: { mode: 'let_finish', release: ['ar-1'] },
    });
  });

  it('puts a refusal’s field and a plan problem on the step or check they name', () => {
    const detail = paused();
    const draft = withStep(draftFromDetail(detail), 'fetch', { removed: true });
    const apply = draft.steps.find((step) => step.key === 'apply');
    const check = draft.acceptance[0];
    expect(fieldOfRefusal('reason', draft)).toBe('reason');
    // The first step sent is `apply` — `fetch` is removed.
    expect(fieldOfRefusal('plan.steps.0.input.host', draft)).toBe(`step:${apply?.uid}:input`);
    expect(fieldOfRefusal('plan.steps[0].input', draft)).toBe(`step:${apply?.uid}:input`);
    expect(fieldOfRefusal('plan.acceptance.0.prompt', draft)).toBe(`check:${check?.uid}:prompt`);
    expect(fieldOfRefusal('plan.steps.7.input', draft)).toBe('plan');
    expect(fieldOfRefusal('statement', draft)).toBe('plan');
    expect(fieldOfProblem('steps.0.worker: Required', draft)).toBe(`step:${apply?.uid}`);
    expect(fieldOfProblem('step "apply" depends on "x", which is not in the plan', draft)).toBe(
      `step:${apply?.uid}`,
    );
    expect(fieldOfProblem('the plan is larger than 262144 bytes', draft)).toBe('plan');
    expect(fieldOfProblem('acceptance[0] "certs": unknown gatekeeper', draft)).toBe(
      `check:${check?.uid}`,
    );
    expect(fieldOfProblem('step "apply": acceptance[0] "x": prompt is empty', draft)).toBe(
      `step:${apply?.uid}`,
    );
    expect(fieldOfRefusal('plan.steps.0.reconcile.0.check.params.token', draft)).toBe(
      `step:${apply?.uid}`,
    );
    expect(fieldOfRefusal('plan.acceptance.0.check.params.token', draft)).toBe(
      `check:${check?.uid}`,
    );
  });

  it('a masked part the editor cannot change is sent as read; changed texts may not keep a mark', () => {
    const base = goalDetail().planRevision;
    const detail = paused({
      planRevision: {
        ...base,
        plan: {
          steps: [
            base.plan.steps[0] as NonNullable<(typeof base.plan.steps)[number]>,
            {
              ...(base.plan.steps[1] as NonNullable<(typeof base.plan.steps)[number]>),
              reconcile: [
                {
                  action: { gatekeeperId: GATE_ID, operation: 'cert.replace' },
                  check: {
                    gatekeeperId: GATE_ID,
                    operation: 'cert.get',
                    params: { token: '[redacted]' },
                    expect: { path: 'ok', op: 'eq', value: true },
                  },
                },
              ],
            },
          ],
          acceptance: [
            {
              kind: 'observe_predicate',
              key: 'certs',
              check: {
                gatekeeperId: GATE_ID,
                operation: 'cert.list',
                params: { auth: '[redacted]' },
                expect: { path: 'expiring', op: 'eq', value: 0 },
              },
            },
          ],
        },
      },
    });
    const draft = draftFromDetail(detail);
    expect(draftProblems(draft, detail, zh).size).toBe(0);
    expect(planOf(draft)).toEqual(detail.planRevision.plan);

    // A reason, and a confirmation's changed prompt, are written here: neither may keep a mark or
    // a shown escape; a confirmation's prompt left as read may.
    const confirm = { ...requesterConfirmDraft(draft), prompt: 'done\\u{200D}' };
    const written = {
      ...draft,
      reason: 'why [redacted]',
      acceptance: [...draft.acceptance, confirm],
    };
    const problems = draftProblems(written, detail, zh);
    expect(problems.get('reason')).toMatch(/此处原文已遮蔽/);
    expect(problems.get(`check:${confirm.uid}:prompt`)).toMatch(/看不见的字符/);
  });

  it('a changed input showing an unseen character as a read writes it is held back', () => {
    const detail = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          steps: [
            {
              key: 'fetch',
              worker: { definitionId: WORKER_ID, version: 2 },
              input: { note: 'a\\u{200D}b' },
            },
          ],
        },
      },
      steps: [],
    });
    let draft = draftFromDetail(detail);
    const fetch = draft.steps[0];
    expect(draftProblems(draft, detail, zh).size).toBe(0);
    draft = withStep(draft, 'fetch', { inputText: '{"note": "a\\\\u{200D}b", "hosts": 2}' });
    expect(draftProblems(draft, detail, zh).get(`step:${fetch?.uid}:input`)).toMatch(
      /看不见的字符/,
    );
    draft = withStep(draft, 'fetch', { inputText: '{"note": "ab", "hosts": 2}' });
    expect(draftProblems(draft, detail, zh).size).toBe(0);
  });

  it('a budget limit at or under what is used already is held on its field', () => {
    const detail = paused({ usage: { tokens: 48200, steps: 3, revisions: 0, plannerTokens: 0 } });
    const draft = draftFromDetail(detail);
    const limits = (budget: Partial<PlanDraft['budget']>) =>
      draftProblems({ ...draft, budget: { ...draft.budget, ...budget } }, detail, zh);
    expect(limits({ maxTokens: '1000' }).get('budget:maxTokens')).toMatch(
      /已用 48,200，上限要比它大/,
    );
    expect(limits({ maxSteps: '3' }).get('budget:maxSteps')).toMatch(/已用 3，上限要比它大/);
    expect(limits({ maxWallClockMinutes: '2' }).get('budget:maxWallClockSeconds')).toMatch(
      /上限要比它大/,
    );
    expect(limits({ maxTokens: '48201', maxSteps: '4', maxWallClockMinutes: '30' }).size).toBe(0);
  });

  it('a goal out of budget may still have what is left of it removed, to go to its checks', () => {
    const detail = paused({
      usage: { tokens: 100000, steps: 3, revisions: 0, plannerTokens: 0 },
      steps: [
        stepRun({ status: 'succeeded' }),
        stepRun({ id: 'sr-apply', stepKey: 'apply', status: 'pending', attempts: [] }),
      ],
    });
    const draft = draftFromDetail(detail);
    expect(draftProblems(draft, detail, zh).get('budget:maxTokens')).toMatch(/上限要比它大/);
    expect(draftProblems(withStep(draft, 'apply', { removed: true }), detail, zh).size).toBe(0);
  });

  it('a masked input left as read under another Worker version must be written again', () => {
    const detail = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          steps: [
            {
              key: 'fetch',
              worker: { definitionId: WORKER_ID, version: 2 },
              input: { auth: '[redacted]' },
            },
          ],
        },
      },
      steps: [],
    });
    const draft = draftFromDetail(detail);
    const fetch = draft.steps[0];
    expect(draftProblems(draft, detail, zh).size).toBe(0);
    const moved = withStep(draft, 'fetch', { version: '3' });
    // About the input only: the person changed the Worker, so nothing says "once this is changed".
    const held = draftProblems(moved, detail, zh).get(`step:${fetch?.uid}:input`);
    expect(held).toMatch(/换了 Worker 或版本.*请把这一段重新写成不带凭据的输入/);
    expect(held).not.toMatch(/改了这一项/);
    expect(
      draftProblems(withStep(moved, 'fetch', { inputText: '{"auth": "见运维手册"}' }), detail, zh)
        .size,
    ).toBe(0);
  });
});
