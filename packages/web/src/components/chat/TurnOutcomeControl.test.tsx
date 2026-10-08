// @vitest-environment jsdom
import type { TurnAttributionWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { TurnOutcomeControl } from './TurnOutcomeControl.js';

afterEach(cleanup);

function turn(overrides: Partial<TurnAttributionWire> = {}): TurnAttributionWire {
  return {
    id: 'turn-1',
    chatId: 'chat-1',
    startedBy: 'p-me',
    status: 'completed',
    startedAt: '2026-10-08T00:00:00.000Z',
    endedAt: '2026-10-08T00:01:00.000Z',
    procedure: null,
    outcome: null,
    ...overrides,
  };
}

function setup(value: TurnAttributionWire, viewerId: string | null = 'p-me') {
  const calls: { name: string; params: unknown }[] = [];
  const marked = (outcome: 'achieved' | 'not_achieved', previous: TurnAttributionWire) =>
    turn({
      ...previous,
      outcome: {
        basis: 'requester',
        outcome,
        givenBy: 'p-me',
        givenAt: '2026-10-08T00:02:00.000Z',
        revision: previous.outcome ? 2 : 1,
        previousOutcome: previous.outcome?.outcome ?? null,
      },
    });
  const http: CapabilityCaller = {
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      return marked((params as { outcome: 'achieved' | 'not_achieved' }).outcome, value);
    }) as CapabilityCaller['call'],
  };
  const onChanged = vi.fn();
  const onError = vi.fn();
  render(
    <PermissionsProvider>
      <TurnOutcomeControl
        http={http}
        turn={value}
        viewerId={viewerId}
        onChanged={onChanged}
        onError={onError}
      />
    </PermissionsProvider>,
  );
  return { calls, onChanged, onError };
}

describe('TurnOutcomeControl (S10 E1)', () => {
  it('asks the requester, and marks the Turn with mark_turn_outcome', async () => {
    const { calls, onChanged } = setup(turn());
    fireEvent.click(screen.getByTestId('turn-outcome-not_achieved'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toEqual([
      { name: 'mark_turn_outcome', params: { turnId: 'turn-1', outcome: 'not_achieved' } },
    ]);
    expect(onChanged.mock.calls[0]?.[0].outcome).toMatchObject({ outcome: 'not_achieved' });
  });

  it('renders nothing for someone else with nothing to show, or while the Turn runs', () => {
    setup(turn(), 'p-other');
    expect(screen.queryByTestId('turn-outcome')).toBeNull();
    cleanup();
    setup(turn({ status: 'running' }));
    expect(screen.queryByTestId('turn-outcome')).toBeNull();
  });

  it('labels the Procedure as agent-reported, also for a viewer who cannot mark', () => {
    setup(
      turn({
        procedure: {
          procedureId: 'proc-1',
          version: 2,
          name: 'diagnose-flow',
          basis: 'claimed',
          claimedAt: '2026-10-08T00:00:05.000Z',
        },
      }),
      'p-other',
    );
    expect(screen.getByTestId('turn-outcome-procedure').textContent).toContain('diagnose-flow v2');
    expect(screen.getByText('agent 自报')).toBeTruthy();
    expect(screen.queryByTestId('turn-outcome-achieved')).toBeNull();
  });

  it('offers one correction through a confirm, and none after it', async () => {
    const given = turn({
      outcome: {
        basis: 'requester',
        outcome: 'achieved',
        givenBy: 'p-me',
        givenAt: '2026-10-08T00:02:00.000Z',
        revision: 1,
        previousOutcome: null,
      },
    });
    const { calls, onChanged } = setup(given);
    expect(screen.getByTestId('turn-outcome-chip').getAttribute('data-status')).toBe('achieved');
    fireEvent.click(screen.getByTestId('turn-outcome-correct'));
    fireEvent.click(await screen.findByRole('button', { name: '更正' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0]?.params).toEqual({ turnId: 'turn-1', outcome: 'not_achieved' });

    cleanup();
    setup(
      turn({
        outcome: {
          basis: 'requester',
          outcome: 'not_achieved',
          givenBy: 'p-me',
          givenAt: '2026-10-08T00:03:00.000Z',
          revision: 2,
          previousOutcome: 'achieved',
        },
      }),
    );
    expect(screen.queryByTestId('turn-outcome-correct')).toBeNull();
    expect(screen.getByText(/已更正，原为 达成/)).toBeTruthy();
  });
});
