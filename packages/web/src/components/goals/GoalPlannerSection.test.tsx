// @vitest-environment jsdom
import type { GoalDetailWire, PlanRevisionWire, PlanningRoundWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { GoalDetailPage } from './GoalDetailPage.js';
import { GATE_ID, goalDetail, stepRun } from './goal-fixtures.test-helpers.js';

afterEach(cleanup);

const OTHER_WORKER = '33333333-3333-4333-8333-333333333333';

function workspace(id: string, role: 'owner' | 'member') {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id, role, displayName: id, kind: 'human' },
  };
}

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

function round(overrides: Partial<PlanningRoundWire> = {}): PlanningRoundWire {
  return {
    id: 'round-1',
    status: 'proposed',
    kind: 'proposal',
    basedOnRevision: 1,
    stepRunId: 'sr-fetch',
    stepKey: 'fetch',
    stepAttempt: 2,
    failureCategory: 'transient',
    taskId: 'task-plan-1',
    revision: 2,
    outcomeReason: null,
    detail: null,
    createdAt: '2026-10-20T00:05:00.000Z',
    settledAt: '2026-10-20T00:06:00.000Z',
    revisionClass: 'minor',
    classReasons: [],
    ...overrides,
  };
}

/** A paused run whose planner proposed revision 2: `fetch` replaced by `fetch-other`. */
function proposedDetail(overrides: Partial<GoalDetailWire> = {}): GoalDetailWire {
  const base = goalDetail({
    status: 'paused',
    pauseReason: 'needs_decision',
    planner: 'propose',
    planningRounds: [round()],
  });
  return {
    ...base,
    revisions: [
      ...base.revisions,
      {
        id: 'rev-2',
        goalRunId: base.id,
        revision: 2,
        status: 'proposed',
        basedOnRevision: 1,
        proposedBy: 'p-planner',
        proposer: 'planner',
        acceptedBy: null,
        reason: 'The first Worker lost its run twice; another Worker renews the same way.',
        decidedBy: null,
        decidedAt: null,
        createdAt: '2026-10-20T00:06:00.000Z',
        removals: {},
        fromProcedure: null,
      },
    ],
    ...overrides,
  };
}

function proposedPlan(detail: GoalDetailWire): PlanRevisionWire {
  const plan = detail.planRevision.plan;
  return {
    ...detail.planRevision,
    id: 'rev-2',
    revision: 2,
    status: 'proposed',
    basedOnRevision: 1,
    proposedBy: 'p-planner',
    proposer: 'planner',
    acceptedBy: null,
    decidedBy: null,
    decidedAt: null,
    plan: {
      ...plan,
      steps: [
        {
          key: 'fetch-other',
          worker: { definitionId: OTHER_WORKER, version: 1 },
          input: { hosts: 3 },
        },
        ...plan.steps.filter((step) => step.key !== 'fetch'),
      ],
    },
    hints: [],
  };
}

function handlers(
  detail: GoalDetailWire,
  as: ReturnType<typeof workspace>,
  extra: Record<string, (params: unknown) => unknown> = {},
) {
  return {
    get_goal: () => detail,
    get_goal_revision: () => proposedPlan(detail),
    list_goal_unresolved_actions: () => ({ items: [] }),
    list_gatekeepers: () => ({ items: [{ id: GATE_ID, name: 'cert-gate' }] }),
    resolve_refs: () => ({ items: [] }),
    get_workspace: () => as,
    ...extra,
  };
}

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <GoalDetailPage http={http} pushes={SILENT_PUSH_SOURCE} goalRunId="goal-1" />
    </PermissionsProvider>,
  );
}

const confirmed = () => ({
  goalRunId: 'goal-1',
  status: 'running',
  changed: true,
  createdStepRunIds: [],
});

const decided = (resumed: boolean) => ({
  goalRunId: 'goal-1',
  status: resumed ? 'running' : 'paused',
  changed: true,
  revision: 2,
  planRevisionId: 'rev-2',
  supersededStepRunIds: ['sr-fetch'],
  createdStepRunIds: ['sr-fetch-other'],
  withdrawnActionRequestIds: [],
  releasedActionRequestIds: [],
  hints: [],
  decision: 'accept',
  resumed,
});

