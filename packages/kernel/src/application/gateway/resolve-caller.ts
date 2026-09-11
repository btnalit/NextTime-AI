import type { CryptoKey } from 'jose';
import type { PoolLike } from '../../adapters/db/pool.js';
import { loadHandleKeyPair } from '../../governance/capability/index.js';
import {
  CSRF_HEADER_VALUE,
  extractConsoleSessionToken,
  listActiveMemberships,
  lookupConsoleSessionUser,
  verifyConsoleSessionToken,
} from '../identity/index.js';
import { authenticateHuman, authenticateUserInWorkspace } from './auth.js';
import { ForbiddenError } from './authorize.js';
import type { ConsoleUser, ResolvedCaller } from './caller.js';
import { authenticateHandle } from './handle-auth.js';

/**
 * application/gateway/resolve-caller: the channel-detection seam (design doc §7.1 gateway "两类
 * 通道认证"; docs/development-tasks.md S1.3, item 2). One Bearer token, tried as an API key first
 * (human channel), then as a CapabilityHandle JWT (handle channel); neither → 401.
 *
 * S4.1 (design doc §7.11 "登录"): a third credential, the console session cookie
 * (`application/identity/console-session.ts`), resolves to the *same* human channel — cookie →
 * user → that user's membership Principal in the workspace the request names → its `web`
 * Session — so nothing downstream (authorize, dispatch, Handle issuance, audit) can tell a
 * password login from an API key. `resolveRequestCaller` is the entry that knows all three;
 * `resolveCaller` (Bearer only) is unchanged for every existing caller.
 */

export type { ConsoleUser, ResolvedCaller } from './caller.js';

/** Thrown by `resolveCaller` for a missing/malformed Authorization header, or a Bearer token that
 *  is neither a known API key nor a valid CapabilityHandle. Always maps to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnauthorizedError';
  }
}

export interface ResolveCallerDeps {
  readonly pool: PoolLike;
  /**
   * Loads the Handle-verification public key, lazily — only invoked when a Bearer token fails as
   * an API key, so a kernel with no Handle keys configured (e.g. local dev without S1.9 secrets)
   * still serves the human channel normally. Defaults to a cached call to
   * governance/capability/keys.ts's `loadHandleKeyPair()` (reads `HANDLE_PRIVATE_KEY_FILE` /
   * `HANDLE_PUBLIC_KEY_FILE` from `process.env`); injectable for tests (e.g. an ephemeral keypair).
   */
  readonly loadHandlePublicKey?: () => Promise<CryptoKey>;
  /**
   * S4.1: loads the Handle-signing *private* key the console session cookie is minted with
   * (`POST /api/auth/login`, `POST /api/platform/setup`). Same key pair as above, same lazy /
   * cached / injectable shape. When loading fails those two routes answer 503; every other
   * credential keeps working — the cookie path is additive.
   */
  readonly loadHandlePrivateKey?: () => Promise<CryptoKey>;
}

// Module-level cache for the default key loader — the production kernel signs/verifies with one
// persisted keypair for its whole lifetime (governance/capability/keys.ts's own doc comment: "a
// Handle issued before a restart still verifies afterward"), so there is no reason to re-read the
// PEM files on every request. Reset on failure so a later request can retry (e.g. secrets mounted
// after the first request arrives).
let cachedPublicKeyPromise: Promise<CryptoKey> | undefined;

/** The Handle-verification public key for `deps` — the injected loader when a test (or a caller
 *  with its own key source) supplies one, else the cached default above. Exported for
 *  interfaces/explorer-contract's cookie session (W7), which verifies its own token kind against
 *  the same key and must resolve it exactly the way `resolveCaller` does. */
export function loadHandlePublicKeyFor(deps: ResolveCallerDeps): Promise<CryptoKey> {
  return (deps.loadHandlePublicKey ?? defaultLoadHandlePublicKey)();
}

async function defaultLoadHandlePublicKey(): Promise<CryptoKey> {
  if (!cachedPublicKeyPromise) {
    cachedPublicKeyPromise = loadHandleKeyPair()
      .then((keyPair) => keyPair.publicKey)
      .catch((err: unknown) => {
        cachedPublicKeyPromise = undefined;
        throw err;
      });
  }
  return cachedPublicKeyPromise;
}

let cachedPrivateKeyPromise: Promise<CryptoKey> | undefined;

/** The Handle-signing private key for `deps` — injected loader or the cached default. */
export function loadHandlePrivateKeyFor(deps: ResolveCallerDeps): Promise<CryptoKey> {
  return (deps.loadHandlePrivateKey ?? defaultLoadHandlePrivateKey)();
}

