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

/** Substitutes `{name}` path segments from `params`; returns the rendered path and the set of
 *  param names consumed (so callers can put the rest on the query string / JSON body). */
function renderPath(
  path: string,
  params: Record<string, unknown>,
): { path: string; used: Set<string> } {
  const used = new Set<string>();
  const rendered = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    used.add(name);
    const value = params[name];
    return encodeURIComponent(value === undefined ? '' : String(value));
  });
  return { path: rendered, used };
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
  ): Promise<{ url: URL; method: string; body: string | undefined }> {
    if (operation.binding.kind !== 'http') {
      throw new BindingKindMismatchError(operation.name, this.kind, operation.binding.kind);
    }
    const bag = (params ?? {}) as Record<string, unknown>;
    const { path, used } = renderPath(operation.binding.path, bag);
    const url = new URL(path, this.options.baseUrl);
    const method = operation.binding.method.toUpperCase();

    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bag)) {
      if (!used.has(key)) remaining[key] = value;
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
    return { url, method, body };
  }

  async invoke(
    operation: Operation,
    params: unknown,
    ctx: TransportInvokeContext,
  ): Promise<TransportInvokeResult> {
    const { url, method, body } = await this.request(operation, params, ctx);
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
          ...credentialHeaders(ctx.credential),
        },
        body,
        signal: controller.signal,
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
    const { url, method, body } = await this.request(operation, params, ctx);
    return {
      description: `would call ${method} ${url.toString()}`,
      detail: { method, url: url.toString(), body },
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
    properties[param.name] = param.schema ?? {};
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
