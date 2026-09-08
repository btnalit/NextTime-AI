import http from 'node:http';
import type { HandleClaims } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { ProviderApiKind, ProviderConfig } from './config.js';
import { HandleAuthError, extractHandleToken, verifyInboundHandle } from './handle-auth.js';
import type { LlmUsageRecord } from './report.js';
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

export class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

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
]);

const STRIPPED_RESPONSE_HEADERS = new Set(['transfer-encoding', 'connection']);

function readBufferedBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
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
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly publicKey: CryptoKey;
  readonly isRevoked: (jti: string) => boolean;
  readonly reporter: { record(record: LlmUsageRecord): void };
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
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `console.log`; overridable for tests. Never receives a key, a Handle, or a
   *  request/response body — see the calls below. */
  readonly log?: (line: string) => void;
}

export function createProxyServer(options: ProxyServerOptions): http.Server {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveApiKey = options.resolveApiKey ?? ((name: string) => process.env[name]);
  const log = options.log ?? ((line: string) => console.log(line));

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = new Date();
    const url = new URL(req.url ?? '/', 'http://llm-proxy.internal');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    const providerName = segments[0];
    const provider = providerName ? options.providers[providerName] : undefined;
    if (!providerName || !provider) {
      sendJson(res, 404, { error: { code: 'unknown_provider', message: 'unknown provider' } });
      return;
    }
    const remainderPath = `/${segments.slice(1).join('/')}`;

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
            provider: providerName,
            reason: err.reason,
          }),
        );
        sendJson(res, 401, { error: { code: 'unauthorized', message: 'unauthorized' } });
        return;
      }
      throw err;
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

    const realKey = resolveApiKey(provider.api_key_env);
    if (!realKey) {
      log(
        JSON.stringify({
          level: 'error',
          msg: 'llm-proxy: provider api key env var is unset',
          provider: providerName,
          envVar: provider.api_key_env,
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
    const modelConfig = modelId ? provider.models.find((m) => m.id === modelId) : undefined;
    options.reporter.record({
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
      status: streamError || !upstreamRes.ok ? 'error' : 'completed',
    });
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      log(
        JSON.stringify({
          level: 'error',
          msg: 'llm-proxy: unhandled request error',
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
