import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * hooks/useResource: the loading / error / ready state machine every page renders from.
 *
 *   loading ──ok──▶ ready ──reload──▶ ready (refreshing: true) ──ok──▶ ready
 *      │                                       └──err──▶ ready (refreshError) — data kept
 *      └──err──▶ error ──retry──▶ loading
 *
 * A first load that fails is `error` (the page shows `ErrorBanner` + Retry); a *re*load that
 * fails keeps the data on screen and surfaces `refreshError` beside it instead of blanking the
 * list. Out-of-order responses are dropped by a request counter, and nothing is set after unmount.
 */
export type ResourceState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | {
      readonly status: 'ready';
      readonly data: T;
      readonly refreshing: boolean;
      readonly refreshError: unknown | null;
    };

export interface Resource<T> {
  readonly state: ResourceState<T>;
  /** Re-runs the loader. From `error` it goes back to `loading`; from `ready` it refreshes. */
  readonly reload: () => Promise<void>;
  /** Local (optimistic) update of ready data; a no-op in any other state. */
  readonly mutate: (update: (data: T) => T) => void;
}

export function useResource<T>(loader: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const requestSeq = useRef(0);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    const current = stateRef.current;
    if (current.status === 'ready') {
      setState({ ...current, refreshing: true, refreshError: null });
    } else {
      setState({ status: 'loading' });
    }
    try {
      const data = await loader();
      if (!mounted.current || seq !== requestSeq.current) return;
      setState({ status: 'ready', data, refreshing: false, refreshError: null });
    } catch (error) {
      if (!mounted.current || seq !== requestSeq.current) return;
      setState((prev) =>
        prev.status === 'ready'
          ? { ...prev, refreshing: false, refreshError: error }
          : { status: 'error', error },
      );
    }
  }, [loader]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mutate = useCallback((update: (data: T) => T) => {
    setState((prev) => (prev.status === 'ready' ? { ...prev, data: update(prev.data) } : prev));
  }, []);

  return { state, reload, mutate };
}
