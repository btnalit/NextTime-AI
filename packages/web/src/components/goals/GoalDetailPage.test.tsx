// @vitest-environment jsdom
import type { GoalAbsenceBaselineWire, GoalDetailWire, PlanRevisionWire } from '@nexttime/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, type PushSource, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { hrefs } from '../../lib/router.js';
import type { TaskUpdatedPush } from '../../lib/ws-client.js';
import { GoalDetailPage } from './GoalDetailPage.js';
import { GATE_ID, goalDetail, stepRun } from './goal-fixtures.test-helpers.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown>,
): CapabilityCaller & { readonly calls: { name: string; params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function baseHandlers(detail: GoalDetailWire, unresolved: unknown[] = []) {
  return {
    get_goal: () => detail,
    list_goal_unresolved_actions: () => ({ items: unresolved }),
    list_gatekeepers: () => ({ items: [{ id: GATE_ID, name: 'cert-gate' }] }),
    resolve_refs: () => ({ items: [] }),
  };
}

function renderPage(http: CapabilityCaller, pushes: PushSource = SILENT_PUSH_SOURCE) {
  return render(
    <PermissionsProvider>
      <GoalDetailPage http={http} pushes={pushes} goalRunId="goal-1" />
    </PermissionsProvider>,
  );
}

describe('GoalDetailPage (S11 GO6, read-only)', () => {
  it('lists the plan’s steps in order with their state, attempts and dependencies, and the plan’s checks as sentences', async () => {
    const http = scriptedHttp(baseHandlers(goalDetail()));
    renderPage(http);

    const steps = await screen.findAllByTestId('goal-step');
    expect(steps.map((step) => step.getAttribute('data-step-key'))).toEqual(['fetch', 'apply']);
    expect(steps[0]?.getAttribute('data-step-status')).toBe('running');
    expect(within(steps[0] as HTMLElement).getByTestId('goal-step-attempts').textContent).toMatch(
      /尝试 1\/3/,
    );
    expect(steps[1]?.textContent).toMatch(/在这些步骤之后：fetch/);
    expect(within(steps[1] as HTMLElement).getByTestId('goal-step-attempts').textContent).toMatch(
      /尝试 0\/2/,
    );
    await waitFor(() =>
      expect(screen.getByTestId('goal-plan-check').textContent).toMatch(
        /在门「cert-gate」上观察 cert\.list，期望 expiring 等于 0/,
      ),
    );
    expect(screen.getByTestId('goal-acceptance-not-started')).toBeTruthy();
    // Who reads is not known yet (get_workspace unanswered): no operation is offered.
    expect(screen.queryByTestId('goal-operations')).toBeNull();
  });

  it('a goal judged by an independent review says that is not counted toward attainment; one the platform checked does not (S11 W1a)', async () => {
    const reviewed = scriptedHttp(
      baseHandlers(
        goalDetail({ status: 'completed', outcome: 'achieved', outcomeBasis: 'reviewer_assessed' }),
      ),
    );
    renderPage(reviewed);
    const status = await screen.findByTestId('goal-status');
    expect(within(status).getByTestId('outcome-proxy-note').textContent).toContain(
      '代理指标，不计入达成率',
    );
    cleanup();

    const checked = scriptedHttp(
      baseHandlers(
        goalDetail({ status: 'completed', outcome: 'achieved', outcomeBasis: 'verified_by_check' }),
      ),
    );
    renderPage(checked);
    expect(await screen.findByText('依据平台验收检查')).toBeTruthy();
    expect(screen.queryByTestId('outcome-proxy-note')).toBeNull();
  });

  it('a goal it may not see reads as not found, without saying which', async () => {
    const http = scriptedHttp({
      ...baseHandlers(goalDetail()),
      get_goal: () => {
        throw new HttpError('capability_error', 'GoalRun not found', 'not_found');
      },
    });
    renderPage(http);
    expect((await screen.findByTestId('goal-not-found')).textContent).toMatch(
      /不存在，或者你看不到它/,
    );
  });

  it('a goal paused for a check: the pending platform check waits for it to go on', async () => {
    const detail = goalDetail({
      status: 'paused',
      pauseReason: 'awaiting_reconcile',
      steps: [
        stepRun({
          status: 'waiting',
          waitingReason: 'reconcile',
          actions: [
            {
              actionRequestId: 'ar-1',
              status: 'failed',
              failureKind: 'outcome_unknown',
              failureCode: null,
              reconciliation: null,
            },
          ],
        }),
      ],
    });
    const http = scriptedHttp(
      baseHandlers(detail, [
        {
          actionRequestId: 'ar-1',
          stepRunId: 'sr-fetch',
          stepKey: 'fetch',
          gatekeeperId: GATE_ID,
          actionKindTag: 'cert.replace',
          failedAt: '2026-10-20T00:05:00.000Z',
          needs: 'finding',
          platformCheck: {
            status: 'pending',
            attempts: 2,
            lastError: null,
            observationId: null,
            nextAttemptAt: null,
          },
        },
      ]),
    );
    renderPage(http);
    expect((await screen.findByTestId('goal-unresolved-check')).textContent).toBe(
      '核对已暂停，继续后再核对。',
    );
    expect(screen.getByTestId('goal-state-note').textContent).toMatch(/有动作结果不明/);
    expect(screen.getByTestId('goal-step-waiting').textContent).toMatch(/等核对动作是否生效/);
    // Whether it took effect is the open question: it reads as unknown, never as failed first.
    const stepAction = screen.getByTestId('goal-step-action');
    expect(stepAction.textContent).toMatch(/结果不明/);
    expect(stepAction.textContent).not.toMatch(/失败/);
  });

  it('once every finding is recorded, a goal paused for a check says it can go on', async () => {
    const http = scriptedHttp(
      baseHandlers(goalDetail({ status: 'paused', pauseReason: 'awaiting_reconcile' }), []),
    );
    renderPage(http);
    await waitFor(() =>
      expect(screen.getByTestId('goal-state-note').textContent).toBe('核对已记录，可以继续。'),
    );
    expect(screen.queryByTestId('goal-unresolved')).toBeNull();
  });

  it('a proposal names, step by step, what the requester could not start now — a gate by its name', async () => {
    const base = goalDetail();
    const detail = goalDetail({
      status: 'proposed',
      planRevision: {
        ...base.planRevision,
        status: 'proposed',
        hints: [
          { code: 'requester_confirm_only', message: 'only on the requester’s word' },
          {
            code: 'step_capability_not_held',
            message: 'step "fetch": …',
            stepKey: 'fetch',
            capabilityNames: ['request_action'],
          },
          {
            code: 'step_gate_not_held',
            message: 'step "apply": …',
            stepKey: 'apply',
            gatekeeperIds: [GATE_ID],
          },
        ],
      },
    });
    renderPage(scriptedHttp(baseHandlers(detail)));
    // The requester's authority over steps heads the steps card, the missing permission by name…
    const hints = await screen.findAllByTestId('goal-step-hint');
    expect(hints.map((hint) => hint.textContent)).toEqual([
      expect.stringContaining(
        '步骤「fetch」的 Worker 需要执行权限「发起动作请求」，请求人现在没有',
      ),
      expect.stringContaining('步骤「apply」'),
    ]);
    await waitFor(() => expect(hints[1]?.textContent).toContain('门「cert-gate」'));
    for (const hint of hints) expect(screen.getByTestId('goal-steps').contains(hint)).toBe(true);
    // …and each step it names carries a chip.
    const chipsOf = (key: string) =>
      within(
        screen
          .getAllByTestId('goal-step')
          .find((row) => row.dataset.stepKey === key) as HTMLElement,
      )
        .queryAllByTestId('goal-step-hint-chip')
        .map((chip) => chip.textContent);
    expect(chipsOf('fetch')).toEqual(['请求人无权限']);
    expect(chipsOf('apply')).toEqual(['请求人无权限']);
    // How the goal is verified stays with acceptance.
    expect(screen.getAllByTestId('goal-plan-hint').map((hint) => hint.textContent)).toEqual([
      expect.stringContaining('只凭请求人确认'),
    ]);
  });

  it('S11 GO8a: a step with a WorkerSpec shows what it sets for its Worker, and the confirmation card what its admission says', async () => {
    const base = goalDetail();
    const OBSERVE_ID = '44444444-4444-4444-8444-444444444444';
    const detail = goalDetail({
      status: 'proposed',
      planRevision: {
        ...base.planRevision,
        status: 'proposed',
        plan: {
          ...base.planRevision.plan,
          steps: [
            {
              key: 'fetch',
              worker: {
                definitionId: base.planRevision.plan.steps[0]?.worker.definitionId ?? '',
                version: 2,
              },
              spec: {
                instructions: 'Only the hosts in the input.',
                skills: ['cert-rotation'],
                gates: [GATE_ID],
                capabilities: ['request_action'],
                model: 'small-model',
                observeScope: [OBSERVE_ID],
                tokenBudget: 5000,
              },
            },
            ...base.planRevision.plan.steps.slice(1),
          ],
        },
        hints: [
          {
            code: 'step_skill_draft',
            message: 'step "fetch": …',
            stepKey: 'fetch',
            skillRefs: ['cert-rotation'],
          },
        ],
      },
    });
    renderPage(scriptedHttp(baseHandlers(detail)));
    const spec = await screen.findByTestId('goal-step-spec');
    expect(spec.textContent).toContain(
      '这一步对 Worker 的调整：职责说明、Skill、门、能力范围、模型、观察范围、每次尝试的 Token 上限',
    );
    expect(within(spec).getByTestId('goal-step-spec-instructions').textContent).toBe(
      'Only the hosts in the input.',
    );
    expect(within(spec).getByTestId('goal-step-spec-skills').textContent).toBe('cert-rotation');
    // A capability by its console name, never as the code; a gate by its name.
    expect(within(spec).getByTestId('goal-step-spec-capabilities').textContent).toBe(
      '发起动作请求',
    );
    await waitFor(() =>
      expect(within(spec).getByTestId('goal-step-spec-gate').textContent).toContain('cert-gate'),
    );
    expect(within(spec).getByTestId('goal-step-spec-model').textContent).toBe('small-model');
    expect(within(spec).getAllByTestId('goal-step-spec-observe-gate')).toHaveLength(1);
    expect(within(spec).getByTestId('goal-step-spec-token-budget').textContent).toBe(
      (5000).toLocaleString(),
    );
    expect(spec.textContent).toContain('不会超出 Worker 能有的上限和请求人现在的权限');
    // The step without one shows none.
    const apply = screen
      .getAllByTestId('goal-step')
      .find((row) => row.dataset.stepKey === 'apply') as HTMLElement;
    expect(within(apply).queryByTestId('goal-step-spec')).toBeNull();
    // What its admission says heads the card — a proposal can be turned down — with a chip.
    const [hint] = screen.getAllByTestId('goal-step-hint');
    expect(hint?.textContent).toMatch(
      /^步骤「fetch」的 Worker 要用 Skill「cert-rotation」，它还只是草稿，没有发布：.*发布它再确认，或者驳回/,
    );
    const fetch = screen
      .getAllByTestId('goal-step')
      .find((row) => row.dataset.stepKey === 'fetch') as HTMLElement;
    expect(
      within(fetch)
        .getAllByTestId('goal-step-hint-chip')
        .map((chip) => chip.textContent),
    ).toEqual(['Skill 还是草稿']);
  });

  it('S11 GO8a: a run paused at a step that did not start says which step and why, the step’s note worded for a plan in force', async () => {
    const detail = goalDetail({
      status: 'paused',
      pauseReason: 'needs_decision',
      steps: [
        stepRun({ status: 'ready', attemptCount: 0, attempts: [] }),
        stepRun({
          id: 'sr-apply',
          stepKey: 'apply',
          status: 'pending',
          attemptCount: 0,
          attempts: [],
        }),
      ],
      planRevision: {
        ...goalDetail().planRevision,
        hints: [
          {
            code: 'step_model_not_allowed',
            message: 'step "fetch": …',
            stepKey: 'fetch',
            model: 'big-model',
          },
        ],
      },
    });
    renderPage(scriptedHttp(baseHandlers(detail)));
    expect((await screen.findByTestId('goal-state-note')).textContent).toBe(
      '需要人决定：步骤「fetch」给 Worker 设定的模型「big-model」不在这个工作区允许的模型里，这一步没有开始。见下面「步骤」里的说明。',
    );
    const [hint] = screen.getAllByTestId('goal-step-hint');
    expect(hint?.textContent).toMatch(
      /平台管理员可以在「平台 → 工作区」里允许它，或者再修订计划，换掉它或移除这一步。$/,
    );
    expect(hint?.textContent).not.toContain('驳回');
  });

  it('legacy 513: a step on a gate where the requester has not connected their account says so, with where to connect it; a refused action says why', async () => {
    const base = goalDetail();
    const proposal = goalDetail({
      status: 'proposed',
      planRevision: {
        ...base.planRevision,
        status: 'proposed',
        hints: [
          {
            code: 'step_account_not_connected',
            message: 'step "apply": …',
            stepKey: 'apply',
            gatekeeperIds: [GATE_ID],
          },
        ],
      },
    });
    const { unmount } = renderPage(scriptedHttp(baseHandlers(proposal)));
    const [hint] = await screen.findAllByTestId('goal-step-hint');
    expect(hint?.textContent).toContain('请求人还没有在这个门上连接账户');
    expect(
      within(hint as HTMLElement)
        .getByTestId('goal-step-hint-connect')
        .getAttribute('href'),
    ).toBe(hrefs.systems());
    expect(
      within(
        screen
          .getAllByTestId('goal-step')
          .find((row) => row.dataset.stepKey === 'apply') as HTMLElement,
      )
        .getAllByTestId('goal-step-hint-chip')
        .map((chip) => chip.textContent),
    ).toEqual(['请求人未连接账户']);
    unmount();

    const failed = goalDetail({
      status: 'paused',
      steps: [
        stepRun({
          status: 'failed',
          actions: [
            {
              actionRequestId: 'ar-1',
              status: 'failed',
              failureKind: 'refused',
              failureCode: 'credential_unavailable',
              reconciliation: null,
            },
          ],
        }),
      ],
    });
    renderPage(scriptedHttp(baseHandlers(failed)));
    const reason = await screen.findByTestId('goal-step-action-reason');
    expect(reason.textContent).toContain('门上没有这次调用可用的凭证');
    expect(reason.textContent).not.toContain('credential_unavailable');
  });

  it('a cancel that left work running lists the leftovers', async () => {
    const http = scriptedHttp(
      baseHandlers(
        goalDetail({
          status: 'cancelled',
          cleanupPending: true,
          endedAt: '2026-10-20T01:00:00.000Z',
          leftovers: {
            liveTaskIds: ['task-left'],
            executingActions: [
              {
                actionRequestId: 'ar-left',
                stepRunId: 'sr-fetch',
                gatekeeperId: GATE_ID,
                actionKindTag: 'cert.replace',
              },
            ],
          },
        }),
      ),
    );
    renderPage(http);
    expect((await screen.findByTestId('goal-state-note')).textContent).toMatch(/有残留/);
    expect(screen.getAllByTestId('goal-leftover-task')).toHaveLength(1);
    expect(screen.getAllByTestId('goal-leftover-action')).toHaveLength(1);
  });

  it('a revision’s changes are read on demand, against the revision it was based on', async () => {
    const base = goalDetail();
    const v2Plan = {
      ...base.planRevision.plan,
      steps: [
        base.planRevision.plan.steps[0],
        { key: 'verify', worker: base.planRevision.plan.steps[0]?.worker },
      ],
    } as PlanRevisionWire['plan'];
    const v2: PlanRevisionWire = {
      ...base.planRevision,
      id: 'rev-2',
      revision: 2,
      basedOnRevision: 1,
      plan: v2Plan,
      proposedBy: 'p-alice',
      reason: '证书已经在另一台上换过了',
      removals: { apply: { mode: 'terminate' } },
    };
    const { plan: _plan, hints: _hints, ...v2Summary } = v2;
    const detail = goalDetail({
      currentRevision: 2,
      planRevision: v2,
      revisions: [...base.revisions, v2Summary],
    });
    const http = scriptedHttp({
      ...baseHandlers(detail),
      get_goal_revision: (params) => {
        expect(params).toEqual({ goalRunId: 'goal-1', revision: 1 });
        return base.planRevision;
      },
    });
    renderPage(http);
    const revisions = await screen.findAllByTestId('goal-revision');
    expect(revisions.map((item) => item.getAttribute('data-revision'))).toEqual(['2', '1']);
    expect(revisions[0]?.textContent).toMatch(/生效中/);
    expect(revisions[0]?.textContent).toContain('证书已经在另一台上换过了');
    expect(
      within(revisions[0] as HTMLElement).getByTestId('goal-revision-removals').textContent,
    ).toMatch(/移除apply/);
    const diff = within(revisions[0] as HTMLElement).getByTestId(
      'goal-revision-diff',
    ) as HTMLDetailsElement;
    diff.open = true;
    fireEvent(diff, new Event('toggle'));
    const body = await within(diff).findByTestId('goal-revision-diff-body');
    expect(within(body).getByText('verify')).toBeTruthy();
    expect(within(body).getByText('apply')).toBeTruthy();
    expect(http.calls.filter((call) => call.name === 'get_goal_revision')).toHaveLength(1);
  });

  it('a plan made from a Procedure says which version, linked to it — on the plan and on revision 1 (S11 GO5d-2)', async () => {
    const base = goalDetail();
    const source = {
      procedureId: 'proc-1',
      version: 3,
      name: '证书续期',
      parameters: { site: 'main' },
      confirmCheck: null,
    };
    const v2: PlanRevisionWire = {
      ...base.planRevision,
      id: 'rev-2',
      revision: 2,
      basedOnRevision: 1,
      proposedBy: 'p-alice',
      reason: '多加一步',
      fromProcedure: null,
    };
    const { plan: _plan, hints: _hints, ...v2Summary } = v2;
    const [v1Summary] = base.revisions;
    const detail = goalDetail({
      currentRevision: 2,
      planRevision: v2,
      revisions: [
        { ...(v1Summary as (typeof base.revisions)[number]), fromProcedure: source },
        v2Summary,
      ],
    });
    renderPage(scriptedHttp(baseHandlers(detail)));

    const plan = await screen.findByTestId('goal-plan-source');
    expect(plan.parentElement?.textContent).toMatch(/第 1 版 由流程 证书续期 v3 生成/);
    expect(screen.getByTestId('goal-plan-source-link').getAttribute('href')).toBe(
      '#/govern/catalog/procedures/proc-1',
    );
    const revisions = screen.getAllByTestId('goal-revision');
    expect(
      within(revisions[1] as HTMLElement).getByTestId('goal-revision-from-procedure').textContent,
    ).toBe('由流程 证书续期 v3 生成');
    expect(
      within(revisions[0] as HTMLElement).queryByTestId('goal-revision-from-procedure'),
    ).toBeNull();
  });

  it('a plan made from a Procedure shows its start parameters, and which steps the requester’s confirmation came from (legacy 454)', async () => {
    const base = goalDetail();
    const source = {
      procedureId: 'proc-1',
      version: 3,
      name: '证书续期',
      parameters: { site: 'main', port: 443 },
      confirmCheck: { key: 'looks-right', procedureSteps: [2, 4] },
    };
    const planRevision: PlanRevisionWire = {
      ...base.planRevision,
      plan: {
        ...base.planRevision.plan,
        acceptance: [{ kind: 'requester_confirm', key: 'looks-right', prompt: '证书看起来对' }],
      },
      fromProcedure: source,
    };
    const [v1Summary] = base.revisions;
    const detail = goalDetail({
      planRevision,
      revisions: [{ ...(v1Summary as (typeof base.revisions)[number]), fromProcedure: source }],
    });
    renderPage(scriptedHttp(baseHandlers(detail)));

    const parameters = await screen.findByTestId('goal-plan-parameters');
    expect(parameters.textContent).toBe('site = mainport = 443');
    expect(screen.getByTestId('goal-revision-parameters').textContent).toBe(
      'site = mainport = 443',
    );
    const check = screen.getByTestId('goal-plan-check');
    expect(within(check).getByTestId('goal-check-procedure-steps').textContent).toMatch(
      /^来自流程第 2、4 步/,
    );
  });

  it('a start parameter the Procedure describes reads by its description, only from the version the plan was made from (legacy 474)', async () => {
    const base = goalDetail();
    const source = {
      procedureId: 'proc-1',
      version: 3,
      name: '证书续期',
      parameters: { site: 'main', port: 443 },
      confirmCheck: null,
    };
    const [v1Summary] = base.revisions;
    const detail = goalDetail({
      planRevision: { ...base.planRevision, fromProcedure: source },
      revisions: [{ ...(v1Summary as (typeof base.revisions)[number]), fromProcedure: source }],
    });
    const procedure = (version: number) => ({
      id: 'proc-1',
      version,
      status: 'published',
      name: '证书续期',
      description: '续期一个站点的证书',
      steps: [],
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', description: '要续期的站点' },
          port: { type: 'integer' },
        },
      },
      proposedBy: 'p-alice',
    });
    renderPage(
      scriptedHttp({
        ...baseHandlers(detail),
        list_procedures: () => ({ items: [procedure(3)] }),
      }),
    );
    const parameters = await screen.findByTestId('goal-plan-parameters');
    await waitFor(() => expect(parameters.textContent).toBe('要续期的站点 site = mainport = 443'));
    cleanup();

    // The latest version is another: its words may not be the plan's, so names alone.
    renderPage(
      scriptedHttp({
        ...baseHandlers(detail),
        list_procedures: () => ({ items: [procedure(4)] }),
      }),
    );
    expect((await screen.findByTestId('goal-plan-parameters')).textContent).toBe(
      'site = mainport = 443',
    );
  });

  it('start parameters not kept show nothing, and a confirmation not from a Procedure says no step (legacy 454)', async () => {
    const base = goalDetail();
    const source = {
      procedureId: 'proc-1',
      version: 3,
      name: '证书续期',
      parameters: null,
      confirmCheck: null,
    };
    const planRevision: PlanRevisionWire = {
      ...base.planRevision,
      plan: {
        ...base.planRevision.plan,
        acceptance: [{ kind: 'requester_confirm', key: 'looks-right', prompt: '证书看起来对' }],
      },
      fromProcedure: source,
    };
    const [v1Summary] = base.revisions;
    const detail = goalDetail({
      planRevision,
      revisions: [{ ...(v1Summary as (typeof base.revisions)[number]), fromProcedure: source }],
    });
    renderPage(scriptedHttp(baseHandlers(detail)));
    await screen.findByTestId('goal-plan-source');
    expect(screen.queryByTestId('goal-plan-parameters')).toBeNull();
    expect(screen.queryByTestId('goal-check-procedure-steps')).toBeNull();
  });

  it('a Fact check names the Object it gives by id by name and type (legacy 470)', async () => {
    const HOST = '33333333-3333-4333-8333-333333333333';
    const base = goalDetail();
    const detail = goalDetail({
      planRevision: {
        ...base.planRevision,
        plan: {
          ...base.planRevision.plan,
          acceptance: [
            {
              kind: 'fact_predicate',
              key: 'runs-on',
              fact: {
                linkType: 'runs_on',
                source: { objectType: 'Service', identity: { name: 'web' } },
                target: { objectId: HOST },
              },
            },
          ],
        },
      },
    });
    const http = scriptedHttp({
      ...baseHandlers(detail),
      get_object: () => ({
        id: HOST,
        objectType: 'Host',
        identityKey: { hostname: 'host-1' },
        properties: {},
      }),
    });
    renderPage(http);
    const acceptance = await screen.findByTestId('goal-acceptance');
    await waitFor(() =>
      expect(acceptance.textContent).toContain('到 host-1 · Host 的「runs_on」事实'),
    );
    expect(acceptance.textContent).not.toContain('对象 33333333');
    expect(http.calls.filter((call) => call.name === 'get_object')).toEqual([
      { name: 'get_object', params: { objectId: HOST } },
    ]);
  });

  it('an absence check says what its “not there” rests on: the declared answer and who confirmed it, or that nobody did (S11 「门确认不存在」 B)', async () => {
    const base = goalDetail();
    const [fetch, apply] = base.planRevision.plan.steps as [
      (typeof base.planRevision.plan.steps)[number],
      (typeof base.planRevision.plan.steps)[number],
    ];
    const detail = goalDetail({
      planRevision: {
        ...base.planRevision,
        plan: {
          steps: [
            fetch,
            {
              ...apply,
              acceptance: [
                {
                  kind: 'observe_absent',
                  key: 'step-gone',
                  check: { gatekeeperId: GATE_ID, operation: 'svc.find' },
                },
              ],
            },
          ],
          acceptance: [
            {
              kind: 'observe_absent',
              key: 'gone',
              check: {
                gatekeeperId: GATE_ID,
                operation: 'svc.lookup',
                params: { name: 'old-web' },
              },
            },
            {
              kind: 'observe_absent',
              key: 'gone-too',
              check: { gatekeeperId: GATE_ID, operation: 'svc.status' },
            },
          ],
        },
      },
    });
    const row = (name: string, extra: Record<string, unknown>) => ({
      gatekeeperId: GATE_ID,
      name,
      mode: 'observe',
      blastRadius: 'low',
      autoApprovable: true,
      version: 2,
      status: 'published',
      ...extra,
    });
    const operations = [
      row('svc.lookup', {
        absentAnswers: { statuses: [404, 410] },
        absentAnswersReview: { reviewedBy: 'p-owner', reviewedAt: '2026-10-28T00:00:00.000Z' },
      }),
      row('svc.find', { absentAnswers: { statuses: [404] } }),
      row('svc.status', {}),
    ];
    const http = scriptedHttp({
      ...baseHandlers(detail),
      list_operations: (params) => {
        const { q } = params as { q: string };
        return { items: operations.filter((candidate) => candidate.name.includes(q)) };
      },
      resolve_refs: () => ({ items: [{ id: 'p-owner', kind: 'principal', name: 'Owner' }] }),
    });
    renderPage(http);

    const acceptance = await screen.findByTestId('goal-acceptance');
    await waitFor(() =>
      expect(within(acceptance).getAllByTestId('goal-absence-basis')).toHaveLength(2),
    );
    const [lookup, status] = within(acceptance).getAllByTestId('goal-absence-basis') as [
      HTMLElement,
      HTMLElement,
    ];
    expect(lookup.getAttribute('data-basis')).toBe('confirmed');
    expect(lookup.textContent).toContain('目标系统回答 404 或 410 时，门回答“不存在”。');
    await waitFor(() => expect(lookup.textContent).toContain('Owner'));
    expect(lookup.textContent).toContain('确认于');
    expect(status.getAttribute('data-basis')).toBe('none');
    expect(status.textContent).toContain('没有声明哪些回答表示不存在');
    expect(acceptance.textContent).toContain(
      '在门「cert-gate」上以参数 {"name":"old-web"} 调用 svc.lookup，门回答“要查的东西不存在”才算通过',
    );

    const step = (await screen.findAllByTestId('goal-step'))[1] as HTMLElement;
    const stepBasis = await within(step).findByTestId('goal-absence-basis');
    expect(stepBasis.getAttribute('data-basis')).toBe('unconfirmed');
    expect(stepBasis.textContent).toContain('所以平台不做这条检查。');
    expect(within(step).getByTestId('goal-step-check').textContent).toContain('平台确认不存在');
    // One read per Operation, by gate and name.
    expect(
      http.calls
        .filter((call) => call.name === 'list_operations')
        .map((call) => (call.params as { q: string }).q)
        .sort(),
    ).toEqual(['svc.find', 'svc.lookup', 'svc.status']);
  });

  it('an Operation that could not be read says so, apart from one with no published version (review #501 on #780)', async () => {
    const base = goalDetail();
    const detail = goalDetail({
      planRevision: {
        ...base.planRevision,
        plan: {
          ...base.planRevision.plan,
          acceptance: [
            {
              kind: 'observe_absent',
              key: 'gone',
              check: { gatekeeperId: GATE_ID, operation: 'svc.lookup' },
            },
            {
              kind: 'observe_absent',
              key: 'gone-too',
              check: { gatekeeperId: GATE_ID, operation: 'svc.retired' },
            },
          ],
        },
      },
    });
    const http = scriptedHttp({
      ...baseHandlers(detail),
      list_operations: (params) => {
        const { q } = params as { q: string };
        if (q === 'svc.lookup') throw new HttpError('network', 'try again later');
        return { items: [] };
      },
    });
    renderPage(http);

    const acceptance = await screen.findByTestId('goal-acceptance');
    await waitFor(() =>
      expect(within(acceptance).getAllByTestId('goal-absence-basis')).toHaveLength(2),
    );
    const [lookup, retired] = within(acceptance).getAllByTestId('goal-absence-basis') as [
      HTMLElement,
      HTMLElement,
    ];
    expect(lookup.getAttribute('data-basis')).toBe('unreadable');
    expect(lookup.textContent).toContain('这个 Operation 没读出来');
    expect(lookup.textContent).not.toContain('平台做不了这条检查');
    expect(retired.getAttribute('data-basis')).toBe('none');
    expect(retired.textContent).toContain('没有已发布版本，平台做不了这条检查');
  });

  it('under each absence check, how the platform’s look before the goal’s work went: seen there, already not there, could not look, or not yet (S11 「门确认不存在」 B-c)', async () => {
    const base = goalDetail();
    const [fetch, apply] = base.planRevision.plan.steps as [
      (typeof base.planRevision.plan.steps)[number],
      (typeof base.planRevision.plan.steps)[number],
    ];
    const absence = (key: string) => ({
      kind: 'observe_absent' as const,
      key,
      check: { gatekeeperId: GATE_ID, operation: 'svc.lookup', params: { name: key } },
    });
    const look = (stepKey: string | null, checkKey: string, extra: Record<string, unknown>) => ({
      stepKey,
      checkKey,
      take: 1,
      look: 1,
      status: 'pending' as const,
      attempts: 0,
      lastError: null,
      observationId: null,
      createdAt: '2026-10-29T00:00:00.000Z',
      settledAt: null,
      ...extra,
    });
    const detail = goalDetail({
      status: 'paused',
      planRevision: {
        ...base.planRevision,
        plan: {
          steps: [fetch, { ...apply, acceptance: [absence('step-gone')] }],
          acceptance: [absence('seen'), absence('never'), absence('later')],
        },
      },
      // No step has started: every look came before the goal's work.
      steps: base.steps.map((step) => ({ ...step, attemptCount: 0, attempts: [] })),
      acceptance: {
        ...base.acceptance,
        absenceBaselines: [
          look(null, 'seen', {
            status: 'seen_present',
            attempts: 1,
            observationId: 'obs-seen-0001',
            settledAt: '2026-10-29T00:01:00.000Z',
          }),
          look(null, 'never', {
            take: 2,
            look: 2,
            status: 'never_seen_present',
            attempts: 1,
            observationId: 'obs-never-0001',
            settledAt: '2026-10-29T00:02:00.000Z',
          }),
          look('apply', 'step-gone', {
            status: 'unavailable',
            attempts: 1,
            lastError: 'operation_refused',
            settledAt: '2026-10-29T00:03:00.000Z',
          }),
        ],
      },
    });
    renderPage(scriptedHttp({ ...baseHandlers(detail), list_operations: () => ({ items: [] }) }));

    const acceptance = await screen.findByTestId('goal-acceptance');
    const lines = within(acceptance).getAllByTestId('goal-absence-baseline') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(lines.map((line) => line.getAttribute('data-baseline'))).toEqual([
      'seen_present',
      'never_seen_present',
      'none',
    ]);
    const [seen, never, later] = lines;
    // #786 UX P2-1: a condition, not a verdict on the check beside it.
    expect(seen.textContent).toContain(
      '开始前平台看到它在。之后门回答它不在，就说明是在目标运行期间删掉的。',
    );
    expect(seen.textContent).toContain('obs-seen');
    expect(never.textContent).toContain('开始前门就回答它不在（第 2 次看）');
    expect(never.textContent).toContain('修订计划、继续运行再看一次，或者取消');
    expect(later.textContent).toContain('第一步开始前平台会先看一次它在不在，还没看。');

    const step = (await screen.findAllByTestId('goal-step'))[1] as HTMLElement;
    const stepLine = within(step).getByTestId('goal-absence-baseline');
    expect(stepLine.getAttribute('data-baseline')).toBe('unavailable');
    expect(stepLine.textContent).toContain('开始前平台没能看它在不在：门拒绝了这次调用。');
    expect(stepLine.textContent).toContain('继续运行会再看一次');
  });

  it('a look whose answer did not show the thing says so (legacy 507); a reconcile absence call names the look it goes by (S11 「门确认不存在」 reconcile)', async () => {
    const base = goalDetail();
    const [fetch, apply] = base.planRevision.plan.steps as [
      (typeof base.planRevision.plan.steps)[number],
      (typeof base.planRevision.plan.steps)[number],
    ];
    const lookup = (name: string) => ({
      gatekeeperId: GATE_ID,
      operation: 'svc.lookup',
      params: { name },
    });
    const detail = goalDetail({
      status: 'paused',
      planRevision: {
        ...base.planRevision,
        plan: {
          steps: [
            fetch,
            {
              ...apply,
              acceptance: [{ kind: 'observe_absent', key: 'removed', check: lookup('web') }],
              reconcile: [
                {
                  action: {
                    gatekeeperId: GATE_ID,
                    operation: 'svc.remove',
                    params: { name: 'web' },
                  },
                  check: lookup('web'),
                },
                {
                  action: {
                    gatekeeperId: GATE_ID,
                    operation: 'svc.remove',
                    params: { name: 'db' },
                  },
                  check: lookup('db'),
                },
              ],
            },
          ],
          acceptance: [{ kind: 'observe_absent', key: 'gone', check: lookup('db') }],
        },
      },
      steps: base.steps.map((step) => ({ ...step, attemptCount: 0, attempts: [] })),
      acceptance: {
        ...base.acceptance,
        absenceBaselines: [
          {
            stepKey: null,
            checkKey: 'gone',
            take: 2,
            look: 2,
            status: 'unavailable',
            attempts: 1,
            lastError: 'presence_not_confirmed',
            observationId: null,
            createdAt: '2026-10-29T00:00:00.000Z',
            settledAt: '2026-10-29T00:01:00.000Z',
          },
        ],
      },
    });
    renderPage(scriptedHttp({ ...baseHandlers(detail), list_operations: () => ({ items: [] }) }));

    const acceptance = await screen.findByTestId('goal-acceptance');
    const line = within(acceptance).getByTestId('goal-absence-baseline');
    expect(line.getAttribute('data-baseline')).toBe('unavailable');
    expect(line.textContent).toBe(
      // The look count beside the look, not stacked on the parenthesis (#799 UX P3-1).
      '开始前平台看了（第 2 次看），门也回答了，但回答里看不出它在（空结果，或者不符合 Operation 声明的结果映射）：参数可能没指向要删的东西。所以目标暂停，步骤没有开始。核对参数后修订计划，或者继续运行再看一次。',
    );

    const step = (await screen.findAllByTestId('goal-step'))[1] as HTMLElement;
    // Each declaration: what the platform asks on one line, what "not there" counts for on the
    // next — two elements, not one run of text (#799 UX P2-1, P3-2).
    const declarations = within(step).getAllByTestId('goal-reconcile-declaration');
    await waitFor(() =>
      expect(declarations[0]?.firstElementChild?.textContent).toBe(
        '对门「cert-gate」上的 svc.remove：在门「cert-gate」上以参数 {"name":"web"} 调用 svc.lookup，看要查的东西还在不在',
      ),
    );
    expect(declarations[0]?.className).toContain('stack-s');
    expect(declarations[0]?.lastElementChild?.getAttribute('data-testid')).toBe(
      'goal-reconcile-absence',
    );
    const notes = within(step).getAllByTestId('goal-reconcile-absence');
    expect(notes.map((note) => note.textContent)).toEqual([
      '门回答它不在，就算这个动作生效了。前提是动作之前平台看到过它在：用的是这一步的验收检查「removed」那次事先查看。',
      '门回答它不在，就算这个动作生效了。前提是动作之前平台看到过它在：用的是目标的验收检查「gone」那次事先查看。',
    ]);
  });

  it('a look made once the goal’s steps had started — a revision changed the check — says so, and that a thing not there may be an earlier step’s doing (#786 review #501)', async () => {
    const base = goalDetail();
    const absence = (key: string) => ({
      kind: 'observe_absent' as const,
      key,
      check: { gatekeeperId: GATE_ID, operation: 'svc.lookup', params: { name: key } },
    });
    // Step fetch's attempt started 2026-10-20T00:01; these looks came after it.
    const look = (
      checkKey: string,
      extra: Pick<GoalAbsenceBaselineWire, 'status'> & Partial<GoalAbsenceBaselineWire>,
    ): GoalAbsenceBaselineWire => ({
      stepKey: null,
      checkKey,
      take: 1,
      look: 1,
      attempts: 1,
      lastError: null,
      observationId: null,
      createdAt: '2026-10-29T00:00:00.000Z',
      settledAt: '2026-10-29T00:01:00.000Z',
      ...extra,
    });
    const detail = goalDetail({
      status: 'paused',
      planRevision: {
        ...base.planRevision,
        plan: {
          ...base.planRevision.plan,
          acceptance: [
            absence('seen'),
            absence('never'),
            absence('refused'),
            absence('pending'),
            absence('later'),
          ],
        },
      },
      acceptance: {
        ...base.acceptance,
        absenceBaselines: [
          // Its call changed: take 2, yet the first look with this call.
          look('seen', { take: 2, status: 'seen_present', observationId: 'obs-seen-0001' }),
          look('never', { status: 'never_seen_present', observationId: 'obs-never-0001' }),
          look('refused', { status: 'unavailable', lastError: 'operation_refused' }),
          look('pending', {
            status: 'pending',
            lastError: 'gate_unreachable',
            settledAt: null,
          }),
        ],
      },
    });
    renderPage(scriptedHttp({ ...baseHandlers(detail), list_operations: () => ({ items: [] }) }));

    const acceptance = await screen.findByTestId('goal-acceptance');
    const [seen, never, refused, pending, later] = within(acceptance).getAllByTestId(
      'goal-absence-baseline',
    ) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(seen.textContent).toContain(
      '目标的步骤开始之后（计划改了这条检查）平台看到它在。之后门回答它不在，就说明是在这之后删掉的。',
    );
    expect(seen.textContent).not.toContain('次看');
    expect(never.getAttribute('data-baseline')).toBe('never_seen_present');
    expect(never.textContent).toContain('平台在目标的步骤开始之后才看（计划改了这条检查）');
    expect(never.textContent).toContain('可能是前面的步骤删掉了它，也可能参数没指向要删的东西');
    expect(never.textContent).toContain('可以用「结束目标…」按你的判断结束');
    expect(never.textContent).not.toContain('开始前');
    expect(refused.textContent).toContain('平台没能看它在不在：门拒绝了这次调用。');
    expect(refused.textContent).toContain('所以目标暂停，没有往下做');
    expect(refused.textContent).not.toContain('开始前');
    expect(pending.textContent).toContain('看到它在之后，目标才往下做。');
    // #786 UX P3: the gate's failure in words, not 「上次没成功（代码 …）」 inside 「上次没看成」.
    expect(pending.textContent).toContain('上次没看成：连不上门，稍后再试。');
    expect(later.getAttribute('data-baseline')).toBe('none');
    expect(later.textContent).toContain('目标往下做之前，平台会先看一次它在不在，还没看。');
  });

  it('a goal not yet confirmed says the platform will look first; an ended one without a look says nothing (S11 「门确认不存在」 B-c)', async () => {
    const base = goalDetail();
    const plan = {
      ...base.planRevision.plan,
      acceptance: [
        {
          kind: 'observe_absent' as const,
          key: 'gone',
          check: { gatekeeperId: GATE_ID, operation: 'svc.lookup' },
        },
      ],
    };
    const proposed = goalDetail({
      status: 'proposed',
      planRevision: { ...base.planRevision, plan },
    });
    const first = renderPage(
      scriptedHttp({ ...baseHandlers(proposed), list_operations: () => ({ items: [] }) }),
    );
    const line = await within(await screen.findByTestId('goal-acceptance')).findByTestId(
      'goal-absence-baseline',
    );
    expect(line.getAttribute('data-baseline')).toBe('none');
    expect(line.textContent).toContain('确认后、第一步开始前，平台会用同样的参数先看一次');
    first.unmount();

    const cancelled = goalDetail({
      status: 'cancelled',
      planRevision: { ...base.planRevision, plan },
    });
    renderPage(
      scriptedHttp({ ...baseHandlers(cancelled), list_operations: () => ({ items: [] }) }),
    );
    await screen.findByTestId('goal-acceptance');
    expect(screen.queryByTestId('goal-absence-baseline')).toBeNull();
  });

  it('a plan written out says nothing of a Procedure', async () => {
    renderPage(scriptedHttp(baseHandlers(goalDetail())));
    await screen.findAllByTestId('goal-revision');
    expect(screen.queryByTestId('goal-plan-source')).toBeNull();
    expect(screen.queryByTestId('goal-revision-from-procedure')).toBeNull();
  });

  it('an update of one of its tasks re-reads the goal; another task’s does not', async () => {
    const tasks = new Set<(event: TaskUpdatedPush) => void>();
    const pushes: PushSource = {
      ...SILENT_PUSH_SOURCE,
      onTaskUpdated: (handler) => {
        tasks.add(handler);
        return () => tasks.delete(handler);
      },
    };
    const http = scriptedHttp(baseHandlers(goalDetail()));
    renderPage(http, pushes);
    await screen.findAllByTestId('goal-step');
    const reads = () => http.calls.filter((call) => call.name === 'get_goal').length;
    expect(reads()).toBe(1);
    act(() => {
      for (const fn of tasks) fn({ id: 'task-elsewhere', status: 'completed' });
    });
    expect(reads()).toBe(1);
    act(() => {
      for (const fn of tasks) fn({ id: 'task-fetch-1', status: 'completed' });
    });
    await waitFor(() => expect(reads()).toBe(2));
  });
  it('a step’s output contract, the inputs it takes from earlier steps, its output, and its automatic rework read as sentences', async () => {
    const base = goalDetail();
    const plan = base.planRevision.plan;
    const detail = goalDetail({
      planRevision: {
        ...base.planRevision,
        plan: {
          ...plan,
          steps: [
            {
              ...(plan.steps[0] as (typeof plan.steps)[number]),
              outputSchema: {
                type: 'object',
                properties: {
                  hosts: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要换证书的主机',
                  },
                  mode: { enum: ['fast', 'safe'] },
                },
                required: ['hosts'],
              },
            },
            {
              ...(plan.steps[1] as (typeof plan.steps)[number]),
              input: { mode: 'safe' },
              bindings: [{ to: 'target.host', from: 'fetch', path: 'hosts[0]' }],
            },
          ],
        },
      },
      steps: [
        stepRun({
          status: 'succeeded',
          attemptCount: 2,
          output: { hosts: ['web-1'], api_token: 'should-not-show' },
          attempts: [
            {
              attempt: 1,
              taskId: 'task-fetch-1',
              status: 'failed',
              createdAt: '2026-10-20T00:01:00.000Z',
              failureReason: 'no_result',
              rework: false,
              outputProblems: [
                { path: 'output.hosts', message: 'required, missing' },
                { path: 'output.mode', message: 'must be one of ["fast","safe"]' },
              ],
              outputProblemCount: 3,
            },
            {
              attempt: 2,
              taskId: 'task-fetch-2',
              status: 'completed',
              createdAt: '2026-10-20T00:03:00.000Z',
              failureReason: null,
              rework: true,
              outputProblems: null,
              outputProblemCount: 0,
            },
          ],
        }),
        stepRun({
          id: 'sr-apply',
          stepKey: 'apply',
          status: 'pending',
          attemptCount: 0,
          attempts: [],
        }),
      ],
    });
    const http = scriptedHttp(baseHandlers(detail));
    renderPage(http);

    const steps = await screen.findAllByTestId('goal-step');
    const fetch = steps[0] as HTMLElement;
    const apply = steps[1] as HTMLElement;
    expect(within(apply).getByTestId('goal-step-binding').textContent).toBe(
      '输入 target.host 来自步骤 fetch 输出的 hosts[0]',
    );
    expect(within(fetch).queryByTestId('goal-step-bindings')).toBeNull();

    const fields = within(within(fetch).getByTestId('goal-step-output-contract')).getAllByTestId(
      'output-contract-field',
    );
    expect(fields.map((field) => field.textContent)).toEqual([
      'hosts列表（每项：文本）必填— 要换证书的主机',
      'mode取值之一："fast"、"safe"',
    ]);
    expect(within(apply).queryByTestId('goal-step-output-contract')).toBeNull();

    const output = within(fetch).getByTestId('goal-step-output');
    expect(output.textContent).toContain('web-1');
    expect(output.textContent).not.toContain('should-not-show');
    expect(within(output).getByTestId('goal-step-output-redacted')).toBeTruthy();

    const attempts = within(fetch).getAllByTestId('goal-step-attempt');
    expect(
      within(attempts[0] as HTMLElement).getByTestId('goal-step-attempt-failure').textContent,
    ).toBe('没有交回结果');
    expect(within(attempts[0] as HTMLElement).queryByTestId('goal-step-attempt-rework')).toBeNull();
    expect(attempts[0]?.textContent).toMatch(/最后一次被拒的报告有 3 处不符合输出约定/);
    const problems = within(attempts[0] as HTMLElement).getByTestId('goal-step-attempt-problems');
    expect(problems.textContent).toContain('output.hosts：必填，但没有');
    expect(problems.textContent).toContain('还有 1 处');
    expect(
      within(attempts[1] as HTMLElement).getByTestId('goal-step-attempt-rework').textContent,
    ).toBe('自动返工');
    // Why, in words anyone reads — not only a tooltip.
    expect(
      within(attempts[1] as HTMLElement).getByTestId('goal-step-attempt-rework-note').textContent,
    ).toMatch(/平台自动重做了这一次/);
    expect(
      within(attempts[1] as HTMLElement).queryByTestId('goal-step-attempt-problems'),
    ).toBeNull();
  });
});