describe('goal planner on the goal page (S11 GO9a)', () => {
  it('the requester reads what the proposal changes and accepts it with a resume', async () => {
    const http = scriptedHttp(
      handlers(proposedDetail(), workspace('p-alice', 'member'), {
        decide_plan_revision: () => decided(true),
      }),
    );
    renderPage(http);
    const proposal = await screen.findByTestId('goal-planner-proposal');
    expect(proposal.getAttribute('data-revision')).toBe('2');
    expect(within(proposal).getByTestId('goal-planner-reason').textContent).toContain(
      'another Worker renews',
    );
    const changes = await within(proposal).findByTestId('goal-planner-changes');
    expect(changes.querySelector('[data-diff="added"]')?.textContent).toContain('fetch-other');
    expect(changes.querySelector('[data-diff="removed"]')?.textContent).toContain('fetch');
    expect(http.calls.find((call) => call.name === 'get_goal_revision')?.params).toEqual({
      goalRunId: 'goal-1',
      revision: 2,
    });

    fireEvent.click(within(proposal).getByTestId('goal-planner-acceptResume'));
    const confirm = await screen.findByTestId('goal-planner-acceptResume-confirm');
    const impact = within(confirm).getByTestId('confirm-impact').textContent ?? '';
    expect(impact).toMatch(/新增步骤：fetch-other/);
    expect(impact).toMatch(/去掉步骤：fetch/);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'decide_plan_revision')?.params).toEqual({
        goalRunId: 'goal-1',
        revision: 2,
        decision: 'accept',
        resume: true,
      }),
    );
    expect((await screen.findByTestId('goal-op-done')).textContent).toBe(
      '计划已改为第 2 版，目标继续执行。',
    );
  });

  it('rejecting sends no resume and says what the requester can do next', async () => {
    const http = scriptedHttp(
      handlers(proposedDetail(), workspace('p-alice', 'member'), {
        decide_plan_revision: () => ({ ...decided(false), decision: 'reject', revision: 2 }),
      }),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-planner-reject'));
    const confirm = await screen.findByTestId('goal-planner-reject-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'decide_plan_revision')?.params).toEqual({
        goalRunId: 'goal-1',
        revision: 2,
        decision: 'reject',
      }),
    );
    expect((await screen.findByTestId('goal-op-done')).textContent).toContain(
      '已拒绝规划器的第 2 版修订',
    );
  });

  it('while an owner holds the run, accept-and-resume waits with the reason; accepting alone is offered', async () => {
    const http = scriptedHttp(
      handlers(
        proposedDetail({ pausedBy: 'p-owner', pausedByAuthority: 'owner' }),
        workspace('p-alice', 'member'),
      ),
    );
    renderPage(http);
    const resume = (await screen.findByTestId('goal-planner-acceptResume')) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(
      document.getElementById(resume.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('工作区所有者锁定了这个目标');
    expect((screen.getByTestId('goal-planner-accept') as HTMLButtonElement).disabled).toBe(false);
  });

  it('anyone but the requester reads who decides, with no buttons', async () => {
    const http = scriptedHttp(handlers(proposedDetail(), workspace('p-owner', 'owner')));
    renderPage(http);
    const proposal = await screen.findByTestId('goal-planner-proposal');
    expect(within(proposal).getByTestId('goal-planner-decider').textContent).toContain(
      '由目标的请求人决定',
    );
    expect(within(proposal).queryByTestId('goal-planner-accept')).toBeNull();
  });

  it('a running round says what the planner is doing; settled rounds say why they ended', async () => {
    const detail = goalDetail({
      status: 'paused',
      pauseReason: 'needs_decision',
      planner: 'propose',
      planningRounds: [
        round({
          id: 'round-0',
          status: 'no_revision',
          stepAttempt: 1,
          revision: null,
          detail: 'The DNS record has to be fixed by a person.',
        }),
        round({
          id: 'round-x',
          status: 'failed',
          stepAttempt: 2,
          revision: null,
          taskId: null,
          outcomeReason: 'token_budget_exhausted',
        }),
        round({
          id: 'round-2',
          status: 'running',
          stepAttempt: 3,
          revision: null,
          settledAt: null,
        }),
      ],
    });
    const http = scriptedHttp(handlers(detail, workspace('p-alice', 'member')));
    renderPage(http);
    const running = await screen.findByTestId('goal-planner-running');
    expect(running.textContent).toContain('步骤 fetch 第 3 次尝试');
    expect(screen.queryByTestId('goal-planner-proposal')).toBeNull();
    const items = screen.getAllByTestId('goal-planner-round');
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual([
      'running',
      'failed',
      'no_revision',
    ]);
    expect(items[1]?.textContent).toContain('目标剩下的 token 不够规划器跑一轮');
    expect(items[2]?.textContent).toContain('The DNS record has to be fixed by a person.');
  });

  it('a goal confirmed without the planner shows no planner card; the confirm card offers three choices, proposals by default', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'proposed', currentRevision: null, confirmedAt: null }),
        workspace('p-alice', 'member'),
        { confirm_goal: confirmed },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-confirm'));
    expect(screen.queryByTestId('goal-planner')).toBeNull();
    const confirm = await screen.findByTestId('goal-op-confirm-confirm');
    const choice = within(confirm).getByTestId('goal-op-confirm-planner');
    expect(within(choice).getAllByRole('radio')).toHaveLength(3);
    expect(
      (within(choice).getByTestId('goal-op-confirm-planner-propose') as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(choice).getByTestId('goal-op-confirm-planner-off'));
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'confirm_goal')?.params).toEqual({
        goalRunId: 'goal-1',
        revision: 1,
      }),
    );
  });

  it('the confirm card lets the requester leave minor revisions to the platform (S11 GO9b)', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'proposed', currentRevision: null, confirmedAt: null }),
        workspace('p-alice', 'member'),
        { confirm_goal: confirmed },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-confirm'));
    const confirm = await screen.findByTestId('goal-op-confirm-confirm');
    fireEvent.click(within(confirm).getByTestId('goal-op-confirm-planner-apply_minor'));
    expect(within(confirm).getByTestId('goal-op-confirm-planner').textContent).toContain(
      '同一步平台最多替你改两次',
    );
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'confirm_goal')?.params).toEqual({
        goalRunId: 'goal-1',
        revision: 1,
        planner: 'apply_minor',
      }),
    );
  });

  it('the revision list marks the planner’s proposal', async () => {
    const http = scriptedHttp(handlers(proposedDetail(), workspace('p-alice', 'member')));
    renderPage(http);
    const revisions = await screen.findAllByTestId('goal-revision');
    const second = revisions.find((item) => item.getAttribute('data-revision') === '2');
    expect(second && within(second).getByTestId('goal-revision-planner').textContent).toBe(
      '规划器提议',
    );
  });
});

