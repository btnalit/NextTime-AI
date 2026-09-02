import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDockerClient } from './docker-client.js';
import { createEgressMapStore } from './egress-map.js';
import { createResidentService } from './resident-service.js';
import { createServer } from './server.js';

export { loadConfig, SpawnRequestSchema, StopRequestSchema } from './config.js';
export type { SpawnRequest, StopRequest, SupervisorConfig } from './config.js';
export { createDockerClient } from './docker-client.js';
export type { ContainerSpec, ContainerState, DockerClient } from './docker-client.js';
export { createEgressMapStore, entrySourceId } from './egress-map.js';
export type { EgressMapStore, SourceMapEntry, SourceMapFile } from './egress-map.js';
export { createResidentService } from './resident-service.js';
export type { ResidentService, ResidentStatus, SpawnOutcome } from './resident-service.js';
export { buildSpawnSpec, entryContainerName } from './spawn-spec.js';
export { createServer } from './server.js';

/**
 * @nexttime/worker-supervisor — docker-socket supervisor for entry and Worker containers (design
 * doc §7.2, §7.3, §7.9, §10.1, §10.2; docs/development-tasks.md S1.5). This half (S1.5a) is the
 * resident-mode API (`/resident/*`); the one-shot Task/Worker spawn mode (S2.8) is a separate
 * later task.
 *
 * IDLE_SWEEP_INTERVAL_MS is deliberately not `ENTRY_IDLE_TIMEOUT_MS` itself — the sweep runs far
 * more often than the timeout so an idle container is stopped within roughly a minute of crossing
 * the threshold, not up to a whole timeout period late.
 */
export const VERSION = '0.1.0';

const IDLE_SWEEP_INTERVAL_MS = 60_000;

export async function main(): Promise<void> {
  const config = loadConfig();
  const docker = createDockerClient({ socketPath: config.dockerSocketPath });
  const egressMap = createEgressMapStore(config.egressSourceMapFile);
  const residentService = createResidentService({ config, docker, egressMap });

  await residentService.reconcile();

  const sweepTimer = setInterval(() => {
    residentService.sweepIdle().catch((err) => {
      console.error(
        JSON.stringify({ level: 'error', msg: 'idle sweep failed', error: String(err) }),
      );
    });
  }, IDLE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const app = createServer({ residentService, logger: true });
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async (): Promise<void> => {
    clearInterval(sweepTimer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err) => {
    console.error('@nexttime/worker-supervisor: fatal error during startup', err);
    process.exit(1);
  });
}
