// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { announceReadinessChange, useExecutionReadiness } from './useExecutionReadiness.js';

afterEach(cleanup);

function readiness(ready: boolean): ExecutionReadinessWire {
  return { ready, gates: [], workers: [], missing: [] } as unknown as ExecutionReadinessWire;
}

function Probe({ http, id }: { readonly http: CapabilityCaller; readonly id: string }) {
  const state = useExecutionReadiness(http).state;
  return (
    <span data-testid={id}>
      {state.status === 'ready' ? String(state.data.ready) : state.status}
    </span>
  );
}

/** Legacy 245: two mounted readiness reads share one call; a change drops the read in flight. */
describe('useExecutionReadiness', () => {
  it('two reads mounted together make one call; a change announced mid-read asks again', async () => {
    const answers: ((value: ExecutionReadinessWire) => void)[] = [];
    const http: CapabilityCaller = {
      call: vi.fn(
        () => new Promise<ExecutionReadinessWire>((resolve) => answers.push(resolve)),
      ) as CapabilityCaller['call'],
    };
    render(
      <PermissionsProvider>
        <Probe http={http} id="a" />
        <Probe http={http} id="b" />
      </PermissionsProvider>,
    );
    await waitFor(() => expect(http.call).toHaveBeenCalledTimes(1));
    // A publish lands while the first read is still out: its answer predates the change.
    act(() => announceReadinessChange(http));
    await waitFor(() => expect(http.call).toHaveBeenCalledTimes(2));
    await act(async () => answers[1]?.(readiness(true)));
    await act(async () => answers[0]?.(readiness(false)));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('true'));
    expect(screen.getByTestId('b').textContent).toBe('true');
    expect(http.call).toHaveBeenCalledTimes(2);
  });
});
