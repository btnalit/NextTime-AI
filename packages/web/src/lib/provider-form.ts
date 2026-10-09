import type {
  LlmProviderApiKindWire,
  LlmProviderAuthHeaderWire,
  LlmProviderTestResultWire,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/provider-form: the pure input handling behind 「新增 / 编辑 LLM 供应商」
 * (`components/platform/providers/ProviderForm.tsx`). The rules the proxy enforces stay exactly as
 * they are (`@nexttime/shared` wire/llm-admin.ts, re-validated by llm-proxy on every write); this
 * module only turns what an administrator naturally types or pastes into a value that already
 * satisfies them, says precisely what is still wrong when it cannot, and explains a test outcome
 * in words instead of an HTTP status line.
 */

/** Same rules as `@nexttime/shared` (`LLM_PROVIDER_ID_PATTERN`, `LLM_PROVIDER_RESERVED_IDS`,
 *  `LlmProviderApiKeyEnvWireSchema`) — the web package imports shared types only, so the two
 *  regexes are restated here; the proxy re-validates on every write. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(['admin', 'healthz', 'internal']);
export const API_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface ProviderPreset {
  readonly key: string;
  /** Becomes the provider id unless the administrator types their own. Where pi has a built-in
   *  provider for the vendor this is pi's own provider name: the agent's models.json names the
   *  provider by this id and points `baseUrl` at llm-proxy, so the id is all pi's OpenAI-compat
   *  vendor detection (`max_tokens` field, thinking-parameter format, `store`) has to go on.
   *  platform-extension `pi-provider-ids.test.ts` checks them against the pinned pi. */
  readonly id: string;
  readonly displayName: string;
  readonly api: LlmProviderApiKindWire;
  /** The bare origin (plus a fixed path prefix where the vendor needs one) — the proxy appends
   *  `/v1/…` itself (llm-proxy config.ts `upstream_base_url`). */
  readonly upstreamBaseUrl: string;
  readonly apiKeyEnv: string;
  /** Where the administrator gets a key — shown next to the key field. */
  readonly keyHint: string;
  /** Offered only when the provider's model list cannot be fetched (a relay without
   *  `/v1/models`, a list error): common model ids for the vendor, shown as "未核验" until
   *  「验证所选模型」 has run against them with the administrator's own key. */
  readonly suggestedModels: readonly string[];
}

/**
 * Vendors whose public endpoint fits the proxy's `<base>/v1/<endpoint>` rule as-is. Deliberately
 * not here: Google Gemini's OpenAI-compatible endpoint (`/v1beta/openai/chat/completions`) and
 * Zhipu (`/api/paas/v4/…`), whose paths have no `/v1/<endpoint>` suffix the proxy could append —
 * reach those through a relay that does (OpenRouter, a self-hosted one-api, …).
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    key: 'anthropic',
    id: 'anthropic',
    displayName: 'Anthropic',
    api: 'anthropic-messages',
    upstreamBaseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    keyHint: 'console.anthropic.com → API Keys',
    suggestedModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  },
  {
    key: 'openai',
    id: 'openai',
    displayName: 'OpenAI',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://api.openai.com',
    apiKeyEnv: 'OPENAI_API_KEY',
    keyHint: 'platform.openai.com → API keys',
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  },
  {
    key: 'deepseek',
    id: 'deepseek',
    displayName: 'DeepSeek',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    keyHint: 'platform.deepseek.com → API keys',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    key: 'openrouter',
    id: 'openrouter',
    displayName: 'OpenRouter',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://openrouter.ai/api',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyHint: 'openrouter.ai → Keys',
    suggestedModels: [],
  },
  {
    key: 'moonshot',
    id: 'moonshotai-cn',
    displayName: 'Moonshot (Kimi)',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://api.moonshot.cn',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    keyHint: 'platform.moonshot.cn → API Key',
    suggestedModels: ['kimi-k2-turbo-preview', 'moonshot-v1-32k'],
  },
  {
    key: 'dashscope',
    id: 'dashscope',
    displayName: '通义千问 (DashScope)',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    keyHint: 'bailian.console.aliyun.com → API-KEY',
    suggestedModels: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    key: 'siliconflow',
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://api.siliconflow.cn',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    keyHint: 'cloud.siliconflow.cn → API 密钥',
    suggestedModels: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-32B'],
  },
];

/** The preset whose upstream host `baseUrl` points at, if any — so an edited provider, or one
 *  whose URL was typed rather than picked, still gets the vendor's suggestions. */
export function presetForBaseUrl(baseUrl: string): ProviderPreset | undefined {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return PROVIDER_PRESETS.find((p) => new URL(p.upstreamBaseUrl).hostname === host);
  } catch {
    return undefined;
  }
}

/** The auth header each api kind's own SDK uses — the proxy sends the real key in it. */
export function defaultAuthHeader(api: LlmProviderApiKindWire): LlmProviderAuthHeaderWire {
  return api === 'anthropic-messages' ? 'x-api-key' : 'authorization';
}

