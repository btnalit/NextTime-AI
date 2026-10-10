/**
 * lib/http-client: `POST /api/cap/<capability_name>` client for the capabilities the chat WS
 * socket cannot reach — `interfaces/ws/server.ts` only forwards methods in the `chat` capability
 * group (packages/shared/src/capabilities.ts), so `approve`/`reject`/`list_pending`/`get_action`/
 * `set_auto_approved_action_kind`/`get_task`/`list_tasks`/the `connection` group all go over this
 * HTTP path instead (design doc §9.3; docs/development-tasks.md S2.10 "read first" item 1: "HTTP
 * `POST /api/cap/<name>` with `Authorization: Bearer <api key>`, envelope `{ok, result|error}`").
 *
 * Mirrors `packages/platform-extension/src/kernel-client.ts`'s shape (same envelope, same error
 * taxonomy) rather than importing it — that package is Node-only tooling code, not published for
 * cross-package/browser import.
 *
 * `fetchImpl` defaults to a *wrapper* around the global `fetch`, never the bare function value:
 * `this.fetchImpl = fetch` followed by `this.fetchImpl(...)` invokes the browser's native `fetch`
 * with `this === HttpClient instance`, which every browser rejects with `TypeError: Failed to
 * execute 'fetch' on 'Window': Illegal invocation` (found on the deployed console — every
 * Approvals/Tasks/Connections call failed before reaching the kernel). `http-client.default-
 * fetch.test.ts` pins the wrapper behavior against a stubbed `globalThis.fetch` that asserts it
 * is never called with a foreign receiver.
 *
 * The path helper (`/api/cap/<name>`) is inlined rather than imported from `@nexttime/shared`'s
 * `capabilityRoute()` (packages/shared/src/http.ts) — same "type-only import, erased at compile
 * time" bundle-size convention S1.8 established for this package (see ws-client.ts's own module
 * doc comment): a one-line template literal is not worth promoting `@nexttime/shared` from
 * `devDependencies` to a real runtime dependency.
 *
 * Always same-origin (a bare `/api/...` path) — production is caddy reverse-proxying `/api` to the
 * kernel on the same origin as the static site (deploy/caddy/Caddyfile), and `pnpm dev`'s Vite
 * server proxies the same path to `KERNEL_DEV_URL` (vite.config.ts) — this file never constructs
 * an absolute URL the way `lib/ws-url.ts` must for `WebSocket` (which requires an explicit
 * scheme+host; `fetch` does not).
 *
 * S4.1: two credential shapes now reach `/api/cap/<name>` (`interfaces/http/capability-route.ts`
 * `resolveRequestCaller`) — the pre-existing API key (`Authorization: Bearer <key>`) and the
 * console session cookie (`nexttime_console_session`, HttpOnly — never read from here, just relied
 * on via `credentials: 'same-origin'`) plus the workspace the caller wants to act in
 * (`X-Workspace-Id`). Every state-changing call already requires `X-Requested-With: nexttime`
 * (§7.11 CSRF) on the cookie path; sent unconditionally here (harmless, and simpler than branching
 * on HTTP method) rather than only on non-GET calls, matching every other console-side auth header
 * already being unconditional.
 */

import {
  type CapabilityName,
  ROLE_VALUES,
  type Role,
  getCapability,
  roleMayUseCapability,
} from '@nexttime/shared';

export type HttpErrorKind = 'network' | 'invalid_response' | 'capability_error';

/** Typed error thrown by every {@link HttpClient.call} failure mode. `code` is the wire
 *  `error.code` (e.g. `not_found`, `forbidden`, `invalid_params`) when `kind ===
 *  'capability_error'` — present so a caller can branch on a stable identifier instead of
 *  string-matching `message` (mirrors `interfaces/http/capability-route.ts`'s `mapCapabilityError`
 *  code taxonomy). */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly code: string | undefined;
  /** The wire `error.details`, when the kernel sent one (a 400 that says exactly what to fix or
   *  confirm — `credentials_review_required`'s count, `module_confirm_required`'s modules). */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: HttpErrorKind,
    message: string,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

interface CapabilitySuccessEnvelope {
  readonly ok: true;
  readonly result: unknown;
}

interface CapabilityErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

function asErrorEnvelope(error: unknown): CapabilityErrorEnvelope['error'] | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string' && typeof record.message === 'string') {
    const details = record.details;
    return typeof details === 'object' && details !== null && !Array.isArray(details)
      ? { code: record.code, message: record.message, details: details as Record<string, unknown> }
      : { code: record.code, message: record.message };
  }
  return undefined;
}

function parseCapabilityEnvelope(
  value: unknown,
): CapabilitySuccessEnvelope | CapabilityErrorEnvelope | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok === true && 'result' in record) return { ok: true, result: record.result };
  if (record.ok === false) {
    const error = asErrorEnvelope(record.error);
    if (error) return { ok: false, error };
  }
  return undefined;
}

