import type http from 'node:http';
import type {
  DeleteLlmProviderResultWire,
  LlmAdminTokenClaims,
  LlmProviderCredentialSourceWire,
  LlmProviderInputWire,
  LlmProviderListWire,
  LlmProviderModelDiscoveryInputWire,
  LlmProviderModelDiscoveryResultWire,
  LlmProviderModelProbeResultWire,
  LlmProviderTestResultWire,
  LlmProviderWire,
} from '@nexttime/shared';
import {
  LLM_PROVIDER_RESERVED_IDS,
  LlmProviderIdWireSchema,
  LlmProviderInputWireSchema,
  LlmProviderModelDiscoveryInputWireSchema,
  LlmProviderModelProbeInputWireSchema,
  LlmProviderSecretInputWireSchema,
  LlmProviderTestInputWireSchema,
  upstreamBaseUrlProblem,
} from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import { AdminAuthError, authenticateAdminRequest } from './admin-auth.js';
import {
  UpstreamCallLimitError,
  type UpstreamCallLimiter,
  createUpstreamCallLimiter,
} from './admin-limits.js';
import type { ProviderCatalog, ResolvedProvider } from './catalog.js';
import type { ProviderConfig } from './config.js';
import { BodyTooLargeError, readBufferedBody, sendJson } from './http-util.js';
import type { KeyStore } from './key-store.js';
import { KeyStoreError } from './key-store.js';
import { checkProviderKey } from './provider-keys.js';
import type { ListUpstreamModelsOptions, ListUpstreamModelsResult } from './provider-models.js';
import type { ProviderStore, StoreProvider, StoreTestResult } from './provider-store.js';
import { ProviderStoreError } from './provider-store.js';

/**
 * admin-api: the S6-B provider-management endpoints (docs/console-completion-plan.md §5.4 / §6
 * "llm-proxy `/api/llm-admin/providers` CRUD、`/providers/:id/test`、`/providers/:id/secret`";
 * docs/platform-admin-design.md §6.2). Mounted under `/admin/*` on this proxy's one listener
 * (proxy.ts hands every `/admin/...` request here); caddy exposes it to the console as
 * `/api/llm-admin/*` (deploy/caddy/Caddyfile — `handle_path` strips the prefix, `rewrite` adds
 * `/admin`). Every request is authenticated by admin-auth.ts (5-minute platform JWT + the
 * console's CSRF header); nothing here is reachable with a Handle.
 *
 *   GET    /providers            merged catalog (file + store), with source / override facts and
 *                                the honest credential state (`credentialPresent` +
 *                                `credentialSource: 'console' | 'env' | 'none'`)
 *   POST   /providers            create a store provider (409 if the id exists anywhere)
 *   GET    /providers/:id
 *   PUT    /providers/:id        replace a store provider, or create a store override of a file
 *                                provider (the yaml itself is never written — it is the
 *                                operator's read-only base; that is how "disable" a file
 *                                provider works too: an override with `enabled: false`). A new
 *                                `upstreamBaseUrl` clears the provider's console key (R-23)
 *   DELETE /providers/:id        remove a store provider / override (409 `provider_from_file` for
 *                                a pure file provider — edit the yaml; a removed override makes
 *                                the file entry visible again)
 *   POST   /providers/:id/test   one completion + one forced tool call against the upstream
 *                                (provider-test.ts); records the outcome on the row
 *   PUT    /providers/:id/secret {key} — set/replace the console key for this provider id
 *                                (key-store.ts). POST is accepted as an alias (the original design
 *                                — plan §6 — used POST; PUT is the one the console actually calls,
 *                                being a full replace of one resource). 404 for an unknown
 *                                provider id, 400 for an empty/oversized/control-character key.
 *   DELETE /providers/:id/secret clears the console key — falls back to `apiKeyEnv` (if any) or no
 *                                credential. Always 200, even when there was no console key to
 *                                clear (the end state already holds).
 *   POST   /model-discovery      "从供应商获取模型": one `GET <upstream>/v1/models` for the upstream
 *                                the console form describes (provider-models.ts), before or after
 *                                the provider exists. Changes nothing; audit-logged like a test.
 *                                Its own top-level segment, not `/providers/<x>`, so it can never
 *                                collide with a provider id.
 *   POST   /model-probe          the provider test against up to six picked models, with the
 *                                form's own upstream and credential (same rules as discovery).
 *
 * The three routes that call an upstream (`/test`, `/model-discovery`, `/model-probe`) run under a
 * per-administrator limit (admin-limits.ts): two at a time plus a short queue, and a budget of
 * upstream calls per minute. Over it → 429 `rate_limited` with `details.retryAfterSeconds`; the
 * upstream is not called. Every upstream answer is read with a byte cap (http-util.ts
 * `readUpstreamJson`).
 *
 * S7-A (docs/STATUS.md 维护者决定 2026-09-22 ①: no approval flow, usability first): the console
 * may now set a provider's key directly — resolution order (proxy.ts, this module's own
 * `credentialSource` below) is the console key first, then `process.env[apiKeyEnv]`, then none.
 * `apiKeyEnv` is optional (config.ts) for exactly this reason: a store provider may rely purely on
 * a console key. The key value itself never appears in a GET/list response, a log line, an error
 * message, an audit row (proxy or kernel), or `models.json` — see key-store.ts's own doc comment.
 *
 * After every successful mutation: the catalog is live already (catalog.ts recomputes from the
 * store), `models.json` is rewritten atomically (gen-models-json.ts `writeModelsJsonAtomic`) so
 * the kernel's projection (`list_platform_models` → workspace `allowedModels` → the chat page)
 * and every newly spawned agent container see the change, and two audit records are produced —
 * this proxy's own structured `level: 'audit'` log line and one kernel platform audit row
 * (`options.kernelAudit` → `POST /internal/llm-admin-audit`, best-effort, retried by the caller
 * of the next mutation only in the sense that every mutation posts its own row). Both carry the
 * token's `jti` and `sub`, never a key — there is no key anywhere in this module to leak. The
 * `/secret` routes are the one exception to "rewrites models.json": a key change never changes
 * `models.json`'s content (its own `apiKey` field is always the literal `$CAPABILITY_HANDLE`
 * template — gen-models-json.ts), so they skip that step entirely.
 *
 * A failed `models.json` rewrite (the config directory is not writable — the operator step in
 * docs/runbooks/operations.md 供应商管理) does not fail the mutation: the store is already the
 * source of truth and the proxy routes the new provider; the list's `modelsJsonError` tells the
 * page what to show, and `make gen-models` (which now merges the store too) is the manual
 * fallback.
 *
 * R-23 (2026-10-02 review): a key only goes to the upstream it was provisioned for. A console key
 * belongs to the upstream it was entered for, so a `PUT` that changes `upstream_base_url` clears
 * it first (the rule gate-host applies to a hosted instance's credentials when its target
 * changes — gatekeeper-base host.ts `wipeInstanceData`), and a new provider never inherits one
 * left behind under its id. An environment key belongs to the upstream the configured provider
 * set pairs it with (`assertEnvKeyPairing`). Otherwise an admin session, a stolen 5-minute token
 * or a console XSS could point a provider at its own host — or name any variable in this
 * process's environment as `apiKeyEnv` — and `/test` it.
 */

