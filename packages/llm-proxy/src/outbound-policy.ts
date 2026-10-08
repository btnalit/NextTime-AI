import type http from 'node:http';
import type { ProviderApiKind, ProviderConfig } from './config.js';

/**
 * outbound-policy: what of an agent's request reaches the provider (R-30, 2026-10-02 review;
 * maintainer decision D-29). Before this, proxy.ts copied every inbound header except a short
 * strip list and forwarded the body untouched apart from `model`. Two things followed:
 *
 *   - Provider-executed tools became an egress channel. An agent could declare a server-side
 *     tool (an MCP connector with an attacker `server_url`, web fetch, web search, code
 *     execution) together with the matching `anthropic-beta` value, and the *provider* would call
 *     out on its behalf — past egress-proxy, past the WorkerDefinition's egress lists, recorded as
 *     an LLM call rather than as egress.
 *   - Agent-chosen headers reached the provider: `openai-organization` / `openai-project` moved
 *     spend to another project on the same key.
 *
 * Now the request is narrowed at this one point, and only here:
 *
 *   - **Headers** — an allow-list (`FORWARDED_REQUEST_HEADERS`): `accept`, plus
 *     `anthropic-version` and the allow-listed `anthropic-beta` values for Anthropic. proxy.ts
 *     adds `content-type`, `accept-encoding: identity` and the provider's own auth header with
 *     the real key. Everything else — any agent-chosen auth, `x-*`, org/project headers,
 *     hop-by-hop headers, the correlation id — is dropped.
 *   - **Query** — only the parameters the SDKs send (`beta=true` from `@anthropic-ai/sdk`'s
 *     `client.beta.messages`, which pi uses).
 *   - **Body** — tool definitions are kept only when they are client-side tools: `function` /
 *     `custom` for the two OpenAI kinds, untyped or `custom` for Anthropic. Every other tool type
 *     (`web_search*`, `web_fetch*`, `code_execution*` / `code_interpreter`, `mcp` / `mcp_toolset`,
 *     `computer*`, `file_search`, `image_generation`, a vendor's built-in search, …) is removed,
 *     and so are the request parameters that switch provider-side tools on without a tool entry
 *     (`SERVER_TOOL_PARAMS`). Tool lists nested in messages / input items, and Anthropic's
 *     mid-conversation `tool_addition` definitions, are filtered the same way. Nothing else in
 *     the body changes; a request with nothing to strip is forwarded byte-for-byte.
 *
 * Stripping, not rejecting (D-29): the request still runs, without the provider-side tools.
 * proxy.ts logs every narrowed request with what was removed (the trail for an attempt).
 *
 * Not here yet: D-29's per-WorkerDefinition opt-in. llm-proxy sees only the Handle, whose claims
 * carry nothing a WorkerDefinition says about provider tools; carrying an opt-in needs a new
 * WorkerDefinition field and the kernel copying it into the Handle scope when it mints entry and
 * WorkerRun Handles. Until then every request is stripped.
 *
 * Normal traffic is unaffected: pi (1.1) sends only function / custom tools, the headers above,
 * and the `anthropic-beta` values in `FORWARDED_ANTHROPIC_BETAS`.
 */

/** Inbound headers forwarded as-is, per api kind. `anthropic-beta` is forwarded per value (below). */
const FORWARDED_REQUEST_HEADERS: Readonly<Record<ProviderApiKind, readonly string[]>> = {
  'openai-completions': ['accept'],
  'openai-responses': ['accept'],
  'anthropic-messages': ['accept', 'anthropic-version'],
};

/**
 * The `anthropic-beta` values forwarded — exactly the ones pi's Anthropic provider sends for
 * API-key auth (`@earendil-works/pi-ai` `api/anthropic-messages.js` `getBetaFeatures`; pi 1.1 and
 * 0.99, so a rollback to the `:pi-0.99.2` runtime image keeps working). Any other value is dropped
 * and logged, so a pi upgrade that starts sending a new one shows up in the proxy log instead of
 * failing silently. Notably absent: the MCP-connector, web-fetch, code-execution, computer-use,
 * files and skills betas.
 *
 * `inline-tools-2026-09-15` (pi 1.0.1+) replaced `mid-conversation-tool-changes-2026-07-01`
 * (pi 0.99): mid-conversation tool additions now carry the full tool definition inside the
 * conversation, which `stripProviderServerTools` filters like the top-level `tools` list.
 */