/** A provider id from free text: lower-cased, separators to `-`, anything else dropped, trimmed
 *  to 63 chars. Returns `''` when nothing usable is left (e.g. an all-Chinese name). */
export function slugifyProviderId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_.:/]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/** A fallback id from the base URL's host: `api.deepseek.com` → `deepseek`. */
export function providerIdFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // A preset vendor's host gets the preset id (pi's provider name — see `ProviderPreset.id`).
    const preset = PROVIDER_PRESETS.find((p) => new URL(p.upstreamBaseUrl).hostname === host);
    if (preset) return preset.id;
    const labels = host.split('.').filter((label) => !['api', 'www', 'openai'].includes(label));
    const core = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    return slugifyProviderId(core ?? '');
  } catch {
    return '';
  }
}

export function providerIdProblem(id: string, t: Translate): string | null {
  if (id.length === 0) return t('需要一个 id', 'An id is required');
  if (RESERVED_PROVIDER_IDS.has(id)) {
    return t(`「${id}」是代理自身路由的保留名，换一个`, `"${id}" is reserved by the proxy`);
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return t(
      '只能用小写字母、数字和连字符，且以字母或数字开头（最长 63 个字符）',
      'Lowercase letters, digits and hyphens, starting with a letter or digit (63 max)',
    );
  }
  return null;
}

const ENDPOINT_SUFFIXES = [
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/models',
  '/chat/completions',
  '/v1',
];

export interface NormalizedBaseUrl {
  readonly value: string;
  /** What was stripped or added, for the one-line note under the field. */
  readonly changed: 'none' | 'scheme-added' | 'suffix-stripped' | 'both';
}

/** Turns a pasted endpoint into the bare base the proxy wants: adds `https://` when there is no
 *  scheme, drops a query/fragment, trailing slashes and a trailing `/v1` or full endpoint path
 *  (`/v1/chat/completions`, `/v1/messages`, …) — the proxy appends those itself. */
export function normalizeBaseUrl(raw: string): NormalizedBaseUrl {
  let value = raw.trim();
  if (value.length === 0) return { value, changed: 'none' };
  let schemeAdded = false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
    schemeAdded = true;
  }
  value = value.replace(/[?#].*$/, '').replace(/\/+$/, '');
  let stripped = false;
  for (;;) {
    const lower = value.toLowerCase();
    const suffix = ENDPOINT_SUFFIXES.find((s) => lower.endsWith(s));
    if (!suffix) break;
    value = value.slice(0, value.length - suffix.length).replace(/\/+$/, '');
    stripped = true;
  }
  return {
    value,
    changed:
      schemeAdded && stripped
        ? 'both'
        : schemeAdded
          ? 'scheme-added'
          : stripped
            ? 'suffix-stripped'
            : 'none',
  };
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/** A guess at the api kind from the base URL's host — only used while the administrator has not
 *  picked one themselves. */
export function guessApiKind(url: string): LlmProviderApiKindWire | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
      return 'anthropic-messages';
    }
    return null;
  } catch {
    return null;
  }
}

/** Case-sensitive on purpose: vendors issue these prefixes exactly so (`sk-…`, `AIza…`), while an
 *  env var name that merely starts with `SK_` is upper-case. */
const SECRET_PREFIXES = /^(sk-|sk_|gsk_|xai-|AIza|pk-|ghp_|github_pat_|hf_)/;

/** Whether a value typed into the env-var-name field is far more likely the key itself: a known
 *  key prefix on a key-length value, or a long run that mixes lower-case letters and digits (an
 *  env var name is conventionally upper-case words). */
export function looksLikeSecret(raw: string): boolean {
  const value = raw.trim();
  if (value.length < 20) return false;
  if (SECRET_PREFIXES.test(value)) return true;
  return value.length >= 30 && /[a-z]/.test(value) && /\d/.test(value) && !/\s/.test(value);
}

export interface NormalizedEnvName {
  readonly value: string;
  /** `secret`: the input looked like a key, not a name (`value` is then `''`). */
  readonly note: 'none' | 'normalized' | 'value-dropped' | 'secret';
}

/**
 * What an administrator types for an env var name, as the proxy's `^[A-Z][A-Z0-9_]*$` rule wants
 * it: `export NAME=…` / `NAME=…` keep only `NAME` (and never the value), `$NAME` / `${NAME}` lose
 * the sigil, letters are upper-cased, and `-`, `.`, spaces and other separators become `_`.
 * A key pasted into this field is reported as `secret` rather than kept.
 */