async function defaultLoadHandlePrivateKey(): Promise<CryptoKey> {
  if (!cachedPrivateKeyPromise) {
    cachedPrivateKeyPromise = loadHandleKeyPair()
      .then((keyPair) => keyPair.privateKey)
      .catch((err: unknown) => {
        cachedPrivateKeyPromise = undefined;
        throw err;
      });
  }
  return cachedPrivateKeyPromise;
}

function parseBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new UnauthorizedError('missing Authorization header');
  }
  // A plain scheme check + slice, not `/^Bearer\s+(.+)$/i`: that regex is polynomial on a
  // header of the shape `Bearer` + many spaces (CodeQL js/polynomial-redos) — this is the one
  // header every unauthenticated client controls, so it must parse in linear time.
  const trimmed = authorizationHeader.trim();
  const scheme = trimmed.slice(0, 6);
  const separator = trimmed.charAt(6);
  if (scheme.toLowerCase() !== 'bearer' || !(separator === ' ' || separator === '\t')) {
    throw new UnauthorizedError('Authorization header must be "Bearer <token>"');
  }
  const token = trimmed.slice(7).trim();
  if (!token) {
    throw new UnauthorizedError('Authorization header must be "Bearer <token>"');
  }
  return token;
}

/**
 * Resolves the caller of one HTTP request from its raw `Authorization` header value. Tries the
 * human channel (API key) first, then the handle channel (CapabilityHandle JWT). Throws
 * `UnauthorizedError` if the header is missing/malformed or the token matches neither.
 */
export async function resolveCaller(
  authorizationHeader: string | undefined,
  deps: ResolveCallerDeps,
): Promise<ResolvedCaller> {
  const token = parseBearerToken(authorizationHeader);

  const human = await authenticateHuman(deps.pool, token);
  if (human) {
    return { channel: 'human', principal: human.principal, session: human.session };
  }

  try {
    const publicKey = await loadHandlePublicKeyFor(deps);
    const claims = await authenticateHandle(deps.pool, token, { publicKey });
    return { channel: 'handle', claims };
  } catch (err) {
    throw new UnauthorizedError('invalid credentials', { cause: err });
  }
}

// -------------------------------------------------------------------------------------------
// S4.1: the console-session channel
// -------------------------------------------------------------------------------------------

/** Cookie caller named no workspace and has more than one (or zero) active membership → 403
 *  `workspace_required`. A platform administrator with no membership anywhere lands here on every
 *  `/api/cap/*` call — by design (§7.11 "平台管理员在业务工作区没有任何数据权限"). */
export class WorkspaceRequiredError extends ForbiddenError {
  constructor(message = 'select a workspace (X-Workspace-Id) to call workspace capabilities') {
    super(message);
    this.name = 'WorkspaceRequiredError';
  }
}

/** Cookie-authenticated state change without `X-Requested-With: nexttime` → 403
 *  `csrf_header_required` (§7.11 "CSRF"): a cross-site form or navigation can carry the cookie
 *  but can never set a custom header. */
export class CsrfHeaderRequiredError extends ForbiddenError {
  constructor() {
    super(
      `state-changing requests authenticated by cookie must send X-Requested-With: ${CSRF_HEADER_VALUE}`,
    );
    this.name = 'CsrfHeaderRequiredError';
  }
}

/** The user's password is temporary (`must_change_password`) → 403 `password_change_required`
 *  on every workspace call until `POST /api/auth/password` clears it. */
export class PasswordChangeRequiredError extends ForbiddenError {
  constructor() {
    super('the password must be changed before the console can be used');
    this.name = 'PasswordChangeRequiredError';
  }
}

/**
 * Everything one transport-level request offers as a credential. The transport picks the values
 * out of its own shape (HTTP headers / cookies, WS upgrade headers + `authenticate` params) and
 * this function decides which channel they resolve to.
 */
export interface RequestCredentials {
  /** `Authorization` header value, if any — takes precedence over the cookie unconditionally. */
  readonly authorization?: string | undefined;
  /** `Cookie` header value, if any. */
  readonly cookie?: string | undefined;
  /** The workspace the caller wants to act in (`X-Workspace-Id`, the `nexttime_workspace`
   *  selector cookie, or WS `authenticate {workspaceId}`). When absent and the user has exactly
   *  one active membership, that one is used. */
  readonly workspaceId?: string | undefined;
  /** `X-Requested-With` header value, checked only when `requireCsrfHeader` is set. */
  readonly requestedWith?: string | undefined;
  /** Whether this request changes state and is authenticated by cookie — every `/api/cap/*`
   *  call. A WebSocket upgrade is protected by the `Origin` check instead. */
  readonly requireCsrfHeader?: boolean;
  /** Let a user whose password is still temporary through (the auth routes themselves). */
  readonly allowPasswordChangePending?: boolean;
}

