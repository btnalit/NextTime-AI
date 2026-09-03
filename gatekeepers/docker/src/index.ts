import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  type CredentialResolver,
  GatekeeperBase,
  JsonFileIdempotencyStore,
  type ResolvedCredential,
  createGatekeeperServer,
  resolveGateDataDir,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { createDockerClient } from './docker-client.js';
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
 * This gate needs no external credential — the trust boundary is the `/var/run/docker.sock`
 * mount itself (`docker-compose.yml`'s `gatekeeper-docker` service), not a bearer token —
 * `NoCredentialResolver` below always resolves to `{}`.
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
  const raw = path
    ? await readFile(path, 'utf8')
    : await readFile(fileURLToPath(DEFAULT_MANIFEST_URL), 'utf8');
  return JSON.parse(raw) as Operation[];
}

export interface BuiltDockerGate {
  readonly gate: GatekeeperBase;
  readonly app: ReturnType<typeof createGatekeeperServer>;
}

export async function buildDockerGate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuiltDockerGate> {
  const manifest = await loadManifest(env.GATE_MANIFEST_FILE);
  const dataDir = resolveGateDataDir(env);
  const socketPath = env.DOCKER_SOCKET_PATH ?? DEFAULT_DOCKER_SOCKET_PATH;

  const transport = createDockerTransport(createDockerClient({ socketPath }));
  const idempotencyStore = new JsonFileIdempotencyStore(dataDir);
  const credentialResolver = new NoCredentialResolver();

  const gate = new GatekeeperBase({ manifest, transport, credentialResolver, idempotencyStore });
  const app = createGatekeeperServer({ gate, logger: true });
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
