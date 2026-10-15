import type {
  DeleteLlmProviderResultWire,
  LlmAdminTokenWire,
  LlmProviderInputWire,
  LlmProviderListWire,
  LlmProviderModelDiscoveryInputWire,
  LlmProviderModelDiscoveryResultWire,
  LlmProviderModelProbeInputWire,
  LlmProviderModelProbeResultWire,
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
      const detail = error instanceof Error ? error.message : String(error);
      // S8 W4 i18n baseline: `message` here is the `Error.message` fallback for a caller that
      // never routes through `llmAdminErrorMessage` below (English, matching every other code's
      // raw `message` — server-originated messages elsewhere in this file are English too); the
      // `'network'` case added to `llmAdminErrorMessage` is what actually renders in the console,
      // picking one language via `t()` instead of gluing both.
      throw new LlmAdminError(0, 'network', `Could not reach the model proxy: ${detail}`, detail);
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
          `The model proxy returned an unrecognized response (HTTP ${response.status})`,
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
      `The model proxy rejected this request (HTTP ${response.status})`,
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

  /** 「从供应商获取模型」: one `GET <upstream>/v1/models` through the proxy for the upstream the
   *  form describes (llm-proxy `POST /admin/model-discovery`). `key`, when given, is the typed key
   *  — sent in this one request body, used only for this upstream, never stored by this call. */
  discoverModels(
    input: LlmProviderModelDiscoveryInputWire,
  ): Promise<LlmProviderModelDiscoveryResultWire> {
    return this.request<LlmProviderModelDiscoveryResultWire>('POST', '/model-discovery', input);
  }

  /** 「验证所选模型」: the provider test (completion + tool call) against each picked model, with
   *  the form's upstream and credential (llm-proxy `POST /admin/model-probe`). Nothing is stored. */
  probeModels(input: LlmProviderModelProbeInputWire): Promise<LlmProviderModelProbeResultWire> {
    return this.request<LlmProviderModelProbeResultWire>('POST', '/model-probe', input);
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
    // S8 W4 i18n baseline: these three codes are client-authored (never a server message), so —
    // unlike the server-originated codes below, which fall through to `error.message` verbatim
    // when unmatched — they get a real bilingual mapping here instead of `request`'s raw
    // `Error.message` (English-only fallback for a caller that skips this function).
    // The browser's own text (e.g. `getaddrinfo ENOTFOUND`) stays in the error's `message` for
    // the 「技术细节」 disclosure (`lib/errors.ts` `presentError`), not in this body (P1-1).
    case 'network':
      return t(
        '无法连接模型代理：检查网络，或请平台管理员确认模型代理正在运行。',
        'Could not reach the model proxy. Check the network, or ask a platform administrator to confirm the model proxy is running.',
      );
    case 'invalid_response':
      return t(
        `模型代理返回了无法识别的响应（HTTP ${error.status}）`,
        `The model proxy returned an unrecognized response (HTTP ${error.status})`,
      );
    case 'http_error':
      return t(
        `模型代理拒绝了这次请求（HTTP ${error.status}）`,
        `The model proxy rejected this request (HTTP ${error.status})`,
      );
    case 'store_unwritable':
      return t(
        '模型代理的状态目录不可写——请操作员在主机上运行 scripts/host-llm-proxy-init.sh 后重建 llm-proxy。',
        'The model proxy cannot write its state directory — the operator must run scripts/host-llm-proxy-init.sh on the host and recreate llm-proxy.',
      );
    case 'credential_missing':
      return t(
        '还没有可用的密钥：在表单里填写 API 密钥，或先在主机 secrets/llm-proxy.env 里设置环境变量。',
        'No key available yet — enter the API key in the form, or set the env var in secrets/llm-proxy.env on the host first.',
      );
    case 'upstream_base_url_invalid':
      return t(
        '这个供应商保存的 Base URL 带有查询串（?）、片段（#）或用户名密码，代理不会向它发请求。编辑供应商，把 Base URL 改成纯源站地址。',
        'This provider’s saved Base URL carries a query (?), fragment (#) or user name — the proxy will not call it. Edit the provider and set a plain origin.',
      );
    case 'api_key_env_not_allowed':
      return t(
        '这个环境变量在代理里已经存着一把密钥，但没有配置给这个上游——为防止密钥被发往别处，不能这样用。请改为直接填写 API 密钥。',
        'That env var already holds a key in the proxy that is not configured for this upstream — so it cannot be sent here. Enter the API key directly instead.',
      );
    case 'upstream_error':
    case 'upstream_unreachable':
    case 'upstream_invalid_response': {
      // The upstream's own words go to the 「技术细节」 disclosure (P1-1); the caller adds the
      // status-specific explanation (`lib/provider-form.ts` `explainUpstreamError`) when it has one.
      if (error.code === 'upstream_unreachable') {
        return t(
          '连不上供应商：检查 Base URL 是否写对，这个地址是否能从服务器访问。',
          'Could not reach the provider. Check the Base URL and that it is reachable from the server.',
        );
      }
      if (error.code === 'upstream_invalid_response') {
        return t(
          '供应商没有返回能识别的模型列表：检查 Base URL 是否指向 OpenAI 兼容接口的源站。',
          'The provider returned no recognizable model list. Check the Base URL points at an OpenAI-compatible origin.',
        );
      }
      return t(
        '供应商拒绝了请求：它的原话在下方「技术细节」里。',
        'The provider refused the request; its own words are in the technical details below.',
      );
    }
    case 'rate_limited': {
      const details = error.details;
      const seconds =
        typeof details === 'object' &&
        details !== null &&
        'retryAfterSeconds' in details &&
        typeof (details as { retryAfterSeconds: unknown }).retryAfterSeconds === 'number'
          ? (details as { retryAfterSeconds: number }).retryAfterSeconds
          : null;
      const busy =
        typeof details === 'object' &&
        details !== null &&
        (details as { reason?: unknown }).reason === 'busy';
      if (busy) {
        return t(
          '还有几项验证正在进行，等它们结束后再试。',
          'Several checks are still running — try again once they finish.',
        );
      }
      return t(
        `短时间内验证次数太多，为保护密钥额度暂停了${seconds ? ` ${seconds} 秒` : '一会儿'}，之后再试。`,
        `Too many checks in a short time — paused${seconds ? ` for ${seconds} s` : ' briefly'} to protect the key's quota; try again after that.`,
      );
    }
    case 'invalid_body':
      return t(
        '代理认为提交的内容不合法，请检查各字段。',
        'The proxy rejected the submitted fields — check them.',
      );
    case 'provider_exists':
      return t('已存在同名供应商。', 'A provider with this id already exists.');
    case 'provider_from_file':
      return t(
        '该供应商来自主机上的 llm-providers.yaml，不能在此删除——可停用它，或由操作员改 yaml。',
        'This provider comes from llm-providers.yaml on the host — disable it here, or have the operator edit the yaml.',
      );
    case 'reserved_id':
      return t('该 ID 为代理自身路由保留。', 'This id is reserved for the proxy’s own routes.');
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
