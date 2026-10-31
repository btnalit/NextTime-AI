// @vitest-environment jsdom
import type { GoalDetailWire, PlanHint, StepTrialApprovalWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { GoalDetailPage } from './GoalDetailPage.js';
import { GATE_ID, goalDetail, stepRun } from './goal-fixtures.test-helpers.js';

afterEach(cleanup);

/**
 * components/goals/StepTrialApproval (S11 GO8b) on the goal page: a step whose Worker would use a
 * Skill that is only a draft offers 「批准试用」 to whoever could publish the draft (its proposer, a
 * workspace owner), names each draft in the confirm, sends what the read showed, asks about
 * suspected credentials the way a publish does, and — the run paused — says the requester resumes.
 */

const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SPEC_DIGEST = 'b'.repeat(64);

type Role = 'owner' | 'builder' | 'member';

function workspace(id: string, role: Role) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 3,
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

const draftHint = (proposedBy = 'p-alice'): PlanHint => ({
  code: 'step_skill_draft',
  message: 'step "fetch": …',
  stepKey: 'fetch',
  skillRefs: ['cert-rotation'],
  trial: {
    specDigest: SPEC_DIGEST,
    drafts: [
      { skillId: SKILL_ID, version: 1, name: 'cert-rotation', draftDigest: DIGEST, proposedBy },
    ],
  },
});

/** Paused at `fetch`, which has not started: its Worker would use the draft `cert-rotation`. */
function pausedAtDraft(
  hints: readonly PlanHint[],
  trialApprovals: readonly StepTrialApprovalWire[] = [],
): GoalDetailWire {
  const base = goalDetail();
  return goalDetail({
    status: 'paused',
    pauseReason: 'needs_decision',
    steps: [stepRun({ status: 'ready', attemptCount: 0, attempts: [] })],
    trialApprovals: [...trialApprovals],
    planRevision: {
      ...base.planRevision,
      plan: {
        ...base.planRevision.plan,
        steps: [
          {
            ...(base.planRevision.plan
              .steps[0] as GoalDetailWire['planRevision']['plan']['steps'][number]),
            spec: { skills: ['cert-rotation'] },
          },
          ...base.planRevision.plan.steps.slice(1),
        ],
      },
      hints: [...hints],
    },
  });
}

const approval = (overrides: Partial<StepTrialApprovalWire> = {}): StepTrialApprovalWire => ({
  id: 'appr-1',
  stepKey: 'fetch',
  stepRunId: 'sr-fetch',
  planRevision: 1,
  specDigest: SPEC_DIGEST,
  drafts: [
    {
      skillId: SKILL_ID,
      version: 1,
      name: 'cert-rotation',
      draftDigest: DIGEST,
      proposedBy: 'p-alice',
    },
  ],
  approvedBy: 'p-alice',
  approvedAt: '2026-10-20T00:03:00.000Z',
  state: 'pending',
  lapsedBecause: null,
  usedByTaskId: null,
  ...overrides,
});

function handlers(
  detail: () => GoalDetailWire,
  as: ReturnType<typeof workspace>,
  extra: Record<string, (params: unknown) => unknown> = {},
) {
  return {
    get_goal: () => detail(),
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

describe('approving a trial of a step’s draft Skills (S11 GO8b)', () => {
  it('the draft’s proposer approves what the read showed; the page then says the requester resumes', async () => {
    let approved = false;
    const http = scriptedHttp(
      handlers(
        () => (approved ? pausedAtDraft([], [approval()]) : pausedAtDraft([draftHint()])),
        workspace('p-alice', 'builder'),
        {
          approve_step_trial: () => {
            approved = true;
            return { goalRunId: 'goal-1', status: 'paused', changed: true, approvalId: 'appr-1' };
          },
        },
      ),
    );
    renderPage(http);
    const [hint] = await screen.findAllByTestId('goal-step-hint');
    expect(hint?.textContent).toMatch(
      /可以在「步骤」里这一步下面「批准试用」，只让这一步用草稿试一次/,
    );
    expect((await screen.findByTestId('goal-state-note')).textContent).toMatch(
      /能发布它的人可以在下面「步骤」里「批准试用」，之后请求人按「继续」/,
    );
    fireEvent.click(await screen.findByTestId('goal-step-trial-approve'));
    const confirm = await screen.findByTestId('goal-step-trial-confirm');
    expect(within(confirm).getByTestId('goal-step-trial-draft').textContent).toBe(
      'cert-rotation v1',
    );
    expect(within(confirm).getByTestId('confirm-impact').textContent).toMatch(
      /只对这一步的这一次运行有效.*批准不会让目标继续/,
    );
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'approve_step_trial')?.params).toEqual({
        goalRunId: 'goal-1',
        stepKey: 'fetch',
        specDigest: SPEC_DIGEST,
        drafts: [{ skillId: SKILL_ID, version: 1, draftDigest: DIGEST }],
      }),
    );
    expect((await screen.findByTestId('goal-op-done')).textContent).toMatch(
      /已批准步骤「fetch」试用 Skill 草稿。目标不会自己继续：请求人按「继续」后这一步开始/,
    );
    // Read again: the step carries the approval, and the pause says who goes on.
    const line = await screen.findByTestId('goal-step-trial');
    expect(line.dataset.trialState).toBe('pending');
    expect(line.textContent).toMatch(
      /已批准试用 Skill 草稿 「cert-rotation v1」：只对这一步的下一次运行有效/,
    );
    await waitFor(() =>
      expect(screen.getByTestId('goal-state-note').textContent).toMatch(
        /步骤「fetch」的 Skill 草稿已批准试用。目标不会自己继续：请求人按「继续」后/,
      ),
    );
    expect(screen.queryByTestId('goal-step-trial-approve')).toBeNull();
  });

  it('a draft carrying suspected credentials asks for the approver’s confirmation, then sends it', async () => {
    let calls = 0;
    const http = scriptedHttp(
      handlers(() => pausedAtDraft([draftHint()]), workspace('p-alice', 'builder'), {
        approve_step_trial: (params) => {
          calls += 1;
          if ((params as { credentialsReviewed?: boolean }).credentialsReviewed !== true) {
            throw new HttpError('capability_error', 'review', 'credentials_review_required', {
              suspectedSecretValues: 1,
              suspectedSecretPaths: ['markdown'],
            });
          }
          return { goalRunId: 'goal-1', status: 'paused', changed: true, approvalId: 'appr-1' };
        },
      }),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-step-trial-approve'));
    const confirm = await screen.findByTestId('goal-step-trial-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const review = await within(confirm).findByTestId('credential-review');
    expect(review.textContent).toMatch(/批准试用后会原样交给这一步的 Worker/);
    expect(within(review).getByTestId('credential-review-paths').textContent).toBe('正文');
    expect(confirm.textContent).toMatch(/勾选确认后再批准/);
    const button = within(confirm).getByTestId('confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(within(review).getByTestId('credential-review-confirm'));
    fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(2));
    expect(http.calls.filter((call) => call.name === 'approve_step_trial').at(-1)?.params).toEqual(
      expect.objectContaining({ credentialsReviewed: true }),
    );
  });

  it('someone who could not publish the draft is told who can, with no button', async () => {
    const http = scriptedHttp(
      handlers(() => pausedAtDraft([draftHint('p-bob')]), workspace('p-alice', 'builder')),
    );
    renderPage(http);
    expect((await screen.findByTestId('goal-step-trial-approver')).textContent).toBe(
      '能批准试用的是这份草稿的提议者（构建者）或工作区所有者。',
    );
    expect(screen.queryByTestId('goal-step-trial-approve')).toBeNull();
  });

  it('a member who proposed the draft gets no button (the capability is a builder’s); an owner does', async () => {
    const member = scriptedHttp(
      handlers(() => pausedAtDraft([draftHint()]), workspace('p-alice', 'member')),
    );
    renderPage(member);
    await screen.findByTestId('goal-step-trial-approver');
    expect(screen.queryByTestId('goal-step-trial-approve')).toBeNull();
    cleanup();
    const owner = scriptedHttp(
      handlers(() => pausedAtDraft([draftHint('p-bob')]), workspace('p-owner', 'owner')),
    );
    renderPage(owner);
    expect(await screen.findByTestId('goal-step-trial-approve')).toBeTruthy();
  });

  it('a draft that changed since is refused (409 draft_changed): the page reads the goal again and says so', async () => {
    const http = scriptedHttp(
      handlers(() => pausedAtDraft([draftHint()]), workspace('p-alice', 'builder'), {
        approve_step_trial: () => {
          throw new HttpError('capability_error', 'changed', 'draft_changed');
        },
      }),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-step-trial-approve'));
    const confirm = await screen.findByTestId('goal-step-trial-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(confirm.textContent).toMatch(/什么也没批准。关掉这个框/));
    expect((await screen.findByTestId('goal-op-done')).textContent).toMatch(
      /草稿或设定在你打开之后改过了，什么也没批准/,
    );
    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'get_goal').length).toBe(2),
    );
  });

  it('a step whose trial cannot be approved says why, with no button', async () => {
    const { trial: _trial, ...noTrial } = draftHint();
    const http = scriptedHttp(
      handlers(() => pausedAtDraft([noTrial]), workspace('p-alice', 'builder')),
    );
    renderPage(http);
    const [hint] = await screen.findAllByTestId('goal-step-hint');
    expect(hint?.textContent).toMatch(/这一步没法只批准试用一次/);
    expect(screen.queryByTestId('goal-step-trial-approve')).toBeNull();
    expect(screen.queryByTestId('goal-step-trial-approver')).toBeNull();
  });

  it('a used approval and a lapsed one each say where they stand under their step', async () => {
    const http = scriptedHttp(
      handlers(
        () =>
          goalDetail({
            status: 'running',
            trialApprovals: [
              approval({ id: 'appr-old', state: 'lapsed', lapsedBecause: 'draft_changed' }),
              approval({ id: 'appr-new', state: 'used', usedByTaskId: 'task-fetch-1' }),
            ],
          }),
        workspace('p-alice', 'builder'),
      ),
    );
    renderPage(http);
    const lines = await screen.findAllByTestId('goal-step-trial');
    expect(lines.map((line) => line.dataset.trialState)).toEqual(['lapsed', 'used']);
    expect(lines[0]?.textContent).toMatch(/但草稿改过了（被丢弃、重新提议或已发布），批准不再适用/);
    expect(lines[1]?.textContent).toMatch(/这一步的第一次尝试用上了它（重试沿用同一份草稿）/);
  });
});