/** The API key channel — unchanged since S1.8. */
export interface ApiKeyAuth {
  readonly kind: 'apiKey';
  /** Sent as `Authorization: Bearer <apiKey>` — the same key `WsClient.authenticate` used, from
   *  `lib/session.ts`. Never logged. */
  readonly apiKey: string;
}

/** The console session cookie channel (S4.1) — no `Authorization` header at all (the kernel
 *  ignores the cookie whenever one is present, `resolveRequestCaller`'s own doc comment, so never
 *  send both). `workspaceId` is `null` before one has been chosen or resolved (e.g. a platform
 *  admin with no memberships) — every capability call then omits `X-Workspace-Id` and the kernel
 *  answers 403 `workspace_required` unless the caller has exactly one active membership. */
export interface CookieAuth {
  readonly kind: 'cookie';
  readonly workspaceId: string | null;
}

export type HttpClientAuth = ApiKeyAuth | CookieAuth;

export interface HttpClientOptions {
  readonly auth: HttpClientAuth;
  /** Injectable `fetch`, for tests. Defaults to a wrapper around the global `fetch` (see module
   *  doc comment — never the bare global, which would be invoked with the wrong receiver). */
  readonly fetchImpl?: typeof fetch;
  /** R-16: called when the kernel answers `unauthorized` (HTTP 401 — the console session or API
   *  key is gone), before the call rejects. The session machine maps it to the same "back to
   *  login" transition as the WebSocket's `-32001`. */
  readonly onUnauthorized?: () => void;
  /**
   * #541 acceptance (must-fix 2): before sending a workspace capability, check the caller's own
   * role with the kernel's predicate (`roleMayUseCapability`, shared with
   * `application/gateway/authorize.ts`) and refuse locally — no request — when it would be
   * refused anyway. A page then renders its "this role cannot" state without a 403 on the wire,
   * for every call path (hooks, loaders, buttons) at once. The kernel stays the authority: the
   * role comes from `get_workspace` (re-read at most every `ROLE_TTL_MS`, and refreshed by any
   * `get_workspace` call made through this client), and when it is unknown the call is sent.
   */
  readonly roleGate?: boolean;
}

/** How long a role read through `get_workspace` is trusted before the next gated call re-reads it
 *  (an owner may change this member's role meanwhile). */
const ROLE_TTL_MS = 60_000;

/** A read older than this is re-read before a call is refused locally on it — a refusal is the
 *  one place a stale role would be visible as "your role cannot" (#541 review M2). */
const ROLE_RECHECK_MS = 5_000;

/** Window event a role-gated client dispatches when a `get_workspace` read finds the caller's role
 *  changed since its previous read (an owner promoted or demoted them meanwhile). `detail` is
 *  {@link CallerRoleChange}: the shell's identity and the session's denial memory refresh from it
 *  without another request (`hooks/useWorkspaceIdentity`, `hooks/usePermissions`). */
export const CALLER_ROLE_CHANGED_EVENT = 'nexttime:caller-role-changed';

/** Window event dispatched each time a role-gated client refuses a call locally — the request was
 *  never sent. A page that asks for what its reader's role cannot have shows up here even though
 *  nothing reaches the network (journey ⑧ counts these; #541 review M1/M3). */
export const CAPABILITY_REFUSED_LOCALLY_EVENT = 'nexttime:capability-refused-locally';

export interface CapabilityRefusedLocally {
  readonly capability: string;
  readonly role: Role;
}

export interface CallerRoleChange {
  readonly client: HttpClient;
  readonly from: Role | null;
  readonly to: Role | null;
  /** The `get_workspace` result the change was read from. */
  readonly workspace: unknown;
}

function callerRoleOf(workspace: unknown): Role | null {
  const role = (workspace as { caller?: { role?: unknown } } | null | undefined)?.caller?.role;
  return typeof role === 'string' && (ROLE_VALUES as readonly string[]).includes(role)
    ? (role as Role)
    : null;
}

/** Whether some workspace role is refused `capabilityName` — only those calls wait for the role.
 *  Platform-scope and unknown capabilities never do: the kernel decides them by channel. */
function roleMatters(capabilityName: string): boolean {
  const capability = getCapability(capabilityName);
  if (capability === undefined || capability.scope === 'platform') return false;
  return ROLE_VALUES.some((role) => !roleMayUseCapability(role, capability));
}

/** Whether `role` is refused `capabilityName` by the kernel's own rule (see `roleMatters`). */
export function roleRefuses(role: Role, capabilityName: string): boolean {
  return roleMatters(capabilityName) && !roleMayUseCapability(role, getCapability(capabilityName));
}

