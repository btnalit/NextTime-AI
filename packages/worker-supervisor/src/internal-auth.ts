/**
 * internal-auth: gates `POST /task/spawn` and every `/resident/*` route behind the same internal-
 * plane shared-secret contract the kernel enforces for its own `/internal/*` plane
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
 * `loadInternalToken` mirrors `packages/agent-host/src/index.ts`'s own function of the same name
 * (deliberately duplicated, not imported — `@nexttime/shared`'s `internal-token.ts` is IO-free by
 * design, see that module's own doc comment; every internal-plane process reads the file itself).
 * `requireInternalToken` mirrors the kernel's own `createInternalPlaneGuard` decision logic
 * (`Authorization: Bearer <token>`, constant-time compare) as a plain Fastify `preHandler` rather
 * than a route-prefix `onRequest` hook — this package's guarded routes (`POST /task/spawn`, the
 * four `/resident/*` routes) are not all under one path prefix the way the kernel's `/internal/*`
 * routes are, so `server.ts` attaches the same guard function to each one explicitly.
 *
 * Fail-closed: `token === undefined` (no internal-plane token file configured) rejects every
 * guarded request — same as the kernel's guard when it starts without a configured token. `POST
 * /task/:workerRunId/terminate`, `GET /task/:workerRunId`, and `GET /healthz` are intentionally
 * left unguarded (not named in the P1-3 fix), matching the review's own scoping.
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

/**
 * Reads the internal-plane token file (`NEXTTIME_INTERNAL_TOKEN_FILE`, default
 * `/run/secrets/internal_token` — the compose secret `internal_token`). Synchronous so `main()`
 * can fail fast, before opening the Docker socket or binding a port: this process refuses to
 * start without it (see this module's own doc comment for why `POST /task/spawn` and
 * `/resident/*` cannot be left open).
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
    throw new InternalTokenError(
      `cannot read the internal-plane token file "${file}" (${INTERNAL_TOKEN_FILE_ENV}; ${code}) — worker-supervisor refuses to start without it: generate it with scripts/gen-handle-keys.sh and mount it as the compose secret internal_token`,
    );
  }
  return normalizeInternalToken(raw, file);
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

/**
 * Builds a Fastify `preHandler` that requires `Authorization: Bearer <token>` matching `token`.
 * `token === undefined` yields a guard that rejects every request it is attached to — fail-closed,
 * matching the kernel's own guard when it starts without a configured token (this module's own doc
 * comment). Attach the returned function as the `preHandler` option on each guarded route in
 * `server.ts` (Fastify runs `preHandler` after body parsing but before the route handler, so a
 * rejected request never reaches business logic or the docker client).
 */
export function requireInternalToken(token: string | undefined) {
  const expected = token !== undefined ? Buffer.from(token, 'utf8') : undefined;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const presented = bearerToken(request.headers.authorization);
    const ok =
      expected !== undefined && presented !== undefined && tokenMatches(presented, expected);
    if (ok) return;
    reply.code(401);
    reply.header('www-authenticate', 'Bearer');
    await reply.send(UNAUTHORIZED_BODY);
  };
}
