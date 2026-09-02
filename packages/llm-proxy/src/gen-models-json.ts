import { writeFile } from 'node:fs/promises';
import { DEFAULT_LLM_PROXY_PORT, loadProvidersFile } from './config.js';
import type { LlmProvidersFile, ModelCost } from './config.js';

/**
 * gen-models-json: derives pi's `models.json` (design doc §7.7 "同一份配置生成内核路由表与
 * models.json"; docs/development-tasks.md S1.7) from the same `llm-providers.yaml` this proxy
 * itself reads — one schema, no second copy to drift. `scripts/gen-models-json.ts` is the thin
 * CLI entry point (`make gen-models`); the actual logic lives here so it's typechecked and unit-
 * tested as part of this package (see gen-models-json.test.ts).
 *
 * Verified against pi 0.84.4's own `models.json` schema and resolution logic before writing this
 * (paths relative to the pi checkout, cited per detail below):
 *
 *   - Shape (`packages/coding-agent/src/core/model-config.ts` `ProviderConfigSchema`/
 *     `ModelDefinitionSchema`/`ModelsConfigSchema`): `{ providers: { <id>: { baseUrl?, apiKey?,
 *     api?, models: [{ id, cost?, ... }] } } }`. `cost`'s own shape
 *     (`ModelCostSchema`/`ModelCostRatesSchema`) is exactly `config.ts`'s `ModelCostSchema` here —
 *     copied straight through, unmodified.
 *   - `api` kind literals (`packages/ai/src/models.ts`, e.g. the `hasApi(model,
 *     "anthropic-messages")` doc example): `"openai-completions"` / `"openai-responses"` /
 *     `"anthropic-messages"` — the exact three strings `config.ts`'s `ProviderApiKind` already
 *     uses, so `provider.api` is passed straight through as pi's `api` field.
 *   - `apiKey` may name an environment variable via `$VAR`/`${VAR}` template syntax
 *     (`packages/coding-agent/src/core/resolve-config-value.ts` `resolveConfigValue`/
 *     `parseConfigValueTemplate`) — resolved from the *container's own* env at call time
 *     (`resolveEnvConfigValue`: `env?.[name] || process.env[name]`). So `apiKey: "$CAPABILITY_HANDLE"`
 *     resolves inside the entry/Worker container to its own `CAPABILITY_HANDLE` env var (design
 *     doc §7.2/§7.3: every agent container's env includes exactly that var) — never a literal key.
 *   - `baseUrl` composition (`packages/coding-agent/src/core/provider-composer.ts`, and the
 *     official SDKs it wraps — `packages/ai/src/api/{openai-completions,openai-responses,
 *     anthropic-messages}.ts`, each constructing `new OpenAI({baseURL: model.baseUrl})` /
 *     `new Anthropic({baseURL: model.baseUrl})`): the `openai` SDK's `baseURL` must already end
 *     in `/v1` (it appends `/chat/completions` or `/responses`); `@anthropic-ai/sdk`'s must
 *     **not** (it appends `/v1/messages` itself) — see config.ts's own doc comment on
 *     `upstream_base_url` for the matching inbound-side rule this mirrors.
 */

export interface PiModelDefinition {
  readonly id: string;
  readonly cost?: ModelCost;
}

export interface PiProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly api: string;
  readonly models: readonly PiModelDefinition[];
}

export interface PiModelsJson {
  readonly providers: Record<string, PiProviderConfig>;
}

export interface BuildModelsJsonOptions {
  /** Compose service name the agent containers reach this proxy at. Default `'llm-proxy'`
   *  (design doc §10.2's own service name — never a host address, since only compose DNS
   *  resolves it). */
  readonly llmProxyHost?: string;
  /** Must match the running proxy's actual `LLM_PROXY_PORT` (config.ts) — defaults to the same
   *  `DEFAULT_LLM_PROXY_PORT` constant that default resolves to, so the two can never drift
   *  unless both are overridden independently. */
  readonly llmProxyPort?: number;
  /** Name of the in-container env var `apiKey` resolves from (S1.7 task brief: "apiKey 解析到容器的
   *  CAPABILITY_HANDLE env"). Default `'CAPABILITY_HANDLE'` — the exact name every entry/Worker
   *  container's env carries it under (docs/development-tasks.md S1.5/S2.8/S2.9). */
  readonly capabilityHandleEnvVar?: string;
}

/**
 * Pure transform, no I/O — unit-tested directly (gen-models-json.test.ts) against
 * `config/llm-providers.example.yaml`. `upstream_base_url`/`api_key_env`/`auth` are deliberately
 * **not** copied into `models.json` — those describe how this proxy reaches the *real* provider,
 * which an agent container must never see (I9); the container only ever talks to this proxy.
 */
export function buildModelsJson(
  providersFile: LlmProvidersFile,
  options: BuildModelsJsonOptions = {},
): PiModelsJson {
  const host = options.llmProxyHost ?? 'llm-proxy';
  const port = options.llmProxyPort ?? DEFAULT_LLM_PROXY_PORT;
  const capabilityHandleEnvVar = options.capabilityHandleEnvVar ?? 'CAPABILITY_HANDLE';

  const providers: Record<string, PiProviderConfig> = {};
  for (const [name, provider] of Object.entries(providersFile.providers)) {
    // See this module's own doc comment for why the two api-kind families need different
    // baseUrl shapes here.
    const baseUrl =
      provider.api === 'anthropic-messages'
        ? `http://${host}:${port}/${name}`
        : `http://${host}:${port}/${name}/v1`;

    providers[name] = {
      baseUrl,
      apiKey: `$${capabilityHandleEnvVar}`,
      api: provider.api,
      models: provider.models.map((model) => ({
        id: model.id,
        ...(model.cost ? { cost: model.cost } : {}),
      })),
    };
  }

  return { providers };
}

export interface GenerateModelsJsonOptions extends BuildModelsJsonOptions {
  readonly providersFile: string;
  readonly outFile: string;
}

/** Reads+validates `providersFile`, derives `models.json`, and writes it to `outFile` (pretty-
 *  printed, trailing newline). Returns the written document. */
export async function generateModelsJson(
  options: GenerateModelsJsonOptions,
): Promise<PiModelsJson> {
  const providersFile = await loadProvidersFile(options.providersFile);
  const modelsJson = buildModelsJson(providersFile, options);
  await writeFile(options.outFile, `${JSON.stringify(modelsJson, null, 2)}\n`, 'utf8');
  return modelsJson;
}
