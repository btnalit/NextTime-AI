// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemStatusLineView } from './SystemStatusLineView.js';

afterEach(cleanup);

describe('SystemStatusLineView', () => {
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
    expect(screen.getByText('(worker_failed)')).toBeTruthy();
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
});
