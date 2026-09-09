import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  type CredentialResolver,
  GatekeeperBase,
  JsonFileIdempotencyStore,
  type ResolvedCredential,
  createGatekeeperServer,
  loadGateKernelToken,
  parseManifestJson,
  resolveGateDataDir,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { createDockerClient, parseDockerConnection } from './docker-client.js';
import { createDockerTransport } from './transport.js';

/**
 * `gatekeepers/docker` — the preset `cli`-kind Gatekeeper instance for the host's own Docker
 * Engine (design doc §7.5, §7.10, §10.2; docs/development-tasks.md S2.5). Not built on
 * `@nexttime/gatekeeper-base`'s `main()`/`startGatekeeperServer()` env-driven bootstrap — its
 * `GATE_TRANSPORT_KIND=cli` path always shells out via the base package's own `CliTransport`
 * (`kinds/cli.ts`, `execFile`), which this task brief forbids ("no docker CLI in the image").
 * This file instead composes `GatekeeperBase` + `createGatekeeperServer` directly with
 * `transport.ts`'s dockerode-backed `Transport` — the "construct directly instead of using
 * `main()`" escape hatch `@nexttime/gatekeeper-base`'s own README documents for a gate needing
 * "anything more specific". `manifest.json` (this package's own preset, not `GATE_MANIFEST_FILE`)
 * is the 接入包 content; `GATE_MANIFEST_FILE` can still override it (e.g. for a host-side manifest
 * edit without rebuilding the image), matching the base package's own env-var name.
 *
 * This gate needs no external credential — the trust boundary is network reachability to the
 * Docker Engine API itself, not a bearer token: as of fix/gate-docker-socket-proxy that's the
 * `dockerapi-gate`-network-only, allowlisted `docker-socket-proxy-gate` service (`docker-
 * compose.yml`'s `gatekeeper-docker` service no longer bind-mounts `/var/run/docker.sock`
 * directly — see `docker-client.ts`'s own module doc comment) — `NoCredentialResolver` below
 * always resolves to `{}`.
 */

class NoCredentialResolver implements CredentialResolver {
  async resolve(_onBehalfOf: string | undefined): Promise<ResolvedCredential> {
    return {};
  }
}

const DEFAULT_MANIFEST_URL = new URL('../manifest.json', import.meta.url);
const DEFAULT_DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_PORT = 8083;

async function loadManifest(path: string | undefined): Promise<Operation[]> {
  const source = path ?? fileURLToPath(DEFAULT_MANIFEST_URL);
  const raw = await readFile(source, 'utf8');
  return parseManifestJson(raw, source);
}

export interface BuiltDockerGate {
  readonly gate: GatekeeperBase;
  readonly app: ReturnType<typeof createGatekeeperServer>;
}

export async function buildDockerGate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuiltDockerGate> {
  // Loaded first — this gate refuses to start without a valid auth token (review lane 5, P1-1;
  // @nexttime/gatekeeper-base's gate-auth.ts).
  const token = loadGateKernelToken(env);
  const manifest = await loadManifest(env.GATE_MANIFEST_FILE);
  const dataDir = resolveGateDataDir(env);
  const socketPath = env.DOCKER_SOCKET_PATH ?? DEFAULT_DOCKER_SOCKET_PATH;
  // fix/gate-docker-socket-proxy: DOCKER_HOST (docker-compose.yml: tcp://docker-socket-proxy-
  // gate:2375 on the `dockerapi-gate` network) takes priority over the plain socket path — see
  // docker-client.ts's own module doc comment for the cutover this replaces.
  const connection = parseDockerConnection(env.DOCKER_HOST, socketPath);

  const transport = createDockerTransport(createDockerClient({ connection }));
  const idempotencyStore = new JsonFileIdempotencyStore(dataDir);
  const credentialResolver = new NoCredentialResolver();

  const gate = new GatekeeperBase({ manifest, transport, credentialResolver, idempotencyStore });
  const app = createGatekeeperServer({ gate, logger: true, token });
  return { gate, app };
}

export async function startDockerGate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ app: BuiltDockerGate['app']; close(): Promise<void> }> {
  const { app } = await buildDockerGate(env);
  const port = Number(env.GATE_PORT ?? DEFAULT_PORT);
  const host = env.GATE_BIND_ADDR ?? '0.0.0.0';
  await app.listen({ port, host });
  return { app, close: () => app.close() };
}

export function main(): void {
  startDockerGate().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'gatekeeper-docker: failed to start',
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
