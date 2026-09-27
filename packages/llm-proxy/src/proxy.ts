import http from 'node:http';
import { CORRELATION_ID_HEADER, type HandleClaims, resolveCorrelationId } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { ExhaustedBudgetRow } from './budget-sync.js';
import type { ProviderApiKind, ProviderConfig } from './config.js';
import { HandleAuthError, extractHandleToken, verifyInboundHandle } from './handle-auth.js';
import { BodyTooLargeError, readBufferedBody, sendJson } from './http-util.js';
import { type LlmProxyMetrics, createLlmProxyMetrics, respondMetrics } from './metrics.js';
import type { LlmUsageRecord, LlmUsageRecordContext } from './report.js';
import { computeCostUsd, createStreamUsageAccumulator, parseUsageFromJsonBody } from './usage.js';

/**
 * proxy: the per-provider passthrough HTTP server (design doc §7.7; docs/development-tasks.md
 * S1.7). One route family per provider name: `/<provider>/v1/*` (OpenAI-compatible — chat/
 * completions, responses, models) and `/<provider>/v1/messages` (Anthropic) — see config.ts's
 * `ProviderConfigSchema.upstream_base_url` doc comment for exactly how an inbound path maps onto
 * the upstream URL (strip only the leading `/<provider>` segment, forward the rest verbatim).
 *
 * Request flow: parse `<provider>` from the path → verify the Handle from the provider's
 * configured header (401 on missing/invalid/expired/revoked) → for `GET .../v1/models`,
 * synthesize the response from the provider's whitelist without ever calling upstream (never
 * leaks a non-whitelisted model id) → otherwise check the request against `ACTION_PATH_BY_API`
 * (design/review lane-6 P1-2): exactly one (method, path) per provider `api` kind is forwardable
 * — anything else (multipart uploads, files, fine-tuning, batches, DELETE, any other path) is
 * rejected with 404/405 **without ever contacting upstream** — then buffer the request body
 * (capped), require it to parse as a JSON object with a non-empty string `model` (400 otherwise —
 * this proxy is JSON-only, no passthrough for opaque/non-JSON bodies), 403 if `model` is not
 * whitelisted, and — the one deliberate body mutation (S1.7 task brief) — for an
 * `openai-completions`/`openai-responses` streaming request, force `stream_options.include_usage:
 * true` so the final chunk carries usage → strip both `authorization` and `x-api-key` from the
 * forwarded headers (never let a client sneak a Handle upstream through the header the provider
 * *isn't* configured to use) and set the provider's configured header to the real key from
 * `process.env[api_key_env]` → forward to `upstream_base_url` → stream the response back
 * **byte-for-byte untouched** while a parallel, non-mutating read extracts usage (usage.ts) →
 * report the parsed usage (report.ts).
 *
 * Response bytes are never altered, streaming or not — only the outbound *request* body is ever
 * mutated, and only in the one case above.
 *
 * Leftover 87: every request gets a correlation id — the caller's `x-correlation-id` when valid
 * (the platform extension sends the Turn id / the Worker's inherited id on every model call), else
 * a minted one — echoed back, written into each log line and the usage line, and **stripped**
 * before anything goes upstream (an internal id never reaches a third-party provider). `GET
 * /internal/metrics` (metrics.ts) is answered before any provider routing, internal-token guarded.
 */

/**
 * The single forwardable (method, path) pair per provider `api` kind — everything else 404/405s
 * before the request body is even read, let alone forwarded. `remainderPath` is the inbound path
 * with the leading `/<provider>` segment already stripped (see `handleRequest` below), so this is
 * exactly the suffix `gen-models-json.ts`'s `baseUrl` composition implies each `api` kind's SDK
 * appends: `openai`'s SDK appends `/chat/completions` or `/responses` onto a `baseUrl` already
 * ending in `/v1`; `@anthropic-ai/sdk` appends `/v1/messages` onto a bare origin. Multipart/file/
 * batch/fine-tuning endpoints and any HTTP verb other than POST for these paths (e.g. DELETE) are
 * deliberately absent — this proxy exists to forward one chat-completion shape per provider, not
 * to be a general passthrough for whatever the provider account can otherwise do.
 */
