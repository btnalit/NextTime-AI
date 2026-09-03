// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCardData } from '../lib/action-card.js';
import { HttpError } from '../lib/http-client.js';
import { ActionRequestCard, type ActionRequestCardProps } from './ActionRequestCard.js';

// `globals: false` (vitest.base.ts) means `@testing-library/react`'s automatic afterEach cleanup
// never fires — every jsdom component test file in this package registers it itself.
afterEach(cleanup);

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
    busy: false,
    error: null,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    canAlwaysAllow: true,
    ...overrides,
  };
  return { ...render(<ActionRequestCard {...props} />), props };
}

describe('ActionRequestCard', () => {
  it('renders title, description, action kind tag, status chip and decision buttons for a holder-pending card', () => {
    renderCard();
    expect(screen.getByText('docker container restart')).toBeTruthy();
    expect(screen.getByText('Restart the web-1 container.')).toBeTruthy();
    expect(document.querySelector('.tag')?.textContent).toBe('docker.container_restart');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Always allow/ })).toBeTruthy();
    const chip = document.querySelector('.action-card-status');
    expect(chip?.getAttribute('data-status')).toBe('pending_approval');
  });

  it('renders a status-only line with no buttons when isHolder is false', () => {
    renderCard({ card: baseCard({ isHolder: false }) });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(document.querySelector('.action-card-status-only')).toBeTruthy();
    expect(document.querySelector('.action-card-status')?.getAttribute('data-status')).toBe(
      'pending_approval',
    );
  });

  it('hides the decision form once status is no longer pending_approval', () => {
    renderCard({ card: baseCard({ status: 'approved' }) });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(document.querySelector('.action-card-status')?.getAttribute('data-status')).toBe(
      'approved',
    );
    expect(document.querySelector('.action-card-status')?.textContent).toBe('Approved');
  });

  it('applies the blocking style when awaitDecision is true and still pending', () => {
    renderCard({ card: baseCard({ awaitDecision: true }) });
    expect(document.querySelector('.action-card-blocking')).toBeTruthy();
    expect(screen.getByText('Awaiting your decision.')).toBeTruthy();
  });

  it('renders the simulated block only when present', () => {
    const { rerender, props } = renderCard();
    expect(document.querySelector('.action-card-simulated')).toBeNull();
    rerender(
      <ActionRequestCard {...props} card={baseCard({ simulated: { wouldStop: 'web-1' } })} />,
    );
    expect(document.querySelector('.action-card-simulated')?.textContent).toContain('wouldStop');
  });

  it('calls onApprove with the actionRequestId and the always-allow choice', () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(props.onApprove).toHaveBeenCalledWith('ar-1', { alwaysAllow: false });

    fireEvent.click(screen.getByRole('checkbox', { name: /Always allow/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(props.onApprove).toHaveBeenLastCalledWith('ar-1', { alwaysAllow: true });
  });

  it('hides the always-allow checkbox when the session may not write auto-approval rules', () => {
    renderCard({ canAlwaysAllow: false });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('calls onReject with the trimmed reason, or undefined when blank', () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(props.onReject).toHaveBeenCalledWith('ar-1', undefined);

    fireEvent.change(screen.getByLabelText('Decision reason'), {
      target: { value: '  not needed  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(props.onReject).toHaveBeenLastCalledWith('ar-1', 'not needed');
  });

  it('disables the decision controls while busy', () => {
    renderCard({ busy: true });
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
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
});
