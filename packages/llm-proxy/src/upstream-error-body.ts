import { scrubTokenLikeRuns } from './provider-test.js';

/**
 * upstream-error-body: what of a provider's error response reaches the caller (review of #549, B5).
 * A provider's 4xx / 5xx body can quote the request — its headers included, so the real key the
 * proxy put there — or another secret-shaped string (an internal token, a signed URL). The proxy
 * reads such a body whole, up to `UPSTREAM_ERROR_BODY_MAX_BYTES`, and forwards a copy with the
 * real key replaced wherever it appears and every token-like run replaced in every string
 * (`scrubTokenLikeRuns`, the patterns the console's provider test scrubs with).
 *
 * The structure is kept: the SDK in the agent reads `error.type` / `error.message` from a JSON
 * body, so a JSON body is parsed and scrubbed string by string, then serialized again — never
 * scrubbed as text, never truncated. The classification fields SDKs and operators read
 * (`KEPT_KEYS`: `type`, `code`, `request_id`) lose only the real key: a token-like pattern would
 * turn `invalid_api_key_format` into `invalid_api_***`. A body that is not JSON is scrubbed as text.
 * A successful response is streamed through untouched.
 */

/** The most of an error body the proxy reads; past it the body is not forwarded. */
export const UPSTREAM_ERROR_BODY_MAX_BYTES = 64 * 1024;

const KEPT_KEYS = new Set(['type', 'code', 'request_id']);

function withoutKey(text: string, realKey: string): string {
  return realKey === '' ? text : text.split(realKey).join('***');
}

function scrubJson(value: unknown, realKey: string, key: string | undefined): unknown {
  if (typeof value === 'string') {
    return key !== undefined && KEPT_KEYS.has(key)
      ? withoutKey(value, realKey)
      : scrubTokenLikeRuns(value, realKey);
  }
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, realKey, undefined));
  if (value !== null && typeof value === 'object') {
    // `Object.fromEntries` keeps a `"__proto__"` key a field, never a prototype swap.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, inner]) => [
        withoutKey(name, realKey),
        scrubJson(inner, realKey, name),
      ]),
    );
  }
  return value;
}

/** The copy of a provider's error body the caller gets (this module's doc comment). */
export function scrubUpstreamErrorBody(text: string, realKey: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return scrubTokenLikeRuns(text, realKey);
  }
  return JSON.stringify(scrubJson(parsed, realKey, undefined));
}

/** What replaces an error body past `UPSTREAM_ERROR_BODY_MAX_BYTES`: the provider's error shape,
 *  so an SDK still reads a message. */
export function oversizedUpstreamErrorBody(): string {
  return JSON.stringify({
    error: {
      type: 'upstream_error',
      message: `the provider's error response was larger than ${UPSTREAM_ERROR_BODY_MAX_BYTES / 1024} KiB and was not forwarded`,
    },
  });
}
