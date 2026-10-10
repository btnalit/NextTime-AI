import type { Operation } from '@nexttime/shared';
import {
  BindingKindMismatchError,
  GateOwnedParamRefusedError,
  TransportInvokeError,
} from '../errors.js';
import { NO_REDIRECTS, refuseRedirect } from './redirect.js';
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
  // `[^{}]`, not `[^}]`: a run of `{` with no `}` would otherwise be rescanned from every `{`
  // (quadratic — the path comes from the target's OpenAPI document).
  const rendered = path.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    used.add(name);
    return encodePathSegment(name, params[name]);
  });
  return { path: rendered, used };
}

/** `path` without its trailing `/`s — a loop, not `/\/+$/`, which rescans a run of `/` from each
 *  of its characters when something other than `/` follows it. */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === '/') end -= 1;
  return path.slice(0, end);
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
  const basePath = withoutTrailingSlashes(url.pathname);
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
 * params are already handled by `renderPath` above before this is ever consulted; a `cookie` param
 * is refused (`GateOwnedParamRefusedError`) — it carries session state, and this transport sets no
 * cookie from a param.
 */
function paramLocation(paramsSchema: Operation['params_schema'], name: string): string | undefined {
  const properties = (paramsSchema as { properties?: Record<string, unknown> }).properties;
  const prop = properties?.[name];
  if (prop && typeof prop === 'object') {
    const loc = (prop as Record<string, unknown>)['x-in'];
    // Compared without case (review of #532, item 3): a hand-written `x-in: 'Header'` used to
    // miss every branch below and go to the query string, header guard and all.
    if (typeof loc === 'string') return loc.trim().toLowerCase();
  }
  return undefined;
}

/**
 * Request headers the gate owns: they say who is calling, on whose account, or where and how the
 * call goes — so only the gate's own configuration sets them, never a caller's param. Who is
 * calling and on whose account, by exact name:
 */
const IDENTITY_HEADERS = new Set([
  // Who is calling.
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'set-cookie',
  'sudo', // GitLab's admin impersonation
  'remote-user',
  'x-remote-user',
  // On whose account, under the same credential (an org, a project, a tenant, a namespace).
  'x-scope-orgid',
  'openai-organization',
  'openai-project',
  'x-goog-user-project',
  'x-grafana-org-id',
  'x-vault-namespace',
  'x-tenant-id',
  'x-on-behalf-of',
]);
/** …and by pattern: `X-Auth-Token` / `X-Auth-Key` / `X-Auth-Email` and oauth2-proxy's
 *  `X-Auth-Request-*`, Grafana's `X-WEBAUTH-*`, Kubernetes' `Impersonate-User` / `-Group`, a
 *  proxy's `X-Forwarded-User` / `-Email` / `-Groups`, Azure's `X-MS-CLIENT-PRINCIPAL*`, Hasura's
 *  `X-Hasura-Role` / `-User-Id` (review of #532, item 5), and any name with the word `jwt`,
 *  `assertion` or `run-as` in it — `x-jwt-assertion`, `X-Goog-IAP-JWT-Assertion`, Elasticsearch's
 *  `es-security-runas-user`. */
const IDENTITY_HEADER_PATTERN =
  /^(?:x-auth[-_]|x-webauth[-_]|(?:x-)?impersonate[-_]|x-forwarded-(?:user|email|preferred-username|groups?)(?:$|[-_])|x-ms-client-principal|x-hasura-)|(?:^|[-_])(?:jwt|assertion|run[-_]?as)(?:$|[-_])/;
/** Where and how the call goes, past the binding's own host, path and method — headers only: as
 *  a query parameter `host=web-1` is an ordinary filter. By exact name… */
const ROUTING_HEADERS = new Set([
  'host',
  'forwarded',
  'x-original-url',
  'x-original-uri',
  'x-rewrite-url',
  'x-method-override',
]);
/** …and by prefix: a proxy's `X-Forwarded-Host` / `-For` / `-Proto`, `X-HTTP-Method-Override`. */
const ROUTING_HEADER_PREFIX = /^(?:x-forwarded-|x-http-method)/;
/** …or a name whose last word names a credential: `X-API-Key`, `Api-Key`, `apikey`,
 *  `PRIVATE-TOKEN`, `X-Amz-Security-Token`, `Ocp-Apim-Subscription-Key`, `DD-APPLICATION-KEY`,
 *  `x-functions-key` (Azure Functions), `X-Client-Secret`. */
const CREDENTIAL_NAME =
  /(?:token|apikey|(?:^|[-_])(?:api|access|secret|private|subscription|auth|session|security|master|client|license|app|application|consumer|developer|service|functions?)[-_]?key|secret|password|passwd|passphrase|credentials?|(?:^|[-_])auth)$/;
/** A name ending in `token` that is a pagination cursor or a retry key, not who is calling — the
 *  word before `token` says so: `X-Page-Token`, `pageToken`, `startPageToken`, `NextToken`,
 *  `PaginationToken`, `continuation-token`, `x-ms-continuationtoken`, `syncToken`, Microsoft's
 *  `$skipToken` / `$deltatoken`, `starting_token`, `resumeToken`, `after_token`,
 *  `nextForwardToken`, `Idempotency-Token`. Matched on `nameWords` (camelCase split), so
 *  `pageAccessToken` or `nextAuthToken` — whose last word is a credential's — stays refused. */
