// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CapabilityCaller, type PushSource, SILENT_PUSH_SOURCE } from '../lib/clients.js';
import type { ActionPendingPush } from '../lib/ws-client.js';
import { usePendingCount } from './usePendingCount.js';
import { PermissionsProvider } from './usePermissions.js';

afterEach(cleanup);

/** `list_pending` answers come from `next()` in order; each call can be held open by the test. */
function deferredCaller(): CapabilityCaller & {
  readonly calls: number;
  answer: (count: number) => void;
} {
  const waiting: ((value: unknown) => void)[] = [];
  const caller = {
    calls: 0,
    call: vi.fn((name: string) =>
      // The reader's role (`useRoleCan`) stays unread here: the count is read as before.
      name === 'get_workspace'
        ? Promise.reject(new Error('not scripted'))
        : new Promise((resolve) => {
            caller.calls += 1;
            waiting.push(resolve);
          }),
    ) as CapabilityCaller['call'],
    answer: (count: number) => {
      const resolve = waiting.shift();
      if (!resolve) throw new Error('no list_pending call is waiting');
      resolve({ items: Array.from({ length: count }, (_, i) => ({ id: `ar-${i}` })) });
    },
  };
  return caller;
}

function pushes(): PushSource & { pending: () => void; resync: () => void } {
  const pendingListeners = new Set<(event: ActionPendingPush) => void>();
  const resynced = new Set<() => void>();
  return {
    ...SILENT_PUSH_SOURCE,
    onActionPending: (handler) => {
      pendingListeners.add(handler);
      return () => pendingListeners.delete(handler);
    },
    onResynced: (handler) => {
      resynced.add(handler);
      return () => resynced.delete(handler);
    },
    pending: () => {
      for (const fn of pendingListeners) fn({} as ActionPendingPush);
    },
    resync: () => {
      for (const fn of resynced) fn();
    },
  };
}

describe('usePendingCount', () => {
  it('R-63: a WS reconnect re-reads the count (an action.pending sent during the outage is lost)', async () => {
    const http = deferredCaller();
    const source = pushes();
    const { result } = renderHook(() => usePendingCount(http, source), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(http.calls).toBe(1));
    await act(async () => http.answer(0));
    expect(result.current).toBe(0);

    act(() => source.resync());
    await waitFor(() => expect(http.calls).toBe(2));
    await act(async () => http.answer(1));
    expect(result.current).toBe(1);
  });

  it('L7a-16: a push arriving while a read is in flight runs one more read afterwards, not none', async () => {
    const http = deferredCaller();
    const source = pushes();
    const { result } = renderHook(() => usePendingCount(http, source), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(http.calls).toBe(1));

    // The first read is still in flight (it may predate the request the push announces) …
    act(() => source.pending());
    act(() => source.pending());
    expect(http.calls).toBe(1);
    await act(async () => http.answer(0));

    // … so exactly one more read follows, and its answer is the one shown.
    await waitFor(() => expect(http.calls).toBe(2));
    await act(async () => http.answer(1));
    expect(result.current).toBe(1);
    expect(http.calls).toBe(2);
  });
});