/** Cookie value → verified claims → live user, or `UnauthorizedError`. Shared by
 *  `resolveRequestCaller` and the `/api/auth/*` routes (which need the user but no workspace). */
export async function resolveConsoleUser(
  cookieHeader: string | undefined,
  deps: ResolveCallerDeps,
): Promise<ConsoleUser> {
  const token = extractConsoleSessionToken(cookieHeader);
  if (!token) throw new UnauthorizedError('missing credentials');
  let claims: Awaited<ReturnType<typeof verifyConsoleSessionToken>>;
  try {
    claims = await verifyConsoleSessionToken(token, await loadHandlePublicKeyFor(deps));
  } catch (err) {
    throw new UnauthorizedError('invalid console session', { cause: err });
  }
  const user = await lookupConsoleSessionUser(deps.pool, claims);
  if (!user) throw new UnauthorizedError('console session no longer valid');
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    platformRole: user.platformRole,
    mustChangePassword: user.mustChangePassword,
    consoleSessionId: claims.sid,
  };
}

/**
 * Resolves the caller of one request from every credential it carries. Order:
 *   1. `Authorization` present → `resolveCaller` (API key, then Handle) — the cookie is ignored
 *      even if also present, so a wrong key never silently succeeds via someone else's login.
 *   2. Console session cookie → user (401 if missing/invalid/revoked/disabled) → CSRF header
 *      (403) → temporary-password gate (403) → workspace (403 `workspace_required` when it cannot
 *      be determined) → membership Principal + web Session (403 when none).
 *   3. Neither → 401.
 */
export class PlatformAdminRequiredError extends ForbiddenError {
  constructor() {
    super('this capability requires a platform administrator');
    this.name = 'PlatformAdminRequiredError';
  }
}

/**
 * P-A1: resolves the caller of a `scope: 'platform'` capability — cookie only (an API key or a
 * Handle names a Principal, and Principals have no platform role), CSRF header, no pending
 * password change, and `platform_role = 'admin'`. No workspace is consulted: the platform plane
 * has none, and an administrator with zero memberships is the normal first-run state.
 */
export async function resolvePlatformCaller(
  credentials: Pick<
    RequestCredentials,
    'authorization' | 'cookie' | 'requestedWith' | 'requireCsrfHeader'
  >,
  deps: ResolveCallerDeps,
): Promise<Extract<ResolvedCaller, { channel: 'platform' }>> {
  if (credentials.authorization) {
    // Resolve it anyway so a bad token is a 401 and a good one a 403 — never leak which.
    await resolveCaller(credentials.authorization, deps);
    throw new PlatformAdminRequiredError();
  }
  const user = await resolveConsoleUser(credentials.cookie, deps);
  if (credentials.requireCsrfHeader && credentials.requestedWith !== CSRF_HEADER_VALUE) {
    throw new CsrfHeaderRequiredError();
  }
  if (user.mustChangePassword) throw new PasswordChangeRequiredError();
  if (user.platformRole !== 'admin') throw new PlatformAdminRequiredError();
  return { channel: 'platform', user };
}

export async function resolveRequestCaller(
  credentials: RequestCredentials,
  deps: ResolveCallerDeps,
): Promise<ResolvedCaller> {
  if (credentials.authorization) return resolveCaller(credentials.authorization, deps);

  const user = await resolveConsoleUser(credentials.cookie, deps);
  if (credentials.requireCsrfHeader && credentials.requestedWith !== CSRF_HEADER_VALUE) {
    throw new CsrfHeaderRequiredError();
  }
  if (user.mustChangePassword && !credentials.allowPasswordChangePending) {
    throw new PasswordChangeRequiredError();
  }

  let workspaceId = credentials.workspaceId?.trim() || undefined;
  if (!workspaceId) {
    const memberships = await listActiveMemberships(deps.pool, user.id);
    if (memberships.length !== 1) throw new WorkspaceRequiredError();
    workspaceId = memberships[0]?.workspaceId;
  }
  if (!workspaceId) throw new WorkspaceRequiredError();

  const human = await authenticateUserInWorkspace(deps.pool, { userId: user.id, workspaceId });
  if (!human) throw new ForbiddenError('no active membership in the requested workspace');
  return { channel: 'human', principal: human.principal, session: human.session, user };
}
