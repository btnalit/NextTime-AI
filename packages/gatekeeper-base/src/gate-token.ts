/**
 * gate-token: the shared-secret contract every `/gate/*` route now requires (review lane 5, P1-1
 * — every route was reachable, unauthenticated, by any container sharing a gate's control
 * network; a compromised control container could `compose.down` the platform via
 * `gatekeeper-docker` or overwrite/delete a principal's `ConnectedAccount`). Pure, IO-free — each
 * of the two readers below does its own file read and feeds the raw contents through
 * `normalizeGateToken`, mirroring `@nexttime/shared`'s `internal-token.ts` (the kernel's own
 * internal-plane token) both in shape and in why it is a *separate* module from the loader: this
 * file only defines the wire contract (env var default, validation floor), never touches
 * `node:fs`.
 *
 * Two independent readers, two independent env var names, one shared default in-container path:
 *   - the gate itself (`gate-auth.ts`'s `loadGateKernelToken`, read via `GATE_KERNEL_TOKEN_FILE`)
 *     — refuses to start without a readable, valid token file.
 *   - the kernel's `HttpGatekeeperClient` (`packages/kernel/src/adapters/gatekeeper-client`, read
 *     via its own `NEXTTIME_GATE_TOKEN_FILE`) — sends `Authorization: Bearer <token>` with every
 *     `/gate/*` request when a token is available.
 * Both default to `/run/secrets/gate_token` even though the env var names differ (this package's
 * own `GATE_*` convention vs. the kernel's `NEXTTIME_*` convention) — `docker-compose.yml` mounts
 * the same compose secret `gate_token` at that path independently in both the kernel service and
 * each of the four gate services, so there is no need for a shared env var name, only a shared
 * default path and validation rule.
 *
 * Deliberately a *different* secret from `@nexttime/shared`'s `internal_token`: that token closes
 * the kernel's own internal plane (agent-host/llm-proxy/egress-proxy → kernel); this one closes
 * every deployed gate's HTTP surface (kernel → gate). Reusing one token across both would collapse
 * two distinct blast radii into a single credential — a compromised gate container would then also
 * be able to reach the kernel's internal plane, and vice versa.
 */

/** Where the compose secret `gate_token` lands inside every container that declares it. */
export const DEFAULT_GATE_TOKEN_FILE = '/run/secrets/gate_token';

/** Smallest token accepted, in characters — same floor as `@nexttime/shared`'s
 *  `INTERNAL_TOKEN_MIN_LENGTH` (32 random bytes are 64 hex characters, comfortably above this; the
 *  floor exists only to refuse an operator placeholder loudly instead of running on a guessable
 *  secret). */
export const GATE_TOKEN_MIN_LENGTH = 32;

/** Thrown by `normalizeGateToken`, and by each side's own file loader, for a token file that
 *  cannot be used as-is. Never carries the token's contents. */
export class GateTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateTokenError';
  }
}

/**
 * Turns the raw contents of a gate-token file into the token: trims surrounding whitespace (the
 * normal case for a file written by a shell, e.g. `openssl rand -hex 32 > file`) and refuses an
 * empty, multi-line/whitespace-containing, or too-short value. `source` (the file path) is named
 * in every error message; the token's own contents never are.
 */
export function normalizeGateToken(raw: string, source: string): string {
  const token = raw.trim();
  if (token.length === 0) {
    throw new GateTokenError(
      `gate token file "${source}" is empty — generate it with scripts/gen-handle-keys.sh (writes secrets/gate.token)`,
    );
  }
  if (/\s/.test(token)) {
    throw new GateTokenError(
      `gate token file "${source}" must contain exactly one line with no whitespace inside the token`,
    );
  }
  if (token.length < GATE_TOKEN_MIN_LENGTH) {
    throw new GateTokenError(
      `gate token file "${source}" holds a token shorter than ${GATE_TOKEN_MIN_LENGTH} characters — regenerate it with scripts/gen-handle-keys.sh (32 random bytes, hex)`,
    );
  }
  return token;
}

/** The `Authorization` header value every gate client sends. */
export function gateAuthorizationHeader(token: string): string {
  return `Bearer ${token}`;
}
