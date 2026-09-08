import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { usePermissions } from './usePermissions.js';
import type { Resource, ResourceState } from './useResource.js';

/**
 * hooks/useCapability: the S3.14 "one small hook layer over the WS client" data-layer deliverable
 * — `useCapability(name, params)` with cache-by-key, invalidation on the principal-scoped pushes,
 * and (via `useCapabilityList`) `nextCursor` pagination (docs/wire-contract-conventions.md §3 list
 * envelope). Built for the new S3.11 governance pages (Members/Access/Systems/Catalog/Models/
 * Audit) — every one of those is a brand-new surface with no existing fetch code to duplicate, so
 * this is where that duplication is centralized going forward. Existing pages (Approvals/Tasks/
 * Chats) keep their own `useResource(loader)` calls untouched — this module is additive, not a
 * replacement (see the PR report for why: same `Resource<T>` shape either way, migrating already-
 * shipped, already-tested loaders would be a same-behavior rewrite with no acceptance-visible
 * benefit).
 *
 * `ResourceState<T>`/`Resource<T>` (hooks/useResource.ts) are reused verbatim so every consumer —
 * `SkeletonRows` while `loading`, `ErrorBanner` on `error`, `EmptyState` on an empty `ready` — reads
 * exactly the state shape every other page in this console already renders from.
 *
 * Every successful/failed call also feeds `hooks/usePermissions.tsx`'s `markAllowed`/`markDenied`
 * automatically (no page has to remember to call them itself, unlike the pre-S3.14 pages, which
 * each did this by hand next to their own `useResource` call).
 */

export type PushKind = 'actionPending' | 'actionUpdated' | 'taskUpdated';

/** One in-memory cache per `CapabilityCaller` instance (i.e. per signed-in session — `http`/`ws`
 *  are reconstructed on every sign-in, see App.tsx's `Session`), so "Forget key" naturally starts
 *  a signed-out principal with a cold cache instead of leaking another principal's governance
 *  reads across a key swap in the same tab. */
const cacheByCaller = new WeakMap<CapabilityCaller, Map<string, unknown>>();

function cacheKey(name: string, serializedParams: string): string {
  return `${name}::${serializedParams}`;
}

function readCache<T>(caller: CapabilityCaller, key: string): T | undefined {
  return cacheByCaller.get(caller)?.get(key) as T | undefined;
}

function writeCache<T>(caller: CapabilityCaller, key: string, value: T): void {
  let byKey = cacheByCaller.get(caller);
  if (!byKey) {
    byKey = new Map();
    cacheByCaller.set(caller, byKey);
  }
  byKey.set(key, value);
}

/** The state to render for `key` before a `run()` resolves: cached data (marked `refreshing`) if
 *  this exact (name, params) was ever loaded successfully before on this `caller`, else `loading`. */
function pendingStateFor<T>(caller: CapabilityCaller, key: string): ResourceState<T> {
  const cached = readCache<T>(caller, key);
  return cached !== undefined
    ? { status: 'ready', data: cached, refreshing: true, refreshError: null }
    : { status: 'loading' };
}

/** Drops every cached entry for one capability name (every param variant) on `caller` — call
 *  after a mutation that invalidates it (e.g. after `create_principal`, before navigating back to
 *  the list, so it does not flash the pre-create page from cache on remount). */
export function invalidateCapability(caller: CapabilityCaller, name: string): void {
  const byKey = cacheByCaller.get(caller);
  if (!byKey) return;
  const prefix = `${name}::`;
  for (const key of byKey.keys()) {
    if (key.startsWith(prefix)) byKey.delete(key);
  }
}

export interface UseCapabilityOptions {
  readonly pushes?: PushSource;
  /** Reload in the background (keeping current data visible, `refreshing: true`) whenever one of
   *  these principal-scoped pushes fires. Requires `pushes`. */
  readonly reloadOn?: readonly PushKind[];
}

