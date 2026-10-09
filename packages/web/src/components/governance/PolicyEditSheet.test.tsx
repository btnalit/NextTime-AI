// @vitest-environment jsdom
import type { OperationSummaryWire, PolicyWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const OPERATIONS = [
  operation({ gatekeeperId: 'gk-lab', name: 'docker.restart', blastRadius: 'medium' }),
  operation({ gatekeeperId: 'gk-lab', name: 'docker.prune', blastRadius: 'high' }),
  // A draft is never a pickable rule target — only published Operations can be requested.
  operation({ gatekeeperId: 'gk-lab', name: 'docker.draft', status: 'draft' }),
];

function operation(overrides: Partial<OperationSummaryWire>): OperationSummaryWire {
  return {
    gatekeeperId: 'gk-lab',
    name: 'op',
    mode: 'execute',
    blastRadius: 'low',
    autoApprovable: false,
    version: 1,
    status: 'published',
    ...overrides,
  };
}

function renderSheet(
  editing?: PolicyWire,
  listOperations: (params: { gatekeeperId?: string }) => Promise<unknown> = async (params) => ({
    items: OPERATIONS.filter(
      (row) => params.gatekeeperId === undefined || row.gatekeeperId === params.gatekeeperId,
    ),
  }),
) {
  const call = vi.fn(async (name: string, params?: unknown) => {
    if (name === 'list_operations')
      return listOperations((params ?? {}) as { gatekeeperId?: string });
    return savedPolicy();
  });
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

/** The Operation names the combobox offers right now (opens it if closed). */
async function offeredOperations(): Promise<string[]> {
  const input = (await screen.findByTestId('policy-edit-operation')) as HTMLInputElement;
  await waitFor(() => expect(input.getAttribute('aria-busy')).toBeNull());
  if (input.getAttribute('aria-expanded') !== 'true') fireEvent.click(input);
  return within(screen.getByRole('listbox'))
    .queryAllByRole('option')
    .map((option) => option.querySelector('.combobox-option-label')?.textContent ?? '');
}

async function pickOperation(name: string) {
  const input = (await screen.findByTestId('policy-edit-operation')) as HTMLInputElement;
  await waitFor(() => expect(input.getAttribute('aria-busy')).toBeNull());
  fireEvent.change(input, { target: { value: name } });
  const option = await waitFor(() => {
    const match = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .find((row) => row.querySelector('.combobox-option-label')?.textContent === name);
    expect(match).toBeTruthy();
    return match as HTMLElement;
  });
  fireEvent.click(option);
}

describe('PolicyEditSheet — R-20 / D-15 rule scope', () => {
  it('a rule for every gate can only tighten: auto-approve is disabled and the save sends no gate', async () => {
    const { call } = renderSheet();
    await pickOperation('docker.restart');
    const autoApprove = screen.getByTestId('policy-edit-auto-approve') as HTMLInputElement;
    expect(autoApprove.disabled).toBe(true);
    expect(autoApprove.checked).toBe(false);

    fireEvent.click(screen.getByTestId('policy-edit-submit'));
    const confirm = await screen.findByTestId('policy-edit-confirm');
    expect(confirm.textContent).toContain('所有门上的同名动作');
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('set_policy', {
        policy: { actionKindTag: 'docker.restart', autoApprove: false, blastRadius: 'medium' },
      }),
    );
  });

  it('a gate rule may turn auto-approval on; the save carries the gate and the confirm names it', async () => {
    const { call } = renderSheet();
    fireEvent.change(screen.getByTestId('policy-edit-gate-scope'), {
      target: { value: 'gk-lab' },
    });
    await pickOperation('docker.restart');
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
        policy: {
          actionKindTag: 'docker.restart',
          autoApprove: true,
          gatekeeperId: 'gk-lab',
          blastRadius: 'medium',
        },
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

describe('PolicyEditSheet — the action kind is picked from the gate’s published Operations', () => {
  it('offers only the chosen gate’s published Operations and prefills the blast radius from the pick', async () => {
    const { call } = renderSheet();
    fireEvent.change(screen.getByTestId('policy-edit-gate-scope'), {
      target: { value: 'gk-lab' },
    });
    await pickOperation('docker.prune');
    expect(call).toHaveBeenCalledWith('list_operations', { gatekeeperId: 'gk-lab' });
    expect((screen.getByTestId('policy-edit-operation') as HTMLInputElement).value).toBe(
      'docker.prune',
    );
    expect(await offeredOperations()).toEqual(['docker.prune', 'docker.restart']);
    // Each choice carries its declared blast radius beside the name.
    expect(screen.getByRole('option', { name: /docker.prune/ }).textContent).toContain('高');
    fireEvent.keyDown(screen.getByTestId('policy-edit-operation'), { key: 'Escape' });
    expect((screen.getByTestId('policy-edit-blast-radius') as HTMLSelectElement).value).toBe(
      'high',
    );
    expect(screen.getByText(/已按 Operation「docker.prune」声明的影响预填/)).toBeTruthy();
    // A high-impact Operation can never be auto-approved (I8).
    expect((screen.getByTestId('policy-edit-auto-approve') as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('switching the gate clears an Operation picked from the previous gate', async () => {
    renderSheet();
    fireEvent.change(screen.getByTestId('policy-edit-gate-scope'), {
      target: { value: 'gk-lab' },
    });
    await pickOperation('docker.restart');
    fireEvent.change(screen.getByTestId('policy-edit-gate-scope'), {
      target: { value: '__all_gates__' },
    });
    const input = (await screen.findByTestId('policy-edit-operation')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect((screen.getByTestId('policy-edit-blast-radius') as HTMLSelectElement).value).toBe(
      '__unset__',
    );
    expect((screen.getByTestId('policy-edit-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a list that fails to load falls back to manual entry with a retry, and the typed name is trimmed', async () => {
    const { call } = renderSheet(undefined, async () => {
      throw new Error('boom');
    });
    await screen.findByTestId('policy-edit-operations-error');
    const input = screen.getByTestId('policy-edit-action-kind-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  docker.restart ' } });
    fireEvent.blur(input);
    expect(input.value).toBe('docker.restart');
    fireEvent.click(screen.getByTestId('policy-edit-submit'));
    await screen.findByTestId('policy-edit-confirm');
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('set_policy', {
        policy: { actionKindTag: 'docker.restart', autoApprove: false },
      }),
    );
  });

  it('a gate with no published Operation shows the manual input directly and says why', async () => {
    renderSheet(undefined, async () => ({ items: [] }));
    fireEvent.change(screen.getByTestId('policy-edit-gate-scope'), {
      target: { value: 'gk-lab' },
    });
    expect((await screen.findByTestId('policy-edit-operations-empty')).textContent).toContain(
      'lab-docker',
    );
    expect(screen.getByTestId('policy-edit-action-kind-input')).toBeTruthy();
    expect(screen.queryByTestId('policy-edit-manual-toggle')).toBeNull();
  });

  it('manual entry warns about a name no gate publishes and offers the case-insensitive match', async () => {
    renderSheet();
    fireEvent.change(screen.getByTestId('policy-edit-gate-scope'), {
      target: { value: 'gk-lab' },
    });
    expect((await offeredOperations()).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('policy-edit-manual-toggle'));
    fireEvent.change(screen.getByTestId('policy-edit-action-kind-input'), {
      target: { value: 'Docker.Restart' },
    });
    expect(screen.getByTestId('policy-edit-unknown-kind').textContent).toContain('lab-docker');
    fireEvent.click(screen.getByTestId('policy-edit-use-match'));
    expect((screen.getByTestId('policy-edit-action-kind-input') as HTMLInputElement).value).toBe(
      'docker.restart',
    );
    expect(screen.queryByTestId('policy-edit-unknown-kind')).toBeNull();
    expect((screen.getByTestId('policy-edit-blast-radius') as HTMLSelectElement).value).toBe(
      'medium',
    );
  });

  it('the Operation picker searches as you type, across every gate for a workspace-wide rule', async () => {
    renderSheet();
    const input = (await screen.findByTestId('policy-edit-operation')) as HTMLInputElement;
    await waitFor(() => expect(input.getAttribute('aria-busy')).toBeNull());
    fireEvent.change(input, { target: { value: 'prun' } });
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.querySelector('.combobox-option-label')?.textContent),
    ).toEqual(['docker.prune']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('docker.prune');
    expect((screen.getByTestId('policy-edit-blast-radius') as HTMLSelectElement).value).toBe(
      'high',
    );
    // Clearing the pick also drops the blast radius it prefilled.
    fireEvent.click(screen.getByTestId('policy-edit-operation-clear'));
    expect(input.value).toBe('');
    expect((screen.getByTestId('policy-edit-blast-radius') as HTMLSelectElement).value).toBe(
      '__unset__',
    );
  });
});
