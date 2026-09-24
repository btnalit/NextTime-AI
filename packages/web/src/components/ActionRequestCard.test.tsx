// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCardData } from '../lib/action-card.js';
import { HttpError } from '../lib/http-client.js';
import { ActionRequestCard, type ActionRequestCardProps } from './ActionRequestCard.js';

// `globals: false` (vitest.base.ts) means `@testing-library/react`'s automatic afterEach cleanup
// never fires — every jsdom component test file in this package registers it itself.
afterEach(cleanup);

/**
 * ActionRequestCard.test.tsx (S6-A): the inline card on `ui/ApprovalCard`. The kit's own tests
 * (ui/ApprovalCard.test.tsx) cover the reason validation and button states; this file covers the
 * adapter — what of `ActionCardData` reaches the card, the two modes, the outcome line, the
 * stable e2e hooks (`.action-card`, `.action-card-status`) and the callback shapes.
 */

function baseCard(overrides: Partial<ActionCardData> = {}): ActionCardData {
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
    params: undefined,
    onBehalfOf: undefined,
    actorRuntime: undefined,
    policyDecision: undefined,
    parentWorkerRunId: undefined,
    requestedAt: undefined,
    executedAt: undefined,
    failedAt: undefined,
    ...overrides,
  };
}

function renderCard(overrides: Partial<ActionRequestCardProps> = {}) {
  const props: ActionRequestCardProps = {
    card: baseCard(),
    error: null,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    canAlwaysAllow: true,
    ...overrides,
  };
  return { ...render(<ActionRequestCard {...props} />), props };
}

