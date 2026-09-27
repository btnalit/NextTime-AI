/**
 * correlation: the cross-service correlation id (docs/STATUS.md leftover 87) — one opaque id per
 * user Turn / delegation that every hop carries on its outbound calls and writes into its own log
 * lines, so one delegation can be followed across `docker compose logs` of every service by a
 * single `grep`. Shared the same way `internal-token.ts` is: one definition of the header name, the
 * env var name and the validation rule, so the kernel, agent-host, worker-supervisor, llm-proxy,
 * egress-proxy, gatekeeper-base and the platform extension cannot drift on any of them.
 *
 * Origin (docs/runbooks/observability.md has the hop-by-hop map): for a chat Turn the id **is the
 * Turn's own id** (`activities.id`, `kind='agent_turn'`) — the kernel already sends it to
 * agent-host on `startTurn`, agent-host already hands it to pi in the prompt's turn marker, so the
 * platform extension reuses it rather than inventing a second id. A Worker inherits the id of the
 * call that spawned it (`NEXTTIME_CORRELATION_ID` in its container env). Any request that arrives
 * without a valid id gets a freshly minted one at the first service that sees it.
 *
 * **Not a credential, never carries one.** The id is caller-chosen and unauthenticated — the kernel
 * reads it before authentication and writes it into log lines and audit payloads — so it is only
 * ever an opaque random-looking token: 8–64 characters of `[A-Za-z0-9_-]` (a UUID fits; a JWT, with
 * its dots, does not; nothing with whitespace or quotes can reach a log line). Anything else is
 * replaced, never truncated or repaired. It must never be derived from a Handle, a key or any
 * other secret, and never placed inside a Handle's scope.
 *
 * Deliberately IO-free and dependency-free (`packages/web` bundles this package): minting uses the
 * platform's own `crypto.randomUUID` (Node ≥ 22, every current browser).
 */

/** The one HTTP header every hop reads and forwards. Lower-case (Node normalizes incoming names). */
export const CORRELATION_ID_HEADER = 'x-correlation-id' as const;

/** The container env var a Worker run inherits its delegating call's id through (worker-supervisor
 *  sets it; the platform extension's worker mode reads it). */
export const CORRELATION_ID_ENV = 'NEXTTIME_CORRELATION_ID' as const;

/** Short and url-safe: exactly what may appear in a log line, an audit payload, a container env var
 *  and a Docker label without any escaping. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

interface RandomUuidSource {
  readonly crypto?: { readonly randomUUID?: () => string };
}

/** A fresh id (a v4 UUID). Not a secret — uniqueness is all that matters — so the fallback for a
 *  runtime without `crypto.randomUUID` (none that this platform ships on) is plain `Math.random`. */
export function mintCorrelationId(): string {
  const webCrypto = (globalThis as RandomUuidSource).crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** The first value of a (possibly repeated) header, as Node's `IncomingHttpHeaders` types it. */
function firstValue(raw: string | readonly string[] | undefined): string | undefined {
  if (typeof raw === 'string') return raw;
  return raw?.[0];
}

/**
 * The id a service adopts for one inbound request: the caller's `x-correlation-id` when it is a
 * valid id, otherwise a freshly minted one — so every request has exactly one id from its first
 * log line on, whether or not the caller sent one.
 */
export function resolveCorrelationId(raw: string | readonly string[] | undefined): string {
  const inbound = firstValue(raw);
  return isValidCorrelationId(inbound) ? inbound : mintCorrelationId();
}

/** `{ 'x-correlation-id': id }` for an outbound call, or `{}` when there is no valid id to forward
 *  — spread into a request's headers. */
export function correlationHeaders(id: string | undefined): Record<string, string> {
  return isValidCorrelationId(id) ? { [CORRELATION_ID_HEADER]: id } : {};
}
