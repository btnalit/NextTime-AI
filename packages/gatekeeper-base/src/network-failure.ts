/**
 * Legacy 287: whether a call that failed on the network could have been delivered. Shared by the
 * two hops that act on a target — the kernel calling a gate (`adapters/gatekeeper-client`) and a
 * gate calling its target system (`GatekeeperBase.apply`) — so both draw the line in one place:
 *
 *   - `not_sent`: the request provably never left — the name did not resolve, the connection was
 *     refused or timed out while connecting, or the TLS handshake failed (an allow-list of the
 *     codes only a handshake raises). Nothing ran, so the call can be recorded as failed and made
 *     again.
 *   - `maybe_delivered`: the connection broke, or the caller stopped waiting, after the request may
 *     have been sent — before the answer came back, or while it was being read. Whether it ran is
 *     unknown; recording it as failed would invite a second run.
 *   - `undefined`: the error carries no network signal this module knows. A caller that knows
 *     the error came from sending the request reads it as `maybe_delivered` (the kernel's gate
 *     client, a gate's http / mcp transports: anything but a proven `not_sent` may have been
 *     delivered); `GatekeeperBase` reads it on a transport's failure as the target's own answer.
 *
 * Read from the error's `code` / `syscall` / `name` (Node's and undici's own, never the message),
 * across its `cause` chain and an `AggregateError`'s `errors` (Node's happy-eyeballs connect). When
 * one chain shows both kinds, `maybe_delivered` wins: the safe reading of a doubt.
 */
export type NetworkFailureDelivery = 'not_sent' | 'maybe_delivered';

/** Codes only ever raised before a request is written: name resolution, a refused connect,
 *  undici's own connect timeout. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EAI_NODATA',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** The system calls of connection setup: a failure in one of them sent nothing (`ETIMEDOUT` or
 *  `EHOSTUNREACH` from `connect`, unlike the same codes on an open socket). */
const NOT_SENT_SYSCALLS = new Set(['connect', 'getaddrinfo', 'getnameinfo']);

/** OpenSSL's certificate verification results, as Node names them on the error: the client
 *  decides them during the handshake, before any request byte is written. */
const CERT_VERIFY_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** TLS failures only a handshake raises (legacy 287 review: an allow-list, never a prefix): the
 *  peer is not speaking TLS or no protocol version is shared, the handshake timed out, or the
 *  server refused it — in TLS 1.3 the server's alert can arrive after the client wrote its first
 *  bytes, but a server that failed the handshake never hands them to its application. */
const TLS_HANDSHAKE_CODES = new Set([
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
]);
const TLS_HANDSHAKE_ALERT =
  /^ERR_SSL_(?:SSLV3|TLSV1|TLSV13)_ALERT_(?:HANDSHAKE_FAILURE|PROTOCOL_VERSION|CERTIFICATE_REQUIRED)$/;

/** Every other TLS / SSL error — a bad record MAC, a renegotiation, a decryption failure — can be
 *  raised on a record read or written once the request is on its way. */
const TLS_ANY_CODE = /^ERR_(?:SSL|TLS)_/;

/** Codes of a connection that broke, or a wait that ended, once a request may have been written —
 *  undici's socket and timeout errors, Node's reset / broken pipe / aborted connection. */
const MAYBE_DELIVERED_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
  'UND_ERR_ABORTED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RESPONSE_EXCEEDED_MAX_SIZE',
]);

/** llhttp's parse errors of a malformed answer (`HPE_*`) and zlib's errors decompressing one
 *  (`Z_*`): the target answered, so it had the request. */
const ANSWER_READ_CODE = /^(?:HPE_|Z_)[A-Z0-9_]+$/;

/** A caller that stopped waiting (`AbortController#abort`, `AbortSignal.timeout`): the request may
 *  already be with the target. */
const MAYBE_DELIVERED_NAMES = new Set(['AbortError', 'TimeoutError']);

const MAX_DEPTH = 8;

function ownDelivery(err: object): NetworkFailureDelivery | undefined {
  const { code, syscall, name } = err as { code?: unknown; syscall?: unknown; name?: unknown };
  if (typeof name === 'string' && MAYBE_DELIVERED_NAMES.has(name)) return 'maybe_delivered';
  if (typeof code !== 'string') return undefined;
  if (
    NOT_SENT_CODES.has(code) ||
    CERT_VERIFY_CODES.has(code) ||
    TLS_HANDSHAKE_CODES.has(code) ||
    TLS_HANDSHAKE_ALERT.test(code)
  ) {
    return 'not_sent';
  }
  if (TLS_ANY_CODE.test(code)) return 'maybe_delivered';
  if (typeof syscall === 'string' && NOT_SENT_SYSCALLS.has(syscall)) return 'not_sent';
  if (MAYBE_DELIVERED_CODES.has(code) || ANSWER_READ_CODE.test(code)) return 'maybe_delivered';
  return undefined;
}

/** How a failed network call reads — see this module's doc comment. */
export function networkFailureDelivery(err: unknown): NetworkFailureDelivery | undefined {
  let found: NetworkFailureDelivery | undefined;
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH || seen.has(value)) {
      return;
    }
    seen.add(value);
    const own = ownDelivery(value);
    if (own === 'maybe_delivered') found = own;
    else if (own === 'not_sent' && found === undefined) found = own;
    const { errors, cause } = value as { errors?: unknown; cause?: unknown };
    if (Array.isArray(errors)) for (const inner of errors) visit(inner, depth + 1);
    visit(cause, depth + 1);
  };
  visit(err, 0);
  return found;
}

/** The first Node / undici error code along `err`'s cause chain that names the failure
 *  (`ECONNREFUSED`, `UND_ERR_SOCKET`, …) — upper-case letters, digits and `_` only, so it is safe
 *  to repeat in a failure reason (never an address or a message). */
export function networkFailureCode(err: unknown): string | undefined {
  let value: unknown = err;
  for (let depth = 0; depth <= MAX_DEPTH && value !== null && typeof value === 'object'; depth++) {
    const { code, cause } = value as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    value = cause;
  }
  return undefined;
}