const ACTION_PATH_BY_API: Readonly<Record<ProviderApiKind, string>> = {
  'openai-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic-messages': '/v1/messages',
};

const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept-encoding',
  // Both possible Handle-carrying headers are always stripped, regardless of which one this
  // provider is configured to use — a client must never be able to smuggle a Handle upstream
  // through the *other* header name.
  'authorization',
  'x-api-key',
  // Leftover 87: the platform's internal correlation id stays inside the platform.
  CORRELATION_ID_HEADER,
]);

const STRIPPED_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection']);

function buildOutboundHeaders(
  reqHeaders: http.IncomingHttpHeaders,
  provider: ProviderConfig,
  realKey: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  // Always request plaintext upstream: this proxy must parse the SSE body to extract usage, and
  // controls its own outbound request independent of what the original client's own
  // Accept-Encoding asked for (S1.7 assumption — see PR body "假设与偏离").
  headers.set('accept-encoding', 'identity');
  headers.set(
    provider.auth.header,
    provider.auth.scheme ? `${provider.auth.scheme} ${realKey}` : realKey,
  );
  return headers;
}

function upstreamHeadersToNodeHeaders(headers: Headers): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) result[key] = value;
  });
  return result;
}

/**
 * Synthesizes an OpenAI-shaped `/v1/models` list from the provider's own whitelist, instead of
 * forwarding to upstream (S1.7 dispatch note: forwarding would leak every model the real
 * provider account can see, not just the ones this Handle is allowed to use).
 */
function respondModelsList(
  res: http.ServerResponse,
  providerName: string,
  provider: ProviderConfig,
): void {
  sendJson(res, 200, {
    object: 'list',
    data: provider.models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: providerName,
    })),
  });
}

interface ParsedRequestBody {
  /** The exact bytes to forward upstream — identical to the inbound body unless mutated below. */
  readonly outboundBody: Buffer;
  readonly modelId: string;
}

export class InvalidRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestBodyError';
  }
}

/** Parses the buffered request body as JSON — this proxy is JSON-only for the one forwardable
 *  action route per provider (see `ACTION_PATH_BY_API`); an empty body, non-JSON content, a
 *  non-object body, or a missing/empty `model` field all throw `InvalidRequestBodyError` (400),
 *  never silently pass through to upstream. Applies the one deliberate mutation once the body is
 *  known-valid: for `openai-completions`/`openai-responses` with `stream: true`, forces
 *  `stream_options.include_usage = true`. */
function parseAndMaybeMutateBody(raw: Buffer, provider: ProviderConfig): ParsedRequestBody {
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined;
  } catch {
    throw new InvalidRequestBodyError('request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequestBodyError('request body must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  const modelId = obj.model;
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new InvalidRequestBodyError('request body must set a non-empty string "model"');
  }
  const isStreaming = obj.stream === true;

  if (provider.api !== 'anthropic-messages' && isStreaming) {
    const existingStreamOptions =
      typeof obj.stream_options === 'object' && obj.stream_options !== null
        ? (obj.stream_options as Record<string, unknown>)
        : {};
    obj.stream_options = { ...existingStreamOptions, include_usage: true };
    return { outboundBody: Buffer.from(JSON.stringify(obj), 'utf8'), modelId };
  }

  return { outboundBody: raw, modelId };
}

