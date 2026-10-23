// @vitest-environment jsdom
import type { GoalDetailWire, PlanRevisionWire } from '@nexttime/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, type PushSource, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
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
    expect(within(status).getByTestId('outcome-proxy-note').textContent).toBe(
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
    const source = { procedureId: 'proc-1', version: 3, name: '证书续期' };
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
