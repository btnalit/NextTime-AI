import type { Operation } from '@nexttime/shared';
import {
  BindingKindMismatchError,
  GateOwnedParamRefusedError,
  TransportInvokeError,
} from '../errors.js';
import { failedAfterAnswer, failedBeforeAnswer } from './call-failure.js';
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
    const what = `http transport: ${method} ${url.pathname}`;
    // Built before the call (review of #586, #501 P2-2): a failure here sent nothing, and must not
    // read as a call that failed on the way.
    const headers = {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headerParams,
      ...credentialHeaders(ctx.credential),
    };
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body,
          signal: controller.signal,
          // Review lane 5, P2-2: 'follow' (the fetch default) resends every header — including
          // the credential header above — to whatever host a 3xx response names, cross-origin or
          // not. A redirect is a failure instead of silently leaking the credential to an
          // unintended target, and it says where it pointed (`redirect.ts`).
          redirect: NO_REDIRECTS,
        });
      } catch (err) {
        // Legacy 287: only a proven "not sent" is a plain failure (`call-failure.ts`).
        throw failedBeforeAnswer(what, err);
      }
      // The target's own answers — a redirect, a non-2xx status — are plain failures. The status
      // goes with the failure, so an observe Operation that declares it means "does not exist"
      // answers as absent (`GatekeeperBase.observe`); the body is never read, so nothing the
      // target writes in it can say so.
      await refuseRedirect(what, response, url);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new TransportInvokeError(`${what} responded ${response.status}`, {
          targetAnswer: { status: response.status },
        });
      }
      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw failedAfterAnswer(what, response.status, 'its answer could not be read', err);
      }
      const data: unknown = text.length > 0 ? safeJsonParse(text) : undefined;
      return { data };
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

/** OpenAPI's Reference Object: a `$ref` in place of a parameter, a request body or a schema. */
interface OpenApiReference {
  readonly $ref: string;
}

interface OpenApiRequestBody {
  readonly content?: {
    readonly 'application/json'?: { readonly schema?: Record<string, unknown> };
  };
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
  readonly parameters?: readonly (OpenApiParameter | OpenApiReference)[];
  readonly requestBody?: OpenApiRequestBody | OpenApiReference;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** A path item: its Operations by method, and (legacy 197) the parameters every one of them takes
 *  unless it declares the same one itself. */
type OpenApiPathItem = {
  readonly parameters?: readonly (OpenApiParameter | OpenApiReference)[];
} & { readonly [M in (typeof HTTP_METHODS)[number]]?: OpenApiOperationObject };

export interface OpenApiDocumentLike {
  readonly paths?: Record<string, OpenApiPathItem>;
  /** Where the document's own `$ref`s point (`#/components/schemas/Pet`, legacy 197). */
  readonly components?: Record<string, unknown>;
}

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

// ---- $ref (legacy 197) ----------------------------------------------------------------------
//
// Most OpenAPI documents put their request bodies, shared parameters and schemas under
// `components` and point at them with `$ref`. None was followed here before, so a `$ref` request
// body added nothing and an Operation with no other parameter got `params_schema: {}` — which
// accepts anything. A reference into the same document (`#/…`) is now written out in place; the
// gate's own validator (`params-validation.ts`) has no document to resolve it against. A reference
// that cannot be followed — another document's, or a pointer that leads nowhere — is not guessed
// at: the Operation gets a schema that takes only what it could read (below, `unread`).

/** What a reference may cost (review #501 on #1354). Written out, a reference copies what it points
 *  at, so a small document whose references fan out (A uses B twice, B uses C twice, …), or one
 *  large schema many Operations use, would grow without bound — in the kernel's import inside a
 *  database transaction, and in the gate host's. Everything copied out of a reference counts:
 *  each schema value is one unit, and text (a key, a string, an `example`) one more per 64
 *  characters. What an Operation declares in place is not counted — it is copied once, as large as
 *  it was written. An Operation whose references cost more than its share, or whose share the
 *  document has already spent, gets {@link INLINE_LIMIT_SCHEMA}. */
const MAX_INLINED_UNITS_PER_OPERATION = 10_000;
const MAX_INLINED_UNITS_PER_DOCUMENT = 100_000;

/** How many references deep one schema may be written out; deeper ones stay as they are. */
const MAX_REF_DEPTH = 64;

/** How deeply nested one schema may be, references and all — past it, as past the units above. */
const MAX_SCHEMA_DEPTH = 512;

/** The `params_schema` of an Operation past the limits above: a reference ajv cannot resolve, so
 *  the schema does not compile and every call is refused (400 `invalid_operation_schema`) — never
 *  a looser schema. Its name says why. */
const INLINE_LIMIT_SCHEMA = { $ref: '#/x-nexttime-inline-limit' } as const;

/** Thrown, by identity, when a schema goes past the limits above. */
const INLINE_LIMIT = Symbol('inline limit');

/** Where a reference recurs inside itself: any value (a fresh `{}`), as `@nexttime/shared`'s
 *  `toJsonSchema` does — a tree's children are checked one level down, not forever. Each one is
 *  remembered so a request body that is nothing but such a reference is not read as one that takes
 *  anything. */
const recursionPlaceholders = new WeakSet<object>();

function recursionPlaceholder(): Record<string, unknown> {
  const placeholder = {};
  recursionPlaceholders.add(placeholder);
  return placeholder;
}

function isRecursionPlaceholder(value: unknown): boolean {
  return isObjectNode(value) && recursionPlaceholders.has(value);
}

/** Keywords whose value is data, not a schema: copied as is, never searched for `$ref`. */
const SCHEMA_DATA_KEYWORDS = new Set(['example', 'examples', 'default', 'enum', 'const']);

/** Keywords whose value maps names to schemas — a property may be called `default`. */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
]);

