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
  canAddReview,
  draftFromDetail,
  draftProblems,
  emptyStep,
  fieldOfProblem,
  fieldOfRefusal,
  hasRequesterConfirm,
  newReviewCriterion,
  planContractNotes,
  planOf,
  removalsOf,
  requesterConfirmDraft,
  reviewChanged,
  reviewCheckDraft,
  shownOnly,
  showsMask,
  skillRefUse,
  specChanged,
  specDraftOf,
  specOf,
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

  it('S11 GO13 (UX on #880): says, before sending, what the revision adopts and the contract hints the kernel will give', () => {
    const detail = paused();
    const report = {
      type: 'object' as const,
      properties: { summary: { type: 'string' as const } },
    };
    const hostsIn = {
      type: 'object' as const,
      properties: { hosts: { type: 'array' as const } },
      required: ['hosts'],
    };
    const definitions = [
      {
        id: WORKER_ID,
        version: 2,
        kind: 'worker',
        status: 'published',
        definition: { name: 'w', outputSchema: report, inputSchema: hostsIn },
      },
    ];
    // In force: both steps on v2, neither sets an output contract; fetch's input `{hosts: 3}`
    // does not meet `hosts: array`; apply has no input at all, which does not either.
    let draft = draftFromDetail(detail);
    let plan = planOf(draft);
    if (plan === null) throw new Error('no plan');
    expect(planContractNotes(draft, plan, definitions)).toEqual({
      adopted: [],
      unused: ['fetch', 'apply'],
      inputMismatch: ['fetch', 'apply'],
    });
    // Adopting on fetch and fixing its input: adopted, and only apply is left with hints.
    draft = withStep(draft, 'fetch', {
      adoptedOutputSchema: report,
      inputText: '{"hosts": ["a"]}',
    });
    plan = planOf(draft);
    if (plan === null) throw new Error('no plan');
    expect(planContractNotes(draft, plan, definitions)).toEqual({
      adopted: ['fetch'],
      unused: ['apply'],
      inputMismatch: ['apply'],
    });
    // A masked input is the kernel's to check; a removed step and an unlisted version say nothing.
    draft = withStep(draft, 'fetch', { inputText: '{"hosts": "[redacted]"}' });
    draft = withStep(draft, 'apply', { removed: true });
    plan = planOf(draft);
    if (plan === null) throw new Error('no plan');
    expect(planContractNotes(draft, plan, definitions)).toEqual({
      adopted: ['fetch'],
      unused: [],
      inputMismatch: [],
    });
    expect(planContractNotes(draft, plan, undefined)).toEqual({
      adopted: ['fetch'],
      unused: [],
      inputMismatch: [],
    });
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
      usage: { tokens: 0, steps: 0, revisions: 3, plannerTokens: 0, plannerRounds: 0 },
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

  it('legacy 444: a key the read masked is the mark too — left as read it is sent as it is, changed it is flagged', () => {
    const detail = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          steps: [
            {
              key: 'fetch',
              worker: { definitionId: WORKER_ID, version: 2 },
              input: { headers: { 'Bearer [redacted]': true } },
            },
            { key: 'apply', worker: { definitionId: WORKER_ID, version: 2 } },
          ],
        },
      },
    });
    expect(showsMask({ headers: { 'Bearer [redacted]': true } })).toBe(true);
    expect(shownOnly({ headers: { 'Bearer [redacted]': true } })).toBe('mask');
    // Escapes are spelled out in values only: a key that looks like one is not taken for one.
    expect(shownOnly({ '\\u{200D}': 'x' })).toBeNull();
    let draft = draftFromDetail(detail);
    const uid = (key: string) => draft.steps.find((step) => step.key === key)?.uid ?? '';
    expect(draftProblems(draft, detail, zh).get(`step:${uid('fetch')}:input`)).toBeUndefined();
    draft = withStep(draft, 'fetch', {
      inputText: '{"headers": {"Bearer [redacted]": true}, "hosts": 3}',
    });
    expect(draftProblems(draft, detail, zh).get(`step:${uid('fetch')}:input`)).toMatch(
      /此处原文已遮蔽，请重新填写/,
    );
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
    const detail = paused({
      usage: { tokens: 48200, steps: 3, revisions: 0, plannerTokens: 0, plannerRounds: 0 },
    });
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
      usage: { tokens: 100000, steps: 3, revisions: 0, plannerTokens: 0, plannerRounds: 0 },
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

  it('S11 GO14: keeps a step’s filesFrom as read, sends a changed one, and says before sending when what it reads is not ticked or not in the plan', () => {
    const base = paused();
    const plan = base.planRevision.plan;
    const detail = paused({
      planRevision: {
        ...base.planRevision,
        plan: {
          ...plan,
          steps: [
            plan.steps[0] as (typeof plan.steps)[number],
            { ...(plan.steps[1] as (typeof plan.steps)[number]), filesFrom: ['fetch'] },
          ],
        },
      },
    });
    const draft = draftFromDetail(detail);
    expect(planOf(draft)?.steps[1]?.filesFrom).toEqual(['fetch']);
    expect(draftProblems(draft, detail, zh).size).toBe(0);
    const apply = draft.steps.find((step) => step.key === 'apply');
    if (!apply) throw new Error('apply');

    // Reading none: the field leaves the step (undefined is left out on the wire).
    expect(
      planOf(withStep(draft, 'apply', { filesFrom: [] }))?.steps[1]?.filesFrom,
    ).toBeUndefined();
    // A new step that makes the files again, read instead (UX P2-1 on #884).
    const remade = {
      ...draft,
      steps: [
        ...draft.steps,
        { ...emptyStep(), key: 'fetch-2', definitionId: WORKER_ID, version: '2' },
      ],
    };
    const rewired = withStep(remade, 'apply', {
      dependsOn: ['fetch', 'fetch-2'],
      filesFrom: ['fetch-2'],
    });
    expect(draftProblems(rewired, detail, zh).size).toBe(0);
    expect(planOf(rewired)?.steps[1]).toMatchObject({
      key: 'apply',
      dependsOn: ['fetch', 'fetch-2'],
      filesFrom: ['fetch-2'],
    });

    const unticked = withStep(draft, 'apply', { dependsOn: [] });
    expect(draftProblems(unticked, detail, zh).get(`step:${apply.uid}:filesFrom`)).toBe(
      '这一步读取步骤 fetch 留下的文件，必须排在它之后：在上面把它勾回来，或者取消读取它的文件。',
    );
    const removed = withStep(draft, 'fetch', { removed: true });
    expect(draftProblems(removed, detail, zh).get(`step:${apply.uid}:filesFrom`)).toBe(
      '这一步读取步骤 fetch 留下的文件，那一步不在计划里了：恢复那一步，或者在下面取消读取它的文件。',
    );
    // The kernel's own problem with what a step reads lands on that field.
    expect(fieldOfProblem('step "apply": filesFrom[0] "x" is not a step of the plan', draft)).toBe(
      `step:${apply.uid}:filesFrom`,
    );
  });

  it('S11 GO15b: a WorkerSpec draft stands for the WorkerSpec it sets, keeping what is left as read', () => {
    const original = {
      instructions: 'Only the hosts.',
      skills: ['b', 'a'],
      observeScope: [GATE_ID],
      tokenBudget: 1000,
    };
    const draft = specDraftOf(original);
    expect(draft).toEqual({
      instructions: 'Only the hosts.',
      skills: ['b', 'a'],
      gates: null,
      capabilities: null,
      model: '',
      observeScope: [GATE_ID],
      tokenBudget: '1000',
    });
    // Come back to as read — the very object, whatever order its lists were ticked in.
    expect(specOf(draft, original)).toBe(original);
    expect(specOf({ ...draft, skills: ['a', 'b'] }, original)).toBe(original);
    // A list kept as a set keeps the plan's order; a changed one is as ticked; empty is a list.
    expect(specOf({ ...draft, model: 'model-b', skills: ['a', 'b'] }, original)).toEqual({
      ...original,
      model: 'model-b',
    });
    expect(specOf({ ...draft, skills: ['a', 'b'] }, original)?.skills).toEqual(['b', 'a']);
    expect(specOf({ ...draft, gates: [] }, original)).toEqual({ ...original, gates: [] });
    // Nothing set: no WorkerSpec at all; a cap not a whole number: no plan yet.
    expect(specOf(specDraftOf(undefined), original)).toBeUndefined();
    expect(specOf({ ...draft, tokenBudget: '1.5' }, original)).toBeNull();
  });

  it('S11 GO15b: a changed WorkerSpec is sent, and a step with one is held where the kernel would refuse it', () => {
    const spec = { instructions: 'Use token [redacted] only.', skills: ['cert-rotation'] };
    const detail = paused({
      planRevision: {
        ...goalDetail().planRevision,
        plan: {
          ...goalDetail().planRevision.plan,
          steps: [
            { key: 'fetch', worker: { definitionId: WORKER_ID, version: 2 }, spec },
            ...goalDetail().planRevision.plan.steps.slice(1),
          ],
        },
      },
    });
    const draft = draftFromDetail(detail);
    const [fetch] = draft.steps;
    if (!fetch) throw new Error('no fetch');
    expect(planOf(draft)?.steps[0]?.spec).toBe(spec);
    expect(specChanged(fetch)).toBe(false);
    expect(draftProblems(draft, detail, zh).size).toBe(0);
    // Another field changed: the masked responsibility left as read counts as written anew.
    const model = withStep(draft, 'fetch', { spec: { ...fetch.spec, model: 'model-b' } });
    const problems = draftProblems(model, detail, zh);
    expect(problems.get(`step:${fetch.uid}:spec.instructions`)).toMatch(
      /^改了这一步对 Worker 的调整，这一段说明就按新写的算/,
    );
    expect(planOf(model)?.steps[0]?.spec).toEqual({ ...spec, model: 'model-b' });
    // Written anew without the mark: nothing held.
    const rewritten = withStep(draft, 'fetch', {
      spec: { ...fetch.spec, model: 'model-b', instructions: 'Use the deploy token only.' },
    });
    expect(draftProblems(rewritten, detail, zh).has(`step:${fetch.uid}:spec.instructions`)).toBe(
      false,
    );
    // A cap that is not a whole number above 0, or over the limit; a responsibility of blanks.
    const capped = (tokenBudget: string) =>
      draftProblems(
        withStep(draft, 'fetch', { spec: { ...fetch.spec, tokenBudget } }),
        detail,
        zh,
      ).get(`step:${fetch.uid}:spec.tokenBudget`);
    expect(capped('0')).toBe('填一个大于 0 的整数，或者清空。');
    expect(capped('abc')).toBe('填一个大于 0 的整数，或者清空。');
    expect(capped('20000000')).toMatch(/^最多 /);
    expect(capped('2000')).toBeUndefined();
    const blank = withStep(draft, 'fetch', { spec: { ...fetch.spec, instructions: '   ' } });
    expect(draftProblems(blank, detail, zh).get(`step:${fetch.uid}:spec.instructions`)).toBe(
      '只有空白：写上这一步的说明，或者清空。',
    );
  });

  it('S11 GO15b: what the kernel finds in a WorkerSpec lands on that field', () => {
    const draft = draftFromDetail(paused());
    const [fetch] = draft.steps;
    if (!fetch) throw new Error('no fetch');
    expect(fieldOfProblem('step "fetch": spec: skills that are not there: "x"', draft)).toBe(
      `step:${fetch.uid}:spec.skills`,
    );
    expect(
      fieldOfProblem(
        'step "fetch": spec: observeScope — Gatekeepers this workspace does not have: "g"',
        draft,
      ),
    ).toBe(`step:${fetch.uid}:spec.observeScope`);
    expect(
      fieldOfProblem('step "fetch": spec: capabilities a Worker can never hold: "x"', draft),
    ).toBe(`step:${fetch.uid}:spec.capabilities`);
    // Unknown wording stays on the step.
    expect(fieldOfProblem('step "fetch": spec: something else', draft)).toBe(`step:${fetch.uid}`);
    expect(fieldOfProblem('steps.0.spec.tokenBudget: Too big', draft)).toBe(
      `step:${fetch.uid}:spec.tokenBudget`,
    );
    expect(fieldOfRefusal('plan.steps.0.spec.instructions', draft)).toBe(
      `step:${fetch.uid}:spec.instructions`,
    );
    expect(fieldOfRefusal('plan.steps.0.spec', draft)).toBe(`step:${fetch.uid}`);
  });

  it('classes a Skill reference as the kernel does when a step starts (UX P2-1 on #889)', () => {
    const published = { id: 'f-1', name: 'triage', status: 'published' };
    // A family whose latest is a draft still has its published version (`inUse`).
    const pending = {
      id: 'f-2',
      name: 'renew',
      status: 'draft',
      inUse: { id: 'f-2', name: 'renew', status: 'published', version: 1, description: '' },
    };
    const draftOnly = { id: 'f-3', name: 'scan', status: 'draft' };
    const rows = [published, pending, draftOnly];
    expect(skillRefUse(rows, 'triage')).toBe('published');
    expect(skillRefUse(rows, 'f-1')).toBe('published');
    expect(skillRefUse(rows, 'renew')).toBe('published');
    expect(skillRefUse(rows, 'scan')).toBe('draft');
    expect(skillRefUse(rows, 'f-3')).toBe('draft');
    // Not listed (its versions deprecated, or gone): a step naming it does not start.
    expect(skillRefUse(rows, 'legacy')).toBe('unusable');
    expect(skillRefUse([{ id: 'f-4', name: 'old', status: 'deprecated' }], 'old')).toBe('unusable');
  });
});

