/**
 * Redirects from a target this platform calls with a credential, or from an address an owner
 * supplied (review of #532, item 4; legacy 221). None of those fetches follows one: `fetch`'s
 * default `'follow'` resends the request's headers — a gate's credential, a provider's
 * `x-api-key` — to whatever host a 3xx names, and reads the answer from an address nobody set.
 * `redirect: 'error'` kept that rule but failed as a bare "fetch failed", so nobody could tell
 * that the address answered 301 → `https://…` or 307 → `/mcp/`. The callers ask for
 * `redirect: 'manual'` (Node's fetch then hands back the 3xx itself, status and `Location`
 * readable — still never followed) and turn it into a failure that names the status and where it
 * pointed: the gate's transports (`@nexttime/gatekeeper-base` `kinds/redirect.ts`), the gate host,
 * the kernel's fetches of owner-supplied URLs, and llm-proxy's upstream calls.
 */

/** A 3xx that points somewhere else (`304 Not Modified` does not). */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

const MAX_SHOWN_TARGET_CHARS = 300;

/**
 * Where a redirect pointed, safe to show: the path when it stays on the request's own origin,
 * else the other origin and the path. Never its query string, fragment or userinfo — a login
 * redirect's query can carry a token. The target chose it, so it goes through the URL parser
 * (percent-encoded, no control characters) and is bounded.
 */
export function redirectTargetForDisplay(
  location: string | null,
  requestUrl: string | URL,
): string {
  if (!location) return 'nowhere (no Location header)';
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return 'an unparseable Location header';
  }
  const sameOrigin = target.origin === new URL(requestUrl).origin;
  const shown = sameOrigin ? target.pathname : `${target.origin}${target.pathname}`;
  return JSON.stringify(
    shown.length > MAX_SHOWN_TARGET_CHARS ? `${shown.slice(0, MAX_SHOWN_TARGET_CHARS)}…` : shown,
  );
}

/** Who refused to follow, and what to fix. */
export interface RedirectAdvice {
  readonly follower: string;
  readonly fix: string;
}

/** The readable failure for a redirect `response` to `requestUrl` (`label`: what was being
 *  called, e.g. `mcp transport: tools/list`). */
export function describeRedirect(
  label: string,
  response: { readonly status: number; readonly headers: Pick<Headers, 'get'> },
  requestUrl: string | URL,
  advice: RedirectAdvice,
): string {
  const where = redirectTargetForDisplay(response.headers.get('location'), requestUrl);
  return `${label} responded ${response.status}, a redirect to ${where}. ${advice.follower}: ${advice.fix}.`;
}
