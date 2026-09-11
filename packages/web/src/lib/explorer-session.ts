/**
 * lib/explorer-session: installs and clears the Explorer session cookie (W7; kernel
 * `interfaces/explorer-contract/session.ts`).
 *
 * The Explorer UI at `/explorer/` is an unmodified third-party static bundle on this same origin;
 * its data calls are plain same-origin `fetch()`, so the only credential the browser can attach
 * for it is a cookie. Right after a successful login the console exchanges the caller's own API
 * key for that cookie (`POST /api/explorer/session`, `HttpOnly; Secure; SameSite=Strict;
 * Path=/api`, 8 h); "Forget key" clears it (`DELETE /api/explorer/session`). Both are
 * fire-and-forget from the caller's point of view and never throw: an older or misconfigured
 * kernel (503) or a network error must not break the console login — the Explorer page then
 * simply answers 401 until the next login.
 *
 * Ordering: the two requests are serialized through one module-level chain, so a `DELETE` issued
 * while an earlier `POST` is still in flight is sent only after that `POST` has settled. Without
 * this, a fast "Forget key" right after signing in could clear the cookie and then have the late
 * `POST` response reinstall a live session for a principal the UI shows as signed out.
 *
 * `defaultFetch` looks the global up at call time and calls it unbound — the same reasoning as
 * `lib/http-client.ts` (the platform requires the global object as receiver, and tests may stub
 * `globalThis.fetch` after this module has loaded).
 */

const EXPLORER_SESSION_PATH = '/api/explorer/session';

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

let chain: Promise<void> = Promise.resolve();

/** Runs `task` after every previously enqueued task has settled. The returned promise never
 *  rejects (each task swallows its own errors), so the chain can never get stuck. */
function enqueue(task: () => Promise<void>): Promise<void> {
  const next = chain.then(task, task);
  chain = next;
  return next;
}

export function createExplorerSession(
  apiKey: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<void> {
  return enqueue(async () => {
    try {
      const response = await fetchImpl(EXPLORER_SESSION_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        console.warn(`createExplorerSession: kernel responded ${response.status}`);
      }
    } catch (err) {
      console.warn('createExplorerSession: request failed', err);
    }
  });
}

export function clearExplorerSession(fetchImpl: typeof fetch = defaultFetch): Promise<void> {
  return enqueue(async () => {
    try {
      const response = await fetchImpl(EXPLORER_SESSION_PATH, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        console.warn(`clearExplorerSession: kernel responded ${response.status}`);
      }
    } catch (err) {
      console.warn('clearExplorerSession: request failed', err);
    }
  });
}
