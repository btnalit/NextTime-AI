// @vitest-environment jsdom
import type { GoalDetailWire, PlanRevisionWire, PlanningRoundWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { GoalDetailPage } from './GoalDetailPage.js';
import { GATE_ID, goalDetail } from './goal-fixtures.test-helpers.js';

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

  it('a goal confirmed without the planner shows no planner card, and the confirm card offers the choice, on by default', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'proposed', currentRevision: null, confirmedAt: null }),
        workspace('p-alice', 'member'),
        {
          confirm_goal: () => ({
            goalRunId: 'goal-1',
            status: 'running',
            changed: true,
            createdStepRunIds: [],
          }),
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-confirm'));
    expect(screen.queryByTestId('goal-planner')).toBeNull();
    const confirm = await screen.findByTestId('goal-op-confirm-confirm');
    const choice = within(confirm).getByTestId('goal-op-confirm-planner');
    const box = within(choice).getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'confirm_goal')?.params).toEqual({
        goalRunId: 'goal-1',
        revision: 1,
        planner: false,
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
