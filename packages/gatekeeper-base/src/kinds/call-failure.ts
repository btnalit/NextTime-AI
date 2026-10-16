import { TransportInvokeError, TransportOutcomeUnknownError } from '../errors.js';
import { networkFailureCode, networkFailureDelivery } from '../network-failure.js';

/**
 * Legacy 287 (review of #586: #493 M3, #501 P2-2): how a transport that calls its target over the
 * network records a call that failed, so the gate→target hop leans the same way as the
 * kernel→gate one (`adapters/gatekeeper-client`'s `networkFailure`):
 *
 *   - Before the target answered: only a proven `not_sent` (`networkFailureDelivery`: refused, no
 *     such host, connect timeout, a handshake-only TLS failure) is a plain failure. Anything else —
 *     a reset, a timeout, an error nobody recognises — may have reached the target and is
 *     "outcome unknown".
 *   - After the target answered: its explicit verdict (a non-2xx status, a JSON-RPC `error`, an
 *     MCP `isError` result) is a plain failure, the target's own answer. Any failure to read an
 *     answer it gave — a body cut short, a malformed or undecompressable answer, a 200 that is
 *     not the protocol's shape — is "outcome unknown": the target had the request.
 *
 * Messages name the call (`what`: the transport, method and path) and the Node / undici code,
 * never an address or the answer's text.
 */
function codeDetail(err: unknown): string {
  const code = networkFailureCode(err);
  return code !== undefined ? ` (${code})` : '';
}

/** A call that threw before its target answered. */
export function failedBeforeAnswer(what: string, err: unknown): TransportInvokeError {
  if (networkFailureDelivery(err) === 'not_sent') {
    return new TransportInvokeError(
      `${what} not sent — could not connect to the target${codeDetail(err)}; nothing reached it`,
      { cause: err },
    );
  }
  return new TransportOutcomeUnknownError(
    `${what} failed after the request may have reached the target${codeDetail(err)} — it may have run`,
    { cause: err },
  );
}

/** A call whose target answered (`status`) with something that could not be read as an answer:
 *  `reason` says what was wrong with it. */
export function failedAfterAnswer(
  what: string,
  status: number,
  reason: string,
  err?: unknown,
): TransportOutcomeUnknownError {
  return new TransportOutcomeUnknownError(
    `${what}: the target answered (status ${status}) but ${reason}${err !== undefined ? codeDetail(err) : ''} — it had the request and may have run it`,
    err !== undefined ? { cause: err } : undefined,
  );
}
