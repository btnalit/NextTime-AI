// gen-models-json.ts — thin CLI: reads ${NEXTTIME_DATA}/config/llm-providers.yaml, writes
// ${NEXTTIME_DATA}/config/models.json (design doc §7.7, §10.1; docs/development-tasks.md S1.7).
//
// The real transform lives in packages/llm-proxy/src/gen-models-json.ts (typechecked and unit-
// tested as part of that package, against config/llm-providers.example.yaml) — this file only
// wires env vars to it and imports the *built* dist output, not the TS source, so it runs the
// same way regardless of which Node 22.x patch is on PATH (deliberately contains no TypeScript-
// only syntax itself, for the same reason). Run via `make gen-models`, which builds
// @nexttime/llm-proxy first.
//
// Usage: NEXTTIME_DATA=/path/to/data node scripts/gen-models-json.ts

import { generateModelsJson } from '../packages/llm-proxy/dist/gen-models-json.js';

const NEXTTIME_DATA = process.env.NEXTTIME_DATA;
if (!NEXTTIME_DATA) {
  console.error('gen-models-json: NEXTTIME_DATA is not set; refusing to run');
  process.exit(1);
}

const providersFile =
  process.env.LLM_PROVIDERS_FILE ?? `${NEXTTIME_DATA}/config/llm-providers.yaml`;
const outFile = process.env.MODELS_JSON_FILE ?? `${NEXTTIME_DATA}/config/models.json`;
const llmProxyPort = process.env.LLM_PROXY_PORT ? Number(process.env.LLM_PROXY_PORT) : undefined;

generateModelsJson({ providersFile, outFile, llmProxyPort })
  .then((result) => {
    const count = Object.keys(result.providers).length;
    console.log(`gen-models-json: wrote ${outFile} (${count} provider(s))`);
  })
  .catch((err) => {
    console.error('gen-models-json: failed');
    console.error(err);
    process.exitCode = 1;
  });