/** Keywords that say nothing about which values pass: a `$ref`'s sibling may restate them. */
const SCHEMA_ANNOTATION_KEYWORDS = new Set([
  'title',
  'description',
  'example',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'externalDocs',
  'xml',
  '$comment',
]);

/** Keywords that combine schemas: a request body written with one at its top is not read. */
const SCHEMA_COMBINING_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'not'] as const;

function isObjectNode(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `target[key] = value` as `target`'s own property — also for `__proto__`, a name the document
 *  may use, which plain assignment would turn into `target`'s prototype instead. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** What a reference into the same document (`#/components/schemas/a~1b`, RFC 6901 escapes
 *  percent-decoded first) points at, or `undefined` — another document's reference, a pointer that
 *  does not decode, a name the document does not have (only its own keys, never `constructor`). */
function resolveLocalRef(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = document;
  for (const raw of ref.slice(2).split('/')) {
    let key: string;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** A parameter or request body object, following `$ref`s to it (a component may itself be a
 *  `$ref`); `undefined` when one of them cannot be followed. `viaRef`: it came out of one, so what
 *  it holds is copied wherever it is used, and counts. */
function dereference(document: unknown, node: unknown): { node: unknown; viaRef: boolean } {
  let current = node;
  for (let hop = 0; hop < MAX_REF_DEPTH; hop += 1) {
    if (!isObjectNode(current) || typeof current.$ref !== 'string') {
      return { node: current, viaRef: hop > 0 };
    }
    current = resolveLocalRef(document, current.$ref);
  }
  return { node: undefined, viaRef: true };
}

/** What writing out one document's references has left to spend: shared by its Operations. */
interface DocumentBudget {
  unitsLeft: number;
  /** What each data value (`example`, `enum`, …) costs, by identity, so a large one is measured
   *  once however many references copy it. */
  readonly dataUnits: WeakMap<object, number>;
}

interface InlineState {
  readonly document: unknown;
  readonly budget: DocumentBudget;
  unitsLeft: number;
}

function textUnits(text: string): number {
  return text.length >> 6;
}

function spend(state: InlineState, units: number): void {
  state.unitsLeft -= units;
  state.budget.unitsLeft -= units;
  if (state.unitsLeft < 0 || state.budget.unitsLeft < 0) throw INLINE_LIMIT;
}

/** What copying a data value costs: one unit, plus its JSON text's. */
function dataUnits(state: InlineState, value: unknown): number {
  if (typeof value === 'string') return 1 + textUnits(value);
  if (value === null || typeof value !== 'object') return 1;
  const known = state.budget.dataUnits.get(value);
  if (known !== undefined) return known;
  let units: number;
  try {
    units = 1 + textUnits(JSON.stringify(value) ?? '');
  } catch {
    // Nested too deeply to write out at all.
    units = Number.POSITIVE_INFINITY;
  }
  state.budget.dataUnits.set(value, units);
  return units;
}

/** `resolved` (what a `$ref` points at) and its `siblings` together. Siblings that restate only
 *  what the target leaves open, or annotations, are written next to it. A sibling that would replace
 *  the target's own constraint (`maxLength: 100` beside a target's `maxLength: 3`) would loosen it
 *  — OpenAPI 3.0 ignores such a sibling, 3.1 applies both — so both are kept, under `allOf`. */
function withSiblings(resolved: unknown, siblings: unknown): unknown {
  if (!isObjectNode(resolved) || !isObjectNode(siblings)) return resolved;
  const clashes =
    isRecursionPlaceholder(resolved) ||
    Object.keys(siblings).some(
      (key) =>
        Object.hasOwn(resolved, key) &&
        !SCHEMA_ANNOTATION_KEYWORDS.has(key) &&
        !Object.is(resolved[key], siblings[key]),
    );
  if (clashes) return { allOf: [resolved, siblings] };
  return { ...resolved, ...siblings };
}

/** `schema` with every reference into the same document written out in place — where one recurs
 *  inside itself, a {@link recursionPlaceholder}; one that cannot be followed, or deeper than `MAX_REF_DEPTH`,
 *  stays a `$ref` (ajv cannot compile it). `counted`: `schema` was copied out of a reference.
 *  Throws {@link INLINE_LIMIT} past the limits above. */
function inlineSchema(
  state: InlineState,
  schema: unknown,
  open: readonly string[],
  counted: boolean,
  depth: number,
): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw INLINE_LIMIT;
  if (counted) spend(state, typeof schema === 'string' ? 1 + textUnits(schema) : 1);
  if (Array.isArray(schema)) {
    return schema.map((item) => inlineSchema(state, item, open, counted, depth + 1));
  }
  if (!isObjectNode(schema)) return schema;
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    if (open.includes(ref)) return recursionPlaceholder();
    const target = open.length < MAX_REF_DEPTH ? resolveLocalRef(state.document, ref) : undefined;
    if (isObjectNode(target)) {
      const { $ref: _ref, ...siblings } = schema;
      const resolved = inlineSchema(state, target, [...open, ref], true, depth + 1);
      if (Object.keys(siblings).length === 0) return resolved;
      return withSiblings(resolved, inlineSchema(state, siblings, open, counted, depth + 1));
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (counted) spend(state, textUnits(key));
    if (SCHEMA_DATA_KEYWORDS.has(key)) {
      if (counted) spend(state, dataUnits(state, value));
      setOwn(out, key, value);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isObjectNode(value)) {
      if (counted) spend(state, 1);
      const named: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        if (counted) spend(state, textUnits(name));
        setOwn(named, name, inlineSchema(state, sub, open, counted, depth + 2));
      }
      setOwn(out, key, named);
    } else {
      setOwn(out, key, inlineSchema(state, value, open, counted, depth + 1));
    }
  }
  return out;
}

