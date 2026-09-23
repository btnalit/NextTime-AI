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

/** What a custom `load` (below) is handed for one (re)load of `key`. */
export interface CapabilityLoadContext<T> {
  readonly caller: CapabilityCaller;
  readonly name: string;
  readonly params: unknown;
  /** The data currently cached for this exact (name, params) — what the reader is looking at —
   *  or `undefined` on a cold first load. */
  readonly previous: T | undefined;
}

export interface UseCapabilityOptions<T = unknown> {
  readonly pushes?: PushSource;
  /** Reload in the background (keeping current data visible, `refreshing: true`) whenever one of
   *  these principal-scoped pushes fires. Requires `pushes`. */
  readonly reloadOn?: readonly PushKind[];
  /** Replaces the default `caller.call(name, params)` for every load and reload of a key (C2:
   *  `useCapabilityList` uses it to re-walk as many pages as the reader had already loaded, so a
   *  push-triggered reload never truncates a paged list back to page one). Read through a ref at
   *  call time — its identity never re-triggers a load. */
  readonly load?: (context: CapabilityLoadContext<T>) => Promise<T>;
}

export function useCapability<T = unknown>(
  caller: CapabilityCaller,
  name: string,
  params?: unknown,
  options: UseCapabilityOptions<T> = {},
): Resource<T> {
  const permissions = usePermissions();
  const { pushes, reloadOn, load } = options;
  const reloadOnKey = (reloadOn ?? []).join(',');
  const loadRef = useRef(load);
  loadRef.current = load;

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
      const context: CapabilityLoadContext<T> = {
        caller,
        name,
        params: paramsRef.current,
        previous: readCache<T>(caller, key),
      };
      const data = await (loadRef.current
        ? loadRef.current(context)
        : caller.call<T>(name, paramsRef.current));
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
  /** S8 W1-A4 (audit S3 follow-up, #243's six newly-paginated `list_*` capabilities):
   *  `docs/wire-contract-conventions.md` §3 — set when the caller's own `limit` was clamped to the
   *  capability's server-side ceiling (never when a page is merely not the last one; that is what
   *  `nextCursor` already means). Carried through `loadMore`/`reloadLoadedPages` from whichever
   *  page was fetched most recently, so a reader who paged past the ceiling still sees it. */
  readonly truncated?: true;
}

export interface CapabilityListResult<T> extends Resource<ListEnvelope<T>> {
  readonly loadingMore: boolean;
  readonly loadMoreError: unknown | null;
  /** Fetches the next page (if any) and appends it — a no-op while not `ready`, already loading
   *  more, or there is no `nextCursor`. */
  readonly loadMore: () => Promise<void>;
}

/**
 * Reloads a keyset-paged list to at least the number of rows the reader had already loaded (C2,
 * console-completion-plan §2b): page one first, then follow `nextCursor` until the row count
 * reaches `previous.items.length` or the list is exhausted. A cold load (no `previous`) is a
 * plain first page. Rows the kernel removed since may make this walk one page further than the
 * reader had — bounded by the previous count, and strictly better than silently truncating a
 * list the reader had paged through back to page one. A cursor that does not advance (a server
 * bug, not a documented state) stops the walk rather than spinning.
 */
async function reloadLoadedPages<T>(
  context: CapabilityLoadContext<ListEnvelope<T>>,
): Promise<ListEnvelope<T>> {
  const { caller, name, previous } = context;
  const params = (context.params ?? {}) as Readonly<Record<string, unknown>>;
  const target = previous?.items.length ?? 0;
  let page = await caller.call<ListEnvelope<T>>(name, params);
  let items = page.items;
  let cursor = page.nextCursor;
  let truncated = page.truncated;
  while (cursor !== undefined && items.length < target) {
    page = await caller.call<ListEnvelope<T>>(name, { ...params, cursor });
    items = [...items, ...page.items];
    truncated = page.truncated;
    if (page.nextCursor === cursor || page.items.length === 0) {
      cursor = undefined;
      break;
    }
    cursor = page.nextCursor;
  }
  return {
    items,
    ...(cursor !== undefined ? { nextCursor: cursor } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

export interface UseCapabilityListOptions<T = unknown>
  extends UseCapabilityOptions<ListEnvelope<T>> {
  /**
   * S8 W1-A4 (audit S3 follow-up): walk every page automatically as pages become available,
   * instead of waiting for a reader to click "加载更多" — for a list consumed as a selector or a
   * name-resolution directory (a checklist, an autocomplete's suggestions, `RefChip`'s id → name
   * map) where a row silently missing past the first page is a correctness bug, not a paging UX
   * choice. Leave unset for an actual browsable list/table, where a manual "加载更多" affordance
   * (with `truncated` surfaced) is the right UX — see `PlatformUsersPage` for that shape.
   */
  readonly autoLoadAll?: boolean;
}

/** `useCapability` specialized for the `{items, nextCursor?, truncated?}` list envelope every
 *  `list_*` capability returns (docs/wire-contract-conventions.md §3). `params` is spread with
 *  `cursor` for `loadMore` — pass the same params object shape `caller.call(name, params)` already
 *  expects. Reloads (a "Refresh" click, a `reloadOn` push, `reload()`) re-walk every page the
 *  reader had loaded (`reloadLoadedPages`) instead of resetting to page one. */
export function useCapabilityList<T = unknown>(
  caller: CapabilityCaller,
  name: string,
  params: Readonly<Record<string, unknown>> = {},
  options: UseCapabilityListOptions<T> = {},
): CapabilityListResult<T> {
  const { autoLoadAll, ...capabilityOptions } = options;
  const base = useCapability<ListEnvelope<T>>(caller, name, params, {
    ...capabilityOptions,
    load: capabilityOptions.load ?? reloadLoadedPages,
  });
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
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
      }));
    } catch (error) {
      setLoadMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  }, [caller, name, params, loadingMore, base.state, base.mutate]);

  useEffect(() => {
    if (!autoLoadAll) return;
    if (base.state.status !== 'ready') return;
    if (base.state.data.nextCursor === undefined) return;
    if (loadingMore) return;
    void loadMore();
  }, [autoLoadAll, base.state, loadingMore, loadMore]);

  return { ...base, loadingMore, loadMoreError, loadMore };
}
