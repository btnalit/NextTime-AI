// @vitest-environment jsdom
import type { PolicyWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { GatekeeperListRow } from '../../lib/governance.js';
import { PolicyEditSheet } from './PolicyEditSheet.js';

afterEach(cleanup);

const GATES: readonly GatekeeperListRow[] = [
  {
    id: 'gk-lab',
    name: 'lab-docker',
    kind: 'http',
    status: 'active',
    operationCount: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
  },
];

function savedPolicy(overrides: Partial<PolicyWire> = {}): PolicyWire {
  return {
    id: 'pol-1',
    gatekeeperId: null,
    actionKindTag: 'docker.restart',
    blastRadius: null,
    autoApprove: false,
    requesterCanApprove: null,
    setBy: 'owner-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderSheet(editing?: PolicyWire) {
  const call = vi.fn(async () => savedPolicy());
  const http = { call } as unknown as CapabilityCaller;
  const onSaved = vi.fn();
  render(
    <PolicyEditSheet
      http={http}
      open
      onOpenChange={vi.fn()}
      editing={editing}
      gatekeepers={GATES}
      onSaved={onSaved}
    />,
  );
  return { call, onSaved };
}

describe('PolicyEditSheet — R-20 / D-15 rule scope', () => {
  it('a rule for every gate can only tighten: auto-approve is disabled and the save sends no gate', async () => {
    const { call } = renderSheet();
    fireEvent.change(document.getElementById('pe-action-kind') as HTMLInputElement, {
      target: { value: 'docker.restart' },
    });
    const autoApprove = screen.getByTestId('policy-edit-auto-approve') as HTMLInputElement;
    expect(autoApprove.disabled).toBe(true);
    expect(autoApprove.checked).toBe(false);

    fireEvent.click(screen.getByTestId('policy-edit-submit'));
    const confirm = await screen.findByTestId('policy-edit-confirm');
    expect(confirm.textContent).toContain('所有门上的同名动作');
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('set_policy', {
        policy: { actionKindTag: 'docker.restart', autoApprove: false },
      }),
    );
  });

  it('a gate rule may turn auto-approval on; the save carries the gate and the confirm names it', async () => {
    const { call } = renderSheet();
    fireEvent.change(document.getElementById('pe-action-kind') as HTMLInputElement, {
      target: { value: 'docker.restart' },
    });
    fireEvent.change(screen.getByTestId('policy-edit-gate-scope'), {
      target: { value: 'gk-lab' },
    });
    const autoApprove = screen.getByTestId('policy-edit-auto-approve') as HTMLInputElement;
    expect(autoApprove.disabled).toBe(false);
    fireEvent.click(autoApprove);

    fireEvent.click(screen.getByTestId('policy-edit-submit'));
    // Loosening → the irreversible tier: retype the target, acknowledge.
    const confirm = await screen.findByTestId('policy-edit-confirm');
    expect(confirm.textContent).toContain('lab-docker');
    fireEvent.change(screen.getByTestId('confirm-typed-name'), {
      target: { value: 'docker.restart' },
    });
    fireEvent.click(screen.getByTestId('confirm-acknowledge'));
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('set_policy', {
        policy: { actionKindTag: 'docker.restart', autoApprove: true, gatekeeperId: 'gk-lab' },
      }),
    );
  });

  it('editing a gate rule keeps its gate (read-only) and sends it back', async () => {
    const { call } = renderSheet(savedPolicy({ gatekeeperId: 'gk-lab', autoApprove: true }));
    const scope = screen.getByTestId('policy-edit-gate-scope') as HTMLSelectElement;
    expect(scope.value).toBe('gk-lab');
    expect(scope.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('policy-edit-auto-approve'));
    fireEvent.click(screen.getByTestId('policy-edit-submit'));
    await screen.findByTestId('policy-edit-confirm');
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('set_policy', {
        policy: { actionKindTag: 'docker.restart', autoApprove: false, gatekeeperId: 'gk-lab' },
      }),
    );
  });
});