const NOT_A_CREDENTIAL_TOKEN =
  /(?:^|[-_$])(?:(?:next|prev|previous|start)[-_]?)?(?:page|paging|pagination|next|prev|previous|continuation|continue|cursor|scroll|sync|delta|marker|skip|start|starting|resume|after|before|forward|backward|offset|idempotency)[-_]?token$/;

/** `startPageToken` → `start_page_token`: lower-cased with its camelCase words split, so a word
 *  is found whatever the casing (`$skipToken` and `$skiptoken` alike). */
function nameWords(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function namesACredential(name: string): boolean {
  return (
    CREDENTIAL_NAME.test(name.trim().toLowerCase()) && !NOT_A_CREDENTIAL_TOKEN.test(nameWords(name))
  );
}

/** Who is calling or on whose account (`IDENTITY_HEADERS`, `IDENTITY_HEADER_PATTERN`), as a
 *  header or a query parameter. */
function namesAnIdentity(lower: string): boolean {
  return IDENTITY_HEADERS.has(lower) || IDENTITY_HEADER_PATTERN.test(lower);
}

/**
 * Whether the request header `name` is one the gate owns (`IDENTITY_HEADERS`, `ROUTING_HEADERS`
 * and the patterns after them), or one its own credential injection sets (`injected`,
 * lower-case). Case-insensitive, as header names are. A denylist: a header it does not name (`X-Page-Token`, `Idempotency-Key`,
 * `X-Request-Id`) is sent as declared.
 */
export function isGateOwnedHeader(
  name: string,
  injected: ReadonlySet<string> = new Set(),
): boolean {
  const lower = name.trim().toLowerCase();
  return (
    namesAnIdentity(lower) ||
    ROUTING_HEADERS.has(lower) ||
    ROUTING_HEADER_PREFIX.test(lower) ||
    injected.has(lower) ||
    namesACredential(name)
  );
}

/** Query parameters that carry who is calling, by exact name: a pre-signed URL's `sig` /
 *  `signature` (Azure SAS and others). */
const GATE_OWNED_QUERY_PARAMS = new Set(['sig', 'signature']);

/**
 * Whether the query parameter `name` carries who is calling: one whose last word names a
 * credential, as for a header (`access_token`, `api_key`, `apikey`, `auth_token`,
 * `client_secret`, `password` — `page_token`, `next_token` stay), a pre-signed URL's
 * (`X-Amz-*`, `X-Goog-*`, `sig`, `signature`), or a header name that says who is calling or on
 * whose account (`sudo`, `X-Scope-OrgID`, `Authorization`, `run_as`, `jwt` — review of #532,
 * item 3: an undeclared GET param goes to the query string, so a header param a newer import
 * dropped, still passed by a caller, used to reach the target as `?X-Scope-OrgID=…`). Routing
 * header names stay (`host=web-1` is an ordinary filter), and so does a bare `key`: it is as often
 * a lookup key (a KV store's, an object's) as Google's API key.
 */
export function isGateOwnedQueryParam(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    GATE_OWNED_QUERY_PARAMS.has(lower) ||
    /^x-(?:amz|goog)-/.test(lower) ||
    namesAnIdentity(lower) ||
    namesACredential(name)
  );
}

/** The header names `credentialHeaders` can set, whatever the gate's credential is: a caller's
 *  param never takes one of them, even on a gate configured with no credential at all. */
const INJECTED_HEADER_NAMES = ['authorization', 'x-api-key'] as const;

/** Where a param would set something only the gate's own configuration may (`GateOwnedParamRefusedError`). */
export type GateOwnedParamLocation = 'header' | 'query' | 'cookie' | 'binding';

/**
 * The one routing rule both `HttpTransport.request` (a call's params, refused before anything is
 * sent) and `gateOwnedParamsOf` (a definition's declared params, refused at publish) use: where
 * param `name`, declared at `location` (its `x-in`, lower-case) and not consumed by the path
 * template, would land that the gate owns — `null` when it lands somewhere a caller may set.
 * Every param of a GET or HEAD that is not a header or a cookie goes to the query string.
 */
function gateOwnedLocation(
  name: string,
  location: string | undefined,
  method: string,
  fixedQuery: ReadonlySet<string>,
  injected: ReadonlySet<string>,
): GateOwnedParamLocation | null {
  if (location === 'header') return isGateOwnedHeader(name, injected) ? 'header' : null;
  if (location === 'cookie') return 'cookie';
  if (location === 'query' || method === 'GET' || method === 'HEAD') {
    // Compared without case: many servers (ASP.NET, so Azure) read `API-Version` as `api-version`.
    if (fixedQuery.has(name.toLowerCase())) return 'binding';
    if (isGateOwnedQueryParam(name)) return 'query';
  }
  return null;
}