/** Looks the global `fetch` up at call time (not at construction) and calls it unbound, so the
 *  receiver is the global object as the platform requires — and so a test can stub
 *  `globalThis.fetch` after the client has already been constructed. */
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export class HttpClient {
  private readonly auth: HttpClientAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly roleGate: boolean;
  private roleRead: { readonly role: Promise<Role | null>; readonly at: number } | null = null;
  /** The role the last successful `get_workspace` read said; `undefined` before the first. */
  private lastRole: Role | null | undefined = undefined;

  constructor(options: HttpClientOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.onUnauthorized = options.onUnauthorized;
    this.roleGate = options.roleGate ?? false;
  }

  /** Calls one capability. Resolves with `result` on `{ok:true}`; throws {@link HttpError}
   *  otherwise (network failure, malformed response body, `{ok:false}`, or — with `roleGate` — a
   *  local `forbidden` for a capability the caller's role cannot use). */
  async call<T = unknown>(capabilityName: CapabilityName, params: unknown = {}): Promise<T> {
    if (this.roleGate && roleMatters(capabilityName)) {
      const read = this.roleRead;
      let role = await this.callerRole();
      if (role !== null && roleRefuses(role, capabilityName) && this.roleRead === read) {
        // Not refused on an old read: the owner may have just granted this role.
        if (read !== null && Date.now() - read.at > ROLE_RECHECK_MS) {
          this.roleRead = null;
          role = await this.callerRole();
        }
      }
      if (role !== null && roleRefuses(role, capabilityName)) {
        if (typeof window !== 'undefined') {
          const detail: CapabilityRefusedLocally = { capability: capabilityName, role };
          window.dispatchEvent(new CustomEvent(CAPABILITY_REFUSED_LOCALLY_EVENT, { detail }));
        }
        throw new HttpError(
          'capability_error',
          `principal role "${role}" may not use capability "${capabilityName}" (checked in the console; not sent)`,
          'forbidden',
          { checkedLocally: true },
        );
      }
    }
    let result: T;
    try {
      result = await this.send<T>(capabilityName, params);
    } catch (error) {
      // The kernel refused what the last read said this role may do: the role changed. Re-read it
      // now (one request) so the next call, and the shell, go by the new one.
      if (
        this.roleGate &&
        error instanceof HttpError &&
        error.code === 'forbidden' &&
        roleMatters(capabilityName)
      ) {
        this.roleRead = null;
        void this.callerRole();
      }
      throw error;
    }
    if (capabilityName === 'get_workspace') this.noteWorkspace(result);
    return result;
  }

  /** Records a `get_workspace` answer as this client's role read, and announces a changed role. */
  private noteWorkspace(workspace: unknown): Role | null {
    const role = callerRoleOf(workspace);
    this.roleRead = { role: Promise.resolve(role), at: Date.now() };
    const from = this.lastRole;
    this.lastRole = role;
    if (this.roleGate && from !== undefined && from !== role && typeof window !== 'undefined') {
      const detail: CallerRoleChange = { client: this, from, to: role, workspace };
      window.dispatchEvent(new CustomEvent(CALLER_ROLE_CHANGED_EVENT, { detail }));
    }
    return role;
  }

  /** The caller's role in this client's workspace, `null` when it cannot be read (no workspace
   *  selected, an older kernel) — then nothing is refused locally. One read in flight at a time. */
  private callerRole(): Promise<Role | null> {
    if (this.roleRead === null || Date.now() - this.roleRead.at > ROLE_TTL_MS) {
      this.roleRead = {
        role: this.send<unknown>('get_workspace', {}).then(
          (workspace) => this.noteWorkspace(workspace),
          () => null,
        ),
        at: Date.now(),
      };
    }
    return this.roleRead.role;
  }

  private async send<T>(capabilityName: string, params: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-requested-with': 'nexttime',
    };
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(params ?? {}) };
    if (this.auth.kind === 'apiKey') {
      headers.authorization = `Bearer ${this.auth.apiKey}`;
    } else {
      if (this.auth.workspaceId) headers['x-workspace-id'] = this.auth.workspaceId;
      init.credentials = 'same-origin';
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`/api/cap/${capabilityName}`, init);
    } catch (error) {
      throw new HttpError(
        'network',
        `capability call "${capabilityName}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HttpError(
        'invalid_response',
        `capability call "${capabilityName}" returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    const envelope = parseCapabilityEnvelope(body);
    if (!envelope) {
      throw new HttpError(
        'invalid_response',
        `capability call "${capabilityName}" returned an unrecognized response shape (HTTP ${response.status})`,
      );
    }
    if (!envelope.ok) {
      if (envelope.error.code === 'unauthorized') this.onUnauthorized?.();
      throw new HttpError(
        'capability_error',
        envelope.error.message,
        envelope.error.code,
        envelope.error.details,
      );
    }
    return envelope.result as T;
  }
}
