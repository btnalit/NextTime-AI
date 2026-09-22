import { rename, unlink, writeFile } from 'node:fs/promises';
import type { ProviderCatalog } from './catalog.js';
import { DEFAULT_LLM_PROXY_PORT, loadProvidersFile } from './config.js';
import type { LlmProvidersFile, ModelCost, ProviderConfig } from './config.js';

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
  /** pi's own optional display name (`ModelDefinitionSchema.name`, pi 0.84.4 model-config.ts) —
   *  S6-B writes the console's per-model display name here; absent when none was set. */
  readonly name?: string;
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
  return buildModelsJsonFromEntries(
    Object.entries(providersFile.providers).map(([name, config]) => ({ name, config })),
    options,
  );
}

export interface ModelsJsonEntry {
  readonly name: string;
  readonly config: ProviderConfig;
}

/** S6-B: the same transform over an explicit provider list — what `ProviderCatalog` feeds it
 *  (`buildModelsJsonFromCatalog`): file + store merged, *enabled* providers only, so a provider
 *  the administrator disabled disappears from pi's picker and from the kernel's projection the
 *  moment `models.json` is rewritten, matching proxy.ts's own 404 for it. */
export function buildModelsJsonFromEntries(
  entries: readonly ModelsJsonEntry[],
  options: BuildModelsJsonOptions = {},
): PiModelsJson {
  const host = options.llmProxyHost ?? 'llm-proxy';
  const port = options.llmProxyPort ?? DEFAULT_LLM_PROXY_PORT;
  const capabilityHandleEnvVar = options.capabilityHandleEnvVar ?? 'CAPABILITY_HANDLE';

  const providers: Record<string, PiProviderConfig> = {};
  for (const { name, config: provider } of entries) {
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
        ...(model.display_name ? { name: model.display_name } : {}),
        ...(model.cost ? { cost: model.cost } : {}),
      })),
    };
  }

  return { providers };
}

export function buildModelsJsonFromCatalog(
  catalog: ProviderCatalog,
  options: BuildModelsJsonOptions = {},
): PiModelsJson {
  return buildModelsJsonFromEntries(
    catalog
      .resolve()
      .filter((provider) => provider.enabled)
      .map((provider) => ({ name: provider.id, config: provider.config })),
    options,
  );
}

export function serializeModelsJson(modelsJson: PiModelsJson): string {
  return `${JSON.stringify(modelsJson, null, 2)}\n`;
}

/**
 * S6-B: writes `models.json` atomically — `<outFile>.tmp-<pid>` then `rename`, the exact
 * guarantee the Makefile's `gen-models` target gives with its own `.tmp` + `mv` (its comment:
 * "readers only ever see the old complete file or the new complete file, never a partial one").
 * The kernel re-reads this file on every `list_models` / `list_platform_models` call and
 * worker-supervisor bind-mounts it into every container it spawns, so a torn write would be
 * visible immediately. The temp file is removed on any failure so a failed rewrite leaves no
 * debris for `make gen-models` to trip over.
 */
export async function writeModelsJsonAtomic(
  outFile: string,
  modelsJson: PiModelsJson,
): Promise<void> {
  const tmp = `${outFile}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, serializeModelsJson(modelsJson), { encoding: 'utf8', mode: 0o644 });
    await rename(tmp, outFile);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
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
  await writeFile(options.outFile, serializeModelsJson(modelsJson), 'utf8');
  return modelsJson;
}