export const FORWARDED_ANTHROPIC_BETAS: ReadonlySet<string> = new Set([
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
  'server-side-fallback-2026-07-01',
  'mid-conversation-output-config-2026-07-01',
  'thinking-binding-controls-2026-08-01',
  'inline-tools-2026-09-15',
  // pi 0.99 only — kept while the `:pi-0.99.2` runtime image is the documented rollback target.
  'mid-conversation-tool-changes-2026-07-01',
]);

const FORWARDED_QUERY_PARAMS: Readonly<Record<ProviderApiKind, readonly string[]>> = {
  'openai-completions': [],
  'openai-responses': [],
  'anthropic-messages': ['beta'],
};

/** Client-side tool types — the model only *asks* for the call and the agent runs it. `undefined`
 *  is an entry with no `type` at all, which is how Anthropic's API (and pi) writes a custom tool. */
const CLIENT_TOOL_TYPES: Readonly<Record<ProviderApiKind, ReadonlySet<string | undefined>>> = {
  'openai-completions': new Set(['function', 'custom']),
  'openai-responses': new Set(['function', 'custom']),
  'anthropic-messages': new Set([undefined, 'custom']),
};

/**
 * Top-level parameters that switch provider-side tools on without a `tools` entry:
 *
 *   - `web_search_options` — OpenAI Chat Completions web search;
 *   - `plugins` — OpenRouter's web / file plugins;
 *   - `enable_search` — Qwen (DashScope) web search;
 *   - `search_parameters` — xAI live search;
 *   - `mcp_servers` — Anthropic's MCP connector;
 *   - `container` — Anthropic's code-execution container and skills.
 *
 * The OpenAI-compatible kinds can point at any vendor; these are the documented switches of the
 * common ones. None is sent by pi.
 */
const SERVER_TOOL_PARAMS: Readonly<Record<ProviderApiKind, readonly string[]>> = {
  'openai-completions': ['web_search_options', 'plugins', 'enable_search', 'search_parameters'],
  'openai-responses': [],
  'anthropic-messages': ['mcp_servers', 'container'],
};

/** Bounds what one agent-chosen value can add to a log line. */
const MAX_LOGGED_VALUES = 20;
const MAX_LOGGED_VALUE_LENGTH = 64;

function boundForLog(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .slice(0, MAX_LOGGED_VALUES)
    .map((value) => value.slice(0, MAX_LOGGED_VALUE_LENGTH));
}

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface OutboundHeaders {
  readonly headers: Headers;
  /** `anthropic-beta` values the agent sent that were not forwarded (bounded, for the log). */
  readonly droppedBetas: readonly string[];
}

/** The upstream request headers: the allow-listed inbound ones, then the ones this proxy owns. */
export function buildOutboundHeaders(
  reqHeaders: http.IncomingHttpHeaders,
  provider: ProviderConfig,
  realKey: string,
): OutboundHeaders {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS[provider.api]) {
    for (const value of headerValues(reqHeaders[name])) headers.append(name, value);
  }
  const droppedBetas: string[] = [];
  if (provider.api === 'anthropic-messages') {
    const kept = new Set<string>();
    for (const raw of headerValues(reqHeaders['anthropic-beta'])) {
      for (const part of raw.split(',')) {
        const value = part.trim();
        if (value.length === 0) continue;
        if (FORWARDED_ANTHROPIC_BETAS.has(value)) kept.add(value);
        else droppedBetas.push(value);
      }
    }
    if (kept.size > 0) headers.set('anthropic-beta', [...kept].join(','));
  }
  // The body was parsed as a JSON object before this point (proxy.ts) and is forwarded as JSON.
  headers.set('content-type', 'application/json');
  // Always request plaintext upstream: this proxy must parse the SSE body to extract usage, and
  // controls its own outbound request independent of what the original client's own
  // Accept-Encoding asked for (S1.7 assumption — see PR body "假设与偏离").
  headers.set('accept-encoding', 'identity');
  headers.set(
    provider.auth.header,
    provider.auth.scheme ? `${provider.auth.scheme} ${realKey}` : realKey,
  );
  return { headers, droppedBetas: boundForLog(droppedBetas) };
}

/** The query string forwarded upstream (with its `?`), or `''`. */
export function buildOutboundSearch(api: ProviderApiKind, params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const name of FORWARDED_QUERY_PARAMS[api]) {
    for (const value of params.getAll(name)) kept.append(name, value);
  }
  const search = kept.toString();
  return search.length > 0 ? `?${search}` : '';
}

