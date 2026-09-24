// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCardData } from '../lib/action-card.js';
import { ActionRequestDetail } from './ActionRequestDetail.js';

afterEach(cleanup);

function card(overrides: Partial<ActionCardData> = {}): ActionCardData {
  return {
    actionRequestId: 'ar-1',
    gatekeeperId: 'gk-1',
    title: 'docker container restart',
    description: 'Restart the web-1 container.',
    actionKindTag: 'docker.container_restart',
    actionKindLabel: 'docker container restart',
    resourceScope: 'web-1',
    blastRadius: 'medium',
    awaitDecision: false,
    simulated: undefined,
    status: 'pending_approval',
    isHolder: true,
    params: { container: 'web-1', password: 'hunter2' },
    onBehalfOf: 'principal-a',
    actorRuntime: 'worker',
    policyDecision: 'require_approval',
    parentWorkerRunId: null,
    requestedAt: '2026-09-03T00:00:00.000Z',
    executedAt: null,
    failedAt: null,
    ...overrides,
  };
}

function renderDetail(
  overrides: Partial<ActionCardData> = {},
  props: Partial<Parameters<typeof ActionRequestDetail>[0]> = {},
) {
  const onApprove = vi.fn();
  const onReject = vi.fn();
  render(
    <ActionRequestDetail
      card={card(overrides)}
      busy={false}
      error={null}
      onApprove={onApprove}
      onReject={onReject}
      canAlwaysAllow
      {...props}
    />,
  );
  return { onApprove, onReject };
}

/**
 * ActionRequestDetail.test.tsx (C22, console-completion-plan §2b): the chat's inline rendering of
 * an ActionRequest (`ActionRequestCard.tsx` wraps it). The approvals page now renders
 * `approvals/ApprovalDetail` instead — these cover the contract the chat card still relies on,
 * plus the S6-A C25 reason handling added here.
 */
describe('ActionRequestDetail', () => {
  it('shows governance fields, redacts sensitive params and hides timestamps when compact', () => {
    renderDetail({}, { compact: true });
    expect(screen.getByText('docker container restart')).toBeTruthy();
    expect(screen.getByText('Restart the web-1 container.')).toBeTruthy();
    expect(screen.getByText('web-1')).toBeTruthy();
    expect(screen.getByText('require_approval')).toBeTruthy();
    const params = document.querySelector('.params-block');
    expect(params?.textContent).toContain('[redacted]');
    expect(params?.textContent).not.toContain('hunter2');
    expect(screen.queryByText('Requested')).toBeNull();
  });

  it('shows the requested / executed timestamps in the full variant', () => {
    renderDetail({ status: 'executed', executedAt: '2026-09-03T00:01:00.000Z' });
    expect(screen.getByText('Requested')).toBeTruthy();
    // Before S8 W1-A10 'Executed' was both the status chip's label and the timestamp's <dt>; the
    // chip is bilingual now (default zh-CN renders '已执行'), so only the <dt> matches.
    expect(screen.getAllByText('Executed')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('approve carries the trimmed reason only when one was typed (pre-S6-A callers see the old shape)', () => {
    const { onApprove } = renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenLastCalledWith('ar-1', { alwaysAllow: false });

    fireEvent.change(screen.getByLabelText('Decision reason'), {
      target: { value: '  change window  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenLastCalledWith('ar-1', {
      alwaysAllow: false,
      reason: 'change window',
    });
  });

  it('high blast radius: Approve without a reason is refused in place; Reject is not gated', () => {
    const { onApprove, onReject } = renderDetail({ blastRadius: 'high' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('必须填写批准理由');
    expect(screen.getByLabelText('Decision reason').getAttribute('aria-required')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith('ar-1', undefined);

    fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'ok' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('ar-1', { alwaysAllow: false, reason: 'ok' });
  });

  it('only a holder of a still-pending request sees the decision form', () => {
    renderDetail({ isHolder: false });
    expect(screen.queryByTestId('decision-form')).toBeNull();
    cleanup();
    renderDetail({ status: 'rejected' });
    expect(screen.queryByTestId('decision-form')).toBeNull();
    expect(document.querySelector('.action-card-status')?.getAttribute('data-status')).toBe(
      'rejected',
    );
  });
});