export type KernelAuditAction =
  | 'provider_created'
  | 'provider_updated'
  | 'provider_deleted'
  | 'provider_tested'
  | 'provider_secret_set'
  | 'provider_secret_cleared'
  | 'provider_models_listed'
  | 'provider_models_probed';

export interface KernelAuditEvent {
  readonly action: KernelAuditAction;
  readonly providerId: string;
  readonly actorUserId: string;
  readonly tokenJti: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AdminApiOptions {
  readonly catalog: ProviderCatalog;
  readonly store: ProviderStore;
  /** S7-A: the console-written provider secrets (key-store.ts). Consulted first, ahead of
   *  `resolveApiKey`/`apiKeyEnv`, for `credentialPresent`/`credentialSource`, the `/test` route's
   *  real key, and the `/secret` routes themselves. */
  readonly keyStore: KeyStore;
  readonly publicKey: CryptoKey;
  /** `api_key_env` → real key; only its presence is ever reported, and its value only reaches
   *  provider-test.ts. Defaults to `process.env[name]`. */
  readonly resolveApiKey?: (envVarName: string) => string | undefined;
  /** Rewrites `models.json` from the catalog. Throws on failure (recorded, not fatal). */
  readonly writeModelsJson: () => Promise<void>;
  /** Posts one platform audit row to the kernel. Absent (no kernel configured) = skipped. */
  readonly kernelAudit?: (event: KernelAuditEvent) => Promise<void>;
  /** provider-test.ts's `runProviderTest`, injectable for tests. */
  readonly runTest: (
    provider: ProviderConfig,
    model: string,
    realKey: string,
  ) => Promise<StoreTestResult>;
  /** provider-models.ts's `listUpstreamModels` (timeout bound by the caller), injectable for
   *  tests. Absent = `POST /model-discovery` answers 501. */
  readonly listModels?: (
    options: Omit<ListUpstreamModelsOptions, 'timeoutMs' | 'fetchImpl'>,
  ) => Promise<ListUpstreamModelsResult>;
  /** Per-administrator bound on the routes that call an upstream (admin-limits.ts). Defaults to
   *  {@link createUpstreamCallLimiter}'s defaults. */
  readonly upstreamCallLimiter?: UpstreamCallLimiter;
  readonly maxRequestBodyBytes: number;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type AdminHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  remainderPath: string,
) => Promise<void>;

function toWireTest(providerId: string, test: StoreTestResult): LlmProviderTestResultWire {
  return {
    providerId,
    model: test.model,
    completion: test.completion,
    toolCall: test.tool_call,
    latencyMs: test.latency_ms,
    error: test.error,
    testedAt: test.tested_at,
  };
}

/** The camelCase wire projection of one merged provider — the only place the snake_case
 *  on-disk shape is translated. `credentialPresent`/`credentialSource` are computed here, per
 *  request, so the page reflects the console key store and the container's env as they are now. */
export function toWireProvider(
  provider: ResolvedProvider,
  credentialPresent: boolean,
  credentialSource: LlmProviderCredentialSourceWire,
  credentialInvalid = false,
): LlmProviderWire {
  const { config } = provider;
  return {
    id: provider.id,
    displayName: provider.displayName,
    api: config.api,
    upstreamBaseUrl: config.upstream_base_url,
    authHeader: config.auth.header,
    authScheme: config.auth.scheme ?? null,
    apiKeyEnv: config.api_key_env ?? null,
    credentialPresent,
    credentialSource,
    ...(credentialInvalid ? { credentialInvalid: true } : {}),
    enabled: provider.enabled,
    source: provider.source,
    overridesFile: provider.overridesFile,
    models: config.models.map((model) => ({
      id: model.id,
      displayName: model.display_name ?? null,
      cost: model.cost ?? null,
    })),
    lastTest: provider.lastTest ? toWireTest(provider.id, provider.lastTest) : null,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

/** Wire input → store entry (snake_case). `authScheme` defaults per header kind: `Bearer` for
 *  `authorization` (the OpenAI-family convention), none for `x-api-key` (Anthropic's) — the same
 *  two shapes config.ts documents. `enabled` defaults to `true`. `apiKeyEnv` omitted (S7-A: now
 *  optional) means this provider has no env var at all — the console key, if any, is its only
 *  credential source; a `PUT` that leaves it out clears a previously-set one, same as every other
 *  field here (full replace). */
export function inputToStoreEntry(
  input: LlmProviderInputWire,
  previous?: StoreProvider,
): Omit<StoreProvider, 'created_at' | 'updated_at'> {
  const scheme =
    input.authScheme === undefined
      ? input.authHeader === 'authorization'
        ? 'Bearer'
        : undefined
      : (input.authScheme ?? undefined);
  return {
    api: input.api,
    upstream_base_url: input.upstreamBaseUrl,
    ...(input.apiKeyEnv ? { api_key_env: input.apiKeyEnv } : {}),
    auth: { header: input.authHeader, ...(scheme ? { scheme } : {}) },
    models: input.models.map((model) => ({
      id: model.id,
      ...(model.displayName ? { display_name: model.displayName } : {}),
      ...(model.cost ? { cost: model.cost } : {}),
    })),
    ...(input.displayName ? { display_name: input.displayName } : {}),
    enabled: input.enabled ?? true,
    ...(previous?.last_test ? { last_test: previous.last_test } : {}),
  };
}

/** R-23: the comparison key for "the same upstream" — WHATWG-normalized (scheme and host
 *  lower-cased, default port dropped) with trailing slashes ignored. Any other difference, a path
 *  included, counts as a different upstream: on a shared gateway host the path can select another
 *  tenant. */
export function upstreamKey(url: string): string {
  try {
    return new URL(url).href.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

/** Which top-level fields differ between two store entries — for the audit records (values are
 *  deliberately not logged; the row can be read back from the store). */
function changedFields(
  before: Omit<StoreProvider, 'created_at' | 'updated_at'> | undefined,
  after: Omit<StoreProvider, 'created_at' | 'updated_at'>,
): string[] {
  if (!before) return Object.keys(after);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    // Lifecycle / bookkeeping fields, never "what the administrator changed".
    if (key === 'last_test' || key === 'created_at' || key === 'updated_at') continue;
    const a = JSON.stringify((before as Record<string, unknown>)[key] ?? null);
    const b = JSON.stringify((after as Record<string, unknown>)[key] ?? null);
    if (a !== b) changed.push(key);
  }
  return changed.sort();
}

export function createAdminApi(options: AdminApiOptions): AdminHandler {
  const log = options.log ?? ((line: string) => console.log(line));
  const upstreamCallLimiter = options.upstreamCallLimiter ?? createUpstreamCallLimiter();

  /** Runs `fn` — the part of a route that calls the upstream — under the caller's limits
   *  (admin-limits.ts), charging `cost` upstream calls (worst case). Over a limit → 429
   *  `rate_limited`, and the upstream is not called. */
  async function withinUpstreamLimits<T>(
    claims: LlmAdminTokenClaims,
    route: string,
    cost: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await upstreamCallLimiter.run(claims.sub, cost, fn);
    } catch (err) {
      if (!(err instanceof UpstreamCallLimitError)) throw err;
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: admin upstream call refused by the per-administrator limit',
          route,
          reason: err.reason,
          actorUserId: claims.sub,
          retryAfterSeconds: err.retryAfterSeconds,
        }),
      );
      throw new AdminApiError(429, 'rate_limited', err.message, {
        reason: err.reason,
        retryAfterSeconds: err.retryAfterSeconds,
      });
    }
  }
  const now = options.now ?? (() => new Date());
  const resolveApiKey = options.resolveApiKey ?? ((name: string) => process.env[name]);
  let modelsJsonWrittenAt: string | null = null;
  let modelsJsonError: string | null = null;

