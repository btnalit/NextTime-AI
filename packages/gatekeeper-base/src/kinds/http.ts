import type { Operation } from '@nexttime/shared';
import { BindingKindMismatchError, TransportInvokeError } from '../errors.js';
import type { Transport, TransportInvokeContext, TransportInvokeResult } from './types.js';

/**
 * `http` transport (design doc §7.5): calls a REST endpoint from the Operation's `binding` (a
 * `{method, path}` pair). `importOpenApi` turns an OpenAPI document into a manifest draft — GET →
 * observe, every other verb → execute, with a default blast radius by verb (design doc §7.5:
 * "GET → observe，其余 → execute 并按动词给默认影响半径"). All imported `execute` Operations are
 * `auto_approvable: false, await_decision: true` (owner review before publish is the gate, I17).
 */

export interface HttpTransportOptions {
  /** The target system's base URL — resolved from the Gatekeeper's own connection config, never
   *  hardcoded (credentials/target never live in kernel source, design doc §11). */
  readonly baseUrl: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 10s). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Decodes every `%XX` escape byte-wise (never throws on a malformed sequence, unlike
 *  `decodeURIComponent`) — enough to see an encoded `.`, `/` or a backslash. */
function decodePercentEscapes(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** At most this many rounds of decoding are looked through; a value still encoded after that is
 *  refused rather than guessed at. */
const MAX_DECODE_ROUNDS = 4;

/** `true` when `raw` can only ever name one path segment, however many times a server decodes
 *  it: not empty, not `.` / `..`, no `/` or backslash — in the raw value or in any decoding of it. */
function isSinglePathSegment(raw: string): boolean {
  let current = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    if (current.length === 0 || current === '.' || current === '..' || /[/\\]/.test(current)) {
      return false;
    }
    const decoded = decodePercentEscapes(current);
    if (decoded === current) return true;
    current = decoded;
  }
  return false;
}

/**
 * R-22 (review 2026-10-02): one templated path parameter, encoded as exactly one path segment —
 * or refused before any request is made. `encodeURIComponent` alone leaves `.` and `..` as they
 * are, so `{dataset_id: '..'}` turned `/api/v1/datasets/{dataset_id}/documents` into
 * `/api/v1/documents`: an endpoint no Operation publishes, called with the gate's own credential
 * under an approval that named another target (I17, RL2). An empty value collapses a segment the
 * same way (and `//host` at the start of a path would even change the host). Refused: a missing
 * or empty value, `.`, `..`, and anything containing `/` or a backslash — in the raw value or after any
 * percent-decoding (`%2e%2e`, `%252F`, …), since the target may decode more than once.
 */
export function encodePathSegment(name: string, value: unknown): string {
  if (value === undefined || value === null) {
    throw new TransportInvokeError(`http transport: path parameter "${name}" is required`);
  }
  const raw = String(value);
  if (!isSinglePathSegment(raw)) {
    throw new TransportInvokeError(
      `http transport: path parameter "${name}" must be a single path segment — no "/", "\\", "." or ".." in any encoding`,
    );
  }
  return encodeURIComponent(raw);
}

/** Substitutes `{name}` path segments from `params` (each through `encodePathSegment`); returns
 *  the rendered path and the set of param names consumed (so callers can put the rest on the query
 *  string / JSON body). */
function renderPath(
  path: string,
  params: Record<string, unknown>,
): { path: string; used: Set<string> } {
  const used = new Set<string>();
  const rendered = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    used.add(name);
    return encodePathSegment(name, params[name]);
  });
  return { path: rendered, used };
}

/**
 * R-22: the request URL for a binding path under the target's base URL. The binding path is
 * appended to the base URL's own path — `new URL('/api/v1/x', 'https://host/ragflow/')` used to
 * drop `/ragflow` for every absolute binding path — and set through `pathname`, so no rendered
 * path can ever change the scheme or host. A `?query` in the binding path is kept.
 */
