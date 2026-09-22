import { useEffect, useState } from 'react';

/**
 * lib/explorer-probe: S6-C (docs/console-completion-plan.md §5.7 first bullet, A5) — is the
 * third-party Explorer bundle actually built on this deployment? caddy serves `/explorer/` from
 * `/srv/explorer` (`deploy/caddy/Caddyfile` `handle_path /explorer/*`), which is either the real
 * upstream Vite build (`EXPLORER_BUILD=1`, docs/runbooks/host-explorer.md §1) or the committed
 * placeholder page `deploy/caddy/explorer-placeholder/index.html`. Because that block ends in
 * `try_files {path} /index.html`, the request always answers 200 — the *body* is the only signal,
 * and the placeholder's `<title>` and `<h1>` are both literally "Explorer bundle not built"
 * ({@link EXPLORER_PLACEHOLDER_MARKER}). The Sidebar hides the 图 Explorer entry on `false`
 * instead of letting a reader click through to the placeholder (§5.7: "bundle 未构建时隐藏侧栏
 * '图'入口（caddy 返回占位页可探测）").
 *
 * Fails open: a transport failure, a non-2xx, or an unreadable body resolves `true` — hiding a
 * real bundle over a transient error is worse than showing an entry that 404s once. Same-origin,
 * `credentials: 'same-origin'`, so the console session cookie rides along exactly as it does when
 * the Explorer itself is opened (S4.1 cookie auth) — a deployment that gates `/explorer/` on the
 * cookie still probes correctly. One probe per page load (module-level cache): the bundle does not
 * appear or vanish while a tab is open, and every `AppShell` mount would otherwise re-fetch it.
 */

export const EXPLORER_PLACEHOLDER_MARKER = 'Explorer bundle not built';
export const EXPLORER_PATH = '/explorer/';

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

/** One-shot probe: `false` only when the placeholder marker is in the body. */
export async function probeExplorerAvailable(
  fetchImpl: typeof fetch = defaultFetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(EXPLORER_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'text/html' },
    });
    if (!response.ok) return true;
    const body = await response.text();
    return !body.includes(EXPLORER_PLACEHOLDER_MARKER);
  } catch {
    return true;
  }
}

let cached: Promise<boolean> | null = null;

/** Drops the memoized probe (one per page load). Exposed for tests. */
export function resetExplorerProbeCache(): void {
  cached = null;
}

function cachedProbe(fetchImpl?: typeof fetch): Promise<boolean> {
  if (cached === null) cached = probeExplorerAvailable(fetchImpl);
  return cached;
}

/**
 * `true` / `false` once the probe has answered, `null` while it is in flight. Consumers treat
 * `null` like `true` (show the entry until proven placeholder) so the Sidebar never flashes the
 * entry out and back in. Intended sidebar wiring (components/shell is another lane's file — see
 * the S6-C report): `AppShell` calls this and passes `explorerAvailable` to `Sidebar`, which
 * renders the 图 entry only when it is not `false`.
 */
export function useExplorerAvailable(fetchImpl?: typeof fetch): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void cachedProbe(fetchImpl).then((result) => {
      if (!cancelled) setAvailable(result);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);
  return available;
}
