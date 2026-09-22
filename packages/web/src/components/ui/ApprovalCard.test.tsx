// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard.js';

afterEach(cleanup);

describe('ApprovalCard', () => {
  it('renders kind, target, chips, on-behalf-of RefChip and the four decisions', () => {
    render(
      <ApprovalCard
        actionRequestId="ar-1"
        actionKind="docker.container_stop"
        mode="execute"
        blastRadius="medium"
        status="pending_approval"
        target="container web-1"
        onBehalfOf={{ id: 'p-1', name: 'Ada' }}
        gatekeeper={{ id: 'gk-1', name: 'docker' }}
        policySummary="require_approval: execute"
        approvalsHref="#/work/approvals/ar-1"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysAllow={vi.fn()}
        testId="card"
      />,
    );
    const card = screen.getByTestId('card');
    expect(card.getAttribute('data-blast-radius')).toBe('medium');
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('docker.container_stop');
    expect(screen.getByTestId('approval-target').textContent).toBe('container web-1');
    expect(screen.getByTestId('approval-blast-radius').textContent).toBe('中影响 Medium');
    expect(screen.getByTestId('approval-status').getAttribute('data-status')).toBe(
      'pending_approval',
    );
    expect(screen.getByTestId('approval-on-behalf-of').textContent).toContain('Ada');
    expect(screen.getByTestId('approval-policy').textContent).toBe('require_approval: execute');
    expect(screen.getByTestId('approval-approve')).toBeTruthy();
    expect(screen.getByTestId('approval-reject')).toBeTruthy();
    expect(screen.getByTestId('approval-always-allow')).toBeTruthy();
    expect(screen.getByTestId('approval-open-page').getAttribute('href')).toBe(
      '#/work/approvals/ar-1',
    );
  });

  it('requires a reason to approve a high-impact action, and passes it through', async () => {
    const onApprove = vi.fn(async () => undefined);
    render(
      <ApprovalCard
        actionRequestId="ar-2"
        actionKind="http.delete"
        blastRadius="high"
        target="/api/orders/42"
        onApprove={onApprove}
      />,
    );
    const reason = screen.getByTestId('approval-reason');
    expect(reason.getAttribute('aria-required')).toBe('true');
    fireEvent.click(screen.getByTestId('approval-approve'));
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('A reason is required');
    expect(document.activeElement).toBe(reason);

    fireEvent.change(reason, { target: { value: '  ticket 123  ' } });
    fireEvent.click(screen.getByTestId('approval-approve'));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith('ticket 123'));
  });

  it('approves without a reason for low impact and rejects with an optional reason', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ApprovalCard
        actionRequestId="ar-3"
        actionKind="fs.read"
        blastRadius="low"
        target="/tmp/x"
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    expect(screen.getByTestId('approval-reason').getAttribute('aria-required')).toBeNull();
    fireEvent.click(screen.getByTestId('approval-approve'));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(undefined));
    fireEvent.change(screen.getByTestId('approval-reason'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('approval-reject'));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith('nope'));
  });

  it('readOnly hides the decisions but keeps the page link', () => {
    render(
      <ApprovalCard
        actionRequestId="ar-4"
        actionKind="x"
        blastRadius="low"
        status="executed"
        target="t"
        readOnly
        approvalsHref="#/work/approvals/ar-4"
        onApprove={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('approval-approve')).toBeNull();
    expect(screen.queryByTestId('approval-reason')).toBeNull();
    expect(screen.getByTestId('approval-open-page')).toBeTruthy();
  });
});
