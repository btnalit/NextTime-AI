import type {
  DeleteLlmProviderResultWire,
  LlmAdminTokenWire,
  LlmProviderInputWire,
  LlmProviderListWire,
  LlmProviderTestInputWire,
  LlmProviderTestResultWire,
  LlmProviderWire,
} from '@nexttime/shared';
import type { CapabilityCaller } from './clients.js';
import type { Translate } from './i18n.js';

/**
 * lib/llm-admin: the console's client for S6-B provider management (docs/console-completion-
 * plan.md §5.4 / §6; docs/platform-admin-design.md §6.2). Two hops, neither through `/api/cap`:
 *
 *   1. `issue_llm_admin_token` (an ordinary platform capability over `http`) mints a 5-minute
 *      JWT — cached per `CapabilityCaller` (i.e. per signed-in session, the same `WeakMap`
 *      lifetime `hooks/useCapability.ts` gives its cache: logout drops it) and reused for a
 *      burst of admin actions until 60 s before expiry (`TOKEN_REFRESH_MARGIN_MS`).
 *   2. the llm-proxy admin endpoints, same-origin at `tokenResult.url` (`/api/llm-admin`, caddy
 *      `handle_path` → llm-proxy `/admin/*`), with `Authorization: Bearer <jwt>` and the same
 *      `X-Requested-With: nexttime` every `/api/*` call carries (§7.11 CSRF; enforced at the
 *      edge and again in llm-proxy's admin-auth.ts).
 *
 * Mirrors `lib/gate-host.ts` (P-B2a's browser → gate host path) rather than `HttpClient`: the
 * proxy's `{error: {code, message}}` vocabulary is its own, so failures become
 * {@link LlmAdminError} (status + code + message) for the page to branch on — a 401
 * `token_expired` drops the cached token and retries once; `store_unwritable` /
 * `credential_missing` are surfaced verbatim with their operator steps.
 *
 * S7-A (docs/STATUS.md 维护者决定 2026-09-22 ①): `setProviderSecret`/`clearProviderSecret` are the
 * one place a provider key ever crosses this client — sent once, in the request body, never
 * echoed back (every response — including these two calls' own — uses `LlmProviderWire`, which
 * has no key field, only `credentialPresent`/`credentialSource`). Callers must clear their own
 * local input state right after a successful call; this module holds nothing.
 */

export class LlmAdminError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'LlmAdminError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const TOKEN_REFRESH_MARGIN_MS = 60_000;

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

interface CachedToken {
  readonly token: LlmAdminTokenWire;
  readonly expiresAtMs: number;
}

const tokenCacheByCaller = new WeakMap<CapabilityCaller, CachedToken>();

export interface LlmAdminClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function isErrorEnvelope(
  body: unknown,
): body is { error: { code: string; message: string; details?: unknown } } {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  return typeof record.code === 'string' && typeof record.message === 'string';
}

/** One client per page instance; the token cache is shared across instances for the same
 *  `http` (session). */
export class LlmAdminClient {
  private readonly http: CapabilityCaller;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(http: CapabilityCaller, options: LlmAdminClientOptions = {}) {
    this.http = http;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.now = options.now ?? (() => Date.now());
  }

  /** The cached admin token, or a fresh one from `issue_llm_admin_token` when there is none or
   *  it is within `TOKEN_REFRESH_MARGIN_MS` of expiry. Exposed for tests and for the page's
   *  "token issued" hint; every request below calls it. */
  async token(): Promise<LlmAdminTokenWire> {
    const cached = tokenCacheByCaller.get(this.http);
    if (cached && cached.expiresAtMs - this.now() > TOKEN_REFRESH_MARGIN_MS) return cached.token;
    const fresh = await this.http.call<LlmAdminTokenWire>('issue_llm_admin_token', {});
    tokenCacheByCaller.set(this.http, { token: fresh, expiresAtMs: Date.parse(fresh.expiresAt) });
    return fresh;
  }

