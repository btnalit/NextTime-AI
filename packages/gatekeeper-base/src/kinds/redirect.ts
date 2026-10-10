import { TransportInvokeError } from '../errors.js';

/**
 * Redirects (review of #532, item 4). A gate never follows one: `fetch`'s default `'follow'`
 * resends every header, the gate's credential included, to whatever host a 3xx names (review lane
 * 5, P2-2). `redirect: 'error'` kept that rule but failed as a bare "request failed", so an
 * administrator could not tell that a Starlette / FastMCP server mounted at `/mcp` had answered
 * 307 → `/mcp/`. Every gate fetch now asks for `redirect: 'manual'` (Node's fetch then hands back
 * the 3xx itself, status and `Location` readable — still never followed) and `refuseRedirect`
 * turns it into a failure that names the status and where it pointed.
 */
export const NO_REDIRECTS = 'manual' as const;

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

/** Who refused to follow, and what to fix — the gate's own transports by default; the kernel's
 *  fetches of owner-supplied URLs say their own. */
export interface RedirectAdvice {
  readonly follower: string;
  readonly fix: string;
}

const GATE_REDIRECT_ADVICE: RedirectAdvice = {
  follower: 'The gate does not follow redirects (its credential would go along)',
  fix: 'set the target URL to the final address',
};

/** The readable failure for a redirect `response` to `requestUrl` (`label`: what was being
 *  called, e.g. `mcp transport: tools/list`). */
export function redirectRefusalMessage(
  label: string,
  response: Pick<Response, 'status' | 'headers'>,
  requestUrl: string | URL,
  advice: RedirectAdvice = GATE_REDIRECT_ADVICE,
): string {
  const where = redirectTargetForDisplay(response.headers.get('location'), requestUrl);
  return `${label} responded ${response.status}, a redirect to ${where}. ${advice.follower}: ${advice.fix}.`;
}

/** Throws a `TransportInvokeError` naming the redirect when `response` is one; returns otherwise. */
export async function refuseRedirect(
  label: string,
  response: Response,
  requestUrl: string | URL,
): Promise<void> {
  if (!isRedirectStatus(response.status)) return;
  await response.body?.cancel().catch(() => {});
  throw new TransportInvokeError(redirectRefusalMessage(label, response, requestUrl));
}
