import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createContainerIoClient } from './container-io.js';
import { createHost } from './host.js';
import type { Host } from './host.js';
import { createKernelLink } from './kernel-link.js';
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
 * — `DOCKER_SOCKET_PATH` optional, defaulting to the standard socket path):
 *   - `KERNEL_URL`: the kernel's base HTTP(S) URL, e.g. `http://kernel:8080` — this process
 *     derives its own WebSocket URL from it (`/internal/agent-host`) and forwards it verbatim as
 *     every `spawn` call's `kernelUrl`.
 *   - `SUPERVISOR_URL`: worker-supervisor's base URL, e.g. `http://worker-supervisor:8081`.
 *   - `KERNEL_LLM_URL`: read but only used as a defensive fallback — see `host.ts`'s own doc
 *     comment on `HostOptions.defaultKernelLlmUrl` for why the per-Turn value from the kernel is
 *     what actually governs.
 *   - `DOCKER_SOCKET_PATH`: defaults to `/var/run/docker.sock` (docker-compose.yml mounts it
 *     read-only into this service — see that file's own comment on why this package, not
 *     worker-supervisor, does the attaching).
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

/** `http://kernel:8080` -> `ws://kernel:8080/internal/agent-host` (`https://` -> `wss://`). */
export function kernelWsUrlFrom(kernelUrl: string): string {
  return `${kernelUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}/internal/agent-host`;
}

function startHealthzServer(): http.Server {
  const server = http.createServer((req, res) => {
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

  const instanceId = randomUUID();
  const log = (line: string): void => console.error(line);

  const supervisorClient = new SupervisorClient({ supervisorUrl });
  const containerIoClient = createContainerIoClient({ dockerSocketPath });

  // Chicken-and-egg: kernelLink needs callbacks that call into `host`, but `host` needs
  // `kernelLink` to send frames back. Neither callback below runs synchronously during this
  // function's own execution (only once a real `startTurn`/`stopTurn` frame arrives, well after
  // `hostRef.current` is assigned), so this is safe — same pattern as any event-emitter-before-
  // its-own-handler-object-exists wiring.
  const hostRef: { current?: Host } = {};
  const kernelLink = createKernelLink({
    kernelWsUrl: kernelWsUrlFrom(kernelUrl),
    instanceId,
    onStartTurn: (cmd) => {
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
    kernelLink,
    kernelUrl,
    defaultKernelLlmUrl: kernelLlmUrl,
    log,
  });

  const healthzServer = startHealthzServer();
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