describe('ActionRequestCard', () => {
  it('renders the shared card — kind, target, blast radius, description, decision buttons and the approvals link — for a holder-pending card', () => {
    renderCard();
    expect(screen.getByTestId('action-request-card')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'docker.container_restart' })).toBeTruthy();
    expect(screen.getByTestId('approval-target').textContent).toBe('web-1');
    expect(screen.getByTestId('approval-blast-radius').getAttribute('data-status')).toBe('medium');
    expect(screen.getByText('Restart the web-1 container.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /批准/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /拒绝/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /总是允许/ })).toBeTruthy();
    expect(screen.getByTestId('approval-open-page').getAttribute('href')).toBe(
      '#/work/approvals/ar-1',
    );
    // The stable e2e hooks: `.action-card` wraps, `.action-card-status` carries the raw status.
    expect(document.querySelector('.action-card')).toBeTruthy();
    const chip = document.querySelector('.action-card-status');
    expect(chip?.getAttribute('data-status')).toBe('pending_approval');
    expect(screen.getByTestId('action-outcome').textContent).toContain('待审批');
  });

  it('renders a status-only line with no buttons when isHolder is false', () => {
    renderCard({ card: baseCard({ isHolder: false }) });
    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /拒绝/ })).toBeNull();
    expect(screen.queryByTestId('action-request-card')).toBeNull();
    expect(document.querySelector('.action-card-status-only')).toBeTruthy();
    expect(document.querySelector('.action-card-status')?.getAttribute('data-status')).toBe(
      'pending_approval',
    );
  });

  it('goes read-only and shows the outcome line once status is no longer pending_approval', () => {
    renderCard({ card: baseCard({ status: 'executed' }) });
    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
    expect(screen.queryByTestId('approval-reason')).toBeNull();
    expect(document.querySelector('.action-card-status')?.getAttribute('data-status')).toBe(
      'executed',
    );
    expect(screen.getByTestId('action-outcome').textContent).toContain('已执行');
    // The deep link stays available on a decided card.
    expect(screen.getByTestId('approval-open-page')).toBeTruthy();
  });

  it('reads 已拒绝', () => {
    renderCard({ card: baseCard({ status: 'rejected' }) });
    expect(screen.getByTestId('action-outcome').textContent).toContain('已拒绝');
  });

  it('applies the blocking style and notice when awaitDecision is true and still pending', () => {
    renderCard({ card: baseCard({ awaitDecision: true }) });
    expect(document.querySelector('.action-card-blocking')).toBeTruthy();
    expect(screen.getByText(/等待你的决定/)).toBeTruthy();
  });

  it('renders the simulated block only when present', () => {
    const { rerender, props } = renderCard();
    expect(document.querySelector('.action-card-simulated')).toBeNull();
    rerender(
      <ActionRequestCard {...props} card={baseCard({ simulated: { wouldStop: 'web-1' } })} />,
    );
    expect(document.querySelector('.action-card-simulated')?.textContent).toContain('wouldStop');
  });

  it('calls onApprove with the trimmed reason and alwaysAllow: false', async () => {
    const { props } = renderCard();
    fireEvent.change(screen.getByTestId('approval-reason'), {
      target: { value: '  routine restart  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /批准/ }));
    await waitFor(() =>
      expect(props.onApprove).toHaveBeenCalledWith('ar-1', {
        reason: 'routine restart',
        alwaysAllow: false,
      }),
    );
  });

  it('"Always allow" approves with alwaysAllow: true', async () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /总是允许/ }));
    await waitFor(() =>
      expect(props.onApprove).toHaveBeenCalledWith('ar-1', {
        reason: undefined,
        alwaysAllow: true,
      }),
    );
  });

  it('requires a reason to approve a high blast radius and never offers "Always allow" for it (I8)', async () => {
    const { props } = renderCard({ card: baseCard({ blastRadius: 'high' }) });
    expect(screen.queryByRole('button', { name: /总是允许/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /批准/ }));
    await screen.findByRole('alert');
    expect(props.onApprove).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('approval-reason'), {
      target: { value: 'incident 42, approved by on-call' },
    });
    fireEvent.click(screen.getByRole('button', { name: /批准/ }));
    await waitFor(() =>
      expect(props.onApprove).toHaveBeenCalledWith('ar-1', {
        reason: 'incident 42, approved by on-call',
        alwaysAllow: false,
      }),
    );
  });

  it('hides "Always allow" when the session may not write auto-approval rules', () => {
    renderCard({ canAlwaysAllow: false });
    expect(screen.queryByRole('button', { name: /总是允许/ })).toBeNull();
    expect(screen.getByRole('button', { name: /批准/ })).toBeTruthy();
  });

  it('calls onReject with the trimmed reason, or undefined when blank', async () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    await waitFor(() => expect(props.onReject).toHaveBeenCalledWith('ar-1', undefined));

    fireEvent.change(screen.getByTestId('approval-reason'), {
      target: { value: '  not needed  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    await waitFor(() => expect(props.onReject).toHaveBeenLastCalledWith('ar-1', 'not needed'));
  });

  it('renders the decision error with its wire code', () => {
    renderCard({
      error: new HttpError(
        'capability_error',
        'I8: high blast radius cannot be auto-approved',
        'invalid_params',
      ),
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('high blast radius');
    expect(alert.getAttribute('data-error-code')).toBe('invalid_params');
  });

  it('redacts sensitive-looking parameter keys in the params block', () => {
    renderCard({
      card: baseCard({ params: { container: 'web-1', apiKey: 'sk-secret-value' } }),
    });
    const block = document.querySelector('.params-block');
    expect(block?.textContent).toContain('"container": "web-1"');
    expect(block?.textContent).toContain('[redacted]');
    expect(block?.textContent).not.toContain('sk-secret-value');
  });

  it('shows on-behalf-of and policy when the row carries them', () => {
    renderCard({
      card: baseCard({ onBehalfOf: 'principal-9', policyDecision: 'require_approval' }),
    });
    expect(screen.getByTestId('approval-on-behalf-of').getAttribute('data-ref-id')).toBe(
      'principal-9',
    );
    expect(screen.getByTestId('approval-policy').textContent).toBe('require_approval');
  });
});
