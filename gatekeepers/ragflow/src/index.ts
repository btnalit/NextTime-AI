import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  JsonFileIdempotencyStore,
  SharedEnvCredentialResolver,
  assertTlsNotDisabled,
  buildTlsFetch,
  createGatekeeperServer,
  gateTlsOptionsFromEnv,
  loadGateKernelToken,
  parseManifestJson,
  resolveGateDataDir,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { RagflowTransport } from './transport.js';

/**
 * `gatekeepers/ragflow` — the preset `http`-kind Gatekeeper instance for a RAGFlow deployment's
 * REST API (design doc §7.5, §7.10, §10.2; docs/development-tasks.md S2.5, v2 manifest S3.4).
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
 * `RagflowTransport` (`./transport.ts` — S3.4; wraps `@nexttime/gatekeeper-base`'s `HttpTransport`
 * for every Operation except `document.upload`, which needs a real multipart request that
 * `HttpTransport` cannot express, see that file's own doc comment) +
 * `SharedEnvCredentialResolver({name: 'RAGFLOW_API_KEY'})` directly instead — otherwise the exact
 * same "common http case" `main()` handles. `manifest.json` (this package's own preset) is loaded
 * the same way `main()`'s own `loadManifest` does; `GATE_MANIFEST_FILE` still overrides it.
 *
 * `SharedEnvCredentialResolver` treats a non-JSON env value as an opaque token
 * (`{token: <value>}`), and `HttpTransport`'s `credentialHeaders` (`RagflowTransport`'s own
 * `credentialAuthorizationHeader` for `document.upload`) turns `{token}` into
 * `Authorization: Bearer <token>` — RAGFlow's own auth convention, so no extra glue is needed
 * (`gatekeeper-base/src/credentials/shared-env.ts`, `kinds/http.ts`).
 */

const DEFAULT_MANIFEST_URL = new URL('../manifest.json', import.meta.url);
const DEFAULT_PORT = 8083;

async function loadManifest(path: string | undefined): Promise<Operation[]> {
  const source = path ?? fileURLToPath(DEFAULT_MANIFEST_URL);
  const raw = await readFile(source, 'utf8');
  return parseManifestJson(raw, source);
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

  // Loaded next — this gate refuses to start without a valid auth token (review lane 5, P1-1;
  // @nexttime/gatekeeper-base's gate-auth.ts).
  const token = loadGateKernelToken(env);
  // Also before any other IO — a gate must never come up with certificate verification silently
  // disabled (review lane 5, P3 batch; @nexttime/gatekeeper-base's tls.ts doc comment).
  assertTlsNotDisabled(env);
  const manifest = await loadManifest(env.GATE_MANIFEST_FILE);
  const dataDir = resolveGateDataDir(env);

  // A RAGFlow edge usually terminates TLS with a self-signed certificate issued to a DNS name —
  // GATE_TLS_CA_FILE (its PEM) + GATE_TLS_SERVERNAME (that name) trust exactly that target; see
  // @nexttime/gatekeeper-base's tls.ts and README "TLS to the target".
  const tls = gateTlsOptionsFromEnv(env);
  const transport = new RagflowTransport({
    baseUrl,
    ...(tls ? { fetchImpl: buildTlsFetch(tls) } : {}),
  });
  const credentialResolver = new SharedEnvCredentialResolver({ name: 'RAGFLOW_API_KEY', env });
  const idempotencyStore = new JsonFileIdempotencyStore(dataDir);

  const gate = new GatekeeperBase({ manifest, transport, credentialResolver, idempotencyStore });
  const app = createGatekeeperServer({ gate, logger: true, token });
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
