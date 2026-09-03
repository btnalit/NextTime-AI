import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDockerClient } from './docker-client.js';
import { createEgressMapStore } from './egress-map.js';
import { createResidentService } from './resident-service.js';
import { createServer } from './server.js';
import { createTaskService } from './task-service.js';

export {
  isImageAllowed,
  isSkillHostPathAllowed,
  loadConfig,
  SpawnRequestSchema,
  StopRequestSchema,
  TaskSpawnRequestSchema,
} from './config.js';
export type {
  SpawnRequest,
  StopRequest,
  SupervisorConfig,
  TaskSpawnRequest,
} from './config.js';
export { createDockerClient } from './docker-client.js';
export type { ContainerSpec, ContainerState, DockerClient } from './docker-client.js';
export { createEgressMapStore, entrySourceId, taskSourceId } from './egress-map.js';
export type { EgressMapStore, SourceMapEntry, SourceMapFile } from './egress-map.js';
export { createResidentService } from './resident-service.js';
export type { ResidentService, ResidentStatus, SpawnOutcome } from './resident-service.js';
export { buildSpawnSpec, entryContainerName } from './spawn-spec.js';
export { buildTaskSpawnSpec, taskContainerName } from './task-spawn-spec.js';
export { createTaskService } from './task-service.js';
export type {
  TaskService,
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskState,
  TaskStatus,
} from './task-service.js';
export { createServer } from './server.js';

/**
 * @nexttime/worker-supervisor — docker-socket supervisor for entry and Worker containers (design
 * doc §7.2, §7.3, §7.9, §10.1, §10.2; docs/development-tasks.md S1.5, S2.8). Resident mode
 * (`/resident/*`, S1.5a) and one-shot Task mode (`/task/*`, S2.8) share this one process, one
 * Fastify server, and one Docker socket — see `server.ts`'s own doc comment for the route list.
 *
 * IDLE_SWEEP_INTERVAL_MS is deliberately not `ENTRY_IDLE_TIMEOUT_MS` itself — the sweep runs far
 * more often than the timeout so an idle container is stopped within roughly a minute of crossing
 * the threshold, not up to a whole timeout period late. TASK_REAP_INTERVAL_MS follows the same
 * reasoning for Task mode's timeout kill + spontaneous-exit reap. TASK_RETENTION_SWEEP_INTERVAL_MS
 * is deliberately much coarser — deleting finished Task workdirs is "small, boring" housekeeping
 * (S2.8 task brief), not latency-sensitive the way noticing a container exited is.
 */
export const VERSION = '0.1.0';

const IDLE_SWEEP_INTERVAL_MS = 60_000;
const TASK_REAP_INTERVAL_MS = 30_000;
const TASK_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;

export async function main(): Promise<void> {
  const config = loadConfig();
  const docker = createDockerClient({ socketPath: config.dockerSocketPath });
  const egressMap = createEgressMapStore(config.egressSourceMapFile);
  const residentService = createResidentService({ config, docker, egressMap });
  const taskService = createTaskService({ config, docker, egressMap });

  await residentService.reconcile();
  await taskService.reconcile();

  const sweepTimer = setInterval(() => {
    residentService.sweepIdle().catch((err) => {
      console.error(
        JSON.stringify({ level: 'error', msg: 'idle sweep failed', error: String(err) }),
      );
    });
  }, IDLE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const taskReapTimer = setInterval(() => {
    taskService.reap().catch((err) => {
      console.error(
        JSON.stringify({ level: 'error', msg: 'task reap failed', error: String(err) }),
      );
    });
  }, TASK_REAP_INTERVAL_MS);
  taskReapTimer.unref();

  const taskRetentionTimer = setInterval(() => {
    taskService.sweepRetention().catch((err) => {
      console.error(
        JSON.stringify({ level: 'error', msg: 'task retention sweep failed', error: String(err) }),
      );
    });
  }, TASK_RETENTION_SWEEP_INTERVAL_MS);
  taskRetentionTimer.unref();

  const app = createServer({ residentService, taskService, config, logger: true });
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async (): Promise<void> => {
    clearInterval(sweepTimer);
    clearInterval(taskReapTimer);
    clearInterval(taskRetentionTimer);
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