  /** Drops the cached token (a 401 from the proxy, or a test). */
  forgetToken(): void {
    tokenCacheByCaller.delete(this.http);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${token.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token.token}`,
          'x-requested-with': 'nexttime',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new LlmAdminError(
        0,
        'network',
        `无法连接模型代理 Could not reach the model proxy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsed: unknown;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LlmAdminError(
          response.status,
          'invalid_response',
          `模型代理返回了无法识别的响应 The model proxy returned an unrecognized response (HTTP ${response.status})`,
        );
      }
    }

    if (response.ok) return parsed as T;

    if (response.status === 401 && !retried) {
      // The cached token expired (or the kernel key rotated): mint a fresh one and retry once.
      this.forgetToken();
      return this.request<T>(method, path, body, true);
    }
    if (isErrorEnvelope(parsed)) {
      throw new LlmAdminError(
        response.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.details,
      );
    }
    throw new LlmAdminError(
      response.status,
      'http_error',
      `模型代理拒绝了这次请求 The model proxy rejected this request (HTTP ${response.status})`,
    );
  }

  listProviders(): Promise<LlmProviderListWire> {
    return this.request<LlmProviderListWire>('GET', '/providers');
  }

  createProvider(input: LlmProviderInputWire): Promise<LlmProviderWire> {
    return this.request<LlmProviderWire>('POST', '/providers', input);
  }

  updateProvider(input: LlmProviderInputWire): Promise<LlmProviderWire> {
    return this.request<LlmProviderWire>(
      'PUT',
      `/providers/${encodeURIComponent(input.id)}`,
      input,
    );
  }

  deleteProvider(id: string): Promise<DeleteLlmProviderResultWire> {
    return this.request<DeleteLlmProviderResultWire>(
      'DELETE',
      `/providers/${encodeURIComponent(id)}`,
    );
  }

  testProvider(
    id: string,
    input: LlmProviderTestInputWire = {},
  ): Promise<LlmProviderTestResultWire> {
    return this.request<LlmProviderTestResultWire>(
      'POST',
      `/providers/${encodeURIComponent(id)}/test`,
      input,
    );
  }

  /** Sets/replaces the console key for `id`. `key` should already be trimmed by the caller (the
   *  form does this); the proxy trims and validates it again regardless. */
  setProviderSecret(id: string, key: string): Promise<LlmProviderWire> {
    return this.request<LlmProviderWire>('PUT', `/providers/${encodeURIComponent(id)}/secret`, {
      key,
    });
  }

  /** Clears the console key for `id` — falls back to `apiKeyEnv` (if set) or no credential. */
  clearProviderSecret(id: string): Promise<LlmProviderWire> {
    return this.request<LlmProviderWire>('DELETE', `/providers/${encodeURIComponent(id)}/secret`);
  }
}

/** The bilingual copy for the codes the page branches on; anything else shows the proxy's own
 *  message. Kept here (not in `lib/platform-errors.ts`) because these are llm-proxy codes, not
 *  kernel capability codes. */
export function llmAdminErrorMessage(error: unknown, t: Translate): string | null {
  if (!(error instanceof LlmAdminError)) return null;
  switch (error.code) {
    case 'store_unwritable':
      return t(
        '模型代理的状态目录不可写——请操作员在主机上运行 scripts/host-llm-proxy-init.sh 后重建 llm-proxy。',
        'The model proxy cannot write its state directory — the operator must run scripts/host-llm-proxy-init.sh on the host and recreate llm-proxy.',
      );
    case 'credential_missing':
      return t(
        '该供应商尚未配置密钥（控制台或 secrets/llm-proxy.env 均未设置）。',
        'This provider has no key configured (neither the console nor secrets/llm-proxy.env).',
      );
    case 'provider_exists':
      return t('已存在同名供应商。', 'A provider with this id already exists.');
    case 'provider_from_file':
      return t(
        '该供应商来自主机上的 llm-providers.yaml，不能在此删除——可停用它，或由操作员改 yaml。',
        'This provider comes from llm-providers.yaml on the host — disable it here, or have the operator edit the yaml.',
      );
    case 'reserved_id':
      return t('该 id 为代理自身路由保留。', 'This id is reserved for the proxy’s own routes.');
    case 'token_expired':
    case 'unauthorized':
      return t(
        '管理令牌无效或已过期，请重试。',
        'The admin token is invalid or expired — try again.',
      );
    default:
      return null;
  }
}
