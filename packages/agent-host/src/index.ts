import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  INTERNAL_TOKEN_FILE_ENV,
  InternalTokenError,
  SUPERVISOR_TOKEN_FILE_ENV,
  internalAuthorizationHeader,
  normalizeInternalToken,
  resolveInternalTokenFile,
  resolveSupervisorTokenFile,
} from '@nexttime/shared';
import { createContainerIoClient, parseDockerConnection } from './container-io.js';
import { createHost } from './host.js';
import type { Host } from './host.js';
import { createKernelLink } from './kernel-link.js';
import { createAgentHostMetrics, handleMetricsRequest } from './metrics.js';
import { SupervisorClient } from './supervisor-client.js';

/**
 * @nexttime/agent-host — event bridge for the per-user resident entry agent container (design
 * doc §7.2; docs/development-tasks.md S1.5, second half). This file only wires the pieces built
 * in the rest of this package (`kernel-link.ts` <-> `host.ts` <-> `supervisor-client.ts` +
 * `container-io.ts`, translated through `bridge.ts`) and runs the process: env, the `GET
 * /healthz` server, and graceful shutdown.
 *
 * Env — deliberately exactly these four (docs/development-tasks.md S1.5b dispatch: "No inherited
 * secrets: agent-host env is only KERNEL_URL, SUPERVISOR_URL, KERNEL_LLM_URL, DOCKER_SOCKET_PATH"
 * — `DOCKER_SOCKET_PATH` optional, defaulting to the standard socket path; `DOCKER_HOST`,
 * fix/socket-proxy-and-backup-user, is the fifth: also optional, and the one docker-compose.yml
 * actually sets now — see below):
 *   - `KERNEL_URL`: the kernel's base HTTP(S) URL, e.g. `http://kernel:8080` — this process
 *     derives its own WebSocket URL from it (`/internal/agent-host`) and forwards it verbatim as
 *     every `spawn` call's `kernelUrl`.
 *   - `SUPERVISOR_URL`: worker-supervisor's base URL, e.g. `http://worker-supervisor:8081`.
 *   - `KERNEL_LLM_URL`: read but only used as a defensive fallback — see `host.ts`'s own doc
 *     comment on `HostOptions.defaultKernelLlmUrl` for why the per-Turn value from the kernel is
 *     what actually governs.
 *   - `DOCKER_SOCKET_PATH` / `DOCKER_HOST`: container-io.ts's `parseDockerConnection` resolves
 *     the Docker Engine API target — `DOCKER_HOST=tcp://docker-socket-proxy:2375`
 *     (docker-compose.yml, fix/socket-proxy-and-backup-user: this container no longer bind-mounts
 *     `/var/run/docker.sock` at all) when set, else `DOCKER_SOCKET_PATH` (default
 *     `/var/run/docker.sock`, kept for tests / any non-compose run).
 *
 * The env list above is still exactly these four — the internal-plane credentials
 * (fix/internal-plane-auth, 2026-09; per-service since R-03) are *files*, not env vars:
 * `loadInternalToken` below reads agent-host's own credential for the kernel from
 * `NEXTTIME_INTERNAL_TOKEN_FILE` (default `/run/secrets/internal_token`, the compose secret
 * `internal_agent_host_to_kernel`), and `loadSupervisorToken` its own credential for
 * worker-supervisor from `NEXTTIME_SUPERVISOR_TOKEN_FILE` (default
 * `/run/secrets/internal_token_worker_supervisor`, `internal_agent_host_to_worker_supervisor`) —
 * the contract `@nexttime/shared`'s `internal-token.ts` defines. Two credentials, not one: the
 * supervisor holds the second to verify it, so it must not be the one that opens the kernel's
 * `/internal/agent-host` link. `main()` loads both eagerly, in the same fail-fast slot as the four
 * `readRequiredEnv` calls below: this process cannot register as agent-host or start a container
 * without them, so an unreadable/unusable file is a startup failure, not a degraded mode.
 */
export const VERSION = '0.1.0';