export function resolveBindingUrl(baseUrl: string, bindingPath: string): URL {
  const url = new URL(baseUrl);
  const queryAt = bindingPath.indexOf('?');
  const pathPart = queryAt === -1 ? bindingPath : bindingPath.slice(0, queryAt);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/${pathPart.replace(/^\/+/, '')}`;
  url.search = queryAt === -1 ? '' : bindingPath.slice(queryAt + 1);
  url.hash = '';
  return url;
}

/** The part of a binding path template before its first `{param}` — what every rendering of it
 *  must still start with. */
function staticPrefix(template: string): string {
  const brace = template.indexOf('{');
  const beforeQuery = template.split('?')[0] ?? template;
  return brace === -1 ? beforeQuery : template.slice(0, brace);
}

/**
 * Review lane 5, P2-4: `importOpenApi` used to discard each parameter's own `in` — every non-path
 * param went to the query string for GET and into the JSON body for everything else, so a POST/
 * PUT/... param the source OpenAPI document declared `in: 'query'` (a common pattern — filters,
 * pagination) was silently misrouted into the body. `x-in` is not a real JSON Schema keyword —
 * `ajv`'s `strict: false` tolerates unknown keywords, and it survives `params_schema`'s own
 * `z.record` passthrough in `OperationSchema` — so `importOpenApi` (below) stamps it onto each
 * property it derives from an OpenAPI `parameter.in`, and `HttpTransport.request` reads it back
 * here to route that one param, independent of everything else about the operation's shape. `path`
 * params are already handled by `renderPath` above before this is ever consulted; `cookie` has no
 * dedicated handling (no fixture uses it) and falls through to the pre-existing verb-based
 * default, same as an undeclared location.
 */
function paramLocation(paramsSchema: Operation['params_schema'], name: string): string | undefined {
  const properties = (paramsSchema as { properties?: Record<string, unknown> }).properties;
  const prop = properties?.[name];
  if (prop && typeof prop === 'object') {
    const loc = (prop as Record<string, unknown>)['x-in'];
    if (typeof loc === 'string') return loc;
  }
  return undefined;
}

function credentialHeaders(credential: unknown): Record<string, string> {
  if (!credential || typeof credential !== 'object') return {};
  const bag = credential as Record<string, unknown>;
  if (typeof bag.token === 'string') return { authorization: `Bearer ${bag.token}` };
  if (typeof bag.apiKey === 'string') return { 'x-api-key': bag.apiKey };
  if (bag.headers && typeof bag.headers === 'object') {
    return Object.fromEntries(
      Object.entries(bag.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  return {};
}

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  private readonly options: HttpTransportOptions;

  constructor(options: HttpTransportOptions) {
    this.options = options;
  }

  private async request(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<{
    url: URL;
    method: string;
    body: string | undefined;
    headerParams: Record<string, string>;
  }> {
    if (operation.binding.kind !== 'http') {
      throw new BindingKindMismatchError(operation.name, this.kind, operation.binding.kind);
    }
    const bag = (params ?? {}) as Record<string, unknown>;
    const { path, used } = renderPath(operation.binding.path, bag);
    const url = resolveBindingUrl(this.options.baseUrl, path);
    // R-22, defense in depth: whatever the parameters were, the request stays under the template's
    // own static prefix — never an ancestor endpoint the manifest does not publish.
    const prefix = resolveBindingUrl(
      this.options.baseUrl,
      staticPrefix(operation.binding.path),
    ).pathname;
    if (!url.pathname.startsWith(prefix)) {
      throw new TransportInvokeError(
        `http transport: operation "${operation.name}" rendered a path outside its template`,
      );
    }
    const method = operation.binding.method.toUpperCase();

    const remaining: Record<string, unknown> = {};
    const headerParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(bag)) {
      if (used.has(key)) continue;
      const location = paramLocation(operation.params_schema, key);
      if (location === 'header') {
        headerParams[key] = String(value);
        continue;
      }
      if (location === 'query') {
        url.searchParams.set(key, String(value));
        continue;
      }
      remaining[key] = value;
    }

    let body: string | undefined;
    if (method === 'GET' || method === 'HEAD') {
      for (const [key, value] of Object.entries(remaining)) {
        url.searchParams.set(key, String(value));
      }
    } else if (Object.keys(remaining).length > 0) {
      body = JSON.stringify(remaining);
    }

    void ctx;
    return { url, method, body, headerParams };
  }

  async invoke(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult> {
    const { url, method, body, headerParams } = await this.request(operation, params, ctx);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headerParams,
          ...credentialHeaders(ctx.credential),
        },
        body,
        signal: controller.signal,
        // Review lane 5, P2-2: 'follow' (the fetch default) resends every header — including the
        // credential header just above — to whatever host a 3xx response names, cross-origin or
        // not. 'error' makes a redirect response a hard failure instead of silently leaking the
        // credential to an unintended target.
        redirect: 'error',
      });
      const text = await response.text();
      const data: unknown = text.length > 0 ? safeJsonParse(text) : undefined;
      if (!response.ok) {
        throw new TransportInvokeError(
          `http transport: ${method} ${url.pathname} responded ${response.status}`,
        );
      }
      return { data };
    } catch (err) {
      if (err instanceof TransportInvokeError) throw err;
      throw new TransportInvokeError('http transport: request failed', { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }

  async simulate(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<{ description: string; detail?: unknown }> {
    const { url, method, body, headerParams } = await this.request(operation, params, ctx);
    return {
      description: `would call ${method} ${url.toString()}`,
      detail: { method, url: url.toString(), body, headerParams },
    };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// -------------------------------------------------------------------------------------------
// importOpenApi — manifest draft from an OpenAPI 3.x document (design doc §7.5).
// -------------------------------------------------------------------------------------------

interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie';
  readonly required?: boolean;
  readonly schema?: Record<string, unknown>;
}

interface OpenApiOperationObject {
  readonly operationId?: string;
  /** S8 W2-K1 (leftover 71/72, audit CO1/B3): OpenAPI's own short human summary — preferred over
   *  `description` (below) when both are present, same convention Swagger UI/most OpenAPI tooling
   *  uses (`summary` is meant to be the short one). Neither was read here before this fix — every
   *  imported Operation's `description` was simply absent, one root cause of "12 个 Operation 描述
   *  全空" (CO1) and B3's `find_operations` keyword-matching failure for anything imported this
   *  way. */
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly content?: {
      readonly 'application/json'?: { readonly schema?: Record<string, unknown> };
    };
  };
}

export interface OpenApiDocumentLike {
  readonly paths?: Record<string, Record<string, OpenApiOperationObject>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function defaultBlastRadiusForVerb(method: string): 'low' | 'medium' | 'high' {
  if (method === 'get') return 'low';
  if (method === 'delete') return 'high';
  return 'medium';
}

function sanitizeName(path: string, method: string): string {
  return `${method}_${path
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

function paramsSchemaFor(op: OpenApiOperationObject): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of op.parameters ?? []) {
    // `x-in` (review lane 5, P2-4) — see `paramLocation`'s own doc comment above for why this
    // survives both ajv (strict:false) and OperationSchema's params_schema passthrough.
    properties[param.name] = { ...(param.schema ?? {}), 'x-in': param.in };
    if (param.required) required.push(param.name);
  }
  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  if (bodySchema && typeof bodySchema === 'object') {
    const bodyProps = (bodySchema as { properties?: Record<string, unknown> }).properties;
    if (bodyProps) Object.assign(properties, bodyProps);
    const bodyRequired = (bodySchema as { required?: string[] }).required;
    if (bodyRequired) required.push(...bodyRequired);
  }
  if (Object.keys(properties).length === 0) return {};
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/** Imports an OpenAPI document into a manifest draft — one Operation per (path, method). Every
 *  imported Operation is `auto_approvable: false`; `mode: observe` (GET) Operations are still
 *  marked `auto_approvable: true` since `mode: observe` never goes through an ActionRequest. */
export function importOpenApi(document: OpenApiDocumentLike): Operation[] {
  const operations: Operation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const mode = method === 'get' ? 'observe' : 'execute';
      operations.push({
        name: op.operationId ?? sanitizeName(path, method),
        // S8 W2-K1 (CO1/B3): `summary` first (OpenAPI's own short human-readable field), then the
        // longer `description`, then a synthesized fallback — never blank, so a real OpenAPI
        // document without either still produces something `find_operations`'s keyword ranking
        // (and any future `importManifest({requireDescription: true})` caller) can use.
        description: op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`,
        binding: { kind: 'http', method: method.toUpperCase(), path },
        params_schema: paramsSchemaFor(op),
        mode,
        blast_radius: defaultBlastRadiusForVerb(method),
        reversibility: false,
        auto_approvable: mode === 'observe',
        await_decision: mode === 'execute',
        reads: [],
        writes: [],
      });
    }
  }
  return operations;
}
