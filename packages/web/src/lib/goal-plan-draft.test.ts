import { describe, expect, it } from 'vitest';
import { WORKER_ID, goalDetail, stepRun } from '../components/goals/goal-fixtures.test-helpers.js';
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
const paused = (overrides: Parameters<typeof goalDetail>[0] = {}) =>
  goalDetail({ status: 'paused', pauseReason: 'requested', ...overrides });

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
      usage: { tokens: 0, steps: 0, revisions: 3 },
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
    expect(problems.get(`step:${uid('fetch')}:input`)).toMatch(/此处原文已遮蔽，请重新填写/);
    expect(problems.get('budget:maxRevisions')).toMatch(/这是第 4 次修订，上限至少要 4/);

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

  it('an ended step with masked input can only be removed', () => {
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
    const fetch = draft.steps[0];
    expect(draftProblems(draft, detail, zh).get(`step:${fetch?.uid}:input`)).toMatch(
      /把它从计划里移除/,
    );
    expect(draftProblems(withStep(draft, 'fetch', { removed: true }), detail, zh).size).toBe(0);
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
  });
});
