// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(screen.getByText('approved')).toBeTruthy();
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
  });
});
