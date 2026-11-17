import {
  type RedirectAdvice,
  describeRedirect,
  isRedirectStatus,
  redirectTargetForDisplay,
} from '@nexttime/shared';
import { TransportInvokeError } from '../errors.js';

export type { RedirectAdvice };
export { isRedirectStatus, redirectTargetForDisplay };

/**
 * Redirects (review of #532, item 4). A gate never follows one: `fetch`'s default `'follow'`
 * resends every header, the gate's credential included, to whatever host a 3xx names (review lane
 * 5, P2-2). `redirect: 'error'` kept that rule but failed as a bare "request failed", so an
 * administrator could not tell that a Starlette / FastMCP server mounted at `/mcp` had answered
 * 307 → `/mcp/`. Every gate fetch now asks for `redirect: 'manual'` (Node's fetch then hands back
 * the 3xx itself, status and `Location` readable — still never followed) and `refuseRedirect`
 * turns it into a failure that names the status and where it pointed. The status test, the safe
 * display of the target and the wording are `@nexttime/shared` `redirect.ts` (legacy 221: llm-proxy
 * says it the same way); this module adds the gate's advice and its error type.
 */
export const NO_REDIRECTS = 'manual' as const;

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
  return describeRedirect(label, response, requestUrl, advice);
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