  /** S7-A resolution order: a console key for this provider id, then the env var named by
   *  `apiKeyEnv` (now optional), else none. Mirrors proxy.ts's own `resolveConsoleKey` ??
   *  `resolveApiKey` order exactly — the page must never show a source the proxy would not
   *  actually use to forward a request. */
  function credentialSource(provider: ResolvedProvider): LlmProviderCredentialSourceWire {
    if (options.keyStore.get(provider.id) !== undefined) return 'console';
    const envKey = provider.config.api_key_env
      ? resolveApiKey(provider.config.api_key_env)
      : undefined;
    if (typeof envKey === 'string' && envKey.length > 0) return 'env';
    return 'none';
  }

  function credentialPresent(provider: ResolvedProvider): boolean {
    return credentialSource(provider) !== 'none';
  }

  /** The resolved credential cannot go in a header (provider-keys.ts `checkProviderKey`): every
   *  call with it fails, so the provider card says to re-enter it. Same order as `credentialSource`. */
  function credentialInvalid(provider: ResolvedProvider): boolean {
    const key =
      options.keyStore.get(provider.id) ??
      (provider.config.api_key_env ? resolveApiKey(provider.config.api_key_env) : undefined);
    return checkProviderKey(key).kind === 'invalid';
  }

  async function rewriteModelsJson(): Promise<void> {
    try {
      await options.writeModelsJson();
      modelsJsonWrittenAt = now().toISOString();
      modelsJsonError = null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      modelsJsonError = code ? `${code}` : String(err).slice(0, 200);
      log(
        JSON.stringify({
          level: 'error',
          msg: 'llm-proxy: models.json rewrite failed — the catalog is live but pi / the kernel projection are stale until `make gen-models` or the config directory becomes writable',
          error: modelsJsonError,
        }),
      );
    }
  }