interface ReadParameter {
  readonly param: OpenApiParameter;
  readonly viaRef: boolean;
}

/** The parameters `op` takes: the path item's, then its own. One of its own replaces the path
 *  item's of the same name and location (OpenAPI 3: "can be overridden at the operation level, but
 *  cannot be removed there"). `unread` when a `$ref` to one could not be followed. */
function parametersOf(
  document: unknown,
  pathItem: OpenApiPathItem,
  op: OpenApiOperationObject,
): { parameters: ReadParameter[]; unread: boolean } {
  let unread = false;
  const read = (list: unknown): ReadParameter[] => {
    if (!Array.isArray(list)) return [];
    const out: ReadParameter[] = [];
    for (const entry of list) {
      const { node: param, viaRef } = dereference(document, entry);
      if (param === undefined) unread = true;
      if (!isObjectNode(param) || typeof param.name !== 'string' || typeof param.in !== 'string') {
        continue;
      }
      out.push({ param: param as unknown as OpenApiParameter, viaRef });
    }
    return out;
  };
  const own = read(op.parameters);
  const ownKeys = new Set(own.map(({ param }) => `${param.in}\u0000${param.name}`));
  const shared = read(pathItem.parameters).filter(
    ({ param }) => !ownKeys.has(`${param.in}\u0000${param.name}`),
  );
  return { parameters: [...shared, ...own], unread };
}