export interface ProxyServerOptions {
  /** The routing table. A plain record (S1.7 shape, still what most tests pass) is read as-is;
   *  a function is consulted per request — S6-B's `ProviderCatalog.getRoutable`, so a provider
   *  the administrator just created, edited or disabled through the admin API is honoured by the
   *  very next request with no restart (catalog.ts "hot reload"). A disabled provider is
   *  `undefined` here, i.e. 404 `unknown_provider` — indistinguishable from a name that never
   *  existed, by design. */
  readonly providers:
    | Readonly<Record<string, ProviderConfig>>
    | ((name: string) => ProviderConfig | undefined);
  readonly publicKey: CryptoKey;
  readonly isRevoked: (jti: string) => boolean;
  /** S6-B leftover 19 (budget-sync.ts): consulted after Handle verification, before anything is
   *  forwarded. A row means "answer 402 `budget_exhausted` for this workspace" — see
   *  `BUDGET_EXHAUSTED_STATUS` below for why 402 and not 429. Optional: absent (tests, a kernel-
   *  less proxy) means never exhausted. */
  readonly isBudgetExhausted?: (workspaceId: string) => ExhaustedBudgetRow | undefined;
  /** S6-B (admin-api.ts): handles every request whose first path segment is `admin` — the
   *  provider-management endpoints caddy exposes as `/api/llm-admin/*`. Optional: absent means
   *  404 like any other unknown provider name (`admin` is reserved either way, config.ts). */
  readonly adminHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    remainderPath: string,
  ) => Promise<void>;
  readonly reporter: { record(record: LlmUsageRecord, context?: LlmUsageRecordContext): void };
  readonly maxRequestBodyBytes: number;
  /** Ceiling for establishing the upstream connection / receiving response headers. */
  readonly upstreamConnectTimeoutMs: number;
  /** Ceiling for the gap between successive response chunks once streaming has started — kept
   *  generous by default (config.ts), since a thinking model can stall for tens of seconds
   *  mid-stream. */
  readonly upstreamIdleTimeoutMs: number;
  /** Resolves `api_key_env` to the real provider key. Defaults to `process.env[name]` — injected
   *  in tests. */
  readonly resolveApiKey?: (envVarName: string) => string | undefined;
  /** S7-A: the console-written key for a provider id (key-store.ts `KeyStore.get`), consulted
   *  *before* `resolveApiKey`/`api_key_env` for every forwarded request — "console overrides env"
   *  holds even for a file/yaml provider. Absent (no key store configured) or returning
   *  `undefined` falls through to `resolveApiKey` exactly as before S7-A. */
  readonly resolveConsoleKey?: (providerId: string) => string | undefined;
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `console.log`; overridable for tests. Never receives a key, a Handle, or a
   *  request/response body — see the calls below. */
  readonly log?: (line: string) => void;
  /** Leftover 87: this process's metric set; omitted (tests) → a fresh one. */
  readonly metrics?: LlmProxyMetrics;
  /** Leftover 87: the internal-plane `Authorization` value (`Bearer <internal_token>`) that
   *  `GET /internal/metrics` requires; `undefined` (no kernel configured) → that route always 401s. */
  readonly internalAuthorizationHeader?: string;
}

/**
 * S6-B leftover 19: the status for a budget-exhausted workspace. 402 rather than 429 on purpose:
 * both official SDKs pi wraps (`openai`, `@anthropic-ai/sdk`) retry a 429 automatically with
 * backoff before surfacing it, which would turn a hard "no more spend today" into several
 * seconds of silent retries and then the same error; neither retries a 402, so the agent sees
 * the structured `budget_exhausted` body on the first attempt and can relay it (design doc I18:
 * "入口 agent 得知"). The body keeps the `{error: {code, message}}` shape every other refusal
 * here uses, plus the scope / numbers the kernel reported so the message is concrete.
 */
export const BUDGET_EXHAUSTED_STATUS = 402;

