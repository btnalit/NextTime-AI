import { useEffect, useState } from 'react';

/**
 * hooks/useMediaQuery (S8 W1-A4, audit S3): a small `window.matchMedia` subscription — used by
 * `components/kit/data-table` to switch between a real `<table>` and a card list at the §5e
 * responsive-table breakpoint. Safe where `matchMedia` is unavailable (a non-browser environment,
 * or a test that has not mocked it): reads `false` rather than throwing, so a component using this
 * hook still renders (in its wide-width shape) instead of crashing.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => readMatches(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    function onChange(event: MediaQueryListEvent): void {
      setMatches(event.matches);
    }
    // Modern `addEventListener`, falling back to the deprecated `addListener` pair some jsdom
    // mocks and older Safari only implement.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

function readMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** The §3.1 responsive-table checkpoint (audit S3, docs/development-tasks.md §5e): a table becomes
 *  a card list at 768px and narrower — `max-width: 768px` so the boundary itself (a viewport
 *  exactly 768px wide, the audit's own screenshot width) renders as cards, matching "≤ 768". */
export const NARROW_TABLE_QUERY = '(max-width: 768px)';
