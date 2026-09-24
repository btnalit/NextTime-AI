// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CapabilityCaller, type PushSource, SILENT_PUSH_SOURCE } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import type { ActionUpdatedPush } from '../lib/ws-client.js';
import { invalidateCapability, useCapability, useCapabilityList } from './useCapability.js';
import { PermissionsProvider, usePermissions } from './usePermissions.js';

afterEach(cleanup);

function scriptedCaller(answers: readonly (() => Promise<unknown>)[]): CapabilityCaller & {
  readonly calls: readonly { readonly name: string; readonly params: unknown }[];
} {
  const queue = [...answers];
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (!next) throw new Error('unscripted call');
      return next();
    }) as CapabilityCaller['call'],
  };
}

function pushSourceWithUpdated(): PushSource & { emit: (event: ActionUpdatedPush) => void } {
  const listeners = new Set<(event: ActionUpdatedPush) => void>();
  return {
    ...SILENT_PUSH_SOURCE,
    onActionUpdated: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit: (event) => {
      for (const fn of listeners) fn(event);
    },
  };
}

describe('useCapability', () => {
  it('goes loading → ready, and reload() re-fetches', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ id: 'p-1' }),
      () => Promise.resolve({ id: 'p-2' }),
    ]);
    const { result } = renderHook(() => useCapability(caller, 'get_workspace'), {
      wrapper: PermissionsProvider,
    });
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.status === 'ready' && result.current.state.data).toEqual({
      id: 'p-1',
    });

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.state.status === 'ready' && result.current.state.data).toEqual({
      id: 'p-2',
    });
    expect(caller.calls).toHaveLength(2);
  });

  it('a first-load failure is `error`; a forbidden error marks the capability denied', async () => {
    const caller = scriptedCaller([
      () => Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
    ]);
    let denied: ReadonlySet<string> = new Set();
    function Probe() {
      denied = usePermissions().denied;
      return null;
    }
    const { result } = renderHook(
      () => {
        Probe();
        return useCapability(caller, 'list_principals');
      },
      { wrapper: PermissionsProvider },
    );
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(denied.has('list_principals')).toBe(true);
  });

  it('caches by (name, params) on the caller instance — a remount shows cached data immediately, refreshing in the background', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [1] }),
      () => Promise.resolve({ items: [1, 2] }),
    ]);
    const first = renderHook(() => useCapability(caller, 'list_grants', { principalId: 'a' }), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(first.result.current.state.status).toBe('ready'));
    first.unmount();

    const second = renderHook(() => useCapability(caller, 'list_grants', { principalId: 'a' }), {
      wrapper: PermissionsProvider,
    });
    // Seeded from cache immediately — no loading flash — but marked refreshing.
    expect(second.result.current.state).toMatchObject({
      status: 'ready',
      data: { items: [1] },
      refreshing: true,
    });
    await waitFor(() =>
      expect(second.result.current.state).toMatchObject({ data: { items: [1, 2] } }),
    );
    expect(caller.calls).toHaveLength(2);
  });

  it('different params are different cache entries', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ id: 'a' }),
      () => Promise.resolve({ id: 'b' }),
    ]);
    const { result, rerender } = renderHook(
      ({ principalId }: { principalId: string }) =>
        useCapability(caller, 'get_gatekeeper', { principalId }),
      { wrapper: PermissionsProvider, initialProps: { principalId: 'a' } },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    rerender({ principalId: 'b' });
    expect(result.current.state.status).toBe('loading');
    await waitFor(() =>
      expect(result.current.state.status === 'ready' && result.current.state.data).toEqual({
        id: 'b',
      }),
    );
  });

  it('reloadOn re-fetches when the named principal-scoped push fires', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [] }),
      () => Promise.resolve({ items: ['x'] }),
    ]);
    const pushes = pushSourceWithUpdated();
    const { result } = renderHook(
      () =>
        useCapability(caller, 'list_pending', undefined, { pushes, reloadOn: ['actionUpdated'] }),
      { wrapper: PermissionsProvider },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => pushes.emit({ id: 'ar-1', status: 'approved' }));
    await waitFor(() =>
      expect(result.current.state.status === 'ready' && result.current.state.data).toEqual({
        items: ['x'],
      }),
    );
  });

  it('invalidateCapability drops the cache so the next mount reloads instead of showing stale data', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ id: 'v1' }),
      () => Promise.resolve({ id: 'v2' }),
    ]);
    const first = renderHook(() => useCapability(caller, 'list_policies'), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(first.result.current.state.status).toBe('ready'));
    first.unmount();

    invalidateCapability(caller, 'list_policies');

    const second = renderHook(() => useCapability(caller, 'list_policies'), {
      wrapper: PermissionsProvider,
    });
    expect(second.result.current.state.status).toBe('loading');
    await waitFor(() =>
      expect(
        second.result.current.state.status === 'ready' && second.result.current.state.data,
      ).toEqual({ id: 'v2' }),
    );
  });
});

