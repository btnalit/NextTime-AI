/**
 * Console session (S4.1, design doc §7.11 "登录"): the cookie a browser holds after
 * `POST /api/auth/login`. Same mechanism as the W7 Explorer session cookie
 * (interfaces/explorer-contract/session.ts): an EdDSA JWT signed with the kernel's Handle key
 * pair under its own `typ`, so a console session, an Explorer session and a Handle can never be
 * mistaken for one another even though one key signs all three. Differences from the Explorer
 * cookie: it names a *user* (`uid`) and a `user_sessions` row (`sid`), not a workspace principal —
 * the workspace is chosen per request (`X-Workspace-Id` / WS `authenticate {workspaceId}`) — and
 * it is scoped to `Path=/` so the WebSocket upgrade on `/ws` carries it too.
 *
 * The cookie is a bearer of identity, not of state: every request re-reads the `user_sessions`
 * row (not revoked, not expired) and the user (active) — `lookupConsoleSessionUser` below — the
 * same way the API-key path re-reads `principals` on every call.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { CryptoKey } from 'jose';
import { z } from 'zod';
import type { PoolLike } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { type UserRow, findUserById } from './users.js';

export const CONSOLE_SESSION_COOKIE = 'nexttime_console_session';
export const CONSOLE_SESSION_TYP = 'nexttime-console-session+jwt';
export const CONSOLE_SESSION_TTL_SECONDS = 8 * 60 * 60;

/** Browsers cannot send this header cross-site from a form or a plain navigation; requiring it
 *  on every cookie-authenticated state change is the CSRF backstop behind `SameSite=Strict`. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'nexttime';

/** The workspace a cookie-authenticated request acts in (§7.11 "工作区上下文按请求给"). The web
 *  console sends the header on every capability call; the Explorer bundle (an unmodified third-
 *  party UI that cannot add headers) is covered by the selector cookie below, which the console
 *  sets (plain, not HttpOnly — it is a *selector*, never a credential: membership is still checked
 *  on every request) whenever the user switches workspace. */
export const WORKSPACE_HEADER = 'x-workspace-id';
export const WORKSPACE_COOKIE = 'nexttime_workspace';

const uuidClaim = z.string().uuid();

export const ConsoleSessionClaimsSchema = z
  .object({
    uid: uuidClaim,
    sid: uuidClaim,
    iat: z.number(),
    exp: z.number(),
  })
  .strict();
export type ConsoleSessionClaims = z.infer<typeof ConsoleSessionClaimsSchema>;

export class ConsoleSessionInvalid extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConsoleSessionInvalid';
  }
}

export async function mintConsoleSessionToken(params: {
  readonly privateKey: CryptoKey;
  readonly userId: string;
  readonly sessionId: string;
  readonly ttlSeconds?: number;
  readonly nowMs?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const exp = iat + (params.ttlSeconds ?? CONSOLE_SESSION_TTL_SECONDS);
  const claims: ConsoleSessionClaims = { uid: params.userId, sid: params.sessionId, iat, exp };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: HANDLE_SIGNING_ALG, typ: CONSOLE_SESSION_TYP })
    .sign(params.privateKey);
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyConsoleSessionToken(
  token: string,
  publicKey: CryptoKey,
): Promise<ConsoleSessionClaims> {
  let payload: unknown;
  try {
    const verified = await jwtVerify(token, publicKey, {
      algorithms: [HANDLE_SIGNING_ALG],
      typ: CONSOLE_SESSION_TYP,
    });
    payload = verified.payload;
  } catch (err) {
    throw new ConsoleSessionInvalid('console session token failed verification', { cause: err });
  }
  const parsed = ConsoleSessionClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ConsoleSessionInvalid('console session token has an unexpected claims shape', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

export function serializeConsoleSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${CONSOLE_SESSION_COOKIE}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; ${COOKIE_ATTRIBUTES}`;
}

export function clearConsoleSessionCookie(): string {
  return `${CONSOLE_SESSION_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/** Same minimal RFC 6265 parser as the Explorer module (a `Map`, never an object keyed by
 *  attacker-chosen names). Duplicated rather than imported so `application/` does not depend on
 *  `interfaces/` (layering, §7.10). */
export function parseCookieHeader(header: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export function extractConsoleSessionToken(cookieHeader: string | undefined): string | undefined {
  const value = parseCookieHeader(cookieHeader).get(CONSOLE_SESSION_COOKIE);
  return value ? value : undefined;
}

// --- user_sessions rows --------------------------------------------------------------------

export interface UserSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export async function createUserSession(
  pool: PoolLike,
  userId: string,
  options: { readonly ttlSeconds?: number; readonly userAgent?: string } = {},
): Promise<UserSessionRow> {
  const ttl = options.ttlSeconds ?? CONSOLE_SESSION_TTL_SECONDS;
  return withAdminClient(pool, async (client) => {
    const result = await client.query<{
      id: string;
      user_id: string;
      created_at: Date;
      expires_at: Date;
    }>(
      `insert into user_sessions (user_id, expires_at, user_agent)
       values ($1, now() + make_interval(secs => $2), $3)
       returning id, user_id, created_at, expires_at`,
      [userId, ttl, options.userAgent?.slice(0, 256) ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('createUserSession: INSERT ... RETURNING produced no row');
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  });
}

/** Re-validates a console session on every request: the row must exist, be unrevoked and
 *  unexpired, and the user must still be active. `null` = 401. */
export async function lookupConsoleSessionUser(
  pool: PoolLike,
  claims: { readonly uid: string; readonly sid: string },
): Promise<UserRow | null> {
  const live = await withAdminClient(pool, async (client) => {
    const result = await client.query(
      `select 1 from user_sessions
        where id = $1 and user_id = $2 and revoked_at is null and expires_at > now()`,
      [claims.sid, claims.uid],
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (!live) return null;
  const user = await findUserById(pool, claims.uid);
  if (!user || user.status !== 'active') return null;
  return user;
}

export async function revokeUserSession(pool: PoolLike, sessionId: string): Promise<void> {
  await withAdminClient(pool, (client) =>
    client.query(
      'update user_sessions set revoked_at = now() where id = $1 and revoked_at is null',
      [sessionId],
    ),
  );
}

export async function revokeAllUserSessions(pool: PoolLike, userId: string): Promise<number> {
  return withAdminClient(pool, async (client) => {
    const result = await client.query(
      'update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
      [userId],
    );
    return result.rowCount ?? 0;
  });
}
