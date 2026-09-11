import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CryptoKey } from 'jose';
import { z } from 'zod';
import type { ResolveCallerDeps } from '../../application/gateway/index.js';
import {
  UnauthorizedError,
  loadHandlePrivateKeyFor,
  resolveConsoleUser,
} from '../../application/gateway/index.js';
import type { MembershipRow, UserRow } from '../../application/identity/index.js';
import {
  CONSOLE_SESSION_TTL_SECONDS,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  IdentityError,
  SetupError,
  changeOwnPassword,
  checkPassword,
  clearConsoleSessionCookie,
  completeSetup,
  createUserSession,
  findUserById,
  getSetupState,
  listActiveMemberships,
  mintConsoleSessionToken,
  revokeUserSession,
  serializeConsoleSessionCookie,
  updateUserDisplayName,
} from '../../application/identity/index.js';

/**
 * interfaces/http/auth-routes: the console login surface (S4.1; design doc §7.11 "登录" and
 * "初始化：一次性令牌"). Cookie-only — none of these routes accept an API key or a Handle, and
 * none of them touch a workspace: a user logs in *before* choosing one (`X-Workspace-Id` on the
 * capability calls that follow, `interfaces/http/capability-route.ts`).
 *
 *   GET  /api/platform/setup-state   {initialized, tokenAvailable}            (no auth)
 *   POST /api/platform/setup         {token, login, displayName, password} → first admin + login
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
const SetupBody = z
  .object({
    token: z.string().min(1),
    login: z.string().min(1),
    displayName: z.string().min(1),
    password: z.string().min(1),
  })
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
      case 'last_admin':
        return fail(reply, 409, err.kind, err.message);
      default:
        return fail(reply, 400, err.kind, err.message);
    }
  }
  if (err instanceof SetupError) {
    switch (err.kind) {
      case 'already_initialized':
        return fail(reply, 409, err.kind, err.message);
      case 'token_exhausted':
        return fail(reply, 403, err.kind, err.message);
      default:
        return fail(reply, 401, err.kind, err.message);
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
    if (request.url.startsWith('/api/auth/') || request.url.startsWith('/api/platform/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.get('/api/platform/setup-state', async (_request, _reply): Promise<Envelope> => {
    const state = await getSetupState(deps.pool);
    return { ok: true, result: state };
  });

  app.post('/api/platform/setup', async (request, reply): Promise<Envelope> => {
    if (!hasCsrfHeader(request)) {
      return fail(
        reply,
        403,
        'csrf_header_required',
        `send X-Requested-With: ${CSRF_HEADER_VALUE}`,
      );
    }
    const body = SetupBody.safeParse(request.body ?? {});
    if (!body.success)
      return fail(
        reply,
        400,
        'invalid_params',
        'token, login, displayName and password are required',
      );
    const key = await signingKeyOr503(request, reply, deps);
    if (isEnvelope(key)) return key;
    try {
      const user = await completeSetup(deps.pool, body.data);
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
