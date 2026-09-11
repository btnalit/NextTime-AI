import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CryptoKey } from 'jose';
import { z } from 'zod';
import type { ResolveCallerDeps } from '../../application/gateway/index.js';
import {
  UnauthorizedError,
  hashApiKey,
  loadHandlePrivateKeyFor,
  lookupPrincipalByApiKeyHash,
  resolveCaller,
  resolveConsoleUser,
} from '../../application/gateway/index.js';
import type { MembershipRow, UserRow } from '../../application/identity/index.js';
import {
  CONSOLE_SESSION_TTL_SECONDS,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  IdentityError,
  bindPrincipalToUser,
  changeOwnPassword,
  checkPassword,
  claimIdentity,
  clearConsoleSessionCookie,
  createUserSession,
  findUserById,
  listActiveMemberships,
  mintConsoleSessionToken,
  revokeUserSession,
  serializeConsoleSessionCookie,
  updateUserDisplayName,
} from '../../application/identity/index.js';

/**
 * interfaces/http/auth-routes: the console login surface (S4.1; design doc §7.11 "登录"). The
 * first administrator is pre-created by the kernel (identity/setup.ts) — there is no setup route.
 * Cookie-only except `claim` (which is *how* a key-only member gets a cookie) — and none of these
 * routes touch a workspace: a user logs in *before* choosing one (`X-Workspace-Id` on the
 * capability calls that follow, `interfaces/http/capability-route.ts`).
 *
 *   POST /api/auth/bind-api-key      cookie + {apiKey} → the key's Principal (workspace membership)
 *                                    now belongs to the calling user; {user, memberships}. How the
 *                                    pre-created `admin` (identity/setup.ts) — or anyone who logs
 *                                    in with a password — picks up the workspaces they already
 *                                    had under pre-S4.1 API keys. Once per key.
 *   POST /api/auth/claim             Authorization: Bearer <API key> + {login, displayName,
 *                                    password} → the key's passwordless user becomes login-able
 *                                    and the browser gets a console session (self-service
 *                                    migration for a member who has only a key; once only)
 *   POST /api/auth/login             {login, password} → cookie + {user, memberships}
 *   POST /api/auth/logout            revoke the cookie's user_sessions row, clear the cookie
 *   GET  /api/auth/me                {user, memberships}
 *   PATCH /api/auth/me               {displayName}
 *   POST /api/auth/password          {currentPassword, newPassword} → clears must_change_password
 *
 * Envelope: the same `{ok:true,result}` / `{ok:false,error:{code,message}}` shape as
 * `/api/cap/*` (packages/shared/src/http.ts), so the web client parses one shape. Every
 * state-changing route requires `X-Requested-With: nexttime` (§7.11 CSRF) — including login and
 * setup, so a cross-site form cannot log the browser into an attacker's account either.
 * `Cache-Control: no-store` on everything that carries a user.
 */

export type AuthRouteDeps = ResolveCallerDeps;

const LoginBody = z.object({ login: z.string().min(1), password: z.string().min(1) }).strict();
const BindBody = z.object({ apiKey: z.string().min(1) }).strict();
const ClaimBody = z
  .object({ login: z.string().min(1), displayName: z.string().min(1), password: z.string().min(1) })
  .strict();
const PasswordBody = z
  .object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) })
  .strict();
const ProfileBody = z.object({ displayName: z.string().min(1) }).strict();

interface WireUser {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly platformRole: 'admin' | 'user';
  readonly mustChangePassword: boolean;
}

interface WireMembership {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly principalId: string;
  readonly role: string;
}

function toWireUser(user: UserRow): WireUser {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    platformRole: user.platformRole,
    mustChangePassword: user.mustChangePassword,
  };
}

function toWireMembership(m: MembershipRow): WireMembership {
  return {
    workspaceId: m.workspaceId,
    workspaceName: m.workspaceName,
    principalId: m.principalId,
    role: m.role,
  };
}

type Envelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