  function audit(
    claims: LlmAdminTokenClaims,
    action: KernelAuditAction,
    providerId: string,
    details: Readonly<Record<string, unknown>>,
  ): void {
    log(
      JSON.stringify({
        level: 'audit',
        msg: 'llm-proxy: provider admin',
        action,
        providerId,
        sub: claims.sub,
        jti: claims.jti,
        ...details,
      }),
    );
    if (!options.kernelAudit) return;
    void options
      .kernelAudit({ action, providerId, actorUserId: claims.sub, tokenJti: claims.jti, details })
      .catch((err: unknown) => {
        log(
          JSON.stringify({
            level: 'warn',
            msg: 'llm-proxy: kernel platform audit row could not be written (this proxy’s own audit line above stands)',
            action,
            providerId,
            error: String(err),
          }),
        );
      });
  }

  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    let raw: Buffer;
    try {
      raw = await readBufferedBody(req, options.maxRequestBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        throw new AdminApiError(413, 'body_too_large', 'request body too large');
      }
      throw err;
    }
    if (raw.length === 0) return {};
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AdminApiError(400, 'invalid_body', 'request body must be valid JSON');
    }
  }

  function requireProvider(id: string): ResolvedProvider {
    const provider = options.catalog.get(id);
    if (!provider) throw new AdminApiError(404, 'not_found', `provider "${id}" not found`);
    return provider;
  }

  function parseId(raw: string): string {
    // P3 hotfix (post-v0.16.0 review): `decodeURIComponent` itself throws `URIError` on malformed
    // percent-encoding (e.g. a lone `%`, or `%zz`) — before this, that propagated out of this
    // function uncaught, past every `AdminApiError`/`ProviderStoreError` branch in the outer
    // catch, as an unhandled 500 instead of the same 400 `invalid_id` a merely-invalid-but-
    // decodable id already gets.
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      throw new AdminApiError(400, 'invalid_id', 'invalid provider id');
    }
    const parsed = LlmProviderIdWireSchema.safeParse(id);
    if (!parsed.success) throw new AdminApiError(400, 'invalid_id', 'invalid provider id');
    return parsed.data;
  }

  async function requireWritableStore(): Promise<void> {
    if (!(await options.store.writable())) {
      throw new AdminApiError(
        503,
        'store_unwritable',
        'the provider store directory is not writable by llm-proxy — create it and give it to the container user (docs/runbooks/operations.md 供应商管理)',
      );
    }
  }

  /** S7-A: the key store lives in the same directory as the provider store — same operator step
   *  (scripts/host-llm-proxy-init.sh) fixes both — but probed independently so a `/secret` write
   *  reports its own 503 rather than borrowing the provider store's. */
  async function requireWritableKeyStore(): Promise<void> {
    if (!(await options.keyStore.writable())) {
      throw new AdminApiError(
        503,
        'store_unwritable',
        'the key store directory is not writable by llm-proxy — create it and give it to the container user (docs/runbooks/operations.md 供应商管理)',
      );
    }
  }

  /** R-23: removes the console key for `id` ahead of a write that would point that id at another
   *  upstream (or at its first one, for a new id). Runs *before* the provider write, so a key store
   *  that cannot be written fails the whole mutation (503) instead of leaving the key behind for
   *  the new host; a provider write that fails afterwards only costs re-entering the key. */
  async function clearConsoleKeyForNewUpstream(id: string): Promise<boolean> {
    if (!options.keyStore.has(id)) return false;
    await requireWritableKeyStore();
    return options.keyStore.remove(id);
  }

  /** R-23: an env var that already holds a key may only be named together with an upstream the
   *  configured provider set already pairs it with — a yaml entry (the operator's own declaration,
   *  shadowed by an override or not) or another store provider. A name that resolves to nothing
   *  yet is accepted: that is the documented flow (operations.md 供应商管理) where the operator adds
   *  the line to `secrets/llm-proxy.env` afterwards, for the upstream the page shows. Checked only
   *  when this provider's (env var, upstream) pair actually changes, so editing models, the display
   *  name or `enabled` never trips it. */
  function assertEnvKeyPairing(
    claims: LlmAdminTokenClaims,
    id: string,
    next: { readonly api_key_env?: string; readonly upstream_base_url: string },
    previous: ProviderConfig | undefined,
  ): void {
    const name = next.api_key_env;
    if (!name) return;
    const target = upstreamKey(next.upstream_base_url);
    if (previous?.api_key_env === name && upstreamKey(previous.upstream_base_url) === target) {
      return;
    }
    const value = resolveApiKey(name);
    if (typeof value !== 'string' || value.length === 0) return;
    const pairs = (config: { readonly api_key_env?: string; readonly upstream_base_url: string }) =>
      config.api_key_env === name && upstreamKey(config.upstream_base_url) === target;
    if (options.catalog.fileEntries().some(([, config]) => pairs(config))) return;
    if (options.store.entries().some(([storeId, entry]) => storeId !== id && pairs(entry))) return;
    log(
      JSON.stringify({
        level: 'warn',
        msg: 'llm-proxy: provider admin refused — an environment key may only go to an upstream it is configured for',
        providerId: id,
        apiKeyEnv: name,
        upstreamBaseUrl: next.upstream_base_url,
        sub: claims.sub,
        jti: claims.jti,
      }),
    );
    throw new AdminApiError(
      409,
      'api_key_env_not_allowed',
      `${name} already holds a key in llm-proxy's environment and is not configured for this upstream — an environment key only goes to an upstream that llm-providers.yaml or another provider already pairs it with; set a console key for this provider instead`,
    );
  }

  /** `POST /model-discovery`. Credential choice, in order — each one under the rule that already
   *  governs where that kind of key may go (R-23):
   *    1. `key` in the body: the administrator's own input, sent only to the upstream named here
   *       (exactly what saving the provider and setting that key would allow anyway);
   *    2. the stored console key of provider `id`, only when the body's upstream is that
   *       provider's current one (a console key belongs to the upstream it was entered for);
   *    3. an environment key — `apiKeyEnv` from the body, else the existing provider's own — only
   *       when `assertEnvKeyPairing` would accept that (name, upstream) pair on a save.
   *  None of them → 409 `credential_missing`. The upstream's own failure is a 502 with a
   *  sanitized message (`upstream_error` / `upstream_unreachable` / `upstream_invalid_response`). */
  /** The credential a form-driven upstream call (`/model-discovery`, `/model-probe`) may use —
   *  R-23's write-path rules: the typed `key` goes only to the upstream named in the form; a stored
   *  console key only to the upstream it was entered for; an environment key only to an upstream
   *  the configured provider set already pairs it with. */
  function resolveFormCredential(
    claims: LlmAdminTokenClaims,
    input: LlmProviderModelDiscoveryInputWire,
  ): {
    realKey: string;
    credentialSource: LlmProviderModelDiscoveryResultWire['credentialSource'];
    existing: ResolvedProvider | undefined;
  } {
    const existing = options.catalog.get(input.id);
    const sameUpstream =
      existing !== undefined &&
      upstreamKey(existing.config.upstream_base_url) === upstreamKey(input.upstreamBaseUrl);

    let realKey: string | undefined;
    let credentialSource: LlmProviderModelDiscoveryResultWire['credentialSource'] = 'inline';
    if (input.key) {
      realKey = input.key;
    } else {
      const consoleKey = sameUpstream ? options.keyStore.get(input.id) : undefined;
      if (consoleKey !== undefined) {
        realKey = consoleKey;
        credentialSource = 'console';
      } else {
        const envName =
          input.apiKeyEnv ?? (sameUpstream ? existing?.config.api_key_env : undefined);
        const envValue = envName ? resolveApiKey(envName) : undefined;
        if (envName && typeof envValue === 'string' && envValue.length > 0) {
          assertEnvKeyPairing(
            claims,
            input.id,
            { api_key_env: envName, upstream_base_url: input.upstreamBaseUrl },
            existing?.config,
          );
          realKey = envValue;
          credentialSource = 'env';
        }
      }
    }
    if (!realKey) {
      throw new AdminApiError(
        409,
        'credential_missing',
        'no key to call the provider with — enter the provider key in the form (or set the env var on the host first)',
      );
    }
    return { realKey, credentialSource, existing };
  }

  async function discoverModels(
    claims: LlmAdminTokenClaims,
    req: http.IncomingMessage,
  ): Promise<LlmProviderModelDiscoveryResultWire> {
    if (!options.listModels) {
      throw new AdminApiError(501, 'not_implemented', 'model discovery is not configured');
    }
    const parsed = LlmProviderModelDiscoveryInputWireSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      throw new AdminApiError(
        400,
        'invalid_body',
        'invalid discovery request',
        parsed.error.issues,
      );
    }
    const input = parsed.data;
    const { realKey, credentialSource, existing } = resolveFormCredential(claims, input);

    const listModels = options.listModels;
    const startedAt = now().getTime();
    const result = await withinUpstreamLimits(claims, 'model-discovery', 1, () =>
      listModels({
        api: input.api,
        upstreamBaseUrl: input.upstreamBaseUrl.replace(/\/+$/, ''),
        authHeader: input.authHeader,
        realKey,
      }),
    );
    const latencyMs = Math.max(0, now().getTime() - startedAt);
    audit(claims, 'provider_models_listed', input.id, {
      upstreamBaseUrl: input.upstreamBaseUrl,
      credentialSource,
      existing: existing !== undefined,
      ...(result.ok
        ? { count: result.models.length }
        : { failed: result.reason, status: result.status }),
    });
    if (!result.ok) {
      const code =
        result.reason === 'upstream_status'
          ? 'upstream_error'
          : result.reason === 'unreachable'
            ? 'upstream_unreachable'
            : 'upstream_invalid_response';
      throw new AdminApiError(502, code, result.message, { status: result.status });
    }
    return {
      models: [...result.models],
      credentialSource,
      truncated: result.truncated,
      latencyMs,
    };
  }

  /** `POST /model-probe`: provider-test.ts's two round trips against each picked model, with the
   *  form's own upstream and credential (resolveFormCredential) — so a model list can be checked
   *  before the provider is saved. Three at a time; nothing is stored; one audit row per call. */
  async function probeModels(
    claims: LlmAdminTokenClaims,
    req: http.IncomingMessage,
  ): Promise<LlmProviderModelProbeResultWire> {
    const parsed = LlmProviderModelProbeInputWireSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      throw new AdminApiError(400, 'invalid_body', 'invalid probe request', parsed.error.issues);
    }
    const input = parsed.data;
    const models = [...new Set(input.models)];
    const { realKey, credentialSource, existing } = resolveFormCredential(claims, input);
    const config: ProviderConfig = {
      api: input.api,
      upstream_base_url: input.upstreamBaseUrl.replace(/\/+$/, ''),
      auth: {
        header: input.authHeader,
        ...(input.authHeader === 'authorization' ? { scheme: 'Bearer' as const } : {}),
      },
      models: models.map((id) => ({ id })),
    };
    const outcomes: StoreTestResult[] = new Array(models.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < models.length) {
        const index = next;
        next += 1;
        outcomes[index] = await options.runTest(config, models[index] as string, realKey);
      }
    };
    // Worst case three calls a model: the completion, the forced tool call and its one retry.
    await withinUpstreamLimits(claims, 'model-probe', 3 * models.length, () =>
      Promise.all(Array.from({ length: Math.min(3, models.length) }, worker)),
    );
    audit(claims, 'provider_models_probed', input.id, {
      upstreamBaseUrl: input.upstreamBaseUrl,
      credentialSource,
      existing: existing !== undefined,
      results: outcomes.map((o) => ({
        model: o.model,
        completion: o.completion,
        toolCall: o.tool_call,
      })),
    });
    return {
      results: outcomes.map((o) => ({
        model: o.model,
        completion: o.completion,
        toolCall: o.tool_call,
        latencyMs: o.latency_ms,
        error: o.error,
      })),
      credentialSource,
    };
  }

  function toWire(provider: ResolvedProvider): LlmProviderWire {
    return toWireProvider(
      provider,
      credentialPresent(provider),
      credentialSource(provider),
      credentialInvalid(provider),
    );
  }

  function listResult(storeWritable: boolean): LlmProviderListWire {
    return {
      items: options.catalog.resolve().map((p) => toWire(p)),
      modelsJsonWrittenAt,
      modelsJsonError,
      storeWritable,
    };
  }

  async function handleAuthenticated(
    claims: LlmAdminTokenClaims,
    req: http.IncomingMessage,
    remainderPath: string,
  ): Promise<{ status: number; body: unknown }> {
    const pathOnly = remainderPath.split('?')[0] ?? '';
    const segments = pathOnly.split('/').filter((segment) => segment.length > 0);
    const method = req.method ?? 'GET';

    if (segments[0] === 'model-probe' && segments.length === 1) {
      if (method !== 'POST') {
        throw new AdminApiError(405, 'method_not_allowed', 'method not allowed');
      }
      return { status: 200, body: await probeModels(claims, req) };
    }
    if (segments[0] === 'model-discovery' && segments.length === 1) {
      if (method !== 'POST') {
        throw new AdminApiError(405, 'method_not_allowed', 'method not allowed');
      }
      return { status: 200, body: await discoverModels(claims, req) };
    }

    if (segments[0] !== 'providers') {
      throw new AdminApiError(404, 'not_found', 'not found');
    }

    // GET /providers · POST /providers
    if (segments.length === 1) {
      if (method === 'GET') {
        return { status: 200, body: listResult(await options.store.writable()) };
      }
      if (method === 'POST') {
        await requireWritableStore();
        const parsed = LlmProviderInputWireSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          throw new AdminApiError(400, 'invalid_body', 'invalid provider', parsed.error.issues);
        }
        const input = parsed.data;
        if (LLM_PROVIDER_RESERVED_IDS.includes(input.id)) {
          throw new AdminApiError(409, 'reserved_id', `provider id "${input.id}" is reserved`);
        }
        if (options.catalog.get(input.id)) {
          throw new AdminApiError(
            409,
            'provider_exists',
            `provider "${input.id}" already exists — edit it with PUT`,
          );
        }
        const entry = inputToStoreEntry(input);
        assertEnvKeyPairing(claims, input.id, entry, undefined);
        // R-23: a console key left under this id (only possible when a DELETE's best-effort clear
        // failed) was entered for a provider that no longer exists, not for this upstream.
        const secretCleared = await clearConsoleKeyForNewUpstream(input.id);
        await options.store.upsert(input.id, entry, now());
        await rewriteModelsJson();
        const created = requireProvider(input.id);
        audit(claims, 'provider_created', input.id, {
          api: entry.api,
          upstreamBaseUrl: entry.upstream_base_url,
          apiKeyEnv: entry.api_key_env ?? null,
          models: entry.models.map((m) => m.id),
          enabled: entry.enabled,
          modelsJsonError,
          ...(secretCleared ? { secretCleared } : {}),
        });
        if (secretCleared) {
          audit(claims, 'provider_secret_cleared', input.id, { reason: 'new_provider' });
        }
        return { status: 201, body: toWire(created) };
      }
      throw new AdminApiError(405, 'method_not_allowed', 'method not allowed');
    }

    const id = parseId(segments[1] ?? '');

    // GET / PUT / DELETE /providers/:id
    if (segments.length === 2) {
      if (method === 'GET') {
        const provider = requireProvider(id);
        return { status: 200, body: toWire(provider) };
      }
      if (method === 'PUT') {
        await requireWritableStore();
        const existing = requireProvider(id);
        const parsed = LlmProviderInputWireSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          throw new AdminApiError(400, 'invalid_body', 'invalid provider', parsed.error.issues);
        }
        if (parsed.data.id !== id) {
          throw new AdminApiError(400, 'id_mismatch', 'body id must match the path');
        }
        const previous = options.store.get(id);
        const before = previous ? previous : { ...existing.config, enabled: true }; // a file entry, about to be overridden
        const entry = inputToStoreEntry(parsed.data, previous);
        assertEnvKeyPairing(claims, id, entry, existing.config);
        // R-23: the console key was entered for the upstream this provider uses now. A change of
        // `api` or auth header keeps it — the key still goes to the same host.
        const fromUpstream = existing.config.upstream_base_url;
        const upstreamChanged = upstreamKey(fromUpstream) !== upstreamKey(entry.upstream_base_url);
        const secretCleared = upstreamChanged ? await clearConsoleKeyForNewUpstream(id) : false;
        await options.store.upsert(id, entry, now());
        await rewriteModelsJson();
        const updated = requireProvider(id);
        audit(claims, 'provider_updated', id, {
          changed: changedFields(before, entry),
          overridesFile: updated.overridesFile,
          enabled: entry.enabled,
          modelsJsonError,
          ...(upstreamChanged
            ? {
                upstreamBaseUrl: { from: fromUpstream, to: entry.upstream_base_url },
                secretCleared,
              }
            : {}),
        });
        if (secretCleared) {
          audit(claims, 'provider_secret_cleared', id, { reason: 'upstream_changed' });
        }
        return { status: 200, body: toWire(updated) };
      }
      if (method === 'DELETE') {
        await requireWritableStore();
        const existing = requireProvider(id);
        if (!options.store.get(id)) {
          throw new AdminApiError(
            409,
            'provider_from_file',
            `provider "${id}" comes from llm-providers.yaml — remove it there (or disable it here)`,
          );
        }
        const restoredFileEntry = existing.overridesFile;
        await options.store.remove(id);
        await rewriteModelsJson();
        // P2 hotfix (post-v0.16.0 review): a deleted provider's console key used to be left behind
        // in the key store — recreating the same id later would silently reuse it against a
        // possibly different upstream. Best-effort, same "a secondary write's failure never fails
        // the mutation" convention `rewriteModelsJson` above already uses: the provider row is
        // already gone (the source of truth), so an unwritable key store here is logged, not fatal.
        let secretCleared = false;
        try {
          secretCleared = await options.keyStore.remove(id);
        } catch (err) {
          log(
            JSON.stringify({
              level: 'warn',
              msg: 'llm-proxy: could not clear the console key for a deleted provider (best-effort)',
              providerId: id,
              error: String(err),
            }),
          );
        }
        audit(claims, 'provider_deleted', id, {
          restoredFileEntry,
          modelsJsonError,
          secretCleared,
        });
        if (secretCleared) {
          audit(claims, 'provider_secret_cleared', id, {});
        }
        const body: DeleteLlmProviderResultWire = {
          id,
          deleted: true,
          restoredFileEntry,
          secretCleared,
        };
        return { status: 200, body };
      }
      throw new AdminApiError(405, 'method_not_allowed', 'method not allowed');
    }

    if (segments.length === 3) {
      // POST /providers/:id/test
      if (segments[2] === 'test' && method === 'POST') {
        const provider = requireProvider(id);
        const parsed = LlmProviderTestInputWireSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          throw new AdminApiError(400, 'invalid_body', 'invalid test request', parsed.error.issues);
        }
        const model = parsed.data.model ?? provider.config.models[0]?.id;
        if (!model || !provider.config.models.some((m) => m.id === model)) {
          throw new AdminApiError(400, 'model_not_allowed', 'model is not on this provider');
        }
        // A base saved before the bare-base rule (#510) is never called — not even to test it.
        const baseProblem = upstreamBaseUrlProblem(provider.config.upstream_base_url);
        if (baseProblem) {
          throw new AdminApiError(
            409,
            'upstream_base_url_invalid',
            `this provider's upstream base URL ${baseProblem} — edit the provider to fix it`,
          );
        }
        // S7-A: same resolution order as proxy.ts and credentialSource() above — a console key
        // wins over apiKeyEnv, so the test exercises exactly the key a real request would use.
        const realKey =
          options.keyStore.get(id) ??
          (provider.config.api_key_env ? resolveApiKey(provider.config.api_key_env) : undefined);
        if (!realKey) {
          throw new AdminApiError(
            409,
            'credential_missing',
            provider.config.api_key_env
              ? `${provider.config.api_key_env} is not set in llm-proxy's environment — set it in secrets/llm-proxy.env and recreate the container, or set a key for this provider in the console`
              : 'no key is configured for this provider — set one in the console',
          );
        }
        const result = await withinUpstreamLimits(claims, 'test', 3, () =>
          options.runTest(provider.config, model, realKey),
        );
        await options.catalog.recordTest(id, result).catch((err: unknown) => {
          log(
            JSON.stringify({
              level: 'warn',
              msg: 'llm-proxy: could not persist the provider test result',
              providerId: id,
              error: String(err),
            }),
          );
        });
        audit(claims, 'provider_tested', id, {
          model,
          completion: result.completion,
          toolCall: result.tool_call,
          latencyMs: result.latency_ms,
        });
        return { status: 200, body: toWireTest(id, result) };
      }

      // PUT (or POST — the original design's route, plan §6) /providers/:id/secret: set/replace
      // the console key. DELETE: clear it (falls back to apiKeyEnv, or no credential). Never
      // rewrites models.json (see the module doc comment) and never logs/audits the value itself.
      if (segments[2] === 'secret') {
        if (method === 'PUT' || method === 'POST') {
          await requireWritableKeyStore();
          requireProvider(id);
          const parsed = LlmProviderSecretInputWireSchema.safeParse(await readJsonBody(req));
          if (!parsed.success) {
            throw new AdminApiError(400, 'invalid_body', 'invalid key', parsed.error.issues);
          }
          await options.keyStore.set(id, parsed.data.key);
          const updated = requireProvider(id);
          audit(claims, 'provider_secret_set', id, {});
          return { status: 200, body: toWire(updated) };
        }
        if (method === 'DELETE') {
          await requireWritableKeyStore();
          requireProvider(id);
          await options.keyStore.remove(id);
          const updated = requireProvider(id);
          audit(claims, 'provider_secret_cleared', id, {});
          return { status: 200, body: toWire(updated) };
        }
        throw new AdminApiError(405, 'method_not_allowed', 'method not allowed');
      }
    }

    throw new AdminApiError(404, 'not_found', 'not found');
  }

  return async (req, res, remainderPath) => {
    let claims: LlmAdminTokenClaims;
    try {
      claims = await authenticateAdminRequest(req.headers, { publicKey: options.publicKey });
    } catch (err) {
      if (err instanceof AdminAuthError) {
        log(
          JSON.stringify({
            level: 'warn',
            msg: 'llm-proxy: admin auth failed',
            reason: err.reason,
            path: remainderPath.split('?')[0],
          }),
        );
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }

    try {
      const { status, body } = await handleAuthenticated(claims, req, remainderPath);
      sendJson(res, status, body);
    } catch (err) {
      if (err instanceof AdminApiError) {
        sendJson(res, err.status, {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
        });
        return;
      }
      if (err instanceof ProviderStoreError) {
        sendJson(res, err.code === 'unwritable' ? 503 : 500, {
          error: { code: `store_${err.code}`, message: err.message },
        });
        return;
      }
      // P3 hotfix (post-v0.16.0 review): a `KeyStoreError` from anywhere not already behind an
      // explicit `requireWritableKeyStore()` guard (e.g. a TOCTOU between that probe and the
      // actual write, or `keyStore.remove()`'s best-effort call inside the provider-DELETE path
      // above surfacing here instead of being swallowed there) gets the same mapping
      // `ProviderStoreError` already has, same code prefix.
      if (err instanceof KeyStoreError) {
        sendJson(res, err.code === 'unwritable' ? 503 : 500, {
          error: { code: `store_${err.code}`, message: err.message },
        });
        return;
      }
      throw err;
    }
  };
}
