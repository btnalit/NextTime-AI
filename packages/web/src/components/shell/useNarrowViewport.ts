import { useEffect, useState } from 'react';

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/**
 * components/shell/useNarrowViewport (S8 W1-A3, audit S2): `true` at or below `breakpointPx`, via
 * `window.matchMedia('(max-width: <n>px)')` and its `change` event — the same mechanism
 * Playwright's `setViewportSize` and a real browser resize both fire, so `AppShell` reacts to a
 * live resize the same way CSS media queries do, not just on first render. Falls back to `false`
 * (the wide layout) wherever `matchMedia` does not exist — SSR has no `window`, and older jsdom
 * versions have no `matchMedia` at all — which is also every existing Sidebar/AppShell test's
 * implicit assumption, so this hook changes nothing for a test that never touches it. A vitest
 * suite that *does* want the narrow branch stubs `window.matchMedia` before rendering (see
 * `AppShell.test.tsx`'s "narrow viewport" describe block for the pattern).
 */
export function useNarrowViewport(breakpointPx: number): boolean {
  const query = `(max-width: ${breakpointPx}px)`;
  const [narrow, setNarrow] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (): void => setNarrow(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return narrow;
}
