import { HttpError } from './http-client.js';

/**
 * lib/auth-api: typed fetch helpers for the console-session surface (S4.1; design doc §7.11) —
 * `/api/platform/*` and `/api/auth/*` (`packages/kernel/src/interfaces/http/auth-routes.ts`, the
 * source of truth this file codes against). Distinct from `lib/http-client.ts`'s `HttpClient`:
 * these routes are not `/api/cap/<name>` capability calls (no envelope-wrapped `{ok,result}` over
 * a single POST shape with a capability name) — they are their own small set of REST-ish endpoints
 * with their own bodies, some GET, none needing a workspace. Same envelope though
 * (`{ok:true,result}` / `{ok:false,error:{code,message}}`), so the parsing/`HttpError` shape is
 * shared with `http-client.ts` rather than reinvented.
 *
 * Every state-changing call sends `X-Requested-With: nexttime` (§7.11 CSRF) and
 * `credentials: 'same-origin'` (the cookie is HttpOnly — this file never reads it, only relies on
 * the browser attaching it). `fetchImpl` is injectable, same convention as `http-client.ts` —
 * resolved at call time, never the bare global assigned as a method (see `http-client.ts`'s own
 * module doc comment on why that throws "Illegal invocation").
 */

export interface WireUser {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly platformRole: 'admin' | 'user';
  readonly mustChangePassword: boolean;
}

export interface WireMembership {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly principalId: string;
  readonly role: string;
}

export interface SessionResult {
  readonly user: WireUser;
  readonly memberships: readonly WireMembership[];
  readonly expiresAt: string;
}

export interface MeResult {
  readonly user: WireUser;
  readonly memberships: readonly WireMembership[];
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

interface Envelope {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

async function request<T>(
  path: string,
  init: {
    readonly method: 'GET' | 'POST' | 'PATCH';
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  },
  fetchImpl: typeof fetch,
): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  const requestInit: RequestInit = { method: init.method, headers, credentials: 'same-origin' };
  if (init.method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-requested-with'] = 'nexttime';
    requestInit.body = JSON.stringify(init.body ?? {});
  }

  let response: Response;
  try {
    response = await fetchImpl(path, requestInit);
  } catch (error) {
    throw new HttpError(
      'network',
      `${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HttpError(
      'invalid_response',
      `${path} returned a non-JSON response (HTTP ${response.status})`,
    );
  }

  if (!isEnvelope(body)) {
    throw new HttpError(
      'invalid_response',
      `${path} returned an unrecognized response shape (HTTP ${response.status})`,
    );
  }
  if (!body.ok) {
    const error = body.error;
    if (!error) {
      throw new HttpError('invalid_response', `${path} returned {ok:false} with no error`);
    }
    throw new HttpError('capability_error', error.message, error.code);
  }
  return body.result as T;
}

/** `POST /api/auth/claim`: self-service migration for a pre-existing API-key Principal — proves
 *  identity with the key itself (`Authorization: Bearer`), never the console session cookie (a
 *  cookie user already has a password and nothing to claim). Same result shape as {@link login},
 *  and installs the same console session cookie on success. */
export function claimIdentity(
  apiKey: string,
  input: { readonly login: string; readonly displayName: string; readonly password: string },
  fetchImpl: typeof fetch = defaultFetch,
): Promise<SessionResult> {
  return request<SessionResult>(
    '/api/auth/claim',
    { method: 'POST', body: input, headers: { authorization: `Bearer ${apiKey}` } },
    fetchImpl,
  );
}

/** `POST /api/auth/bind-api-key`: cookie-authenticated (the console session, not the key being
 *  bound) — folds the Principal behind `apiKey` into the caller's own account, so the caller
 *  gains that Principal's workspace membership without having to hold two separate credentials.
 *  Unlike {@link claimIdentity} this mints no new session (the caller already has one); the
 *  result is just the caller's refreshed `{user, memberships}` (same shape as {@link getMe}). */
export function bindApiKey(
  apiKey: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<MeResult> {
  return request<MeResult>('/api/auth/bind-api-key', { method: 'POST', body: { apiKey } }, fetchImpl);
}

export function login(
  input: { readonly login: string; readonly password: string },
  fetchImpl: typeof fetch = defaultFetch,
): Promise<SessionResult> {
  return request<SessionResult>('/api/auth/login', { method: 'POST', body: input }, fetchImpl);
}

export function logout(fetchImpl: typeof fetch = defaultFetch): Promise<{ loggedOut: true }> {
  return request<{ loggedOut: true }>('/api/auth/logout', { method: 'POST' }, fetchImpl);
}

export function getMe(fetchImpl: typeof fetch = defaultFetch): Promise<MeResult> {
  return request<MeResult>('/api/auth/me', { method: 'GET' }, fetchImpl);
}

export function patchMe(
  input: { readonly displayName: string },
  fetchImpl: typeof fetch = defaultFetch,
): Promise<{ user: WireUser }> {
  return request<{ user: WireUser }>('/api/auth/me', { method: 'PATCH', body: input }, fetchImpl);
}

export function changePassword(
  input: { readonly currentPassword: string; readonly newPassword: string },
  fetchImpl: typeof fetch = defaultFetch,
): Promise<{ user: WireUser }> {
  return request<{ user: WireUser }>(
    '/api/auth/password',
    { method: 'POST', body: input },
    fetchImpl,
  );
}

/** `document.cookie` name the Explorer (`/explorer/`) reads to know which workspace's graph to
 *  show — a plain, non-HttpOnly selector cookie the console itself sets/clears (design doc §7.11;
 *  `packages/kernel/src/interfaces/explorer-contract` reads it alongside the console session
 *  cookie). Not the console session cookie itself (`nexttime_console_session`, HttpOnly, minted
 *  server-side only). */
const WORKSPACE_COOKIE = 'nexttime_workspace';

/** Sets (or clears, `workspaceId: null`) the `nexttime_workspace` selector cookie — call whenever
 *  the current workspace changes (login, switch, logout). `Secure` is included only over https
 *  (a plain-http dev server would otherwise silently refuse to set the cookie at all). */
export function setWorkspaceCookie(workspaceId: string | null): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  if (workspaceId === null) {
    document.cookie = `${WORKSPACE_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
    return;
  }
  document.cookie = `${WORKSPACE_COOKIE}=${encodeURIComponent(workspaceId)}; Path=/; SameSite=Strict${secure}`;
}
