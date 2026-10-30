import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/**
 * components/evaluation/hooks: what the 用例集 detail's sections share — a read that waits for its
 * key, and focus handed on when a change takes away the control that had it.
 */

/** A read that runs whenever `key` is set and changes; idle while it is `null`. */
export function useLoadWhen<T>(
  key: string | null,
  load: () => Promise<T>,
): {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly data?: T;
  readonly error?: unknown;
} {
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly status: 'idle' | 'loading' | 'ready' | 'error';
    readonly data?: T;
    readonly error?: unknown;
  }>({ key: null, status: 'idle' });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` decides when to read; `load` is a fresh closure every render
  useEffect(() => {
    if (key === null) {
      setState({ key: null, status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ key, status: 'loading' });
    load().then(
      (data) => !cancelled && setState({ key, status: 'ready', data }),
      (error: unknown) => !cancelled && setState({ key, status: 'error', error }),
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state.key === key ? state : { status: key === null ? 'idle' : 'loading' };
}

/** A change that takes away the control that had focus — the 同步 that leaves with its gate's
 *  mismatch, a removed gate's whole card (#802 UX P3-2) — hands focus to `target` instead of the
 *  page. `request` once the change is made; the move waits for the closing confirm's own focus
 *  return, which finds its control gone, and leaves alone any focus the reader has moved on to. */
export function useFocusAfterChange<T extends HTMLElement>(): readonly [RefObject<T>, () => void] {
  const target = useRef<T>(null);
  const [requested, setRequested] = useState(0);
  useEffect(() => {
    if (requested === 0) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        target.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [requested]);
  const request = useCallback(() => setRequested((n) => n + 1), []);
  return [target, request];
}
