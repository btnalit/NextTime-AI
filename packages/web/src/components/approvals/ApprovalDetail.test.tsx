// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionRequestRow } from '../../lib/governance.js';
import { HttpError } from '../../lib/http-client.js';
import { ApprovalDetail } from './ApprovalDetail.js';

afterEach(cleanup);

function row(overrides: Partial<ActionRequestRow> = {}): ActionRequestRow {
  return {
    id: 'ar-1',
    status: 'pending_approval',
    gatekeeperId: 'gk-1',
    actionKindTag: 'docker.container_restart',
    resourceScope: 'web-1',
    blastRadius: 'medium',
    awaitDecision: true,
    params: { container: 'web-1', apiKey: 'sk-secret' },
    onBehalfOf: 'principal-a',
    actorRuntime: 'worker',
    policyDecision: 'require_approval',
    parentWorkerRunId: 'run-1',
    requestedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

function renderDetail(
  overrides: Partial<ActionRequestRow> = {},
  props: Partial<Parameters<typeof ApprovalDetail>[0]> = {},
) {
  const onApprove = vi.fn(async () => undefined);
  const onReject = vi.fn(async () => undefined);
  const view = render(
    <ApprovalDetail
      row={row(overrides)}
      principalNames={new Map([['principal-a', 'Alice']])}
      gatekeeperNames={new Map([['gk-1', 'docker-prod']])}
      canAlwaysAllow
      onApprove={onApprove}
      onReject={onReject}
      error={null}
      {...props}
    />,
  );
  return { ...view, onApprove, onReject };
}

describe('ApprovalDetail (S6-A B2 / B3 / C25)', () => {
  it('renders the shared ApprovalCard with named gatekeeper / on-behalf-of chips, redacted params and the blocking notice', () => {
    renderDetail();
    const card = screen.getByTestId('approval-card');
    expect(card.getAttribute('data-blast-radius')).toBe('medium');
    expect(screen.getByTestId('approval-status').getAttribute('data-status')).toBe(
      'pending_approval',
    );
    expect(screen.getByTestId('approval-target').textContent).toBe('web-1');
    expect(screen.getByTestId('approval-on-behalf-of').textContent).toContain('Alice');
    expect(card.querySelector('[data-ref-kind="gatekeeper"]')?.textContent).toContain(
      'docker-prod',
    );
    expect(screen.getByTestId('approval-params').textContent).toContain('[redacted]');
    expect(screen.getByTestId('approval-params').textContent).not.toContain('sk-secret');
    expect(screen.getByTestId('approval-blocking')).toBeTruthy();
    expect(screen.getByTestId('approval-policy').textContent).toContain('require_approval');
  });

  it('reports the decision with the reason and the always-allow choice; Reject carries the reason', async () => {
    const { onApprove, onReject } = renderDetail();
    fireEvent.change(screen.getByTestId('approval-reason'), { target: { value: ' why ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Always allow/ }));
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith({
        actionRequestId: 'ar-1',
        reason: 'why',
        alwaysAllow: true,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    await waitFor(() =>
      expect(onReject).toHaveBeenCalledWith({ actionRequestId: 'ar-1', reason: 'why' }),
    );
  });

  it('high blast radius: Approve without a reason is refused in place (the kernel rule, mirrored)', async () => {
    const { onApprove } = renderDetail({ blastRadius: 'high' });
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await screen.findByText(/A reason is required for a high-impact action/);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('a decided row is read-only and shows the human decision (decidedBy chip, reason, time)', () => {
    renderDetail({
      status: 'approved',
      decidedBy: 'principal-a',
      decidedAt: '2026-09-03T00:01:00.000Z',
      decisionReason: 'looks safe',
      executedAt: '2026-09-03T00:02:00.000Z',
    });
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const decidedBy = screen.getByTestId('approval-decided-by');
    expect(decidedBy.getAttribute('data-ref-id')).toBe('principal-a');
    expect(decidedBy.textContent).toContain('Alice');
    expect(screen.getByTestId('approval-decision-reason').textContent).toBe('looks safe');
    expect(screen.getByText(/Executed/)).toBeTruthy();
  });

  it('a decided row without a human decision says so instead of rendering an empty chip', () => {
    renderDetail({ status: 'auto_approved', decidedBy: null, decisionReason: null });
    expect(screen.queryByTestId('approval-decided-by')).toBeNull();
    expect(screen.getByTestId('approval-decision').textContent).toContain('No human decision');
  });

  it('links to the audit page with the request id and, when decided, the decision node', () => {
    const { unmount } = renderDetail();
    expect(screen.getByTestId('approval-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?actionRequestId=ar-1',
    );
    unmount();
    renderDetail({ status: 'approved', approvalDecisionId: 'dec-9' });
    expect(screen.getByTestId('approval-provenance-link').getAttribute('href')).toBe(
      '#/govern/audit?nodeId=dec-9&actionRequestId=ar-1',
    );
  });

  it('hides the always-allow checkbox when the session may not write rules, and renders the decision error', () => {
    renderDetail(
      {},
      {
        canAlwaysAllow: false,
        error: new HttpError('capability_error', 'already decided', 'illegal_transition'),
      },
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('approval-decision-error').getAttribute('data-error-code')).toBe(
      'illegal_transition',
    );
  });
});