function paramsSchemaFor(
  document: OpenApiDocumentLike,
  budget: DocumentBudget,
  pathItem: OpenApiPathItem,
  op: OpenApiOperationObject,
): Record<string, unknown> {
  const state: InlineState = { document, budget, unitsLeft: MAX_INLINED_UNITS_PER_OPERATION };
  try {
    return writeParamsSchema(state, pathItem, op);
  } catch (error) {
    if (error === INLINE_LIMIT) return { ...INLINE_LIMIT_SCHEMA };
    throw error;
  }
}

function writeParamsSchema(
  state: InlineState,
  pathItem: OpenApiPathItem,
  op: OpenApiOperationObject,
): Record<string, unknown> {
  const { document } = state;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const { parameters, unread: parameterUnread } = parametersOf(document, pathItem, op);
  let unread = parameterUnread;
  for (const { param, viaRef } of parameters) {
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
    const schema = inlineSchema(state, param.schema ?? {}, [], viaRef, 0);
    // `x-in` (review lane 5, P2-4) — see `paramLocation`'s own doc comment above for why this
    // survives both ajv (strict:false) and OperationSchema's params_schema passthrough.
    setOwn(properties, param.name, { ...(isObjectNode(schema) ? schema : {}), 'x-in': param.in });
    if (param.required) required.push(param.name);
  }
  if (op.requestBody !== undefined) {
    const { node: requestBody, viaRef } = dereference(document, op.requestBody);
    const content = isObjectNode(requestBody) ? requestBody.content : undefined;
    const media = isObjectNode(content) ? content['application/json'] : undefined;
    const rawSchema = isObjectNode(media) ? media.schema : undefined;
    const bodySchema = isObjectNode(rawSchema)
      ? inlineSchema(state, rawSchema, [], viaRef, 0)
      : undefined;
    if (
      requestBody === undefined ||
      isRecursionPlaceholder(bodySchema) ||
      (isObjectNode(bodySchema) &&
        ('$ref' in bodySchema ||
          SCHEMA_COMBINING_KEYWORDS.some((keyword) => keyword in bodySchema)))
    ) {
      unread = true;
    } else if (isObjectNode(bodySchema)) {
      const bodyProps = bodySchema.properties;
      if (isObjectNode(bodyProps)) {
        for (const [name, sub] of Object.entries(bodyProps)) setOwn(properties, name, sub);
      }
      const bodyRequired = bodySchema.required;
      if (Array.isArray(bodyRequired)) required.push(...(bodyRequired as string[]));
    }
  }
  // Legacy 197: a parameter or body the document points at but this could not read is not
  // offered — and the schema is not left empty either, which would take anything.
  if (Object.keys(properties).length === 0 && !unread) return {};
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/** Imports an OpenAPI document into a manifest draft — one Operation per (path, method). Every
 *  imported Operation is `auto_approvable: false`; `mode: observe` (GET) Operations are still
 *  marked `auto_approvable: true` since `mode: observe` never goes through an ActionRequest. */
export function importOpenApi(document: OpenApiDocumentLike): Operation[] {
  const operations: Operation[] = [];
  const budget: DocumentBudget = {
    unitsLeft: MAX_INLINED_UNITS_PER_DOCUMENT,
    dataUnits: new WeakMap(),
  };
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
        // can use.
        description: op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`,
        binding: { kind: 'http', method: method.toUpperCase(), path },
        params_schema: paramsSchemaFor(document, budget, pathItem, op),
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
