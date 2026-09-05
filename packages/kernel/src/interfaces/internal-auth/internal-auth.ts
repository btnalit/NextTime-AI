import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  INTERNAL_TOKEN_FILE_ENV,
  InternalTokenError,
  normalizeInternalToken,
  resolveInternalTokenFile,
} from '@nexttime/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createSubnetMatcher } from './subnet.js';
import type { SubnetMatcher } from './subnet.js';

/**
 * interfaces/internal-auth: the shared-secret guard in front of the kernel's whole *internal
 * plane* — every route registered under `/internal/` (the `interfaces/http/internal/*` HTTP
 * routes `llm-proxy` and `egress-proxy` call, and `interfaces/ws/agent-host.ts`'s
 * `/internal/agent-host` WebSocket upgrade) — plus the loader for the token it checks against.
 * Contract (env var, default path, header, validation floor) is `@nexttime/shared`'s
 * `internal-token.ts`; that module's doc comment also records *why* this plane needs a credential
 * at all: the kernel is dual-homed on `control` and `workers` and binds every interface, so
 * "reachable only on `control`" was never true for this listener and every agent container could
 * reach these routes unauthenticated.
 *
 * Mechanism: one Fastify `onRequest` hook on the root instance (`registerInternalPlaneGuard`),
 * keyed on the *matched route pattern* (`request.routeOptions.url`) rather than the raw URL —
 * so it cannot be side-stepped by URL encoding tricks, and any future route registered anywhere
 * under `/internal/` is guarded without its author remembering to opt in. `onRequest` is the
 * earliest lifecycle hook (before body parsing), and `@fastify/websocket` pushes upgrade requests
 * through the same hook chain, so a rejected WebSocket upgrade gets the 401 written over the raw
 * socket and never reaches the route's connection handler (no `hello` is ever read).
 *
 * Three independent checks, evaluated in order, every one of which rejects with the same
 * 401 `{ok:false, error:{code:'unauthorized', message:'unauthorized'}}` body and a structured
 * `warn` log line carrying the route, method, peer address and a `reason` — never the presented
 * or expected token:
 *   1. a token must be configured at all (an instance built without `InternalPlaneAuthConfig` is
 *      fail-*closed*: the plane rejects everything, it never falls back to "open");
 *   2. `Authorization: Bearer <token>` must be present and equal to the configured token,
 *      compared with `crypto.timingSafeEqual` on equal-length buffers (an unequal length is a
 *      plain mismatch);
 *   3. when `workersSubnet` (`NEXTTIME_SUBNET_WORKERS`) is configured, the TCP peer must be
 *      outside it — a Worker container must never hold this token, so a correct token arriving
 *      from that subnet is treated as a leaked token, not as a client. The peer is the socket's
 *      own `remoteAddress`, never an `X-Forwarded-For`-style header (the kernel sits behind no
 *      proxy on these networks; a header would be attacker-controlled).
 *
 * `/api/cap/*`, `/api/health` and `/ws` are outside the prefix and untouched by this hook.
 */

/** Every route whose pattern starts with this is part of the internal plane. */
export const INTERNAL_PLANE_ROUTE_PREFIX = '/internal/' as const;

export interface InternalPlaneAuthConfig {
  /** The shared secret (`@nexttime/shared` `normalizeInternalToken`'s output — `loadInternalToken`
   *  below in production, any ≥ 1-character string in tests). */
  readonly token: string;
  /** `NEXTTIME_SUBNET_WORKERS` as a CIDR string; peers inside it are rejected even with a valid
   *  token. Omit (or pass `undefined`) to skip the peer check. */
  readonly workersSubnet?: string;
}

/** Why a request was rejected — the `reason` field of the guard's `warn` log line. */
export type InternalPlaneRejectReason =
  | 'no_token_configured'
  | 'missing_token'
  | 'invalid_token'
  | 'workers_subnet_peer';

const UNAUTHORIZED_BODY = {
  ok: false,
  error: { code: 'unauthorized', message: 'unauthorized' },
} as const;

/**
 * Reads the token file named by `NEXTTIME_INTERNAL_TOKEN_FILE` (default
 * `/run/secrets/internal_token`, the compose secret `internal_token` backed by
 * `${NEXTTIME_DATA}/secrets/internal.token`) and returns the normalized token. Synchronous on
 * purpose: `main()` calls it before opening the DB pool or binding a port, in the same fail-fast
 * slot as `resolveAgentRuntimeKind()`, and an unreadable / empty / too-short file is a startup
 * failure with a message that names the path and the env var — never the contents.
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
      'the kernel refuses to start without it: generate it with scripts/gen-handle-keys.sh and mount it as the compose secret internal_token';
    throw new InternalTokenError(
      `cannot read the internal-plane token file "${file}" (${INTERNAL_TOKEN_FILE_ENV}; ${code}) — ${hint}`,
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
  /** `undefined` = allow; otherwise the reason the request must be rejected. Exposed for tests
   *  and for any future non-Fastify transport that needs the identical decision. */
  evaluate(request: FastifyRequest): InternalPlaneRejectReason | undefined;
}

export function createInternalPlaneGuard(
  config: InternalPlaneAuthConfig | undefined,
): InternalPlaneGuard {
  const expected = config ? Buffer.from(config.token, 'utf8') : undefined;
  const inWorkersSubnet: SubnetMatcher | undefined = config?.workersSubnet
    ? createSubnetMatcher(config.workersSubnet)
    : undefined;

  return {
    evaluate(request) {
      if (!expected) return 'no_token_configured';
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined) return 'missing_token';
      if (!tokenMatches(presented, expected)) return 'invalid_token';
      if (inWorkersSubnet) {
        const peer = peerAddress(request);
        if (peer !== undefined && inWorkersSubnet(peer)) return 'workers_subnet_peer';
      }
      return undefined;
    },
  };
}

/**
 * Installs the guard as a root-level `onRequest` hook on `app`. Call once per Fastify instance,
 * from the composition root (`packages/kernel/src/index.ts` `createServer`), before or after the
 * internal routes are registered — Fastify resolves every route's hook chain at `preReady`, so
 * ordering does not matter, but `createServer` registers it first for readability. Passing
 * `undefined` installs a fail-closed guard (every internal request → 401
 * `no_token_configured`) and logs one `warn` at registration so a misconfigured process is
 * visible in its first log lines, not only through its clients' failures.
 */
export function registerInternalPlaneGuard(
  app: FastifyInstance,
  config: InternalPlaneAuthConfig | undefined,
): void {
  const guard = createInternalPlaneGuard(config);
  if (!config) {
    app.log.warn(
      'internal plane: no shared-secret token configured — every /internal/* request will be rejected (fail-closed)',
    );
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions.url;
    if (typeof route !== 'string' || !route.startsWith(INTERNAL_PLANE_ROUTE_PREFIX)) return;

    const reason = guard.evaluate(request);
    if (reason === undefined) return;

    const upgrade = isUpgradeRequest(request);
    request.log.warn(
      {
        route,
        method: request.method,
        peer: peerAddress(request),
        upgrade,
        reason,
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
