import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  INTERNAL_TOKEN_FILE_ENV,
  InternalTokenError,
  SUPERVISOR_TOKEN_FILE_ENV,
  normalizeInternalToken,
  resolveInternalTokenFile,
  resolveSupervisorTokenFile,
} from '@nexttime/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createSubnetMatcher } from './subnet.js';
import type { SubnetMatcher } from './subnet.js';

/**
 * interfaces/internal-auth: the credential guard in front of the kernel's whole *internal plane*
 * — every route registered under `/internal/` (the `interfaces/http/internal/*` HTTP routes and
 * `interfaces/ws/agent-host.ts`'s `/internal/agent-host` WebSocket upgrade) — plus the loader for
 * the root secret it derives every caller's credential from. Contract (env var, default path,
 * header, validation floor) is `@nexttime/shared`'s `internal-token.ts`; that module's doc
 * comment also records *why* this plane needs a credential at all: the kernel is dual-homed on
 * `control` and `workers` and binds every interface, so "reachable only on `control`" was never
 * true for this listener and every agent container could reach these routes unauthenticated.
 *
 * Per-caller credentials (R-03, 2026-10-02 review L1-7/L6-1). The plane used to accept one shared
 * token that seven services held, so any one of them — a gate included — could open
 * `/internal/agent-host` and receive every user's `startTurn` (prompt + entry Handle), forge
 * `/internal/llm-usage`, audit and egress rows, or announce gate manifests. Now only the kernel
 * holds the root secret (`secrets/internal.token`); each calling service holds only its own
 * credential, derived from the root by `scripts/gen-handle-keys.sh` and mounted into that service
 * alone:
 *
 *     credential(caller) = HMAC-SHA256(key = "nexttime-internal:<caller>->kernel", msg = root)
 *
 * which is RFC 5869 HKDF-Extract with the public label as the salt (the root is the input keying
 * material, as in TLS 1.3's key schedule) — the shell script streams the root to `openssl dgst
 * -hmac <label>` on stdin, so the root never appears in a process argv. One credential reveals
 * neither the root nor any sibling credential. The kernel re-derives every caller's credential
 * from the root it already holds (`deriveInternalCredential`), identifies the caller by which one
 * the bearer matches (constant-time), and admits it only on the routes `INTERNAL_ROUTE_CALLERS`
 * lists for it. Rotating the root and re-running the script rotates every credential at once.
 *
 * Mechanism: one Fastify `onRequest` hook on the root instance (`registerInternalPlaneGuard`),
 * keyed on the *matched route pattern* (`request.routeOptions.url`) rather than the raw URL —
 * so it cannot be side-stepped by URL encoding tricks, and any future route registered anywhere
 * under `/internal/` is guarded without its author remembering to opt in (and fails registration
 * until it is given an allow-list entry). `onRequest` is the earliest lifecycle hook (before body
 * parsing), and `@fastify/websocket` pushes upgrade requests through the same hook chain, so a
 * rejected WebSocket upgrade gets the 401 written over the raw socket and never reaches the
 * route's connection handler (no `hello` is ever read).
 *
 * Four independent checks, evaluated in order, every one of which rejects with the same
 * 401 `{ok:false, error:{code:'unauthorized', message:'unauthorized'}}` body and a structured
 * `warn` log line carrying the route, method, peer address, a `reason` and (once identified) the
 * `caller` — never the presented or expected token:
 *   1. a root must be configured at all (an instance built without `InternalPlaneAuthConfig` is
 *      fail-*closed*: the plane rejects everything, it never falls back to "open");
 *   2. `Authorization: Bearer <token>` must be present and equal one caller's credential, compared
 *      with `crypto.timingSafeEqual` on equal-length buffers (an unequal length is a plain
 *      mismatch);
 *   3. when `workersSubnet` (`NEXTTIME_SUBNET_WORKERS`) is configured, the TCP peer must be
 *      outside it — a Worker container must never hold any of these credentials, so a correct one
 *      arriving from that subnet is treated as a leaked credential, not as a client. The peer is
 *      the socket's own `remoteAddress`, never an `X-Forwarded-For`-style header (the kernel sits
 *      behind no proxy on these networks; a header would be attacker-controlled);
 *   4. the identified caller must be on the route's allow-list — a valid credential on another
 *      service's route is refused (`route_not_allowed`).
 *
 * `/api/cap/*`, `/api/health` and `/ws` are outside the prefix and untouched by this hook.
 */

