/**
 * internal-token: the wire contract for the kernel's *internal plane* — every `/internal/*` HTTP
 * route and the `/internal/agent-host` WebSocket upgrade — shared by the kernel (which verifies)
 * and each internal client that presents it (`@nexttime/agent-host`, `@nexttime/llm-proxy`,
 * `@nexttime/egress-proxy`). Same precedent as `handle-token.ts` and `agent-host-protocol.ts`:
 * one definition of the env var name, the default file path, the header shape and the validation
 * floor, so four processes cannot drift on any of them.
 *
 * Why this exists (fix/internal-plane-auth, 2026-09): the kernel is dual-homed on the compose
 * `control` *and* `workers` networks and listens on every interface, so every entry/Worker agent
 * container can reach it by design (`/api/cap/*`, authenticated by Capability Handle). The
 * internal plane on that same listener previously carried no credential at all — "reachable only
 * on `control`" was the documented trust boundary, but it was never true for a dual-homed
 * listener. A compromised agent container could therefore have registered itself as agent-host
 * and harvested every user's fresh entry Handle from `startTurn` frames, injected runtime events
 * into other users' chats, forged LLM-usage / egress observations, or read the Handle revocation
 * list. The internal plane is now closed behind a shared secret:
 *
 *   - One random token (≥ 32 bytes, hex/base64url, one line) lives on the host at
 *     `${NEXTTIME_DATA}/secrets/internal.token` (written by `scripts/gen-handle-keys.sh`, same
 *     0640 / group-10001 convention as `handle.key`) and reaches exactly the kernel and its
 *     internal clients as the compose secret `internal_token`, mounted at
 *     `DEFAULT_INTERNAL_TOKEN_FILE`. `INTERNAL_TOKEN_FILE_ENV` overrides the path.
 *   - Every internal request carries `Authorization: Bearer <token>`; the kernel compares in
 *     constant time and answers 401 `unauthorized` otherwise. The WebSocket upgrade is rejected
 *     before any `hello` frame is read.
 *   - A Worker must never hold this token, so the kernel additionally refuses internal requests
 *     whose TCP peer is inside `NEXTTIME_SUBNET_WORKERS` even when the token is right.
 *
 * Deliberately IO-free (no `node:fs`): `packages/web` bundles this package for the browser, and
 * the domain layer does no IO — each process reads the file itself with a few lines and feeds the
 * raw contents through `normalizeInternalToken`, so the *validation* rule is still defined once.
 */

/** Env var naming the file the token is read from (in-container path). */
export const INTERNAL_TOKEN_FILE_ENV = 'NEXTTIME_INTERNAL_TOKEN_FILE' as const;

/** Where the compose secret `internal_token` lands inside every container that declares it. */
export const DEFAULT_INTERNAL_TOKEN_FILE = '/run/secrets/internal_token' as const;

/** Smallest token accepted, in characters. 32 random bytes are 64 hex or 43 base64url characters,
 *  so a correctly generated token always clears this; the floor only exists to refuse an operator
 *  placeholder ("changeme") loudly at startup instead of running on a guessable secret. */
export const INTERNAL_TOKEN_MIN_LENGTH = 32;

/** Thrown by `normalizeInternalToken` when the file's contents cannot be used as the token. Each
 *  process's own loader wraps its file-read failure in the same class so "cannot read" and
 *  "unusable contents" surface identically to an operator. */
export class InternalTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalTokenError';
  }
}

/** The token file path for `env`: `INTERNAL_TOKEN_FILE_ENV` when set and non-empty, else
 *  `DEFAULT_INTERNAL_TOKEN_FILE`. */
export function resolveInternalTokenFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[INTERNAL_TOKEN_FILE_ENV];
  return configured && configured.length > 0 ? configured : DEFAULT_INTERNAL_TOKEN_FILE;
}

/**
 * Turns the raw contents of the token file into the token: trims surrounding whitespace (a
 * trailing newline is the normal case for a file written by a shell) and refuses an empty, multi-
 * line / whitespace-containing, or too-short value with an `InternalTokenError` whose message names
 * `source` (the file path) but never echoes the contents.
 */
export function normalizeInternalToken(raw: string, source: string): string {
  const token = raw.trim();
  if (token.length === 0) {
    throw new InternalTokenError(
      `internal-plane token file "${source}" is empty — generate it with scripts/gen-handle-keys.sh (writes secrets/internal.token)`,
    );
  }
  if (/\s/.test(token)) {
    throw new InternalTokenError(
      `internal-plane token file "${source}" must contain exactly one line with no whitespace inside the token`,
    );
  }
  if (token.length < INTERNAL_TOKEN_MIN_LENGTH) {
    throw new InternalTokenError(
      `internal-plane token file "${source}" holds a token shorter than ${INTERNAL_TOKEN_MIN_LENGTH} characters — regenerate it with scripts/gen-handle-keys.sh (32 random bytes, hex)`,
    );
  }
  return token;
}

/** The `Authorization` header value every internal client sends. */
export function internalAuthorizationHeader(token: string): string {
  return `Bearer ${token}`;
}