describe('minor revisions the platform adopts (S11 GO9b)', () => {
  it('while the goal runs, an autonomous round says no new attempt starts meanwhile', async () => {
    const detail = goalDetail({
      planner: 'apply_minor',
      planningRounds: [
        round({
          id: 'round-a',
          kind: 'autonomous',
          status: 'running',
          revision: null,
          revisionClass: null,
          settledAt: null,
        }),
      ],
    });
    const http = scriptedHttp(handlers(detail, workspace('p-alice', 'member')));
    renderPage(http);
    const card = await screen.findByTestId('goal-planner');
    expect(within(card).getByTestId('goal-planner-mode').getAttribute('data-mode')).toBe(
      'apply_minor',
    );
    expect(within(card).getByTestId('goal-planner-mode').textContent).toContain(
      '平台替自己采用小修订',
    );
    const running = within(card).getByTestId('goal-planner-running');
    expect(running.textContent).toContain('换一条路');
    expect(running.textContent).toContain('这期间不开始新的尝试');
  });

  it('a revision the platform adopted reads so, in the rounds and in the revision list', async () => {
    const base = goalDetail({
      planner: 'apply_minor',
      currentRevision: 2,
      planningRounds: [round({ kind: 'autonomous', status: 'applied', revision: 2 })],
    });
    const detail: GoalDetailWire = {
      ...base,
      revisions: [
        ...base.revisions,
        {
          id: 'rev-2',
          goalRunId: base.id,
          revision: 2,
          status: 'accepted',
          basedOnRevision: 1,
          proposedBy: 'p-planner',
          proposer: 'planner',
          acceptedBy: 'platform',
          reason: 'Another Worker renews the same way.',
          decidedBy: 'p-alice',
          decidedAt: '2026-10-20T00:06:00.000Z',
          createdAt: '2026-10-20T00:06:00.000Z',
          removals: {},
          fromProcedure: null,
        },
      ],
    };
    const http = scriptedHttp(handlers(detail, workspace('p-alice', 'member')));
    renderPage(http);
    const card = await screen.findByTestId('goal-planner');
    expect(within(card).queryByTestId('goal-planner-proposal')).toBeNull();
    const roundItem = within(card).getByTestId('goal-planner-round');
    expect(roundItem.getAttribute('data-status')).toBe('applied');
    expect(within(roundItem).getByTestId('goal-planner-round-applied').textContent).toContain(
      '平台按请求人的授权采用了它',
    );
    const revisions = await screen.findAllByTestId('goal-revision');
    const second = revisions.find((item) => item.getAttribute('data-revision') === '2');
    expect(second && within(second).getByTestId('goal-revision-platform').textContent).toBe(
      '小修订，平台按请求人的授权采用',
    );
    expect(second?.textContent).toContain('代为接受，授权人');
  });

  it('a revision the platform left to the requester says why', async () => {
    const detail = proposedDetail({
      planner: 'apply_minor',
      planningRounds: [
        round({
          kind: 'autonomous',
          revisionClass: 'major',
          classReasons: [
            { code: 'goal_acceptance_changed', stepKey: null },
            { code: 'execution_step', stepKey: 'fetch-other' },
          ],
        }),
      ],
    });
    const http = scriptedHttp(handlers(detail, workspace('p-alice', 'member')));
    renderPage(http);
    const reasons = await screen.findByTestId('goal-planner-major-reasons');
    expect(reasons.textContent).toContain('平台没有替请求人采用，目标为此暂停');
    expect(
      within(reasons)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '改了目标的验收',
      '新增或改动的步骤能执行动作，或能让别的 Worker 替它做事（步骤 fetch-other）',
    ]);
  });
});

