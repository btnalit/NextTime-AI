// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCardData } from '../lib/action-card.js';
import { ActionRequestCard } from './ActionRequestCard.js';

// `globals: false` (vitest.base.ts) means `@testing-library/react`'s automatic afterEach cleanup
// (which relies on globally-registered test hooks) never fires — every jsdom component test file
// in this package must register it itself.
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
    ...overrides,
  };
}

describe('ActionRequestCard', () => {
  it('renders title, description, action kind tag, and buttons for a holder-pending card', () => {
    render(
      <ActionRequestCard
        card={baseCard()}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );

    expect(screen.getByText('docker container restart')).toBeTruthy();
    expect(screen.getByText('Restart the web-1 container.')).toBeTruthy();
    expect(screen.getByText('docker.container_restart')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always approve this kind' })).toBeTruthy();
  });

  it('renders a status-only line with no buttons when isHolder is false', () => {
    render(
      <ActionRequestCard
        card={baseCard({ isHolder: false })}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('pending_approval')).toBeTruthy();
  });

  it('hides buttons once status is no longer pending_approval', () => {
    render(
      <ActionRequestCard
        card={baseCard({ status: 'approved' })}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('approved')).toBeTruthy();
  });

  it('applies the blocking style when awaitDecision is true and still pending', () => {
    const { container } = render(
      <ActionRequestCard
        card={baseCard({ awaitDecision: true })}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );
    expect(container.querySelector('.action-card-blocking')).toBeTruthy();
    expect(screen.getByText('Awaiting your decision.')).toBeTruthy();
  });

  it('renders the simulated block only when present', () => {
    const { rerender, container } = render(
      <ActionRequestCard
        card={baseCard()}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );
    expect(container.querySelector('.action-card-simulated')).toBeNull();

    rerender(
      <ActionRequestCard
        card={baseCard({ simulated: { wouldStop: 'web-1' } })}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );
    expect(container.querySelector('.action-card-simulated')?.textContent).toContain('wouldStop');
  });

  it('calls onApprove with the actionRequestId', () => {
    const onApprove = vi.fn();
    render(
      <ActionRequestCard
        card={baseCard()}
        busy={false}
        error={null}
        onApprove={onApprove}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('ar-1');
  });

  it('calls onAlwaysApprove with the actionKindTag', () => {
    const onAlwaysApprove = vi.fn();
    render(
      <ActionRequestCard
        card={baseCard()}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={onAlwaysApprove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Always approve this kind' }));
    expect(onAlwaysApprove).toHaveBeenCalledWith('docker.container_restart');
  });

  it('reveals a reason field on Reject and calls onReject with the trimmed reason on confirm', () => {
    const onReject = vi.fn();
    render(
      <ActionRequestCard
        card={baseCard()}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={onReject}
        onAlwaysApprove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const textarea = screen.getByPlaceholderText('Reason (optional)');
    fireEvent.change(textarea, { target: { value: '  not needed  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));
    expect(onReject).toHaveBeenCalledWith('ar-1', 'not needed');
  });

  it('calls onReject with undefined reason when left blank', () => {
    const onReject = vi.fn();
    render(
      <ActionRequestCard
        card={baseCard()}
        busy={false}
        error={null}
        onApprove={vi.fn()}
        onReject={onReject}
        onAlwaysApprove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }));
    expect(onReject).toHaveBeenCalledWith('ar-1', undefined);
  });

  it('disables buttons while busy', () => {
    render(
      <ActionRequestCard
        card={baseCard()}
        busy={true}
        error={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('renders the error message when present', () => {
    render(
      <ActionRequestCard
        card={baseCard()}
        busy={false}
        error="I8: high blast radius cannot be auto-approved"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onAlwaysApprove={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('high blast radius');
  });
});