/** No env var for this — see this module's own doc comment: agent-host's env list is fixed. */
const HEALTHZ_PORT = 8090;

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`@nexttime/agent-host: required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Reads the internal-plane token file (`NEXTTIME_INTERNAL_TOKEN_FILE`, default
 * `/run/secrets/internal_token` — same contract as `packages/kernel/src/interfaces/internal-auth`'s
 * `loadInternalToken`, deliberately duplicated rather than shared: `@nexttime/shared`'s
 * `internal-token.ts` is IO-free by design, see that module's own doc comment). Synchronous so
 * `main()` can fail fast, before opening the kernel WebSocket or starting the healthz server —
 * this process has nothing useful to do without a working link to the kernel.
 */
export function loadInternalToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const file = resolveInternalTokenFile(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
    throw new InternalTokenError(
      `cannot read the internal-plane token file "${file}" (${INTERNAL_TOKEN_FILE_ENV}; ${code}) — agent-host refuses to start without it: derive it with scripts/gen-handle-keys.sh and mount it as the compose secret internal_agent_host_to_kernel`,
    );
  }
  return normalizeInternalToken(raw, file);
}

/** Reads agent-host's own credential for worker-supervisor (`NEXTTIME_SUPERVISOR_TOKEN_FILE`,
 *  default `/run/secrets/internal_token_worker_supervisor`). Same fail-fast contract as
 *  `loadInternalToken` above. */
export function loadSupervisorToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const file = resolveSupervisorTokenFile(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'error';
    throw new InternalTokenError(
      `cannot read the worker-supervisor credential file "${file}" (${SUPERVISOR_TOKEN_FILE_ENV}; ${code}) — agent-host refuses to start without it: derive it with scripts/gen-handle-keys.sh and mount it as the compose secret internal_agent_host_to_worker_supervisor`,
    );
  }
  return normalizeInternalToken(raw, file);
}

/** `http://kernel:8080` -> `ws://kernel:8080/internal/agent-host` (`https://` -> `wss://`). */
export function kernelWsUrlFrom(kernelUrl: string): string {
  return `${kernelUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}/internal/agent-host`;
}

/** `GET /healthz` (open) and, leftover 87, `GET /internal/metrics` (internal-plane token — the
 *  same `Authorization` value agent-host sends the kernel; metrics.ts) on the one fixed port. The
 *  port is on `control`/`dockerapi` only and is not published through caddy. */
function startHealthzServer(metrics: {
  readonly authorizationHeader: string;
  readonly render: () => string;
}): http.Server {
  const server = http.createServer((req, res) => {
    if (handleMetricsRequest(req, res, metrics)) return;
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(HEALTHZ_PORT, '0.0.0.0');
  return server;
}

export function main(): void {
  const kernelUrl = readRequiredEnv('KERNEL_URL');
  const supervisorUrl = readRequiredEnv('SUPERVISOR_URL');
  const kernelLlmUrl = readRequiredEnv('KERNEL_LLM_URL');
  const dockerSocketPath = process.env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';
  const dockerConnection = parseDockerConnection(process.env.DOCKER_HOST, dockerSocketPath);
  // Same fail-fast slot as the three readRequiredEnv calls above — see this module's own doc
  // comment for why there are two credentials.
  const authorizationHeader = internalAuthorizationHeader(loadInternalToken());
  const supervisorAuthorizationHeader = internalAuthorizationHeader(loadSupervisorToken());

  const instanceId = randomUUID();
  const log = (line: string): void => console.error(line);
  const metrics = createAgentHostMetrics({ log });

  const supervisorClient = new SupervisorClient({
    supervisorUrl,
    authorizationHeader: supervisorAuthorizationHeader,
  });
  const containerIoClient = createContainerIoClient({ connection: dockerConnection });

  // Chicken-and-egg: kernelLink needs callbacks that call into `host`, but `host` needs
  // `kernelLink` to send frames back. Neither callback below runs synchronously during this
  // function's own execution (only once a real `startTurn`/`stopTurn` frame arrives, well after
  // `hostRef.current` is assigned), so this is safe — same pattern as any event-emitter-before-
  // its-own-handler-object-exists wiring.
  const hostRef: { current?: Host } = {};
  const kernelLink = createKernelLink({
    kernelWsUrl: kernelWsUrlFrom(kernelUrl),
    authorizationHeader,
    instanceId,
    onStartTurn: (cmd) => {
      metrics.turnStarted(cmd);
      void hostRef.current?.handleStartTurn(cmd);
    },
    onStopTurn: (cmd) => {
      hostRef.current?.handleStopTurn(cmd);
    },
    log,
  });
  hostRef.current = createHost({
    supervisorClient,
    containerIoClient,
    // Leftover 87: host.ts sends every Turn outcome through this decorator (counted + logged).
    kernelLink: metrics.observe(kernelLink),
    kernelUrl,
    defaultKernelLlmUrl: kernelLlmUrl,
    log,
  });

  const healthzServer = startHealthzServer({ authorizationHeader, render: metrics.render });
  kernelLink.start();

  const shutdown = (): void => {
    kernelLink.stop();
    healthzServer.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
