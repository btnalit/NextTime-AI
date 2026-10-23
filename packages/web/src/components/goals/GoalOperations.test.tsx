// @vitest-environment jsdom
import type { GoalDetailWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { GoalDetailPage } from './GoalDetailPage.js';
import { GATE_ID, goalDetail, stepRun } from './goal-fixtures.test-helpers.js';

afterEach(cleanup);

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

function handlers(
  detail: GoalDetailWire,
  as: ReturnType<typeof workspace>,
  extra: Record<string, (params: unknown) => unknown> = {},
) {
  return {
    get_goal: () => detail,
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

const reads = (http: { calls: { name: string }[] }) =>
  http.calls.filter((call) => call.name === 'get_goal').length;

describe('goal operations on the goal page (S11 GO6)', () => {
  it('the requester confirms a proposal on the revision they read, and the page reads it again', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'proposed', currentRevision: null, confirmedAt: null }),
        workspace('p-alice', 'member'),
        {
          confirm_goal: () => ({
            goalRunId: 'goal-1',
            status: 'running',
            changed: true,
            createdStepRunIds: ['a', 'b'],
          }),
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-confirm'));
    const confirm = await screen.findByTestId('goal-op-confirm-confirm');
    expect(within(confirm).getByTestId('confirm-impact').textContent).toMatch(/2 个步骤/);
    expect(screen.getByTestId('goal-op-reject')).toBeTruthy();
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'confirm_goal')?.params).toEqual({
        goalRunId: 'goal-1',
        revision: 1,
      }),
    );
    await waitFor(() => expect(reads(http)).toBe(2));
    expect((await screen.findByTestId('goal-op-done')).textContent).toBe('目标已确认，开始执行');
  });

  it('the confirmation card says which step the requester could not start now', async () => {
    const base = goalDetail();
    const detail = goalDetail({
      status: 'proposed',
      currentRevision: null,
      confirmedAt: null,
      planRevision: {
        ...base.planRevision,
        status: 'proposed',
        hints: [
          {
            code: 'step_gate_not_held',
            message: 'step "apply": …',
            stepKey: 'apply',
            gatekeeperIds: [GATE_ID],
          },
        ],
      },
    });
    renderPage(scriptedHttp(handlers(detail, workspace('p-alice', 'member'))));
    fireEvent.click(await screen.findByTestId('goal-op-confirm'));
    const confirm = await screen.findByTestId('goal-op-confirm-confirm');
    await waitFor(() =>
      expect(within(confirm).getByTestId('confirm-impact').textContent).toMatch(
        /注意：步骤「apply」的 Worker 要操作门「cert-gate」，请求人现在没有这个门的权限.*可以请工作区所有者在「成员与授权」给请求人开通/,
      ),
    );
  });

  it('someone else’s running goal: an owner’s pause is a hold, and says so', async () => {
    const http = scriptedHttp(
      handlers(goalDetail(), workspace('p-owner', 'owner'), {
        pause_goal: () => ({ goalRunId: 'goal-1', status: 'paused', changed: true }),
      }),
    );
    renderPage(http);
    const pause = await screen.findByTestId('goal-op-pause');
    expect(pause.textContent).toBe('暂停并锁定');
    expect(screen.queryByTestId('goal-op-resume')).toBeNull();
    fireEvent.click(pause);
    const confirm = await screen.findByTestId('goal-op-pause-confirm');
    expect(within(confirm).getByTestId('confirm-impact').textContent).toMatch(/请求人不能自己继续/);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'pause_goal')?.params).toEqual({
        goalRunId: 'goal-1',
      }),
    );
  });

  it('lifting a hold says the requester revised the plan while it was held', async () => {
    const base = goalDetail();
    const v1 = base.revisions[0];
    if (!v1) throw new Error('fixture has a revision');
    const detail = goalDetail({
      status: 'paused',
      pauseReason: 'requested',
      pausedBy: 'p-owner',
      pausedByAuthority: 'owner',
      currentRevision: 2,
      revisions: [
        v1,
        {
          ...v1,
          id: 'rev-2',
          revision: 2,
          basedOnRevision: 1,
          decidedAt: '2026-10-20T13:00:00.000Z',
        },
      ],
    });
    const http = scriptedHttp(
      handlers(detail, workspace('p-owner', 'owner'), {
        audit_query: () => ({
          items: [
            {
              id: 'a1',
              actorPrincipalId: 'p-owner',
              action: 'goal_run.pause',
              resourceType: 'goal_run',
              resourceId: 'goal-1',
              payload: { pausedByAuthority: 'owner' },
              createdAt: '2026-10-20T12:00:00.000Z',
            },
          ],
        }),
        release_goal_hold: () => ({ goalRunId: 'goal-1', status: 'paused', changed: true }),
      }),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-release'));
    const confirm = await screen.findByTestId('goal-op-release-confirm');
    expect((await within(confirm).findByTestId('goal-hold-plan')).textContent).toMatch(
      /锁定后请求人改过计划：第 2 版/,
    );
    // Read by action — the goal's own reads fill its trail (review #501 on #697).
    expect(
      http.calls
        .filter((call) => call.name === 'audit_query')
        .map((call) => (call.params as { filter: { action: string } }).filter.action)
        .sort(),
    ).toEqual(['goal_run.hold', 'goal_run.pause']);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'release_goal_hold')).toBe(true),
    );
  });

  it('the requester’s resume on a held goal waits, and says why', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({
          status: 'paused',
          pauseReason: 'requested',
          pausedBy: 'p-owner',
          pausedByAuthority: 'owner',
        }),
        workspace('p-alice', 'member'),
      ),
    );
    renderPage(http);
    const resume = await screen.findByTestId('goal-op-resume');
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen
        .getAllByTestId('goal-op-wait')
        .map((p) => p.textContent)
        .join(),
    ).toMatch(/要等所有者解除锁定/);
    expect(screen.queryByTestId('goal-op-release')).toBeNull();
  });

  it('resuming sends back only the failed steps ticked', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({
          status: 'paused',
          pauseReason: 'needs_decision',
          steps: [
            stepRun({ status: 'failed', failureCategory: 'transient', attempts: [] }),
            stepRun({ id: 'sr-apply', stepKey: 'apply', status: 'failed', attempts: [] }),
          ],
        }),
        workspace('p-alice', 'member'),
        {
          resume_goal: () => ({
            goalRunId: 'goal-1',
            status: 'running',
            changed: true,
            retriedStepRunIds: ['sr-apply'],
          }),
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-resume'));
    const confirm = await screen.findByTestId('goal-op-resume-confirm');
    const retry = within(confirm).getByTestId('goal-op-resume-retry');
    fireEvent.click(within(retry).getByLabelText('apply'));
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'resume_goal')?.params).toEqual({
        goalRunId: 'goal-1',
        retrySteps: ['apply'],
      }),
    );
  });

  it('a note refused for carrying a credential says how to rewrite it, and keeps the note', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({
          status: 'paused',
          pauseReason: 'requested',
          steps: [stepRun({ status: 'succeeded' })],
        }),
        workspace('p-alice', 'member'),
        {
          end_goal: () => {
            throw new HttpError('capability_error', 'note: refused', 'credentials_in_text', {
              field: 'note',
              suspectedSecretValues: 1,
            });
          },
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-end'));
    const confirm = await screen.findByTestId('goal-op-end-confirm');
    const note = within(confirm).getByTestId('goal-op-note') as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: 'password=hunter2' } });
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(confirm.textContent).toMatch(/比如「token 过期了」/));
    expect(note.value).toBe('password=hunter2');
    expect(http.calls.find((call) => call.name === 'end_goal')?.params).toEqual({
      goalRunId: 'goal-1',
      outcome: 'not_achieved',
      note: 'password=hunter2',
    });
  });

  it('records that an action had no effect and runs it again, in one call', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'paused', pauseReason: 'awaiting_reconcile' }),
        workspace('p-alice', 'member'),
        {
          list_goal_unresolved_actions: () => ({
            items: [
              {
                actionRequestId: 'ar-1',
                stepRunId: 'sr-fetch',
                stepKey: 'fetch',
                gatekeeperId: GATE_ID,
                actionKindTag: 'cert.replace',
                failedAt: '2026-10-20T00:05:00.000Z',
                needs: 'finding',
                platformCheck: null,
              },
            ],
          }),
          reconcile_goal_action: () => ({
            goalRunId: 'goal-1',
            status: 'paused',
            changed: true,
            action: {
              actionRequestId: 'ar-1',
              status: 'failed',
              failureKind: 'outcome_unknown',
              reconciliation: 'effect_absent',
              reconciliationDecisionId: 'd1',
              reexecuteDecisionId: 'd2',
            },
          }),
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-reconcile-record'));
    const confirm = await screen.findByTestId('goal-reconcile-record-confirm');
    const button = within(confirm).getByTestId('confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(within(confirm).getByLabelText('没有生效'));
    fireEvent.click(within(confirm).getByTestId('goal-reconcile-reexecute'));
    fireEvent.click(button);
    await waitFor(() =>
      expect(http.calls.find((call) => call.name === 'reconcile_goal_action')?.params).toEqual({
        goalRunId: 'goal-1',
        actionRequestId: 'ar-1',
        verdict: 'effect_absent',
        reexecute: true,
      }),
    );
  });

  it('a 409 because the goal moved on reads it again and says what it is now', async () => {
    let refused = false;
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'paused', pauseReason: 'requested' }),
        workspace('p-alice', 'member'),
        {
          get_goal: () =>
            refused
              ? goalDetail({ status: 'cancelled', updatedAt: '2026-10-20T13:00:00.000Z' })
              : goalDetail({ status: 'paused', pauseReason: 'requested' }),
          resume_goal: () => {
            refused = true;
            throw new HttpError('capability_error', 'goal is cancelled', 'illegal_transition');
          },
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-resume'));
    const confirm = await screen.findByTestId('goal-op-resume-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(screen.getByTestId('goal-op-done').textContent).toMatch(
        /刚才的操作没有执行。页面已经刷新：它现在是「已取消」/,
      ),
    );
  });

  it('a 409 for something of the goal, the goal itself unchanged, says nothing moved on', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'paused', pauseReason: 'requested' }),
        workspace('p-alice', 'member'),
        {
          resume_goal: () => {
            throw new HttpError('capability_error', 'step has a live task', 'illegal_transition');
          },
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-resume'));
    const confirm = await screen.findByTestId('goal-op-resume-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(reads(http)).toBe(2));
    const said = (await screen.findByTestId('goal-op-done')).textContent ?? '';
    expect(said).toMatch(/此刻不能执行，什么也没改；目标仍是「已暂停」/);
    expect(said).not.toMatch(/刚变了/);
    expect(within(confirm).getByText(/此刻不能执行，什么也没改/)).toBeTruthy();
  });

  it('a 409 whose re-read fails says nothing about where the goal stands', async () => {
    let refused = false;
    const http = scriptedHttp(
      handlers(
        goalDetail({ status: 'paused', pauseReason: 'requested' }),
        workspace('p-alice', 'member'),
        {
          get_goal: () => {
            if (refused) throw new HttpError('network', 'offline');
            return goalDetail({ status: 'paused', pauseReason: 'requested' });
          },
          resume_goal: () => {
            refused = true;
            throw new HttpError('capability_error', 'step has a live task', 'illegal_transition');
          },
        },
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-resume'));
    const confirm = await screen.findByTestId('goal-op-resume-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(reads(http)).toBe(2));
    await waitFor(() => expect(screen.queryByTestId('goal-op-done')).toBeNull());
  });

  it('ending as achieved lists the checks recorded as passed on the requester’s word', async () => {
    const http = scriptedHttp(
      handlers(
        goalDetail({
          status: 'paused',
          pauseReason: 'requested',
          steps: [stepRun({ status: 'succeeded' })],
        }),
        workspace('p-alice', 'member'),
      ),
    );
    renderPage(http);
    fireEvent.click(await screen.findByTestId('goal-op-end'));
    const confirm = await screen.findByTestId('goal-op-end-confirm');
    fireEvent.change(within(confirm).getByTestId('goal-op-end-outcome'), {
      target: { value: 'achieved' },
    });
    expect(within(confirm).getByTestId('confirm-impact').textContent).toMatch(
      /记为「请求人判定通过」并写进审计：certs（在门「.*」上观察 /,
    );
  });
});
