import { loadProvidersFile } from '../config.js';
import { buildModelsJson } from '../gen-models-json.js';

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
 * rather than writing a file directly — the running `llm-proxy` compose service mounts
 * `${NEXTTIME_DATA}/config/llm-providers.yaml` read-only (docker-compose.yml), and `docker compose
 * run` reuses that same service definition, so this file could not write a sibling `models.json`
 * into that same read-only-mounted directory without a separate, one-off writable bind mount —
 * stdout + host-side shell redirection avoids needing one at all. Reads `LLM_PROVIDERS_FILE`
 * (default `/data/config/llm-providers.yaml`, config.ts's own `loadConfig` default — the same
 * value the running proxy itself reads) and `LLM_PROXY_PORT` (default `DEFAULT_LLM_PROXY_PORT`)
 * so the generated `baseUrl`s always agree with how this same container would actually serve
 * requests.
 */

async function run(): Promise<void> {
  const providersFile = process.env.LLM_PROVIDERS_FILE ?? '/data/config/llm-providers.yaml';
  const llmProxyPort = process.env.LLM_PROXY_PORT ? Number(process.env.LLM_PROXY_PORT) : undefined;

  const providersFileContents = await loadProvidersFile(providersFile);
  const modelsJson = buildModelsJson(providersFileContents, { llmProxyPort });

  process.stdout.write(`${JSON.stringify(modelsJson, null, 2)}\n`);
}

run().catch((err: unknown) => {
  console.error('gen-models: failed');
  console.error(err);
  process.exitCode = 1;
});