/** Every route whose pattern starts with this is part of the internal plane. */
export const INTERNAL_PLANE_ROUTE_PREFIX = '/internal/' as const;

/** Prefix of every derived internal-plane credential's label (`deriveInternalCredential`) —
 *  `scripts/gen-handle-keys.sh` derives the same labels, so the two must change together. */
export const INTERNAL_CREDENTIAL_LABEL_PREFIX = 'nexttime-internal:' as const;

/**
 * Who called the internal plane, identified by which credential the bearer matched:
 *   - `kernel`: the root itself, which no service holds — operators read `/internal/metrics`
 *     from inside the kernel container with it (docs/runbooks/observability.md §2);
 *   - `agent-host`, `llm-proxy`, `egress-proxy`: the one compose service of that name;
 *   - `gate`: every packaged gate (the bundled ones and any `gatekeeper-<system>` an operator
 *     adds per docs/runbooks/add-gatekeeper.md) — one shared, announce-only credential, since the
 *     family is open-ended;
 *   - `gate-host`: the generic gate host, which alone may also pull hosted instance definitions.
 */
export type InternalCaller =
  | 'kernel'
  | 'agent-host'
  | 'llm-proxy'
  | 'egress-proxy'
  | 'gate'
  | 'gate-host';

/** Every caller whose credential is derived from the root (all but `kernel`). */
const DERIVED_CALLERS = ['agent-host', 'llm-proxy', 'egress-proxy', 'gate', 'gate-host'] as const;

/**
 * The per-route caller allow-list, keyed by the matched route pattern. Built from what each
 * service actually calls (grep its `KERNEL_URL` uses): agent-host only its WebSocket link;
 * llm-proxy usage, budget, Handle revocations and its provider-admin audit rows; egress-proxy its
 * egress observations; gates announce (which doubles as their heartbeat), and gate-host also its
 * instance-definition pull. A route missing from this table is refused for every caller, and
 * `registerInternalPlaneGuard` refuses to register one.
 */
export const INTERNAL_ROUTE_CALLERS: Readonly<Record<string, readonly InternalCaller[]>> = {
  '/internal/agent-host': ['agent-host'],
  '/internal/llm-usage': ['llm-proxy'],
  '/internal/llm-budget-exhausted': ['llm-proxy'],
  '/internal/handle-revocations': ['llm-proxy'],
  '/internal/llm-admin-audit': ['llm-proxy'],
  '/internal/egress': ['egress-proxy'],
  '/internal/gates/announce': ['gate', 'gate-host'],
  '/internal/gate-host/instances': ['gate-host'],
  '/internal/metrics': ['kernel'],
};

/** `caller`'s credential toward the kernel, derived from `root` — see this module's doc comment
 *  for the construction and why the label is the HMAC key. */
export function deriveInternalCredential(
  root: string,
  caller: Exclude<InternalCaller, 'kernel'>,
): string {
  return createHmac('sha256', `${INTERNAL_CREDENTIAL_LABEL_PREFIX}${caller}->kernel`)
    .update(root, 'utf8')
    .digest('hex');
}

export interface InternalPlaneAuthConfig {
  /** The root secret (`@nexttime/shared` `normalizeInternalToken`'s output — `loadInternalToken`
   *  below in production, any ≥ 1-character string in tests). Every caller's credential is
   *  derived from it; presented as-is it identifies the `kernel` caller. */
  readonly token: string;
  /** `NEXTTIME_SUBNET_WORKERS` as a CIDR string; peers inside it are rejected even with a valid
   *  credential. Omit (or pass `undefined`) to skip the peer check. */
  readonly workersSubnet?: string;
}

/** Why a request was rejected — the `reason` field of the guard's `warn` log line. */
export type InternalPlaneRejectReason =
  | 'no_token_configured'
  | 'missing_token'
  | 'invalid_token'
  | 'workers_subnet_peer'
  | 'route_not_allowed';

/** The guard's decision for one request: admitted as `caller`, or rejected for `reason` (with the
 *  caller when its credential was valid but the peer or the route was not). */
export type InternalPlaneDecision =
  | { readonly ok: true; readonly caller: InternalCaller }
  | {
      readonly ok: false;
      readonly reason: InternalPlaneRejectReason;
      readonly caller?: InternalCaller;
    };

