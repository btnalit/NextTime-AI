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
 */

export type HttpErrorKind = 'network' | 'invalid_response' | 'capability_error';

/** Typed error thrown by every {@link HttpClient.call} failure mode. `code` is the wire
 *  `error.code` (e.g. `not_found`, `forbidden`, `invalid_params`) when `kind ===
 *  'capability_error'` — present so a caller can branch on a stable identifier instead of
 *  string-matching `message` (mirrors `interfaces/http/capability-route.ts`'s `mapCapabilityError`
 *  code taxonomy). */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly code: string | undefined;

  constructor(kind: HttpErrorKind, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.code = code;
  }
}

interface CapabilitySuccessEnvelope {
  readonly ok: true;
  readonly result: unknown;
}

interface CapabilityErrorEnvelope {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

function asErrorEnvelope(error: unknown): CapabilityErrorEnvelope['error'] | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string' && typeof record.message === 'string') {
    return { code: record.code, message: record.message };
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

export interface HttpClientOptions {
  /** The API key sent as `Authorization: Bearer <apiKey>` — the same key `WsClient.authenticate`
   *  used, from `lib/session.ts`. Never logged. */
  readonly apiKey: string;
  /** Injectable `fetch`, for tests. Defaults to a wrapper around the global `fetch` (see module
   *  doc comment — never the bare global, which would be invoked with the wrong receiver). */
  readonly fetchImpl?: typeof fetch;
}

/** Looks the global `fetch` up at call time (not at construction) and calls it unbound, so the
 *  receiver is the global object as the platform requires — and so a test can stub
 *  `globalThis.fetch` after the client has already been constructed. */
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export class HttpClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  /** Calls one capability. Resolves with `result` on `{ok:true}`; throws {@link HttpError}
   *  otherwise (network failure, malformed response body, or `{ok:false}`). */
  async call<T = unknown>(capabilityName: string, params: unknown = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`/api/cap/${capabilityName}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(params ?? {}),
      });
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
      throw new HttpError('capability_error', envelope.error.message, envelope.error.code);
    }
    return envelope.result as T;
  }
}
