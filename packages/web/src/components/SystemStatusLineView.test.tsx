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
    expect(document.querySelector('.chip')?.textContent).toBe('Approved');
    expect(screen.getByText('ActionRequest approved')).toBeTruthy();
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