describe('useCapabilityList', () => {
  it('loadMore appends the next page and clears nextCursor once exhausted', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [1, 2], nextCursor: 'c1' }),
      () => Promise.resolve({ items: [3], nextCursor: undefined }),
    ]);
    const { result } = renderHook(() => useCapabilityList<number>(caller, 'list_gatekeepers'), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([
      1, 2,
    ]);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([
      1, 2, 3,
    ]);
    expect(result.current.state.status === 'ready' && result.current.state.data.nextCursor).toBe(
      undefined,
    );
    expect(caller.calls[1]).toMatchObject({ name: 'list_gatekeepers', params: { cursor: 'c1' } });
  });

  it('C2: a push-triggered reload re-walks every page the reader had loaded — the row count never shrinks', async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      first: { items: [1, 2], nextCursor: 'c1' },
      c1: { items: [3, 4], nextCursor: 'c2' },
      c2: { items: [5] },
    };
    const caller = scriptedCaller([
      () => Promise.resolve(pages.first),
      () => Promise.resolve(pages.c1),
      // The reload: page one again, then the cursor page it must follow to keep 4 rows.
      () => Promise.resolve({ items: [1, 2], nextCursor: 'c1' }),
      () => Promise.resolve({ items: [3, 4], nextCursor: 'c2' }),
    ]);
    const pushes = pushSourceWithUpdated();
    const { result } = renderHook(
      () =>
        useCapabilityList<number>(
          caller,
          'list_action_requests',
          { limit: 2 },
          {
            pushes,
            reloadOn: ['actionUpdated'],
          },
        ),
      { wrapper: PermissionsProvider },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([
      1, 2, 3, 4,
    ]);

    act(() => pushes.emit({ id: 'ar-1', status: 'approved' }));
    await waitFor(() =>
      expect(result.current.state.status === 'ready' && result.current.state.refreshing).toBe(
        false,
      ),
    );
    expect(result.current.state.status === 'ready' && result.current.state.data).toEqual({
      items: [1, 2, 3, 4],
      nextCursor: 'c2',
    });
    // Reload = first page + one cursor follow-up, with the original params carried along.
    expect(caller.calls.slice(2)).toEqual([
      { name: 'list_action_requests', params: { limit: 2 } },
      { name: 'list_action_requests', params: { limit: 2, cursor: 'c1' } },
    ]);
    // `loadMore` still appends from the kept cursor.
    expect(result.current.state.status === 'ready' && result.current.state.data.nextCursor).toBe(
      'c2',
    );
  });

  it('C2: a reload of a single-page list is still one call', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: ['a'] }),
      () => Promise.resolve({ items: ['a', 'b'] }),
    ]);
    const { result } = renderHook(() => useCapabilityList<string>(caller, 'list_grants'), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([
      'a',
      'b',
    ]);
    expect(caller.calls).toHaveLength(2);
  });

  it('S8 W1-A4: `truncated` from the initial load is surfaced', async () => {
    const caller = scriptedCaller([() => Promise.resolve({ items: [1], truncated: true })]);
    const { result } = renderHook(() => useCapabilityList<number>(caller, 'list_skills'), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.status === 'ready' && result.current.state.data.truncated).toBe(
      true,
    );
  });

  it('S8 W1-A4: `loadMore` carries `truncated` from the page it fetched', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [1], nextCursor: 'c1' }),
      () => Promise.resolve({ items: [2], truncated: true }),
    ]);
    const { result } = renderHook(() => useCapabilityList<number>(caller, 'list_skills'), {
      wrapper: PermissionsProvider,
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.status === 'ready' && result.current.state.data.truncated).toBe(
      undefined,
    );
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.state.status === 'ready' && result.current.state.data.truncated).toBe(
      true,
    );
    expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([
      1, 2,
    ]);
  });

  it('S8 W1-A4: `autoLoadAll` walks every page without a manual loadMore()', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [1], nextCursor: 'c1' }),
      () => Promise.resolve({ items: [2], nextCursor: 'c2' }),
      () => Promise.resolve({ items: [3] }),
    ]);
    const { result } = renderHook(
      () => useCapabilityList<number>(caller, 'list_worker_definitions', {}, { autoLoadAll: true }),
      { wrapper: PermissionsProvider },
    );
    await waitFor(() =>
      expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([
        1, 2, 3,
      ]),
    );
    expect(
      result.current.state.status === 'ready' && result.current.state.data.nextCursor,
    ).toBeUndefined();
    expect(caller.calls).toHaveLength(3);
  });

  it('autoLoadAll stops after a failed page instead of retrying in a loop', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [1], nextCursor: 'c1' }),
      () => Promise.reject(new Error('kernel unavailable')),
    ]);
    const { result } = renderHook(
      () => useCapabilityList<number>(caller, 'list_worker_definitions', {}, { autoLoadAll: true }),
      { wrapper: PermissionsProvider },
    );
    await waitFor(() => expect(result.current.loadMoreError).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(caller.calls).toHaveLength(2);
    expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([1]);
  });

  it('autoLoadAll stops when a page echoes the cursor it was asked for', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [1], nextCursor: 'c1' }),
      () => Promise.resolve({ items: [2], nextCursor: 'c1' }),
    ]);
    const { result } = renderHook(
      () => useCapabilityList<number>(caller, 'list_worker_definitions', {}, { autoLoadAll: true }),
      { wrapper: PermissionsProvider },
    );
    await waitFor(() =>
      expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([
        1, 2,
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(caller.calls).toHaveLength(2);
    expect(
      result.current.state.status === 'ready' && result.current.state.data.nextCursor,
    ).toBeUndefined();
  });

  it('autoLoadAll unset (default): stays on the first page until loadMore() is called', async () => {
    const caller = scriptedCaller([
      () => Promise.resolve({ items: [1], nextCursor: 'c1' }),
      () => Promise.resolve({ items: [2] }),
    ]);
    const { result } = renderHook(
      () => useCapabilityList<number>(caller, 'list_worker_definitions'),
      { wrapper: PermissionsProvider },
    );
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    // Give any stray effect a chance to fire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.state.status === 'ready' && result.current.state.data.items).toEqual([1]);
    expect(caller.calls).toHaveLength(1);
  });
});