function fail(reply: FastifyReply, status: number, code: string, message: string): Envelope {
  reply.code(status);
  return { ok: false, error: { code, message } };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasCsrfHeader(request: FastifyRequest): boolean {
  return firstHeader(request.headers[CSRF_HEADER]) === CSRF_HEADER_VALUE;
}

/** Maps the identity module's typed errors; anything else is a 500 with no detail leaked. */
function mapAuthError(request: FastifyRequest, reply: FastifyReply, err: unknown): Envelope {
  if (err instanceof UnauthorizedError) return fail(reply, 401, 'unauthorized', 'unauthorized');
  if (err instanceof IdentityError) {
    switch (err.kind) {
      case 'login_taken':
        return fail(reply, 409, err.kind, err.message);
      case 'user_not_found':
        return fail(reply, 404, err.kind, err.message);
      case 'invalid_api_key':
        return fail(reply, 401, err.kind, err.message);
      case 'already_claimed':
      case 'already_member':
      case 'last_admin':
        return fail(reply, 409, err.kind, err.message);
      default:
        return fail(reply, 400, err.kind, err.message);
    }
  }
  request.log.error({
    route: request.routeOptions.url,
    errorName: err instanceof Error ? err.name : typeof err,
  });
  return fail(reply, 500, 'internal_error', 'internal error');
}

/** Mints the cookie for a fresh `user_sessions` row and installs it on `reply`. */
async function installSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AuthRouteDeps,
  privateKey: CryptoKey,
  user: UserRow,
): Promise<Envelope> {
  const session = await createUserSession(deps.pool, user.id, {
    userAgent: firstHeader(request.headers['user-agent']),
  });
  const minted = await mintConsoleSessionToken({
    privateKey,
    userId: user.id,
    sessionId: session.id,
  });
  reply.header(
    'Set-Cookie',
    serializeConsoleSessionCookie(minted.token, CONSOLE_SESSION_TTL_SECONDS),
  );
  const memberships = await listActiveMemberships(deps.pool, user.id);
  return {
    ok: true,
    result: {
      user: toWireUser(user),
      memberships: memberships.map(toWireMembership),
      expiresAt: minted.expiresAt.toISOString(),
    },
  };
}