export interface ServerToolStripResult {
  /** `type` values of the removed tool entries (bounded; `(none)` for a missing type). */
  readonly strippedTools: readonly string[];
  /** Removed top-level parameters. */
  readonly strippedParams: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Filters one tool list in place on `holder[key]`; records what it removed. */
function filterToolList(
  holder: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string | undefined>,
  removed: string[],
): void {
  const tools = holder[key];
  if (!Array.isArray(tools)) return;
  const kept = tools.filter((tool) => {
    const type = isRecord(tool) ? tool.type : undefined;
    const typeKey = typeof type === 'string' ? type : type === undefined ? undefined : String(type);
    if (isRecord(tool) && allowed.has(typeKey)) return true;
    removed.push(typeKey ?? '(none)');
    return false;
  });
  if (kept.length !== tools.length) holder[key] = kept;
}

/**
 * Filters the `tool_addition` blocks out of one Anthropic content-block array in place on
 * `holder[key]`. pi 1.0.1+ declares a tool added mid-conversation by value
 * (`{type:'tool_addition', tool:{type:'tool_definition', definition}}`, `inline-tools-2026-09-15`);
 * pi 0.99 referenced an already-declared tool by name (`tool:{type:'tool_reference', name}`), which
 * carries no definition and is kept. A definition is kept only when it is a client-side tool; any
 * other `tool_addition` is removed. A message whose blocks were all removed is left as
 * `content: []`, which the provider rejects with a 400 — fail-closed, like a `tool_choice` naming a
 * removed tool.
 */
function filterToolAdditionBlocks(
  holder: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string | undefined>,
  removed: string[],
): void {
  const content = holder[key];
  if (!Array.isArray(content)) return;
  const kept = content.filter((block) => {
    if (!isRecord(block) || block.type !== 'tool_addition') return true;
    const tool = isRecord(block.tool) ? block.tool : undefined;
    if (tool?.type === 'tool_reference') return true;
    if (tool?.type === 'tool_definition' && isRecord(tool.definition)) {
      const type = tool.definition.type;
      const typeKey =
        typeof type === 'string' ? type : type === undefined ? undefined : String(type);
      if (allowed.has(typeKey)) return true;
      removed.push(typeKey ?? '(none)');
      return false;
    }
    removed.push(`tool_addition:${typeof tool?.type === 'string' ? tool.type : '(none)'}`);
    return false;
  });
  if (kept.length !== content.length) holder[key] = kept;
}

/**
 * Anthropic `tool_addition` blocks wherever a block array can carry them: each message's
 * `content` (where pi puts them, inside a role:system message) and a top-level `system` given as
 * a block array. pi never sends the latter, but R-30's threat is a process holding the Handle
 * that builds its own body, and whether the provider honours a `tool_addition` there is
 * unverified — so it is filtered the same way.
 */
function filterAnthropicToolAdditions(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string | undefined>,
  removed: string[],
): void {
  filterToolAdditionBlocks(body, 'system', allowed, removed);
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (isRecord(message)) filterToolAdditionBlocks(message, 'content', allowed, removed);
  }
}

/**
 * Removes provider-side tools from a parsed request body, in place (see the module comment).
 * The `tools` key stays — possibly as `[]`, which pi itself sends for a conversation with tool
 * history — and `tool_choice` is left alone: one that names a removed tool fails at the provider
 * rather than running it.
 */
export function stripProviderServerTools(
  api: ProviderApiKind,
  body: Record<string, unknown>,
): ServerToolStripResult {
  const allowed = CLIENT_TOOL_TYPES[api];
  const strippedTools: string[] = [];
  const strippedParams: string[] = [];

  filterToolList(body, 'tools', allowed, strippedTools);
  // Tool lists nested in the conversation: pi's mid-conversation tool additions for the OpenAI
  // kinds (a `messages[]` entry with `tools`; Responses `additional_tools` / `tool_search_output`
  // input items) and Anthropic's `tool_addition` content blocks (messages and a block-array `system`).
  const nestedHolder =
    api === 'openai-completions'
      ? body.messages
      : api === 'openai-responses'
        ? body.input
        : undefined;
  if (Array.isArray(nestedHolder)) {
    for (const item of nestedHolder) {
      if (isRecord(item)) filterToolList(item, 'tools', allowed, strippedTools);
    }
  }
  if (api === 'anthropic-messages') {
    filterAnthropicToolAdditions(body, allowed, strippedTools);
  }

  for (const param of SERVER_TOOL_PARAMS[api]) {
    if (Object.hasOwn(body, param)) {
      delete body[param];
      strippedParams.push(param);
    }
  }

  return { strippedTools: boundForLog(strippedTools), strippedParams };
}
