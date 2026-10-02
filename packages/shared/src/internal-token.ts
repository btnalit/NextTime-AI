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
 * list. The internal plane is now closed behind per-service credentials (R-03, 2026-10-02 review:
 * the first version was one token shared by seven services, so any of them could act as any
 * other):
 *
 *   - One random root (≥ 32 bytes, hex/base64url, one line) lives on the host at
 *     `${NEXTTIME_DATA}/secrets/internal.token` (written by `scripts/gen-handle-keys.sh`, same
 *     0640 / group-10001 convention as `handle.key`) and reaches the kernel only, as the compose
 *     secret `internal_token`.
 *   - The same script derives one credential per caller → callee edge from it
 *     (`secrets/internal-<caller>-to-<callee>.token`; the kernel's `interfaces/internal-auth`
 *     documents the construction) and compose mounts each into the services on that edge only.
 *     A kernel client finds its own credential at `DEFAULT_INTERNAL_TOKEN_FILE` (a compose secret
 *     `target`), so client code reads one path whatever service it is;
 *     `INTERNAL_TOKEN_FILE_ENV` overrides it. A worker-supervisor client (agent-host, the kernel)
 *     finds its credential for the supervisor at `DEFAULT_SUPERVISOR_TOKEN_FILE`.
 *   - Every internal request carries `Authorization: Bearer <credential>`; the callee compares in
 *     constant time, identifies the caller by which credential matched, admits it only on the
 *     routes allowed for that caller, and answers 401 `unauthorized` otherwise. The WebSocket
 *     upgrade is rejected before any `hello` frame is read.
 *   - A Worker must never hold any of these, so the kernel additionally refuses internal requests
 *     whose TCP peer is inside `NEXTTIME_SUBNET_WORKERS` even when the credential is right.
 *
 * Deliberately IO-free (no `node:fs`): `packages/web` bundles this package for the browser, and
 * the domain layer does no IO — each process reads the file itself with a few lines and feeds the
 * raw contents through `normalizeInternalToken`, so the *validation* rule is still defined once.
 */

/** Env var naming the file the token is read from (in-container path). */
export const INTERNAL_TOKEN_FILE_ENV = 'NEXTTIME_INTERNAL_TOKEN_FILE' as const;

/** Where each container's internal-plane credential lands: the root in the kernel, the service's
 *  own credential toward the kernel in each kernel client, the kernel's credential toward it in
 *  worker-supervisor. */
export const DEFAULT_INTERNAL_TOKEN_FILE = '/run/secrets/internal_token' as const;

/** Env var naming the file a worker-supervisor client (agent-host, the kernel) reads its own
 *  credential for worker-supervisor from (in-container path). */
export const SUPERVISOR_TOKEN_FILE_ENV = 'NEXTTIME_SUPERVISOR_TOKEN_FILE' as const;

/** Where that credential lands: compose mounts `internal_agent_host_to_worker_supervisor` here in
 *  agent-host and `internal_kernel_to_worker_supervisor` here in the kernel. */
export const DEFAULT_SUPERVISOR_TOKEN_FILE =
  '/run/secrets/internal_token_worker_supervisor' as const;

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

/** The worker-supervisor credential file path for `env`: `SUPERVISOR_TOKEN_FILE_ENV` when set and
 *  non-empty, else `DEFAULT_SUPERVISOR_TOKEN_FILE`. */
export function resolveSupervisorTokenFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[SUPERVISOR_TOKEN_FILE_ENV];
  return configured && configured.length > 0 ? configured : DEFAULT_SUPERVISOR_TOKEN_FILE;
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
      `internal-plane token file "${source}" is empty — generate it with scripts/gen-handle-keys.sh (writes secrets/internal.token and every secrets/internal-*-to-*.token derived from it)`,
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
