/**
 * internal-auth: gates every route but `GET /healthz` behind the same internal-plane credential
 * contract the kernel enforces for its own `/internal/*` plane
 * (`packages/kernel/src/interfaces/internal-auth/internal-auth.ts`) and `@nexttime/shared`'s
 * `internal-token.ts` defines. Lane-6 review P1-3: this service is `control`-network only
 * (docker-compose.yml — unlike the kernel/llm-proxy/egress-proxy, it is never on `workers`, so no
 * agent container can reach it directly), but *any other* `control`-network peer could — before
 * this fix — call `POST /task/spawn` or `POST /resident/spawn` unauthenticated: spawn arbitrary
 * containers, or (combined with the P1-3 `skills[]` host-path removal in `config.ts`) mount an
 * arbitrary host path read-only into one. "Trusted-caller, no separate auth" was never actually
 * enforced by anything other than every other `control`-network service choosing not to call
 * these routes.
 *
 * Per-caller credentials (R-03, 2026-10-02 review). This service has exactly two callers, and
 * holds exactly their two credentials for it — never the internal-plane root, never a credential
 * that opens anything on the kernel:
 *   - the kernel (`task/service.ts`, purge's reclaim, `runtime_inventory`; and the acceptance /
 *     ops scripts that run in a kernel container) — `loadInternalToken`, the compose secret
 *     `internal_kernel_to_worker_supervisor` at `/run/secrets/internal_token`;
 *   - agent-host (`supervisor-client.ts`: the resident entry containers) — `loadAgentHostToken`,
 *     `internal_agent_host_to_worker_supervisor` at `/run/secrets/internal_token_agent_host`.
 * `requireInternalCaller` identifies the caller by which credential the bearer matches and admits
 * it only on the routes `server.ts` lists for it — so a compromised agent-host still cannot
 * `/task/spawn`, `/resident/reclaim` (which deletes a user's workspace data) or read the
 * inventories, and a token from any other service matches neither.
 *
 * `loadInternalToken` mirrors `packages/agent-host/src/index.ts`'s own function of the same name
 * (deliberately duplicated, not imported — `@nexttime/shared`'s `internal-token.ts` is IO-free by
 * design, see that module's own doc comment; every internal-plane process reads the file itself).
 * `requireInternalCaller` mirrors the kernel's own `createInternalPlaneGuard` decision logic
 * (`Authorization: Bearer <token>`, constant-time compare, per-route caller allow-list) as a plain
 * Fastify `preHandler` rather than a route-prefix `onRequest` hook — this package's guarded routes
 * are not all under one path prefix the way the kernel's `/internal/*` routes are, so `server.ts`
 * attaches a guard to each one explicitly, naming its callers.
 *
 * Fail-closed: a caller whose token is `undefined` (no file configured) matches nothing, so with
 * neither configured every guarded request is rejected — same as the kernel's guard when it
 * starts without a configured root. Every route is guarded except `GET /healthz`: `server.ts`
 * registers an `onRoute` hook (`isInternalCallerGuard`) that refuses any other route without a
 * guard, so a new route cannot ship open (R-03 review: `POST /task/:workerRunId/terminate` and
 * `GET /task/:workerRunId` used to be left open, letting any `control`-network peer kill any Task
 * container).
 */

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  INTERNAL_TOKEN_FILE_ENV,
  InternalTokenError,
  normalizeInternalToken,
  resolveInternalTokenFile,
} from '@nexttime/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Env var naming the file agent-host's credential for this service is read from. */
export const AGENT_HOST_TOKEN_FILE_ENV = 'NEXTTIME_AGENT_HOST_TOKEN_FILE' as const;

/** Where compose mounts `internal_agent_host_to_worker_supervisor` in this container. */
export const DEFAULT_AGENT_HOST_TOKEN_FILE = '/run/secrets/internal_token_agent_host' as const;

/** The two services that call this one — see this module's doc comment. */
export type SupervisorCaller = 'kernel' | 'agent-host';

/** Each caller's credential for this service; an absent one matches nothing (fail-closed). */
export type SupervisorCallerTokens = Readonly<Partial<Record<SupervisorCaller, string>>>;

function readTokenFile(file: string, envVar: string, secret: string): string {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
    throw new InternalTokenError(
      `cannot read the internal-plane token file "${file}" (${envVar}; ${code}) — worker-supervisor refuses to start without it: derive it with scripts/gen-handle-keys.sh and mount it as the compose secret ${secret}`,
    );
  }
  return normalizeInternalToken(raw, file);
}

/**
 * Reads the kernel's credential for this service (`NEXTTIME_INTERNAL_TOKEN_FILE`, default
 * `/run/secrets/internal_token` — the compose secret `internal_kernel_to_worker_supervisor`).
 * Synchronous so `main()` can fail fast, before opening the Docker socket or binding a port: this
 * process refuses to start without it (see this module's own doc comment for why `POST
 * /task/spawn` and `/resident/*` cannot be left open).
 */
export function loadInternalToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return readTokenFile(
    resolveInternalTokenFile(env),
    INTERNAL_TOKEN_FILE_ENV,
    'internal_kernel_to_worker_supervisor',
  );
}

/** Reads agent-host's credential for this service (`NEXTTIME_AGENT_HOST_TOKEN_FILE`, default
 *  `/run/secrets/internal_token_agent_host`). Same fail-fast contract as `loadInternalToken`. */
export function loadAgentHostToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[AGENT_HOST_TOKEN_FILE_ENV];
  const file = configured && configured.length > 0 ? configured : DEFAULT_AGENT_HOST_TOKEN_FILE;
  return readTokenFile(file, AGENT_HOST_TOKEN_FILE_ENV, 'internal_agent_host_to_worker_supervisor');
}

/** `Authorization: Bearer <token>` → `<token>`; anything else → `undefined`. Scheme matched case-
 *  insensitively per RFC 9110, same as the kernel's own `internal-auth.ts`. */
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

const UNAUTHORIZED_BODY = { error: { code: 'unauthorized', message: 'unauthorized' } } as const;

/** Every function `requireInternalCaller` has built — what `isInternalCallerGuard` checks. */
const callerGuards = new WeakSet<object>();

/** Whether `handler` is a guard `requireInternalCaller` built — `server.ts`'s `onRoute` check that
 *  every non-public route carries one. */
export function isInternalCallerGuard(handler: unknown): boolean {
  return typeof handler === 'function' && callerGuards.has(handler);
}

/**
 * Builds a Fastify `preHandler` that requires `Authorization: Bearer <token>` matching the
 * credential of one of `allowed` (from `tokens`). Every rejection — no header, no match, or a
 * valid credential of a caller this route does not admit — is the same 401. Attach the returned
 * function as the `preHandler` option on each guarded route in `server.ts` (Fastify runs
 * `preHandler` after body parsing but before the route handler, so a rejected request never
 * reaches business logic or the docker client).
 */
export function requireInternalCaller(
  tokens: SupervisorCallerTokens,
  allowed: readonly SupervisorCaller[],
) {
  const expected = allowed.flatMap((caller) => {
    const token = tokens[caller];
    return token !== undefined ? [Buffer.from(token, 'utf8')] : [];
  });
  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const presented = bearerToken(request.headers.authorization);
    let ok = false;
    if (presented !== undefined) {
      for (const candidate of expected) {
        if (tokenMatches(presented, candidate)) ok = true;
      }
    }
    if (ok) return;
    reply.code(401);
    reply.header('www-authenticate', 'Bearer');
    await reply.send(UNAUTHORIZED_BODY);
  };
  callerGuards.add(guard);
  return guard;
}