const UNAUTHORIZED_BODY = {
  ok: false,
  error: { code: 'unauthorized', message: 'unauthorized' },
} as const;

/**
 * Reads the root secret from the file named by `NEXTTIME_INTERNAL_TOKEN_FILE` (default
 * `/run/secrets/internal_token`, the compose secret `internal_token` backed by
 * `${NEXTTIME_DATA}/secrets/internal.token` — mounted into the kernel only) and returns the
 * normalized token. Synchronous on purpose: `main()` calls it before opening the DB pool or
 * binding a port, in the same fail-fast slot as `resolveAgentRuntimeKind()`, and an unreadable /
 * empty / too-short file is a startup failure with a message that names the path and the env var
 * — never the contents.
 */
export function loadInternalToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const file = resolveInternalTokenFile(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
    const hint =
      'the kernel refuses to start without it: generate it with scripts/gen-handle-keys.sh and mount it as the compose secret internal_token (the root — the kernel is its only holder)';
    throw new InternalTokenError(
      `cannot read the internal-plane token file "${file}" (${INTERNAL_TOKEN_FILE_ENV}; ${code}) — ${hint}`,
    );
  }
  return normalizeInternalToken(raw, file);
}

/**
 * Reads the kernel's own credential for worker-supervisor from `NEXTTIME_SUPERVISOR_TOKEN_FILE`
 * (default `/run/secrets/internal_token_worker_supervisor`, the compose secret
 * `internal_kernel_to_worker_supervisor`). A file rather than a derivation from the root, so the
 * acceptance / ops scripts that call worker-supervisor from a kernel container read the same file
 * the kernel does. Same fail-fast contract as `loadInternalToken`.
 */
export function loadSupervisorToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const file = resolveSupervisorTokenFile(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
    throw new InternalTokenError(
      `cannot read the worker-supervisor credential file "${file}" (${SUPERVISOR_TOKEN_FILE_ENV}; ${code}) — the kernel refuses to start without it: derive it with scripts/gen-handle-keys.sh and mount it as the compose secret internal_kernel_to_worker_supervisor`,
    );
  }
  return normalizeInternalToken(raw, file);
}

/** `Authorization: Bearer <token>` → `<token>`; anything else → `undefined`. Scheme is matched
 *  case-insensitively per RFC 9110; the token itself is taken verbatim. */
function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const space = header.indexOf(' ');
  if (space === -1) return undefined;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return undefined;
  const token = header.slice(space + 1).trim();
  return token.length > 0 ? token : undefined;
}

/** Constant-time equality over equal-length UTF-8 buffers; an unequal length is a mismatch. */
function tokenMatches(presented: string, expected: Buffer): boolean {
  const presentedBuffer = Buffer.from(presented, 'utf8');
  if (presentedBuffer.length !== expected.length) return false;
  return timingSafeEqual(presentedBuffer, expected);
}

/** The peer's own transport address (what the TCP connection says), independent of any proxy
 *  header. `undefined` only for a socket that is already gone. */
function peerAddress(request: FastifyRequest): string | undefined {
  return request.socket?.remoteAddress ?? undefined;
}

/** Whether this request arrived through the HTTP server's `upgrade` event (a WebSocket handshake).
 *  Detected from the request's own `Upgrade` header rather than `@fastify/websocket`'s
 *  `request.ws` flag: that flag is set by the plugin's *own* `onRequest` hook, which Fastify runs
 *  after this module's (the plugin is loaded asynchronously by avvio, after `createServer` has
 *  already added the guard hook synchronously), so it is still unset when the guard decides. */
function isUpgradeRequest(request: FastifyRequest): boolean {
  return typeof request.raw.headers.upgrade === 'string';
}

export interface InternalPlaneGuard {
  /** The decision for `request` (its matched route pattern included). Exposed for tests and for
   *  any future non-Fastify transport that needs the identical decision. */
  evaluate(request: FastifyRequest): InternalPlaneDecision;
}

