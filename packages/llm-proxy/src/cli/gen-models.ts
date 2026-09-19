import { ProviderCatalog } from '../catalog.js';
import { loadProvidersFile } from '../config.js';
import { buildModelsJsonFromCatalog, serializeModelsJson } from '../gen-models-json.js';
import { ProviderStore } from '../provider-store.js';

/**
 * CLI entry for generating pi's `models.json` from *inside* the built `llm-proxy` image, so it
 * works on a host with no Node/corepack of its own (docs/development-tasks.md S1.5, second half,
 * deliverable 5 — the pre-existing `scripts/gen-models-json.ts` at the repo root imports this
 * package's *dist* output by relative path, which only exists on a machine that already has this
 * whole monorepo checked out and built; the target host runbook's own §10 already documents "the
 * host has no corepack").
 *
 * Usage (see Makefile's `gen-models` target and docs/runbooks/host-worker-runtime.md):
 *
 *   docker compose build llm-proxy
 *   docker compose run --rm --no-deps -T llm-proxy node dist/cli/gen-models.js \
 *     > "${NEXTTIME_DATA}/config/models.json"
 *
 * Prints the generated `models.json` document to **stdout** (pretty-printed, trailing newline)
 * rather than writing a file directly — `docker compose run` reuses the service definition, and
 * the Makefile's `.tmp` + `mv` redirect on the host side is what makes the operator path atomic.
 * Reads `LLM_PROVIDERS_FILE` (default `/data/config/llm-providers.yaml`, config.ts's own
 * `loadConfig` default — the same value the running proxy itself reads) and `LLM_PROXY_PORT`
 * (default `DEFAULT_LLM_PROXY_PORT`) so the generated `baseUrl`s always agree with how this same
 * container would actually serve requests.
 *
 * S6-B: also reads the console-managed provider store (`LLM_PROVIDER_STORE_FILE`, default
 * `/data/state/providers.json` — mounted into this same service definition, so `docker compose
 * run` sees it) and emits the *merged* catalog, exactly what the running proxy writes after an
 * admin mutation. Before this, `make gen-models` would have silently dropped every provider the
 * administrator added in the console. A missing store file is an empty store.
 */

async function run(): Promise<void> {
  const providersFile = process.env.LLM_PROVIDERS_FILE ?? '/data/config/llm-providers.yaml';
  const storeFile = process.env.LLM_PROVIDER_STORE_FILE ?? '/data/state/providers.json';
  const llmProxyPort = process.env.LLM_PROXY_PORT ? Number(process.env.LLM_PROXY_PORT) : undefined;

  const providersFileContents = await loadProvidersFile(providersFile);
  const store = new ProviderStore(storeFile);
  await store.load();
  const catalog = new ProviderCatalog(providersFileContents.providers, store);
  const modelsJson = buildModelsJsonFromCatalog(catalog, { llmProxyPort });

  process.stdout.write(serializeModelsJson(modelsJson));
}

run().catch((err: unknown) => {
  console.error('gen-models: failed');
  console.error(err);
  process.exitCode = 1;
});
