import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_GATE_TOKEN_FILE, GateTokenError, normalizeGateToken } from './gate-token.js';

/**
 * gate-auth: the guard installed in front of every `/gate/*` route (review lane 5, P1-1). Mirrors
 * the kernel's own `interfaces/internal-auth/internal-auth.ts` in mechanism — a root-level Fastify
 * `onRequest` hook keyed on the *matched route pattern* (`request.routeOptions.url`) so a route
 * added anywhere under `/gate/` in the future is covered without its author remembering to opt
 * in — but simpler: one shared secret, no subnet check (a gate has no dual-homed-listener trust
 * boundary to defend beyond the token itself), no WebSocket upgrade path.
 *
 * `createGatekeeperServer` (`server.ts`) always installs this hook — a gate built without a token
 * fails at `loadGateKernelToken` (below), so there is no "gate constructed with auth disabled"
 * mode to accidentally leave open.
 */

export const GATE_KERNEL_TOKEN_FILE_ENV = 'GATE_KERNEL_TOKEN_FILE';

/** The token file path for `env`: `GATE_KERNEL_TOKEN_FILE_ENV` when set and non-empty, else
 *  `DEFAULT_GATE_TOKEN_FILE`. */
export function resolveGateKernelTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[GATE_KERNEL_TOKEN_FILE_ENV];
  return configured && configured.length > 0 ? configured : DEFAULT_GATE_TOKEN_FILE;
}

/**
 * Reads and validates the gate's own auth token. Synchronous and called before the transport/
 * credential resolver/idempotency store are constructed (`index.ts`'s `startGatekeeperServer`,
 * `gatekeepers/docker`'s `buildDockerGate`, `gatekeepers/ragflow`'s `buildRagflowGate`) — an
 * unreadable, empty, or too-short file is a fatal startup error naming the path and env var, never
 * the token's contents: this gate refuses to start without it rather than come up silently open.
 */
export function loadGateKernelToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = resolveGateKernelTokenFile(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
    throw new GateTokenError(
      `cannot read the gate auth token file "${file}" (${GATE_KERNEL_TOKEN_FILE_ENV}; ${code}) — this gate refuses to start without it: generate it with scripts/gen-handle-keys.sh and mount it as the compose secret gate_token`,
    );
  }
  return normalizeGateToken(raw, file);
}

/** `Authorization: Bearer <token>` → `<token>`; anything else → `undefined`. Scheme matched
 *  case-insensitively per RFC 9110. */
function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const space = header.indexOf(' ');
  if (space === -1) return undefined;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return undefined;
  const token = header.slice(space + 1).trim();
  return token.length > 0 ? token : undefined;
}

/** Constant-time equality over equal-length UTF-8 buffers; an unequal length is a plain mismatch
 *  (never compared byte-by-byte, so its own timing leaks nothing beyond "wrong length"). */
function tokenMatches(presented: string, expected: Buffer): boolean {
  const presentedBuffer = Buffer.from(presented, 'utf8');
  if (presentedBuffer.length !== expected.length) return false;
  return timingSafeEqual(presentedBuffer, expected);
}

const UNAUTHORIZED_BODY = {
  ok: false,
  error: { code: 'unauthorized', message: 'unauthorized' },
} as const;

export interface GateAuthGuard {
  /** `true` = allow. Exposed for tests. */
  evaluate(request: FastifyRequest): boolean;
}

export function createGateAuthGuard(token: string): GateAuthGuard {
  const expected = Buffer.from(token, 'utf8');
  return {
    evaluate(request) {
      const presented = bearerToken(request.headers.authorization);
      return presented !== undefined && tokenMatches(presented, expected);
    },
  };
}

/**
 * Installs the guard as a root-level `onRequest` hook on `app`, covering every route whose
 * matched pattern starts with `/gate/`. The 401 body matches this package's own envelope
 * (`server.ts`'s `{ok:false,error:{code,message}}`) and never echoes the presented or expected
 * token — not in the body, not in a log line (this module logs nothing at all).
 */
export function registerGateAuthGuard(app: FastifyInstance, token: string): void {
  const guard = createGateAuthGuard(token);
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions.url;
    if (typeof route !== 'string' || !route.startsWith('/gate/')) return;
    if (guard.evaluate(request)) return;
    reply.code(401);
    reply.header('www-authenticate', 'Bearer');
    return reply.send(UNAUTHORIZED_BODY);
  });
}
