import { useCallback, useEffect, useState } from 'react';
import { type GraphQuery, graphHref, parseGraphHash } from '../../lib/graph-route.js';
import { navigate } from '../../lib/router.js';

/**
 * components/graph/useGraphQuery: the page's hash query (`lib/graph-route.ts`) in React state.
 * The hash is the single source of truth for `objectId` / `q` / `type` / `at` — every change goes
 * through `navigate` (so Back works and a deep link is just a URL) and comes back via `hashchange`.
 * Read outside the graph route (a test mounting the page on a blank hash) it is `{}`.
 */
export function useGraphQuery(): {
  readonly query: GraphQuery;
  readonly setQuery: (next: GraphQuery) => void;
} {
  const [query, setState] = useState<GraphQuery>(() => parseGraphHash(window.location.hash) ?? {});
  useEffect(() => {
    const sync = (): void => {
      const parsed = parseGraphHash(window.location.hash);
      if (parsed !== null) setState(parsed);
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const setQuery = useCallback((next: GraphQuery): void => {
    navigate(graphHref(next));
    // `hashchange` is asynchronous; mirror the state now so a test (or a fast second click) sees
    // the new query without waiting for the event — the event then sets the identical value.
    setState(next);
  }, []);
  return { query, setQuery };
}