describe('lib/goal-plan-draft: an independent review (S11 GO18b)', () => {
  const REVIEW = {
    kind: 'review' as const,
    key: 'quality',
    subjects: ['fetch', 'apply'],
    criteria: [
      { key: 'complete', description: 'Every host is listed', weight: 3 },
      { key: 'clear', description: 'Each line says why', weight: 1 },
    ],
    passAt: 75,
    model: 'model-b',
  };
  const reviewed = (review: Record<string, unknown> = REVIEW) => {
    const base = goalDetail().planRevision;
    return paused({
      planRevision: {
        ...base,
        plan: { ...base.plan, acceptance: [...(base.plan.acceptance ?? []), review as never] },
      },
    });
  };
  const reviewOf = (draft: PlanDraft) => {
    const check = draft.acceptance.find((item) => item.review !== null);
    if (check?.review == null) throw new Error('no review in the draft');
    return { check, review: check.review };
  };
  const withReview = (
    draft: PlanDraft,
    patch: (
      review: NonNullable<PlanDraft['acceptance'][number]['review']>,
    ) => Partial<NonNullable<PlanDraft['acceptance'][number]['review']>>,
  ): PlanDraft => ({
    ...draft,
    acceptance: draft.acceptance.map((check) =>
      check.review === null
        ? check
        : { ...check, review: { ...check.review, ...patch(check.review) } },
    ),
  });

  it('a review left alone goes back as the plan’s own check, whatever was ticked off and on', () => {
    const detail = reviewed();
    const draft = draftFromDetail(detail);
    const { check, review } = reviewOf(draft);
    expect(review).toMatchObject({ subjects: ['fetch', 'apply'], passAt: '75', model: 'model-b' });
    expect(review.criteria.map((criterion) => [criterion.key, criterion.weight])).toEqual([
      ['complete', '3'],
      ['clear', '1'],
    ]);
    expect(reviewChanged(check)).toBe(false);
    // Unticked and ticked again: another order, the same steps — still the plan's own check.
    const again = withReview(draft, () => ({ subjects: ['apply', 'fetch'] }));
    expect(planOf(again)?.acceptance?.[1]).toBe(detail.planRevision.plan.acceptance?.[1]);
    expect(reviewChanged(reviewOf(again).check)).toBe(false);
    expect(draftProblems(again, detail, zh).size).toBe(0);
  });

  it('a changed review is sent as the editor holds it: weights and the line as numbers, no model for the requester’s', () => {
    const detail = reviewed();
    const draft = withReview(draftFromDetail(detail), (review) => ({
      criteria: review.criteria.map((criterion) =>
        criterion.key === 'clear' ? { ...criterion, weight: '2' } : criterion,
      ),
      passAt: '80',
      model: '',
    }));
    expect(reviewChanged(reviewOf(draft).check)).toBe(true);
    expect(planOf(draft)?.acceptance?.[1]).toEqual({
      kind: 'review',
      key: 'quality',
      subjects: ['fetch', 'apply'],
      criteria: [
        { key: 'complete', description: 'Every host is listed', weight: 3 },
        { key: 'clear', description: 'Each line says why', weight: 2 },
      ],
      passAt: 80,
    });
    expect(
      planDiff(detail.planRevision.plan, planOf(draft) ?? { steps: [] }).acceptanceChanged,
    ).toBe(true);
  });

  it('a new review reviews what the plan ends with, one criterion to write, 75%, the requester’s model; keys are made up, never typed', () => {
    const detail = paused();
    const draft = draftFromDetail(detail);
    const added = reviewCheckDraft(draft);
    // `apply` comes after `fetch`: the plan ends with `apply`.
    expect(added).toMatchObject({ original: null, key: 'review', removed: false });
    expect(added.review).toMatchObject({ subjects: ['apply'], passAt: '75', model: '' });
    expect(added.review?.criteria.map((criterion) => [criterion.key, criterion.weight])).toEqual([
      ['c1', '1'],
    ]);
    const two = { ...draft, acceptance: [...draft.acceptance, added] };
    expect(reviewCheckDraft(two).key).toBe('review-2');
    // Not a confirmation: 加一条请求人确认 stays offered.
    expect(hasRequesterConfirm(two)).toBe(false);
    // A criterion added never takes a key the review has or had.
    const plan = reviewed();
    const kept = draftFromDetail(plan);
    const { check, review } = reviewOf(kept);
    const fewer = { ...review, criteria: review.criteria.filter((item) => item.key !== 'clear') };
    expect(newReviewCriterion(fewer, check.original).key).toBe('c1');
    expect(
      newReviewCriterion(
        {
          ...review,
          criteria: [...review.criteria, { ...newReviewCriterion(review, null), key: 'c1' }],
        },
        check.original,
      ).key,
    ).toBe('c2');
    expect(
      newReviewCriterion(fewer, {
        ...REVIEW,
        criteria: [...REVIEW.criteria, { key: 'c1', description: 'x', weight: 1 }],
      }).key,
    ).toBe('c2');
  });

  it('holds before sending what the kernel would refuse, each on its own field', () => {
    const detail = reviewed();
    const draft = draftFromDetail(detail);
    const { check, review } = reviewOf(draft);
    const [first, second] = review.criteria;
    if (!first || !second) throw new Error('two criteria');
    const none = withReview(draft, () => ({ subjects: [] }));
    expect(draftProblems(none, detail, zh).get(`check:${check.uid}:subjects`)).toBe(
      '勾选要评审的步骤，至少一步。',
    );
    const gone = withStep(
      withReview(draft, () => ({})),
      'fetch',
      { removed: true },
    );
    // `apply` depended on `fetch` too; the review's own problem is on its steps.
    expect(draftProblems(gone, detail, zh).get(`check:${check.uid}:subjects`)).toMatch(
      /^要评审的步骤不在计划里了：fetch。/,
    );
    const blank = withReview(draft, (current) => ({
      criteria: current.criteria.map((item) =>
        item.uid === second.uid ? { ...item, description: '  ' } : item,
      ),
    }));
    expect(
      draftProblems(blank, detail, zh).get(`check:${check.uid}:criterion:${second.uid}`),
    ).toMatch(/^写上这条标准/);
    const long = withReview(draft, (current) => ({
      criteria: current.criteria.map((item) =>
        item.uid === first.uid ? { ...item, description: 'x'.repeat(1001) } : item,
      ),
    }));
    expect(draftProblems(long, detail, zh).get(`check:${check.uid}:criterion:${first.uid}`)).toBe(
      '最多 1000 个字符。',
    );
  });

  it('a criterion a read shows with an unseen character goes back as stored while the review is left alone, and must be written again once it changes', () => {
    const shown = {
      ...REVIEW,
      criteria: [
        { key: 'complete', description: 'Every\\u{200B}host', weight: 3 },
        REVIEW.criteria[1],
      ],
    };
    const detail = reviewed(shown);
    const draft = draftFromDetail(detail);
    const { check, review } = reviewOf(draft);
    expect(draftProblems(draft, detail, zh).size).toBe(0);
    const changed = withReview(draft, () => ({ passAt: '90' }));
    const first = review.criteria[0];
    expect(
      draftProblems(changed, detail, zh).get(`check:${check.uid}:criterion:${first?.uid}`),
    ).toMatch(/\\u\{…\}/);
  });

  it('puts the kernel’s word about a review on the field it names', () => {
    const detail = reviewed();
    const draft = draftFromDetail(detail);
    const { check, review } = reviewOf(draft);
    const second = review.criteria[1];
    expect(fieldOfRefusal('plan.acceptance.1.criteria.1.description', draft)).toBe(
      `check:${check.uid}:criterion:${second?.uid}`,
    );
    expect(fieldOfRefusal('plan.acceptance.1.subjects.0', draft)).toBe(
      `check:${check.uid}:subjects`,
    );
    expect(fieldOfRefusal('plan.acceptance.1.passAt', draft)).toBe(`check:${check.uid}:passAt`);
    expect(fieldOfRefusal('plan.acceptance.1.model', draft)).toBe(`check:${check.uid}:model`);
    expect(
      fieldOfProblem(
        'acceptance[1] "quality": criteria[1] "clear": the description looks like it carries a credential (1 suspected) — a plan does not carry credentials',
        draft,
      ),
    ).toBe(`check:${check.uid}:criterion:${second?.uid}`);
    expect(
      fieldOfProblem(
        'acceptance[1] "quality": reviews step "gone", which is not in the plan',
        draft,
      ),
    ).toBe(`check:${check.uid}:subjects`);
    expect(
      fieldOfProblem(
        'acceptance[1] "quality": model — one this workspace does not allow: "model-b"',
        draft,
      ),
    ).toBe(`check:${check.uid}:model`);
    expect(
      fieldOfProblem('acceptance[1] "quality": a plan has at most 4 review checks', draft),
    ).toBe(`check:${check.uid}`);
    // Another kind of check stays the check.
    const certs = draft.acceptance[0];
    expect(fieldOfProblem('acceptance[0] "certs": model — not a word a predicate has', draft)).toBe(
      `check:${certs?.uid}`,
    );
  });

  it('offers another review only under the plan’s limits', () => {
    let draft = draftFromDetail(paused());
    for (let n = 0; n < 4; n += 1) {
      expect(canAddReview(draft)).toBe(true);
      draft = { ...draft, acceptance: [...draft.acceptance, reviewCheckDraft(draft)] };
    }
    expect(canAddReview(draft)).toBe(false);
    // Four is allowed: all that is left to do is to write each one's first criterion.
    expect([...draftProblems(draft, paused(), zh).keys()]).toEqual(
      draft.acceptance
        .filter((check) => check.review !== null)
        .map((check) => `check:${check.uid}:criterion:${check.review?.criteria[0]?.uid}`),
    );
    // A removed one of the plan's, restored past the limit, is held on that check.
    const fifth = { ...reviewCheckDraft(draft), original: REVIEW, removed: false };
    const over = { ...draft, acceptance: [...draft.acceptance, fifth] };
    expect(draftProblems(over, paused(), zh).get(`check:${fifth.uid}`)).toMatch(
      /最多 4 条独立评审/,
    );
  });
});
