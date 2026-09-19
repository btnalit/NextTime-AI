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
    actionKindTag: 'docker.container_restart',
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
 *  resolve to whatever `others` says. `list_pending` itself returns `{items}` on the wire (§3
 *  list envelope) — scripted as a bare array here for brevity and wrapped at the call site. */
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
        const items = await next();
        return { items };
      }
      const handler = others[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

/** `list_action_requests` always answers with the given rows as one page (`nextCursor`
 *  undefined) — good enough for the History-tab assertions in this file, which do not exercise
 *  pagination itself (that is `ApprovalHistory load more` below, scripted separately). */
function historyOf(
  rows: readonly ActionRequestRowLike[],
): (params: unknown) => Promise<{ items: readonly ActionRequestRowLike[] }> {
  return () => Promise.resolve({ items: rows });
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

  it('approving from the drawer is optimistic: the row leaves Pending, appears in History (server-backed) as approved, and reverts on failure', async () => {
    const approve = vi.fn(async () => ({ id: 'ar-1', status: 'approved' }));
    const http = scriptedHttp([() => Promise.resolve([row()])], {
      approve,
      list_action_requests: historyOf([row({ status: 'approved' })]),
    });
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

    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    const historyRow = await screen.findByTestId('approval-history-row');
    expect(historyRow.querySelector('.chip')?.getAttribute('data-status')).toBe('approved');
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
      list_action_requests: historyOf([row({ status: 'rejected' })]),
    });
    render(<ApprovalQueuePage http={http} pushes={pushes} onSelect={vi.fn()} />);
    await screen.findByTestId('approval-row');

    act(() => pushes.emitUpdated({ id: 'ar-1', status: 'rejected' }));
    await waitFor(() => expect(screen.queryByTestId('approval-row')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    const historyRow = await screen.findByTestId('approval-history-row');
    expect(historyRow.querySelector('.chip')?.getAttribute('data-status')).toBe('rejected');
  });

  it('C7: an action.updated push costs exactly one get_action — no full list_pending reload — and the drawer keeps the decided row (C3)', async () => {
    const pushes = pushSourceWithUpdated();
    const http = scriptedHttp([() => Promise.resolve([row()])], {
      get_action: () => Promise.resolve(row({ status: 'approved' })),
    });
    render(<ApprovalQueuePage http={http} pushes={pushes} selectedId="ar-1" onSelect={vi.fn()} />);
    await screen.findByTestId('approval-row');
    expect(http.calls.filter((name) => name === 'list_pending')).toHaveLength(1);

    act(() => pushes.emitUpdated({ id: 'ar-1', status: 'approved' }));
    await waitFor(() => expect(screen.queryByTestId('approval-row')).toBeNull());
    await waitFor(() => expect(http.calls.filter((name) => name === 'get_action')).toHaveLength(1));
    // The row left Pending into `decided` (C3: outside the `mutate` updater), so the open drawer
    // still resolves its subject instead of falling back to a `get_action` deep-link fetch.
    const detail = await screen.findByTestId('action-request-detail');
    await waitFor(() =>
      expect(detail.querySelector('[data-status]')?.getAttribute('data-status')).toBe('approved'),
    );
    expect(http.calls.filter((name) => name === 'list_pending')).toHaveLength(1);
  });
});

describe('ApprovalHistoryTab (list_action_requests, S5.5 leftover 21)', () => {
  it('loads on first switch to History, shows rows, and re-fetches with the selected status on filter change', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const http = scriptedHttp([() => Promise.resolve([])], {
      list_action_requests: (params) => {
        calls.push(params as Record<string, unknown> | undefined);
        return Promise.resolve({ items: [row({ status: 'approved' })] });
      },
    });
    render(<ApprovalQueuePage http={http} pushes={SILENT_PUSH_SOURCE} onSelect={vi.fn()} />);
    await screen.findByTestId('approvals-empty');
    expect(calls).toHaveLength(0); // History's own capability never fires while on Pending

    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    await screen.findByTestId('approval-history-row');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ limit: 50 });
    expect(calls[0]).not.toHaveProperty('status');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'approved' } });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ limit: 50, status: 'approved' });
  });

  it('shows an operator-role explanation on 403, and "Load more" appends the next page via cursor', async () => {
    const forbiddenHttp = scriptedHttp([() => Promise.resolve([])], {
      list_action_requests: () =>
        Promise.reject(
          new HttpError('capability_error', 'role "member" does not satisfy', 'forbidden'),
        ),
    });
    const forbiddenView = render(
      <ApprovalQueuePage http={forbiddenHttp} pushes={SILENT_PUSH_SOURCE} onSelect={vi.fn()} />,
    );
    await screen.findByTestId('approvals-empty');
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    await screen.findByTestId('approval-history-forbidden');
    forbiddenView.unmount();

    let page = 0;
    const pagedHttp = scriptedHttp([() => Promise.resolve([])], {
      list_action_requests: () => {
        page += 1;
        return page === 1
          ? Promise.resolve({ items: [row({ id: 'ar-1' })], nextCursor: 'cursor-1' })
          : Promise.resolve({ items: [row({ id: 'ar-2' })] });
      },
    });
    render(<ApprovalQueuePage http={pagedHttp} pushes={SILENT_PUSH_SOURCE} onSelect={vi.fn()} />);
    await screen.findByTestId('approvals-empty');
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    await screen.findByTestId('approval-history-row');
    expect(screen.getAllByTestId('approval-history-row')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('approval-history-row')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