export function normalizeEnvName(raw: string): NormalizedEnvName {
  let value = raw.trim();
  if (value.length === 0) return { value: '', note: 'none' };
  value = value.replace(/^export\s+/i, '');
  let valueDropped = false;
  const eq = value.indexOf('=');
  if (eq >= 0) {
    valueDropped = value.slice(eq + 1).trim().length > 0;
    value = value.slice(0, eq).trim();
  }
  if (looksLikeSecret(value)) return { value: '', note: 'secret' };
  value = value.replace(/^\$\{?/, '').replace(/\}$/, '');
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128);
  return {
    value: normalized,
    note: valueDropped ? 'value-dropped' : normalized !== raw.trim() ? 'normalized' : 'none',
  };
}

export function envNameProblem(value: string, t: Translate): string | null {
  if (value.length === 0) return null;
  if (!API_KEY_ENV_PATTERN.test(value)) {
    return t(
      '变量名要以字母开头，像 DEEPSEEK_API_KEY 这样',
      'The name must start with a letter, e.g. DEEPSEEK_API_KEY',
    );
  }
  return null;
}

export type TestVerdict = 'ok' | 'chat-only' | 'failed';

export function testVerdict(result: LlmProviderTestResultWire): TestVerdict {
  if (result.completion === 'ok' && result.toolCall === 'ok') return 'ok';
  if (result.completion === 'ok') return 'chat-only';
  return 'failed';
}

/** The upstream HTTP status inside a test/discovery error string (`HTTP 401: …`), if any. */
export function upstreamStatus(error: string | null): number | null {
  if (!error) return null;
  const match = /HTTP (\d{3})/.exec(error);
  return match ? Number(match[1]) : null;
}

/** One plain sentence on what an upstream failure most likely means and what to change.
 *  `phase` says which round trip of a provider test failed (`'tool_call'` once the completion
 *  passed): a 400 there means the endpoint refused a request carrying tools. */
export function explainUpstreamError(
  error: string | null,
  t: Translate,
  phase?: 'completion' | 'tool_call',
): string | null {
  if (!error) return null;
  // Checked first: when the forced tool_choice was refused and the retry answered in prose, the
  // message also carries that first refusal's `HTTP 400`.
  if (/^tool-call response carried no call of/.test(error)) {
    return t(
      '模型能回答，但没有按要求发起工具调用：这个模型或中转可能不支持工具调用，Worker 和门工具会用不了。',
      'The model answered but did not call the tool — this model or relay may not support tool calling, so Workers and gate tools will not work.',
    );
  }
  const status = upstreamStatus(error);
  if (status === 401 || status === 403) {
    return t(
      '供应商拒绝了密钥：检查密钥是否完整、未过期、对这个模型有权限。',
      'The provider rejected the key — check it is complete, not expired, and allowed to use this model.',
    );
  }
  // A result stored before the probe learned to retry: the upstream refused only the probe's
  // forced tool_choice (DeepSeek thinking mode), which says nothing about tool support.
  if ((status === 400 || status === 422) && /tool_choice/i.test(error) && !/retried/i.test(error)) {
    return t(
      '供应商只是不接受测试探针里强制指定的 tool_choice（如 DeepSeek 思考模式），不代表不能用工具。重新测试一次即可得到准确结果。',
      'The provider only refused the probe’s forced tool_choice (e.g. DeepSeek thinking mode), which does not mean tools are unsupported. Run the test again for an accurate result.',
    );
  }
  if (phase === 'tool_call' && (status === 400 || status === 422)) {
    return t(
      '能正常对话，但上游拒绝了带工具的请求：这个模型或中转多半不支持工具调用，Worker 和门工具会用不了，换一个支持工具调用的模型。',
      'Chat works, but the upstream refused a request carrying tools — this model or relay most likely does not support tool calling, so Workers and gate tools will not work. Pick a model that does.',
    );
  }
  if (status === 404) {
    return t(
      '上游返回 404：多半是模型 id 拼错，或 Base URL 不对（应为不带 /v1 的源站）。',
      'The upstream answered 404 — usually a misspelt model id or a wrong Base URL (the origin, without /v1).',
    );
  }
  if (status === 400 || status === 422) {
    return t(
      '上游拒绝了请求参数：常见于模型不支持这个接口或工具调用，或 API 种类选错。',
      'The upstream rejected the request — often a model that does not support this API or tool calling, or the wrong API kind.',
    );
  }
  if (status === 402 || status === 429) {
    return t(
      '被限流或额度不足：稍后重试，或检查供应商账户余额与限额。',
      'Rate-limited or out of credit — retry later, or check the account balance and limits.',
    );
  }
  if (status !== null && status >= 500) {
    return t(
      '供应商服务端出错，通常是暂时的，稍后重试。',
      'The provider had a server error — usually temporary, retry later.',
    );
  }
  if (/timeout|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|certificate|redirect/i.test(error)) {
    return t(
      '连不上上游：检查 Base URL 拼写，以及主机能否访问这个地址（出网放行）。',
      'Could not reach the upstream — check the Base URL and that the host may reach it (egress).',
    );
  }
  return null;
}
