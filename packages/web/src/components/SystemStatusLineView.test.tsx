// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../lib/format.js';
import { SystemStatusLineView } from './SystemStatusLineView.js';

afterEach(cleanup);

describe('SystemStatusLineView', () => {
  it('legacy 589: a refused Turn reads as a warning with what happened and when the budget resets, and opens nothing', () => {
    const onOpen = vi.fn();
    render(
      <SystemStatusLineView
        line={{
          variant: 'model_refused',
          text: 'The platform refused the model calls for this message',
          turnId: 'turn-1',
          scope: 'workspace_daily_cost',
          resetsAt: '2026-11-02T00:00:00.000Z',
        }}
        onOpen={onOpen}
      />,
    );
    const row = screen.getByTestId('system-status-line');
    expect(row.getAttribute('data-variant')).toBe('model_refused');
    const label = screen.getByTestId('system-status-failure');
    expect(label.textContent).toBe('模型调用被平台拒绝');
    expect(label.className).toContain('text-danger');
    expect(row.textContent).toContain('当天的模型费用预算用完了');
    expect(row.textContent).toContain(formatDateTime('2026-11-02T00:00:00.000Z'));
    expect(row.textContent).not.toContain('The platform refused');
    expect(document.querySelector('.chip')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders status badge and text for an action_update line', () => {
    render(
      <SystemStatusLineView
        line={{
          variant: 'action_update',
          text: 'ActionRequest approved',
          actionRequestId: 'ar-1',
          status: 'approved',
          isHolder: true,
        }}
      />,
    );
    expect(document.querySelector('.chip')?.getAttribute('data-status')).toBe('approved');
    // S8 W1-A10: the actionRequest StatusChip is bilingual now; default zh-CN renders '已批准'.
    expect(document.querySelector('.chip')?.textContent).toBe('已批准');
    expect(screen.getByText('ActionRequest approved')).toBeTruthy();
  });

  it('names the failure kind of a failed action_update line (S11 GO1)', () => {
    const renderKind = (failureKind: string) =>
      render(
        <SystemStatusLineView
          line={{
            variant: 'action_update',
            text: 'ActionRequest failed',
            actionRequestId: 'ar-1',
            status: 'failed',
            isHolder: true,
            failureKind,
          }}
        />,
      );
    renderKind('outcome_unknown');
    const unknown = screen.getByTestId('system-status-failure');
    expect(unknown.textContent).toBe('结果不明，需要核对');
    expect(unknown.className).toContain('text-danger');
    cleanup();
    renderKind('not_delivered');
    const notSent = screen.getByTestId('system-status-failure');
    expect(notSent.getAttribute('data-failure-kind')).toBe('not_delivered');
    expect(notSent.className).not.toContain('text-danger');
    cleanup();
    render(
      <SystemStatusLineView
        line={{
          variant: 'action_update',
          text: 'ActionRequest withdrawn',
          actionRequestId: 'ar-1',
          status: 'withdrawn',
          isHolder: true,
          failureKind: null,
        }}
      />,
    );
    // Legacy 328: a withdrawn line says nothing ran and nothing is needed, quietly.
    const withdrawn = screen.getByTestId('system-status-failure');
    expect(withdrawn.getAttribute('data-failure-kind')).toBe('withdrawn');
    expect(withdrawn.textContent).toBe('什么都没执行，不需要处理');
    expect(withdrawn.className).not.toContain('text-danger');
    expect(document.querySelector('.chip')?.textContent).toBe('已撤回');
  });

  it('renders the failureReason hint for a failed task_update line', () => {
    render(
      <SystemStatusLineView
        line={{
          variant: 'task_update',
          text: 'Task failed',
          taskId: 'task-1',
          status: 'failed',
          failureReason: 'worker_failed',
          summary: null,
        }}
      />,
    );
    // Legacy 324: the label, with the sentence as its tooltip — never the raw code.
    const reason = screen.getByText('(Worker 运行失败)');
    expect(reason.getAttribute('title')).toContain('自动重试也没有成功');
    expect(document.body.textContent).not.toContain('worker_failed');
    expect(document.querySelector('.chip')?.getAttribute('data-status')).toBe('failed');
  });

  it('renders as a button that opens the referenced detail when onOpen is given', () => {
    const onOpen = vi.fn();
    render(
      <SystemStatusLineView
        line={{
          variant: 'task_update',
          text: 'Task completed',
          taskId: 'task-1',
          status: 'completed',
          failureReason: null,
          summary: null,
        }}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Task completed/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("S11 GO5e-2: a goal milestone reads in the reader's language with the goal's chip and opens the goal", () => {
    const onOpen = vi.fn();
    render(
      <SystemStatusLineView
        line={{
          variant: 'goal_update',
          text: "Goal goal-1 completed: achieved, on the platform's checks",
          goalRunId: 'goal-1',
          change: 'complete',
          status: 'completed',
          pauseReason: null,
          heldByOwner: false,
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
          cleanupPending: false,
          revision: null,
        }}
        onOpen={onOpen}
      />,
    );
    const button = screen.getByRole('button', { name: /目标已达成 · 依据平台验收检查/ });
    expect(button.getAttribute('title')).toBe('打开目标');
    expect(document.querySelector('.chip')?.getAttribute('data-status')).toBe('completed');
    expect(screen.getByTestId('system-status-goal-outcome').getAttribute('data-status')).toBe(
      'achieved',
    );
    // The kernel's own (English) text is not what the reader sees.
    expect(screen.queryByText(/on the platform's checks/)).toBeNull();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('#737 UX P2-1: an end "not achieved" says so in words and with the outcome chip, never only a green 「已结束」', () => {
    render(
      <SystemStatusLineView
        line={{
          variant: 'goal_update',
          text: 'Goal goal-1 completed: not achieved',
          goalRunId: 'goal-1',
          change: 'complete',
          status: 'completed',
          pauseReason: null,
          heldByOwner: false,
          outcome: 'not_achieved',
          outcomeBasis: 'requester',
          cleanupPending: false,
          revision: null,
        }}
      />,
    );
    const line = screen.getByTestId('system-status-line');
    expect(line.textContent).toMatch(/目标按未达成结束 · 依据请求人确认/);
    expect(line.textContent).not.toMatch(/已完成/);
    const outcome = screen.getByTestId('system-status-goal-outcome');
    expect(outcome.getAttribute('data-status')).toBe('not_achieved');
    expect(outcome.className).toMatch(/chip-danger/);
  });

  it('#737 UX P2-2: a milestone and a goal step say which goal, on one line with the whole statement as its title', () => {
    const statement = '复核二号仓的低库存 SKU，并确认库存系统读数正常。';
    const { unmount } = render(
      <SystemStatusLineView
        line={{
          variant: 'goal_update',
          text: 'Goal goal-1 paused',
          goalRunId: 'goal-1',
          change: 'pause',
          status: 'paused',
          pauseReason: 'authority_lost',
          heldByOwner: false,
          outcome: null,
          outcomeBasis: null,
          cleanupPending: false,
          revision: null,
        }}
        goalLabel={statement}
      />,
    );
    const goal = screen.getByTestId('system-status-goal');
    expect(goal.textContent).toBe(statement);
    expect(goal.getAttribute('title')).toBe(statement);
    // #737 UX P2-3: on a row of its own under what happened, never a column beside it.
    expect(goal.parentElement?.className).toBe('system-status-main');
    expect(goal.previousElementSibling?.className).toBe('system-status-head');
    expect(screen.getByTestId('system-status-line').hasAttribute('data-goal')).toBe(true);
    expect(screen.queryByTestId('system-status-goal-outcome')).toBeNull();
    unmount();
    render(
      <SystemStatusLineView
        line={{
          variant: 'task_update',
          text: 'Goal step "scan": task task-1 failed',
          taskId: 'task-1',
          status: 'failed',
          failureReason: 'other',
          summary: null,
          goalStep: { goalRunId: 'goal-1', stepKey: 'scan' },
        }}
        goalLabel="一个读不到的目标"
      />,
    );
    // The step and why it failed read on one row, then the goal under them.
    expect(screen.getByTestId('system-status-line').textContent).toMatch(
      /^已失败目标步骤 scan\(其他原因\) 一个读不到的目标$/,
    );
    const head = screen.getByTestId('system-status-goal-step').parentElement;
    expect(head?.className).toBe('system-status-head');
    expect(head?.nextElementSibling).toBe(screen.getByTestId('system-status-goal'));
  });

  it("S11 GO5e-2: a goal step's Task names its step in place of the kernel's line", () => {
    render(
      <SystemStatusLineView
        line={{
          variant: 'task_update',
          text: 'Goal step "report": task task-1 completed',
          taskId: 'task-1',
          status: 'completed',
          failureReason: null,
          summary: null,
          goalStep: { goalRunId: 'goal-1', stepKey: 'report' },
        }}
      />,
    );
    expect(screen.getByTestId('system-status-goal-step').textContent).toMatch(/^目标步骤 report$/);
    expect(screen.queryByText(/Goal step "report"/)).toBeNull();
    cleanup();
    render(
      <SystemStatusLineView
        line={{
          variant: 'task_update',
          text: 'Task task-1 completed',
          taskId: 'task-1',
          status: 'completed',
          failureReason: null,
          summary: null,
        }}
      />,
    );
    expect(screen.queryByTestId('system-status-goal-step')).toBeNull();
    expect(screen.getByText('Task task-1 completed')).toBeTruthy();
  });
});