async function signingKeyOr503(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AuthRouteDeps,
): Promise<CryptoKey | Envelope> {
  try {
    return await loadHandlePrivateKeyFor(deps);
  } catch (err) {
    request.log.error({
      route: request.routeOptions.url,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return fail(
      reply,
      503,
      'sessions_unavailable',
      'console sessions are not configured on this kernel',
    );
  }
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/auth/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.post('/api/auth/bind-api-key', async (request, reply): Promise<Envelope> => {
    if (!hasCsrfHeader(request)) {
      return fail(
        reply,
        403,
        'csrf_header_required',
        `send X-Requested-With: ${CSRF_HEADER_VALUE}`,
      );
    }
    const body = BindBody.safeParse(request.body ?? {});
    if (!body.success) return fail(reply, 400, 'invalid_params', 'apiKey is required');
    try {
      const consoleUser = await resolveConsoleUser(request.headers.cookie, deps);
      const principal = await lookupPrincipalByApiKeyHash(deps.pool, hashApiKey(body.data.apiKey));
      if (!principal || principal.kind !== 'human') {
        return fail(reply, 401, 'invalid_api_key', 'that API key does not belong to a person');
      }
      await bindPrincipalToUser(deps.pool, {
        userId: consoleUser.id,
        workspaceId: principal.workspaceId,
        principalId: principal.id,
      });
      const user = await findUserById(deps.pool, consoleUser.id);
      if (!user) return fail(reply, 401, 'unauthorized', 'unauthorized');
      const memberships = await listActiveMemberships(deps.pool, user.id);
      return {
        ok: true,
        result: { user: toWireUser(user), memberships: memberships.map(toWireMembership) },
      };
    } catch (err) {
      return mapAuthError(request, reply, err);
    }
  });

  app.post('/api/auth/claim', async (request, reply): Promise<Envelope> => {
    if (!hasCsrfHeader(request)) {
      return fail(
        reply,
        403,
        'csrf_header_required',
        `send X-Requested-With: ${CSRF_HEADER_VALUE}`,
      );
    }
    const body = ClaimBody.safeParse(request.body ?? {});
    if (!body.success)
      return fail(reply, 400, 'invalid_params', 'login, displayName and password are required');
    // The API key *is* the proof of identity here — never the cookie (a cookie user already has
    // a password and nothing to claim).
    let caller: Awaited<ReturnType<typeof resolveCaller>>;
    try {
      caller = await resolveCaller(request.headers.authorization, deps);
    } catch {
      return fail(reply, 401, 'unauthorized', 'send your API key as Authorization: Bearer');
    }
    if (caller.channel !== 'human') {
      return fail(reply, 401, 'unauthorized', 'a Handle cannot claim an identity');
    }
    const key = await signingKeyOr503(request, reply, deps);
    if (isEnvelope(key)) return key;
    try {
      const user = await claimIdentity(deps.pool, {
        workspaceId: caller.principal.workspaceId,
        principalId: caller.principal.id,
        ...body.data,
      });
      return await installSession(request, reply, deps, key, user);
    } catch (err) {
      return mapAuthError(request, reply, err);
    }
  });

  app.post('/api/auth/login', async (request, reply): Promise<Envelope> => {
    if (!hasCsrfHeader(request)) {
      return fail(
        reply,
        403,
        'csrf_header_required',
        `send X-Requested-With: ${CSRF_HEADER_VALUE}`,
      );
    }
    const body = LoginBody.safeParse(request.body ?? {});
    if (!body.success) return fail(reply, 400, 'invalid_params', 'login and password are required');
    const key = await signingKeyOr503(request, reply, deps);
    if (isEnvelope(key)) return key;
    try {
      const check = await checkPassword(deps.pool, body.data.login, body.data.password);
      if (!check.ok) {
        // One message for "no such login" and "wrong password" (the throttle counts both); the
        // lock and the disabled state are distinguishable because the user already knows the
        // login exists once they have a password for it.
        if (check.reason === 'locked') {
          return fail(reply, 423, 'locked', 'too many failed attempts; try again in a few minutes');
        }
        if (check.reason === 'disabled') {
          return fail(reply, 403, 'disabled', 'this account is disabled');
        }
        return fail(reply, 401, 'bad_credentials', 'login or password is incorrect');
      }
      return await installSession(request, reply, deps, key, check.user);
    } catch (err) {
      return mapAuthError(request, reply, err);
    }
  });

  app.post('/api/auth/logout', async (request, reply): Promise<Envelope> => {
    if (!hasCsrfHeader(request)) {
      return fail(
        reply,
        403,
        'csrf_header_required',
        `send X-Requested-With: ${CSRF_HEADER_VALUE}`,
      );
    }
    // Idempotent: an expired or already-revoked cookie still gets cleared from the browser.
    try {
      const user = await resolveConsoleUser(request.headers.cookie, deps);
      await revokeUserSession(deps.pool, user.consoleSessionId);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) return mapAuthError(request, reply, err);
    }
    reply.header('Set-Cookie', clearConsoleSessionCookie());
    return { ok: true, result: { loggedOut: true } };
  });

  app.get('/api/auth/me', async (request, reply): Promise<Envelope> => {
    try {
      const consoleUser = await resolveConsoleUser(request.headers.cookie, deps);
      const user = await findUserById(deps.pool, consoleUser.id);
      if (!user) return fail(reply, 401, 'unauthorized', 'unauthorized');
      const memberships = await listActiveMemberships(deps.pool, user.id);
      return {
        ok: true,
        result: { user: toWireUser(user), memberships: memberships.map(toWireMembership) },
      };
    } catch (err) {
      return mapAuthError(request, reply, err);
    }
  });

  app.patch('/api/auth/me', async (request, reply): Promise<Envelope> => {
    if (!hasCsrfHeader(request)) {
      return fail(
        reply,
        403,
        'csrf_header_required',
        `send X-Requested-With: ${CSRF_HEADER_VALUE}`,
      );
    }
    const body = ProfileBody.safeParse(request.body ?? {});
    if (!body.success) return fail(reply, 400, 'invalid_params', 'displayName is required');
    try {
      const consoleUser = await resolveConsoleUser(request.headers.cookie, deps);
      const user = await updateUserDisplayName(deps.pool, consoleUser.id, body.data.displayName);
      return { ok: true, result: { user: toWireUser(user) } };
    } catch (err) {
      return mapAuthError(request, reply, err);
    }
  });

  app.post('/api/auth/password', async (request, reply): Promise<Envelope> => {
    if (!hasCsrfHeader(request)) {
      return fail(
        reply,
        403,
        'csrf_header_required',
        `send X-Requested-With: ${CSRF_HEADER_VALUE}`,
      );
    }
    const body = PasswordBody.safeParse(request.body ?? {});
    if (!body.success) {
      return fail(reply, 400, 'invalid_params', 'currentPassword and newPassword are required');
    }
    try {
      const consoleUser = await resolveConsoleUser(request.headers.cookie, deps);
      const user = await changeOwnPassword(
        deps.pool,
        consoleUser.id,
        body.data.currentPassword,
        body.data.newPassword,
      );
      if (!user) return fail(reply, 401, 'bad_credentials', 'current password is incorrect');
      return { ok: true, result: { user: toWireUser(user) } };
    } catch (err) {
      return mapAuthError(request, reply, err);
    }
  });
}