export function createProxyServer(options: ProxyServerOptions): http.Server {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveApiKey = options.resolveApiKey ?? ((name: string) => process.env[name]);
  const log = options.log ?? ((line: string) => console.log(line));
  const providersOption = options.providers;
  const lookupProvider: (name: string) => ProviderConfig | undefined =
    typeof providersOption === 'function'
      ? providersOption
      : (name: string) => providersOption[name];
  const isBudgetExhausted = options.isBudgetExhausted ?? (() => undefined);
  const metrics = options.metrics ?? createLlmProxyMetrics();

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    correlationId: string,
  ): Promise<void> {
    const startedAt = new Date();
    const url = new URL(req.url ?? '/', 'http://llm-proxy.internal');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/internal/metrics') {
      respondMetrics(req, res, {
        authorizationHeader: options.internalAuthorizationHeader,
        render: metrics.render,
      });
      return;
    }

    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    const providerName = segments[0];
    const remainderPath = `/${segments.slice(1).join('/')}`;

    // S6-B: `/admin/*` is the provider-management API (admin-api.ts), authenticated by its own
    // 5-minute platform JWT — never by a Handle. `admin` is a reserved provider name (config.ts).
    if (providerName === 'admin' && options.adminHandler) {
      await options.adminHandler(req, res, `${remainderPath}${url.search}`);
      return;
    }

    const provider = providerName ? lookupProvider(providerName) : undefined;
    // Leftover 87: one `requests_total` sample per model-traffic request, labelled only with a
    // configured provider id and (once validated below) an allowlisted model — never raw input.
    const observed = { provider: provider && providerName ? providerName : 'unknown', model: '' };
    res.once('finish', () =>
      metrics.recordRequest(observed.provider, observed.model, res.statusCode),
    );
    if (!providerName || !provider) {
      sendJson(res, 404, { error: { code: 'unknown_provider', message: 'unknown provider' } });
      return;
    }

    let claims: HandleClaims;
    try {
      const token = extractHandleToken(req.headers, provider.auth);
      claims = await verifyInboundHandle(token, {
        publicKey: options.publicKey,
        isRevoked: options.isRevoked,
      });
    } catch (err) {
      if (err instanceof HandleAuthError) {
        log(
          JSON.stringify({
            level: 'warn',
            msg: 'llm-proxy: handle auth failed',
            correlationId,
            provider: providerName,
            reason: err.reason,
          }),
        );
        sendJson(res, 401, { error: { code: 'unauthorized', message: 'unauthorized' } });
        return;
      }
      throw err;
    }

    // S6-B leftover 19 (design doc I18 "到 100% 时 llm-proxy 返回预算耗尽错误"): refused after the
    // Handle is verified (an unauthenticated caller learns nothing about a workspace's budget)
    // and before the request body is read, let alone forwarded — no upstream spend at all. The
    // model list stays answerable: it is synthesized locally and costs nothing.
    const exhausted = isBudgetExhausted(claims.ws);
    if (exhausted && !(req.method === 'GET' && remainderPath === '/v1/models')) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: refused, workspace budget exhausted',
          correlationId,
          provider: providerName,
          workspaceId: claims.ws,
          scope: exhausted.scope,
        }),
      );
      sendJson(res, BUDGET_EXHAUSTED_STATUS, {
        error: {
          code: 'budget_exhausted',
          message: `workspace budget exhausted (${exhausted.scope}: ${exhausted.spent} of ${exhausted.budget}); resets at ${exhausted.until}`,
          scope: exhausted.scope,
          budget: exhausted.budget,
          spent: exhausted.spent,
          resetsAt: exhausted.until,
        },
      });
      return;
    }

    if (req.method === 'GET' && remainderPath === '/v1/models') {
      respondModelsList(res, providerName, provider);
      return;
    }

    // Allowlist: exactly one (method, path) is forwardable for this provider's `api` kind.
    // Everything else — multipart uploads, files, fine-tuning, batches, DELETE, any other path —
    // 404/405s here, before the body is even read, let alone forwarded upstream (P1-2).
    const actionPath = ACTION_PATH_BY_API[provider.api];
    if (remainderPath !== actionPath) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: { code: 'method_not_allowed', message: 'method not allowed' },
      });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBufferedBody(req, options.maxRequestBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, {
          error: { code: 'body_too_large', message: 'request body too large' },
        });
        return;
      }
      throw err;
    }

    let outboundBody: Buffer;
    let modelId: string;
    try {
      ({ outboundBody, modelId } = parseAndMaybeMutateBody(rawBody, provider));
    } catch (err) {
      if (err instanceof InvalidRequestBodyError) {
        sendJson(res, 400, { error: { code: 'invalid_request_body', message: err.message } });
        return;
      }
      throw err;
    }

    if (!provider.models.some((model) => model.id === modelId)) {
      sendJson(res, 403, { error: { code: 'model_not_allowed', message: 'model not allowed' } });
      return;
    }
    observed.model = modelId;

    // S7-A resolution order: a console key for this provider id, then the env var named by
    // `api_key_env` (now optional — a store provider may have none), else no key at all.
    const realKey =
      options.resolveConsoleKey?.(providerName) ??
      (provider.api_key_env ? resolveApiKey(provider.api_key_env) : undefined);
    if (!realKey) {
      log(
        JSON.stringify({
          level: 'error',
          msg: 'llm-proxy: no provider key resolved (no console key, and api_key_env is unset or its env var is empty)',
          correlationId,
          provider: providerName,
          envVar: provider.api_key_env ?? null,
        }),
      );
      sendJson(res, 502, {
        error: { code: 'upstream_not_configured', message: 'upstream not configured' },
      });
      return;
    }

    const outboundHeaders = buildOutboundHeaders(req.headers, provider, realKey);
    if (outboundBody.length > 0) {
      outboundHeaders.set('content-length', String(outboundBody.length));
    }

    const upstreamUrl = `${provider.upstream_base_url}${remainderPath}${url.search}`;

    const controller = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const armTimeout = (ms: number): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => controller.abort(new Error('upstream timeout')), ms);
      timeoutHandle.unref?.();
    };
    armTimeout(options.upstreamConnectTimeoutMs);

    const upstreamStartedMs = Date.now();
    let upstreamRes: Response;
    try {
      upstreamRes = await fetchImpl(upstreamUrl, {
        method: req.method,
        headers: outboundHeaders,
        body: outboundBody.length > 0 ? outboundBody : undefined,
        signal: controller.signal,
      });
    } catch {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      metrics.observeUpstream(
        providerName,
        modelId,
        'error',
        (Date.now() - upstreamStartedMs) / 1000,
      );
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: upstream request failed',
          correlationId,
          provider: providerName,
          model: modelId,
        }),
      );
      sendJson(res, 502, { error: { code: 'bad_gateway', message: 'upstream request failed' } });
      return;
    }

    armTimeout(options.upstreamIdleTimeoutMs);
    res.writeHead(upstreamRes.status, upstreamHeadersToNodeHeaders(upstreamRes.headers));

    const contentType = upstreamRes.headers.get('content-type') ?? '';
    const isSse = contentType.includes('text/event-stream');
    const usageAccumulator = isSse ? createStreamUsageAccumulator(provider.api) : undefined;
    const decoder = new TextDecoder();
    let nonSseText = '';
    let streamError: unknown;

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armTimeout(options.upstreamIdleTimeoutMs);
          res.write(value);
          if (isSse) {
            usageAccumulator?.push(decoder.decode(value, { stream: true }));
          } else {
            nonSseText += decoder.decode(value, { stream: true });
          }
        }
      } catch (err) {
        streamError = err;
      }
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    res.end();

    let parsedUsage = isSse ? usageAccumulator?.result() : undefined;
    if (!isSse && !streamError && nonSseText.length > 0) {
      try {
        parsedUsage = parseUsageFromJsonBody(provider.api, JSON.parse(nonSseText));
      } catch {
        // Not JSON (or malformed) — no usage to report for this response.
      }
    }

    const finishedAt = new Date();
    const upstreamOutcome = streamError || !upstreamRes.ok ? 'error' : 'completed';
    metrics.observeUpstream(
      providerName,
      modelId,
      upstreamOutcome,
      (finishedAt.getTime() - upstreamStartedMs) / 1000,
    );
    metrics.recordTokens(
      providerName,
      modelId,
      parsedUsage?.inputTokens ?? 0,
      parsedUsage?.outputTokens ?? 0,
    );
    const modelConfig = modelId ? provider.models.find((m) => m.id === modelId) : undefined;
    options.reporter.record(
      {
        workspaceId: claims.ws,
        sessionId: claims.sid,
        jti: claims.jti,
        provider: providerName,
        model: modelId ?? 'unknown',
        inputTokens: parsedUsage?.inputTokens ?? 0,
        outputTokens: parsedUsage?.outputTokens ?? 0,
        ...(parsedUsage?.cacheReadTokens !== undefined
          ? { cacheReadTokens: parsedUsage.cacheReadTokens }
          : {}),
        ...(parsedUsage?.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: parsedUsage.cacheWriteTokens }
          : {}),
        ...(parsedUsage && modelConfig?.cost
          ? { costUsd: computeCostUsd(modelConfig.cost, parsedUsage) }
          : {}),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        status: upstreamOutcome,
      },
      { correlationId },
    );
  }

  const server = http.createServer((req, res) => {
    const correlationId = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    void handleRequest(req, res, correlationId).catch((err: unknown) => {
      log(
        JSON.stringify({
          level: 'error',
          msg: 'llm-proxy: unhandled request error',
          correlationId,
          error: String(err),
        }),
      );
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'internal_error', message: 'internal error' } });
      } else {
        res.end();
      }
    });
  });

  return server;
}
