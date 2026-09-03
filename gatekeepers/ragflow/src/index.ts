import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  HttpTransport,
  JsonFileIdempotencyStore,
  SharedEnvCredentialResolver,
  createGatekeeperServer,
  resolveGateDataDir,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';

/**
 * `gatekeepers/ragflow` — the preset `http`-kind Gatekeeper instance for a RAGFlow deployment's
 * REST API (design doc §7.5, §7.10, §10.2; docs/development-tasks.md S2.5).
 *
 * Not built on `@nexttime/gatekeeper-base`'s `main()`/`startGatekeeperServer()`: that env-driven
 * bootstrap reads a fixed env var name for each piece (`GATE_TARGET_BASE_URL` for the base URL,
 * always `SharedEnvCredentialResolver({env})` — i.e. always `GATE_CREDENTIAL_DEFAULT` for the
 * credential, never a caller-chosen name). This task's own env contract names them
 * `RAGFLOW_BASE_URL` and `GATE_CREDENTIAL_RAGFLOW_API_KEY` instead (so `gatekeeper-ragflow.env`
 * reads unambiguously as this gate's own config, not a generic `GATE_CREDENTIAL_DEFAULT` that
 * would collide in meaning with any other gate reusing the same `main()` convention) — `main()`
 * cannot be parameterized to do that without editing `@nexttime/gatekeeper-base` itself (out of
 * this task's scope), so this file composes `GatekeeperBase` + `createGatekeeperServer` +
 * `HttpTransport` + `SharedEnvCredentialResolver({name: 'RAGFLOW_API_KEY'})` directly instead —
 * otherwise the exact same "common http case" `main()` handles. `manifest.json` (this package's
 * own preset) is loaded the same way `main()`'s own `loadManifest` does; `GATE_MANIFEST_FILE`
 * still overrides it.
 *
 * `SharedEnvCredentialResolver` treats a non-JSON env value as an opaque token
 * (`{token: <value>}`), and `HttpTransport`'s `credentialHeaders` turns `{token}` into
 * `Authorization: Bearer <token>` — RAGFlow's own auth convention, so no extra glue is needed
 * (`gatekeeper-base/src/credentials/shared-env.ts`, `kinds/http.ts`).
 */

const DEFAULT_MANIFEST_URL = new URL('../manifest.json', import.meta.url);
const DEFAULT_PORT = 8083;

async function loadManifest(path: string | undefined): Promise<Operation[]> {
  const raw = path
    ? await readFile(path, 'utf8')
    : await readFile(fileURLToPath(DEFAULT_MANIFEST_URL), 'utf8');
  return JSON.parse(raw) as Operation[];
}

export interface BuiltRagflowGate {
  readonly gate: GatekeeperBase;
  readonly app: ReturnType<typeof createGatekeeperServer>;
}

export async function buildRagflowGate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuiltRagflowGate> {
  const baseUrl = env.RAGFLOW_BASE_URL;
  if (!baseUrl) throw new Error('gatekeeper-ragflow: RAGFLOW_BASE_URL is not set');

  const manifest = await loadManifest(env.GATE_MANIFEST_FILE);
  const dataDir = resolveGateDataDir(env);

  const transport = new HttpTransport({ baseUrl });
  const credentialResolver = new SharedEnvCredentialResolver({ name: 'RAGFLOW_API_KEY', env });
  const idempotencyStore = new JsonFileIdempotencyStore(dataDir);

  const gate = new GatekeeperBase({ manifest, transport, credentialResolver, idempotencyStore });
  const app = createGatekeeperServer({ gate, logger: true });
  return { gate, app };
}

export async function startRagflowGate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ app: BuiltRagflowGate['app']; close(): Promise<void> }> {
  const { app } = await buildRagflowGate(env);
  const port = Number(env.GATE_PORT ?? DEFAULT_PORT);
  const host = env.GATE_BIND_ADDR ?? '0.0.0.0';
  await app.listen({ port, host });
  return { app, close: () => app.close() };
}

export function main(): void {
  startRagflowGate().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'gatekeeper-ragflow: failed to start',
        error: String(err),
      }),
    );
    process.exitCode = 1;
  });
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