export function createInternalPlaneGuard(
  config: InternalPlaneAuthConfig | undefined,
  routeCallers: Readonly<Record<string, readonly InternalCaller[]>> = INTERNAL_ROUTE_CALLERS,
): InternalPlaneGuard {
  const credentials: readonly { readonly caller: InternalCaller; readonly expected: Buffer }[] =
    config
      ? [
          { caller: 'kernel', expected: Buffer.from(config.token, 'utf8') },
          ...DERIVED_CALLERS.map((caller) => ({
            caller,
            expected: Buffer.from(deriveInternalCredential(config.token, caller), 'utf8'),
          })),
        ]
      : [];
  const inWorkersSubnet: SubnetMatcher | undefined = config?.workersSubnet
    ? createSubnetMatcher(config.workersSubnet)
    : undefined;

  return {
    evaluate(request) {
      if (credentials.length === 0) return { ok: false, reason: 'no_token_configured' };
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined) return { ok: false, reason: 'missing_token' };
      // Compared against every credential (no early exit), so the time taken says nothing about
      // which one, if any, matched.
      let caller: InternalCaller | undefined;
      for (const credential of credentials) {
        if (tokenMatches(presented, credential.expected)) caller = credential.caller;
      }
      if (caller === undefined) return { ok: false, reason: 'invalid_token' };
      if (inWorkersSubnet) {
        const peer = peerAddress(request);
        if (peer !== undefined && inWorkersSubnet(peer)) {
          return { ok: false, reason: 'workers_subnet_peer', caller };
        }
      }
      const route = request.routeOptions.url;
      const allowed = typeof route === 'string' ? routeCallers[route] : undefined;
      if (!allowed?.includes(caller)) return { ok: false, reason: 'route_not_allowed', caller };
      return { ok: true, caller };
    },
  };
}

/**
 * Installs the guard as a root-level `onRequest` hook on `app`. Call once per Fastify instance,
 * from the composition root (`packages/kernel/src/index.ts` `createServer`), *before* the
 * internal routes are registered: the guard also installs an `onRoute` hook that throws for any
 * `/internal/` route `routeCallers` has no entry for, so a new internal route cannot ship
 * unreachable (or tempt anyone into opening it up) — its author adds its callers to
 * `INTERNAL_ROUTE_CALLERS` instead. Passing `undefined` installs a fail-closed guard (every
 * internal request → 401 `no_token_configured`) and logs one `warn` at registration so a
 * misconfigured process is visible in its first log lines, not only through its clients'
 * failures. `routeCallers` is overridable for tests only.
 */
export function registerInternalPlaneGuard(
  app: FastifyInstance,
  config: InternalPlaneAuthConfig | undefined,
  routeCallers: Readonly<Record<string, readonly InternalCaller[]>> = INTERNAL_ROUTE_CALLERS,
): void {
  const guard = createInternalPlaneGuard(config, routeCallers);
  if (!config) {
    app.log.warn(
      'internal plane: no root token configured — every /internal/* request will be rejected (fail-closed)',
    );
  }

  app.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;
    if (url.startsWith(INTERNAL_PLANE_ROUTE_PREFIX) && routeCallers[url] === undefined) {
      throw new Error(
        `internal plane: route ${url} has no caller allow-list entry — add it to INTERNAL_ROUTE_CALLERS (interfaces/internal-auth)`,
      );
    }
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions.url;
    if (typeof route !== 'string' || !route.startsWith(INTERNAL_PLANE_ROUTE_PREFIX)) return;

    const decision = guard.evaluate(request);
    if (decision.ok) return;

    const upgrade = isUpgradeRequest(request);
    request.log.warn(
      {
        route,
        method: request.method,
        peer: peerAddress(request),
        upgrade,
        reason: decision.reason,
        ...(decision.caller !== undefined ? { caller: decision.caller } : {}),
      },
      'internal plane: request rejected',
    );
    reply.code(401);
    reply.header('www-authenticate', 'Bearer');
    if (upgrade) {
      // A rejected WebSocket handshake needs its socket closed by hand: Node's HTTP server detaches
      // a socket from its own lifecycle management the moment it emits `upgrade`, and
      // `@fastify/websocket` only destroys it in its `onResponse` hook when its `request.ws` flag
      // is set — which it is not on this path (see `isUpgradeRequest`). Without this, every
      // rejected upgrade would leave one half-open socket behind (a file descriptor per attempt,
      // and `app.close()` would wait on it forever). `finish` fires once the 401 has been handed
      // to the OS, so the peer still sees the status line rather than a bare reset.
      reply.header('connection', 'close');
      const socket = request.raw.socket;
      reply.raw.once('finish', () => socket?.destroy());
    }
    return reply.send(UNAUTHORIZED_BODY);
  });
}
