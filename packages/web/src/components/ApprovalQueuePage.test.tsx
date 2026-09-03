// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionRequestRowLike } from '../lib/action-card.js';
import { type CapabilityCaller, type PushSource, SILENT_PUSH_SOURCE } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import type { ActionUpdatedPush } from '../lib/ws-client.js';
import { ApprovalQueuePage } from './ApprovalQueuePage.js';

afterEach(cleanup);

function row(overrides: Partial<ActionRequestRowLike> = {}): ActionRequestRowLike {
  return {
    id: 'ar-1',
    status: 'pending_approval',
    gatekeeperId: 'gk-1',
    actionKind: 'docker.container_restart',
    resourceScope: 'web-1',
    blastRadius: 'medium',
    awaitDecision: true,
    params: { container: 'web-1' },
    onBehalfOf: 'principal-a',
    actorRuntime: 'worker',
    requestedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

/** A capability caller whose `list_pending` answers are scripted in order; other capabilities
 *  resolve to whatever `others` says. */
function scriptedHttp(
  listPending: readonly (() => Promise<readonly ActionRequestRowLike[]>)[],
  others: Record<string, (params: unknown) => Promise<unknown>> = {},
): CapabilityCaller & { readonly calls: string[] } {
  const queue = [...listPending];
  const calls: string[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push(name);
      if (name === 'list_pending') {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw new Error('unscripted list_pending');
        return next();
      }
      const handler = others[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function pushSourceWithUpdated(): PushSource & { emitUpdated: (event: ActionUpdatedPush) => void } {
  const listeners = new Set<(event: ActionUpdatedPush) => void>();
  return {
    ...SILENT_PUSH_SOURCE,
    onActionUpdated: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emitUpdated: (event) => {
      for (const fn of listeners) fn(event);
    },
  };
}

describe('ApprovalQueuePage state machine', () => {
  it('goes loading → error (with the wire code and Retry) → loading → empty → ready', async () => {
    let resolveFirst: ((rows: readonly ActionRequestRowLike[]) => void) | undefined;
    const first = new Promise<readonly ActionRequestRowLike[]>((_resolve, reject) => {
      resolveFirst = () =>
        reject(new HttpError('capability_error', 'db unavailable', 'internal_error'));
    });
    const http = scriptedHttp([
      () => first,
      () => Promise.resolve([]),
      () => Promise.resolve([row()]),
    ]);

    render(<ApprovalQueuePage http={http} pushes={SILENT_PUSH_SOURCE} onSelect={vi.fn()} />);

    // loading: skeleton, no list, no error
    expect(screen.getByTestId('approvals-loading')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    // error: banner carries the code + message + Retry; the skeleton is gone ("Loading…" never
    // lingers under a red error — the bug the redesign fixes)
    await act(async () => {
      resolveFirst?.([]);
    });
    const banner = await screen.findByTestId('approvals-error');
    expect(banner.getAttribute('data-error-code')).toBe('internal_error');
    expect(banner.textContent).toContain('db unavailable');
    expect(screen.queryByTestId('approvals-loading')).toBeNull();

    // retry → loading → empty
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByTestId('approvals-loading')).toBeTruthy();
    await screen.findByTestId('approvals-empty');
    expect(screen.queryByRole('alert')).toBeNull();

    // refresh → ready with one row (the refresh keeps the previous view, no skeleton flash)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const rowEl = await screen.findByTestId('approval-row');
    expect(rowEl.textContent).toContain('docker container restart');
    expect(rowEl.querySelector('.chip')?.getAttribute('data-status')).toBe('pending_approval');
    expect(http.calls.filter((name) => name === 'list_pending')).toHaveLength(3);
  });

  it('shows an operator-role explanation (not a generic error) on 403 forbidden', async () => {
    const http = scriptedHttp([
      () =>
        Promise.reject(
          new HttpError('capability_error', 'role "member" does not satisfy', 'forbidden'),
        ),
    ]);
    render(<ApprovalQueuePage http={http} pushes={SILENT_PUSH_SOURCE} onSelect={vi.fn()} />);
    await screen.findByTestId('approvals-forbidden');
    expect(screen.queryByTestId('approvals-error')).toBeNull();
  });

  it('approving from the drawer is optimistic: the row leaves Pending, appears under All as approved, and reverts on failure', async () => {
    const approve = vi.fn(async () => ({ id: 'ar-1', status: 'approved' }));
    const http = scriptedHttp([() => Promise.resolve([row()])], { approve });
    const onSelect = vi.fn();
    const view = render(
      <ApprovalQueuePage
        http={http}
        pushes={SILENT_PUSH_SOURCE}
        selectedId="ar-1"
        onSelect={onSelect}
      />,
    );
    await screen.findByTestId('approval-row');
    const drawer = await screen.findByTestId('approval-drawer');
    expect(drawer.textContent).toContain('docker container restart');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith({ actionRequestId: 'ar-1' }));
    await waitFor(() => expect(screen.queryByTestId('approval-row')).toBeNull());
    expect(screen.getByTestId('approvals-empty')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    const decidedRow = await screen.findByTestId('approval-row');
    expect(decidedRow.querySelector('.chip')?.getAttribute('data-status')).toBe('approved');
    view.unmount();

    // failure path: the kernel rejects (409 illegal_transition) → the row comes back, error shown
    const failing = scriptedHttp([() => Promise.resolve([row()])], {
      approve: () =>
        Promise.reject(new HttpError('capability_error', 'already decided', 'illegal_transition')),
    });
    render(
      <ApprovalQueuePage
        http={failing}
        pushes={SILENT_PUSH_SOURCE}
        selectedId="ar-1"
        onSelect={onSelect}
      />,
    );
    await screen.findByTestId('approval-row');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByText('already decided');
    expect(alert.closest('[data-error-code]')?.getAttribute('data-error-code')).toBe(
      'illegal_transition',
    );
    await waitFor(() => expect(screen.getByTestId('approval-row')).toBeTruthy());
  });

  it('reconciles a live action.updated push: the row moves out of Pending with the pushed status', async () => {
    const pushes = pushSourceWithUpdated();
    const http = scriptedHttp([() => Promise.resolve([row()]), () => Promise.resolve([])], {
      get_action: () => Promise.resolve(row({ status: 'rejected' })),
    });
    render(<ApprovalQueuePage http={http} pushes={pushes} onSelect={vi.fn()} />);
    await screen.findByTestId('approval-row');

    act(() => pushes.emitUpdated({ actionRequestId: 'ar-1', status: 'rejected' }));
    await waitFor(() => expect(screen.queryByTestId('approval-row')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    const decided = await screen.findByTestId('approval-row');
    expect(decided.querySelector('.chip')?.getAttribute('data-status')).toBe('rejected');
  });
});