export function useCapability<T = unknown>(
  caller: CapabilityCaller,
  name: string,
  params?: unknown,
  options: UseCapabilityOptions = {},
): Resource<T> {
  const permissions = usePermissions();
  const { pushes, reloadOn } = options;
  const reloadOnKey = (reloadOn ?? []).join(',');

  // Recomputed every render (a caller typically passes a fresh params object literal) but cheap
  // for the small param shapes every governance capability takes; `key` is what actually gates a
  // reload below (via `run`'s own dependency array), not `params`'s object identity.
  const key = cacheKey(name, JSON.stringify(params ?? null));
  // Latest params, read at call time only — `key` (derived from the same params, serialized) is
  // what gates a reload, so a caller passing a fresh params *object* with the same content every
  // render never causes one; see the module doc comment.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  // `permissions.markAllowed`/`markDenied` are stable (`useCallback(..., [])` in the provider) —
  // read through a ref, never as a `run` dependency, so calling them (which changes `denied`/
  // `allowed` and therefore the `permissions` object identity) can never itself change `run`'s
  // identity and re-trigger the mount effect below in a loop.
  const permissionsRef = useRef(permissions);
  permissionsRef.current = permissions;

  const [state, setState] = useState<ResourceState<T>>(() => pendingStateFor<T>(caller, key));

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const seq = useRef(0);
  const run = useCallback(async () => {
    const mySeq = ++seq.current;
    // Always keyed off the *current* `key`'s own cache entry, never off `prev` directly: `prev`
    // may belong to a different key (params just changed — a switched catalog tab, a different
    // `principalId` filter) whose data must not be shown, tagged "refreshing", under the new key.
    // A same-key refresh (a "Refresh" click, a push-triggered reload) still shows cached+refreshing
    // exactly as before, since a prior successful `run` for this same `key` already wrote it.
    setState(pendingStateFor<T>(caller, key));
    try {
      const data = await caller.call<T>(name, paramsRef.current);
      permissionsRef.current.markAllowed(name);
      if (!mounted.current || mySeq !== seq.current) return;
      writeCache(caller, key, data);
      setState({ status: 'ready', data, refreshing: false, refreshError: null });
    } catch (error) {
      if (isForbiddenError(error)) permissionsRef.current.markDenied(name);
      if (!mounted.current || mySeq !== seq.current) return;
      setState((prev) =>
        prev.status === 'ready'
          ? { ...prev, refreshing: false, refreshError: error }
          : { status: 'error', error },
      );
    }
  }, [caller, name, key]);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    if (!pushes || reloadOnKey === '') return;
    const kinds = new Set(reloadOnKey.split(','));
    const unsubs: Array<() => void> = [];
    if (kinds.has('actionPending')) unsubs.push(pushes.onActionPending(() => void run()));
    if (kinds.has('actionUpdated')) unsubs.push(pushes.onActionUpdated(() => void run()));
    if (kinds.has('taskUpdated')) unsubs.push(pushes.onTaskUpdated(() => void run()));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [pushes, reloadOnKey, run]);

  const mutate = useCallback(
    (update: (data: T) => T) => {
      setState((prev) => {
        if (prev.status !== 'ready') return prev;
        const next = update(prev.data);
        writeCache(caller, key, next);
        return { ...prev, data: next };
      });
    },
    [caller, key],
  );

  return { state, reload: run, mutate };
}

export interface ListEnvelope<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface CapabilityListResult<T> extends Resource<ListEnvelope<T>> {
  readonly loadingMore: boolean;
  readonly loadMoreError: unknown | null;
  /** Fetches the next page (if any) and appends it — a no-op while not `ready`, already loading
   *  more, or there is no `nextCursor`. */
  readonly loadMore: () => Promise<void>;
}

/** `useCapability` specialized for the `{items, nextCursor?}` list envelope every `list_*`
 *  capability returns (docs/wire-contract-conventions.md §3). `params` is spread with `cursor` for
 *  `loadMore` — pass the same params object shape `caller.call(name, params)` already expects. */
export function useCapabilityList<T = unknown>(
  caller: CapabilityCaller,
  name: string,
  params: Readonly<Record<string, unknown>> = {},
  options: UseCapabilityOptions = {},
): CapabilityListResult<T> {
  const base = useCapability<ListEnvelope<T>>(caller, name, params, options);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<unknown | null>(null);

  const loadMore = useCallback(async () => {
    if (base.state.status !== 'ready' || loadingMore) return;
    const cursor = base.state.data.nextCursor;
    if (cursor === undefined) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await caller.call<ListEnvelope<T>>(name, { ...params, cursor });
      base.mutate((data) => ({
        items: [...data.items, ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      setLoadMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  }, [caller, name, params, loadingMore, base.state, base.mutate]);

  return { ...base, loadingMore, loadMoreError, loadMore };
}