describe('the planner card after the UX review of #864', () => {
  /** `fetch` failed on its 2nd attempt and the run waits for a person. */
  const failedFetch = (
    rounds: readonly PlanningRoundWire[],
    overrides: Partial<GoalDetailWire> = {},
  ) =>
    goalDetail({
      status: 'paused',
      pauseReason: 'needs_decision',
      planner: 'propose',
      planningRounds: [...rounds],
      steps: [
        stepRun({ status: 'failed', attemptCount: 2, failureCategory: 'transient' }),
        stepRun({
          id: 'sr-apply',
          stepKey: 'apply',
          status: 'pending',
          attemptCount: 0,
          attempts: [],
        }),
      ],
      ...overrides,
    });
  const placedFirst = () => {
    const planner = screen.getByTestId('goal-planner');
    const overview = screen.getByTestId('goal-overview');
    return Boolean(planner.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING);
  };

  it('P2-2: a round that found no revision says so on its own, with the planner’s word, above the overview', async () => {
    const detail = failedFetch([
      round({
        status: 'no_revision',
        revision: null,
        detail: 'The DNS record has to be fixed by a person.',
      }),
    ]);
    renderPage(scriptedHttp(handlers(detail, workspace('p-alice', 'member'))));
    const conclusion = await screen.findByTestId('goal-planner-conclusion');
    expect(conclusion.textContent).toContain(
      '规划器看过步骤 fetch 第 2 次尝试（运行出错）的失败，没有可行的修订',
    );
    expect(conclusion.textContent).toContain('接下来由请求人重试失败的步骤、自己修订计划或取消');
    expect(within(conclusion).getByTestId('goal-planner-conclusion-detail').textContent).toMatch(
      /^规划器的说明：The DNS record has to be fixed by a person\.$/,
    );
    expect(placedFirst()).toBe(true);
  });

  it('P3-3: a planning Task’s own failure text stays out of the card; the outcome says what happened', async () => {
    const detail = failedFetch([
      round({
        status: 'failed',
        revision: null,
        outcomeReason: 'task_failed',
        detail: 'worker exited: SIGKILL (oom) at /srv/run/abc',
      }),
    ]);
    renderPage(scriptedHttp(handlers(detail, workspace('p-alice', 'member'))));
    const conclusion = await screen.findByTestId('goal-planner-conclusion');
    expect(conclusion.textContent).toContain(
      '规划器没能为步骤 fetch 第 2 次尝试（运行出错）的失败给出修订',
    );
    expect(within(conclusion).queryByTestId('goal-planner-conclusion-detail')).toBeNull();
    expect(conclusion.textContent).toContain('规划器的任务没有交回可用的结果');
    expect(screen.queryByTestId('goal-planner-round-detail')).toBeNull();
    expect(document.body.textContent).not.toContain('SIGKILL');
  });

  it('P3-7: a conclusion about an earlier attempt is not this pause’s; the card sits below the overview', async () => {
    const detail = failedFetch([
      round({ status: 'no_revision', stepAttempt: 1, revision: null, detail: 'old' }),
    ]);
    renderPage(scriptedHttp(handlers(detail, workspace('p-alice', 'member'))));
    await screen.findByTestId('goal-planner');
    expect(screen.queryByTestId('goal-planner-conclusion')).toBeNull();
    expect(placedFirst()).toBe(false);
  });

  it('P3-7: with no round yet the card says why, below the overview', async () => {
    renderPage(
      scriptedHttp(handlers(goalDetail({ planner: 'propose' }), workspace('p-alice', 'member'))),
    );
    const card = await screen.findByTestId('goal-planner');
    expect(card.textContent).toContain('还没有步骤失败到要人决定，规划器还没跑过。');
    expect(placedFirst()).toBe(false);
  });

  it('P3-8 and P3-4: the proposal says whose decision it waits for, and its round says what became of it', async () => {
    renderPage(scriptedHttp(handlers(proposedDetail(), workspace('p-alice', 'member'))));
    expect((await screen.findByTestId('goal-planner-proposal-state')).textContent).toBe('等你决定');
    expect(screen.getByTestId('goal-planner-round-proposed').textContent).toBe(
      '提了第 2 版修订（等请求人决定）。',
    );
    expect(placedFirst()).toBe(true);
    cleanup();

    renderPage(scriptedHttp(handlers(proposedDetail(), workspace('p-owner', 'owner'))));
    expect((await screen.findByTestId('goal-planner-proposal-state')).textContent).toBe(
      '等请求人决定',
    );
    cleanup();

    const settled = proposedDetail({ status: 'running', pauseReason: null, currentRevision: 2 });
    const rejected = {
      ...settled,
      revisions: settled.revisions.map((row) =>
        row.revision === 2 ? { ...row, status: 'rejected' as const } : row,
      ),
    };
    renderPage(scriptedHttp(handlers(rejected, workspace('p-alice', 'member'))));
    expect((await screen.findByTestId('goal-planner-round-proposed')).textContent).toBe(
      '提了第 2 版修订（已拒绝）。',
    );
  });

  it('P2-3: each step the proposal adds is shown as it would run', async () => {
    const detail = proposedDetail();
    const http = scriptedHttp(
      handlers(detail, workspace('p-alice', 'member'), {
        get_goal_revision: () => {
          const plan = proposedPlan(detail);
          return {
            ...plan,
            plan: {
              ...plan.plan,
              steps: plan.plan.steps.map((step) =>
                step.key === 'fetch-other'
                  ? {
                      ...step,
                      maxAttempts: 4,
                      input: { hosts: 3, token: 'abc' },
                      acceptance: [
                        {
                          kind: 'observe_predicate',
                          key: 'renewed',
                          check: {
                            gatekeeperId: GATE_ID,
                            operation: 'cert.list',
                            expect: { path: 'expiring', op: 'eq', value: 0 },
                          },
                        },
                      ],
                    }
                  : step,
              ),
            },
          };
        },
      }),
    );
    renderPage(http);
    const proposal = await screen.findByTestId('goal-planner-proposal');
    const added = await within(proposal).findByTestId('goal-planner-step');
    expect(added.getAttribute('data-step-key')).toBe('fetch-other');
    expect(added.textContent).toContain('没有前置步骤');
    expect(added.textContent).toContain('最多尝试 4 次');
    expect(within(added).getByTestId('goal-planner-step-checks').textContent).toContain(
      'cert-gate',
    );
    const input = within(added).getByTestId('goal-planner-step-input').textContent ?? '';
    expect(input).toContain('"hosts": 3');
    expect(input).not.toContain('abc');
  });

  it('P3-5: the confirm names a removed step as stopping only while it still runs', async () => {
    const detail = proposedDetail({
      steps: [
        stepRun({ status: 'failed', attemptCount: 2 }),
        stepRun({
          id: 'sr-apply',
          stepKey: 'apply',
          status: 'pending',
          attemptCount: 0,
          attempts: [],
        }),
      ],
    });
    renderPage(scriptedHttp(handlers(detail, workspace('p-alice', 'member'))));
    await screen.findByTestId('goal-planner-changes');
    fireEvent.click(screen.getByTestId('goal-planner-accept'));
    const confirm = await screen.findByTestId('goal-planner-accept-confirm');
    const impact = within(confirm).getByTestId('confirm-impact').textContent ?? '';
    expect(impact).toMatch(/去掉步骤：fetch/);
    expect(impact).not.toContain('还在运行');
    cleanup();

    renderPage(scriptedHttp(handlers(proposedDetail(), workspace('p-alice', 'member'))));
    await screen.findByTestId('goal-planner-changes');
    fireEvent.click(screen.getByTestId('goal-planner-accept'));
    const running = await screen.findByTestId('goal-planner-accept-confirm');
    expect(within(running).getByTestId('confirm-impact').textContent).toContain(
      '去掉步骤：fetch（fetch 还在运行，会停下）',
    );
  });

  it('P2-1: resuming or cancelling says the planner’s proposal is rejected; the pause note points at the card', async () => {
    renderPage(scriptedHttp(handlers(proposedDetail(), workspace('p-alice', 'member'))));
    expect((await screen.findByTestId('goal-state-note')).textContent).toContain(
      '目标规划器为这次失败提了第 2 版修订',
    );
    fireEvent.click(screen.getByTestId('goal-op-resume'));
    const resume = await screen.findByTestId('goal-op-resume-confirm');
    expect(within(resume).getByTestId('confirm-impact').textContent).toContain(
      '规划器提的第 2 版修订会被拒绝',
    );
    fireEvent.click(within(resume).getByRole('button', { name: /取消|返回/ }));
    fireEvent.click(screen.getByTestId('goal-op-cancel'));
    const cancel = await screen.findByTestId('goal-op-cancel-confirm');
    expect(within(cancel).getByTestId('confirm-impact').textContent).toContain(
      '规划器提的第 2 版修订会被拒绝',
    );
  });

  it('P2-5: ending says the planner’s proposal is rejected; an ended goal’s proposal no longer waits', async () => {
    const steps = failedFetch([]).steps;
    renderPage(scriptedHttp(handlers(proposedDetail({ steps }), workspace('p-alice', 'member'))));
    fireEvent.click(await screen.findByTestId('goal-op-end'));
    const end = await screen.findByTestId('goal-op-end-confirm');
    expect(within(end).getByTestId('confirm-impact').textContent).toContain(
      '规划器提的第 2 版修订会被拒绝',
    );
    cleanup();

    // A proposal an earlier release left `proposed` on a goal that has ended since.
    renderPage(
      scriptedHttp(
        handlers(
          proposedDetail({
            steps,
            status: 'completed',
            pauseReason: null,
            outcome: 'not_achieved',
          }),
          workspace('p-alice', 'member'),
        ),
      ),
    );
    const card = await screen.findByTestId('goal-planner');
    expect(within(card).queryByTestId('goal-planner-proposal')).toBeNull();
    const listed = screen
      .getAllByTestId('goal-revision')
      .find((item) => item.getAttribute('data-revision') === '2');
    expect(listed?.textContent).toContain('目标已经不在暂停中，不能再接受。');
    expect(listed?.textContent).not.toContain('等请求人');
  });

  it('P2-5: while the planner works on the pause, ending waits for it and says why', async () => {
    const detail = failedFetch([round({ status: 'running', revision: null, settledAt: null })]);
    renderPage(scriptedHttp(handlers(detail, workspace('p-alice', 'member'))));
    const end = (await screen.findByTestId('goal-op-end')) as HTMLButtonElement;
    expect(end.disabled).toBe(true);
    expect(
      screen
        .getAllByTestId('goal-op-wait')
        .map((p) => p.textContent)
        .join(),
    ).toContain('目标规划器正在看步骤 fetch 的失败：等它给出结果再结束，或者取消目标。');
  });
});
