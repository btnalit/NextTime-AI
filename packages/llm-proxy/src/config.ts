import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * config: env vars (`loadConfig`) and `${NEXTTIME_DATA}/config/llm-providers.yaml`
 * (`loadProvidersFile`) — the schema design doc §7.7/§9.2 and docs/development-tasks.md S1.7
 * define: "同一份配置生成内核路由表与 models.json" (this file's `ProviderConfigSchema` is that one
 * schema; `gen-models-json.ts` derives pi's `models.json` from it, and `proxy.ts` derives the
 * inbound-route/whitelist/upstream-forwarding table from it directly — no separate copy).
 *
 * Field names in the YAML are snake_case (`upstream_base_url`, `api_key_env`) — these are the
 * exact names the S1.7 task brief specifies for this on-disk config file, unlike this package's
 * JSON wire contracts (report.ts, revocation.ts), which use this codebase's established camelCase
 * convention instead (see report.ts's own doc comment for that distinction).
 */

/** Default `LLM_PROXY_PORT` — also what `gen-models-json.ts` bakes into `models.json`'s
 *  `baseUrl`s, so the two can never drift on which port the proxy actually listens on. */
export const DEFAULT_LLM_PROXY_PORT = 8082;

/** pi-ai's `ModelCost` shape (verified against pi 0.84.4's own schema —
 *  pi-0.84.4/packages/coding-agent/src/core/model-config.ts `ModelCostSchema`): four required
 *  per-token-type USD rates, plus optional volume `tiers`. A model entry's `cost` is optional
 *  (many deployments won't configure pricing at all), but once present every rate is required —
 *  matching pi's own schema exactly, since `gen-models-json.ts` writes this straight through into
 *  `models.json`'s own `cost` field. */
const ModelCostRatesSchema = {
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
};
const ModelCostTierSchema = z
  .object({ inputTokensAbove: z.number(), ...ModelCostRatesSchema })
  .strict();
export const ModelCostSchema = z
  .object({ ...ModelCostRatesSchema, tiers: z.array(ModelCostTierSchema).optional() })
  .strict();
export type ModelCost = z.infer<typeof ModelCostSchema>;

const ProviderModelSchema = z
  .object({
    id: z.string().min(1),
    cost: ModelCostSchema.optional(),
  })
  .strict();
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/** The header the *inbound* request carries the Handle in — the same header the upstream request
 *  substitutes the real provider key into (S1.7 task brief). Verified against pi 0.84.4's own
 *  provider implementations: `openai-completions`/`openai-responses` send `Authorization: Bearer
 *  <key>` (pi-0.84.4/packages/ai/src/api/openai-completions.ts, .../openai-responses.ts — both
 *  construct `new OpenAI({ baseURL: model.baseUrl, ... })`, the official `openai` SDK's own
 *  Bearer-auth convention); `anthropic-messages` sends `x-api-key: <key>` with no scheme prefix
 *  (pi-0.84.4/packages/ai/src/api/anthropic-messages.ts `new Anthropic({ baseURL: model.baseUrl
 *  })`, the official `@anthropic-ai/sdk`'s own convention). */
const ProviderAuthSchema = z
  .object({
    header: z.enum(['authorization', 'x-api-key']),
    scheme: z.literal('Bearer').optional(),
  })
  .strict();
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>;

/**
 * `upstream_base_url` must be the bare provider origin, e.g. `https://api.openai.com` or
 * `https://api.anthropic.com` — **never** ending in `/v1`. `proxy.ts` forwards an inbound request
 * by stripping only the leading `/<provider>` path segment and appending the remainder verbatim
 * onto this base; the remainder already starts with `/v1` for every supported `api` kind (design
 * doc's own inbound-route naming: `/<provider>/v1/*` for the OpenAI-compatible kinds,
 * `/<provider>/v1/messages` for Anthropic). This one rule works uniformly for both provider
 * families only because the official SDKs disagree on whether their own `baseUrl` config
 * includes `/v1` (verified in pi 0.84.4's source, same files cited on `ProviderAuthSchema` above):
 * `openai`'s `baseURL` already ends in `/v1` and the SDK appends `/chat/completions` or
 * `/responses`; `@anthropic-ai/sdk`'s `baseURL` does **not** end in `/v1` and the SDK appends
 * `/v1/messages` itself. `gen-models-json.ts` bakes the matching convention into each provider's
 * `models.json` `baseUrl` (`/<name>/v1` for the OpenAI kinds, bare `/<name>` for Anthropic) so the
 * inbound path this proxy actually receives is already correct without any per-kind branching
 * here.
 */
const ProviderConfigSchema = z
  .object({
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
    upstream_base_url: z.string().url(),
    /** Name of the env var (in this container's own env — `secrets/llm-proxy.env`, design doc
     *  §10.2) holding the real provider key. Never the key itself. */
    api_key_env: z.string().min(1),
    auth: ProviderAuthSchema,
    models: z.array(ProviderModelSchema).min(1),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
/** One of the three `api` kinds this proxy understands — verified against pi 0.84.4's own
 *  provider implementations (see `ProviderAuthSchema`'s doc comment above for the exact files). */
export type ProviderApiKind = ProviderConfig['api'];

export const LlmProvidersFileSchema = z
  .object({
    providers: z.record(z.string(), ProviderConfigSchema),
  })
  .strict();
export type LlmProvidersFile = z.infer<typeof LlmProvidersFileSchema>;

export class LlmProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProxyConfigError';
  }
}

/** Reads and validates `${NEXTTIME_DATA}/config/llm-providers.yaml` (or the example file, in
 *  tests). Loaded once at startup — this package does not hot-reload it (unlike
 *  `egress-proxy`'s `SOURCE_MAP_FILE`); a config change needs a container restart. */
export async function loadProvidersFile(filePath: string): Promise<LlmProvidersFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new LlmProxyConfigError(
      `failed to read llm-providers.yaml at "${filePath}": ${String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new LlmProxyConfigError(
      `failed to parse llm-providers.yaml at "${filePath}" as YAML: ${String(err)}`,
    );
  }

  const result = LlmProvidersFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmProxyConfigError(
      `llm-providers.yaml at "${filePath}" does not match the expected schema: ${result.error.message}`,
    );
  }
  return result.data;
}

export interface LlmProxyConfig {
  /** All interfaces — reachable from both `control` (kernel-adjacent tooling) and `workers`
   *  (agent containers) networks (design doc §10.2 compose block). */
  readonly port: number;
  /** Base URL for `POST/GET ${kernelUrl}/internal/*`. Unset disables both usage reporting and
   *  revocation sync (fail-open on the latter — see revocation.ts). */
  readonly kernelUrl: string | undefined;
  readonly handlePublicKeyFile: string;
  readonly providersFile: string;
  readonly revocationSyncIntervalMs: number;
  /** How far back of the last successful sync's `now` to re-request on the next poll, to absorb
   *  clock/transaction-commit skew (revocation.ts doc comment). */
  readonly revocationSyncOverlapMs: number;
  readonly usageFlushIntervalMs: number;
  readonly usageMaxFlushIntervalMs: number;
  readonly usageMaxQueueSize: number;
  /** Caps how much of a request body this proxy buffers (it must buffer the whole body to read
   *  `model` and, for one provider kind, mutate it — see proxy.ts). */
  readonly maxRequestBodyBytes: number;
  /** Idle timeout for the upstream connection — generous by default: LLM responses can stall for
   *  tens of seconds mid-stream while the model "thinks". */
  readonly upstreamIdleTimeoutMs: number;
  readonly upstreamConnectTimeoutMs: number;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LlmProxyConfig {
  return {
    port: parseIntEnv(env.LLM_PROXY_PORT, DEFAULT_LLM_PROXY_PORT),
    kernelUrl: env.KERNEL_URL,
    handlePublicKeyFile: env.HANDLE_PUBLIC_KEY_FILE ?? '/data/config/handle.pub',
    providersFile: env.LLM_PROVIDERS_FILE ?? '/data/config/llm-providers.yaml',
    revocationSyncIntervalMs: parseIntEnv(env.REVOCATION_SYNC_INTERVAL_MS, 15_000),
    revocationSyncOverlapMs: parseIntEnv(env.REVOCATION_SYNC_OVERLAP_MS, 60_000),
    usageFlushIntervalMs: parseIntEnv(env.USAGE_FLUSH_INTERVAL_MS, 2000),
    usageMaxFlushIntervalMs: parseIntEnv(env.USAGE_MAX_FLUSH_INTERVAL_MS, 60_000),
    usageMaxQueueSize: parseIntEnv(env.USAGE_MAX_QUEUE_SIZE, 1000),
    maxRequestBodyBytes: parseIntEnv(env.MAX_REQUEST_BODY_BYTES, 10 * 1024 * 1024),
    upstreamIdleTimeoutMs: parseIntEnv(env.UPSTREAM_IDLE_TIMEOUT_MS, 300_000),
    upstreamConnectTimeoutMs: parseIntEnv(env.UPSTREAM_CONNECT_TIMEOUT_MS, 10_000),
  };
}