/** The lower-cased query parameter names a binding path fixes (`/items?api-version=2024-01-01`). */
function fixedQueryOf(searchParams: URLSearchParams): Set<string> {
  return new Set([...searchParams.keys()].map((key) => key.toLowerCase()));
}

/** The param names a binding path template consumes (`{sku}`), as `renderPath` substitutes them. */
function templateParams(path: string): Set<string> {
  return new Set([...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? ''));
}

/** One declared param of an Operation that the gate would refuse on every call that passes it. */
export interface GateOwnedParam {
  readonly param: string;
  readonly location: GateOwnedParamLocation;
}

/**
 * Legacy J (review of #532): the params an `http` Operation's `params_schema` declares that
 * `HttpTransport.request` would refuse whenever a caller passes them — a gate-owned header, a
 * credential in the query string, a cookie, or a query parameter the binding fixes. Such a
 * definition offers the agent a param the gate never sends, and a `required` one makes the
 * Operation impossible to call; the kernel refuses to publish it (`publishOperation`). The same
 * rule as the call (`gateOwnedLocation`), minus what only a call knows: the header names a gate's
 * configured credential adds beyond `Authorization` / `X-API-Key`, which the call still refuses.
 * Empty for any other binding kind, and for a definition that is not an object with properties.
 */
export function gateOwnedParamsOf(operation: unknown): GateOwnedParam[] {
  if (!operation || typeof operation !== 'object') return [];
  const { binding, params_schema: paramsSchema } = operation as {
    binding?: { kind?: unknown; method?: unknown; path?: unknown };
    params_schema?: unknown;
  };
  if (binding?.kind !== 'http' || typeof binding.path !== 'string') return [];
  if (!paramsSchema || typeof paramsSchema !== 'object') return [];
  const properties = (paramsSchema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object') return [];
  const path = binding.path;
  const method = typeof binding.method === 'string' ? binding.method.toUpperCase() : '';
  const queryAt = path.indexOf('?');
  const fixedQuery = fixedQueryOf(
    new URLSearchParams(queryAt === -1 ? '' : path.slice(queryAt + 1)),
  );
  const consumed = templateParams(path);
  const injected = new Set<string>(INJECTED_HEADER_NAMES);
  const found: GateOwnedParam[] = [];
  for (const name of Object.keys(properties)) {
    if (consumed.has(name)) continue;
    const location = gateOwnedLocation(
      name,
      paramLocation(paramsSchema as Operation['params_schema'], name),
      method,
      fixedQuery,
      injected,
    );
    if (location) found.push({ param: name, location });
  }
  // By name, so the report is the same however the definition was stored (jsonb reorders keys).
  return found.sort((a, b) => (a.param < b.param ? -1 : a.param > b.param ? 1 : 0));
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
    // Legacy 175 follow-up (review of #532): a caller's param never sets what the gate owns — a
    // header that says who is calling, on whose account or where the call goes, a credential in
    // the query string, a cookie, or a query parameter the binding fixes. The gate authenticates
    // with the credential configured on it (design doc §11), and an observe-class call runs with
    // no approval, so `Authorization: Basic …` in a header param would pick the identity the gate
    // acts as. Refused by name, whatever the value, before anything is sent.
    const injected = new Set<string>([
      ...INJECTED_HEADER_NAMES,
      ...Object.keys(credentialHeaders(ctx.credential)).map((name) => name.toLowerCase()),
    ]);
    const fixedQuery = fixedQueryOf(url.searchParams);
    for (const [key, value] of Object.entries(bag)) {
      if (used.has(key)) continue;
      const location = paramLocation(operation.params_schema, key);
      const refused = gateOwnedLocation(key, location, method, fixedQuery, injected);
      if (refused) throw new GateOwnedParamRefusedError(operation.name, key, refused);
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
      // Every other param of a GET goes to the query string too — undeclared ones included when
      // the Operation's `params_schema` is empty (a not-yet-refined import accepts anything).
      for (const [key, value] of Object.entries(remaining))
        url.searchParams.set(key, String(value));
    } else if (Object.keys(remaining).length > 0) {
      body = JSON.stringify(remaining);
    }

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
        // not. A redirect is a failure instead of silently leaking the credential to an
        // unintended target, and it says where it pointed (`redirect.ts`).
        redirect: NO_REDIRECTS,
      });
      await refuseRedirect(`http transport: ${method} ${url.pathname}`, response, url);
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
    // Legacy 175 follow-up (review of #532): what the gate owns is never a param — a cookie, a
    // header that says who is calling, on whose account or where the call goes, a credential in
    // the query string. OpenAPI 3 itself says an `Authorization` header parameter SHALL be ignored
    // (a security scheme carries it); the gate sets these from its own configuration, so they are
    // left out of `params_schema` (and of `required`) rather than offered to a caller that
    // `HttpTransport.request` would refuse.
    if (
      param.in === 'cookie' ||
      (param.in === 'header' && isGateOwnedHeader(param.name)) ||
      (param.in === 'query' && isGateOwnedQueryParam(param.name))
    ) {
      continue;
    }
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
