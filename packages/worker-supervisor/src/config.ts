/**
 * config: env vars for the resident-mode supervisor (docs/development-tasks.md S1.5; design doc
 * §7.2, §7.3, §10.2). Mirrors the `loadConfig(env = process.env): Config` pattern used by
 * `@nexttime/llm-proxy` and `@nexttime/egress-proxy` — one pure function, defaults baked in,
 * `env` injectable for tests.
 *
 * `nextTimeData` deserves a callout: this container also has `${NEXTTIME_DATA}/workspaces` etc.
 * bind-mounted at `/data/workspaces` (see docker-compose.yml), which is what this process reads
 * and writes through directly. But when it asks the Docker Engine API (over the host's own
 * `/var/run/docker.sock`) to create an entry container, the bind-mount *source* in that request
 * is resolved by the daemon against the **host** filesystem, not this container's own mount
 * namespace — so the source string must be the host path (`${NEXTTIME_DATA}/workspaces/<id>`),
 * not this container's `/data/workspaces/<id>`. `host-paths.ts` is the one place that distinction
 * is made concrete; every other module only ever sees whichever of the two a given operation
 * actually needs.
 */

import { z } from 'zod';

export const DEFAULT_SUPERVISOR_PORT = 8081;

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildTaskImageAllowlist(raw: string | undefined, defaultImage: string): string[] {
  const extra = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([defaultImage, ...extra])];
}

export interface SupervisorConfig {
  /** `control`-network-only — never published to the host (design doc §11). */
  readonly port: number;
  /** Image name (and optional tag/digest) the resident containers are spawned from — built by
   *  `docker compose build worker-runtime` (deploy/worker-runtime/Dockerfile), never pulled. */
  readonly workerImage: string;
  /** `--runtime` for spawned containers: `runsc` (gVisor, default) or `runc` (E1 fallback). */
  readonly workerRuntime: string;
  /** Host-side `${NEXTTIME_DATA}` — see this file's own doc comment above. Required; the process
   *  refuses to start without it (a misconfigured value would silently bind-mount the wrong host
   *  directory into every future container). */
  readonly nextTimeData: string;
  /** This container's own view of the same data root (compose: `${NEXTTIME_DATA}/workspaces:
   *  /data/workspaces`, `.../config:/data/config:ro`) — used for local fs operations (mkdir,
   *  chown-equivalent, existence checks, the egress source-map read-modify-write). */
  readonly localDataDir: string;
  /** Docker network the spawned containers get attached to (design doc §7.9/§10.2 `workers`,
   *  `internal: true`). When unset, resolved at startup from the `com.docker.compose.network`
   *  label Compose stamps on the network it creates — see `docker-client.ts`
   *  `resolveWorkersNetwork`. */
  readonly networkWorkers: string | undefined;
  readonly kernelUrl: string;
  readonly kernelLlmUrl: string;
  /** `HTTP_PROXY`/`HTTPS_PROXY` value injected into every spawned container (design doc §7.9;
   *  egress-proxy's own README: `http://egress-proxy:3128`). */
  readonly httpProxyForWorkers: string;
  /** `NO_PROXY` value injected into every spawned container — the two `control`+`workers`
   *  dual-homed services agent containers may reach directly, plus loopback. */
  readonly noProxyForWorkers: string;
  readonly workerMemoryMb: number;
  readonly workerPidsLimit: number;
  readonly workerTmpfsMb: number;
  readonly entryIdleTimeoutMs: number;
  /** Path (in this container's own filesystem — `localDataDir`-relative) to the `SOURCE_MAP_FILE`
   *  `@nexttime/egress-proxy` hot-reloads (its `source-map.ts`) — this is the "documented
   *  mechanism" docs/development-tasks.md points at in lieu of an admin HTTP endpoint egress-proxy
   *  doesn't expose (verified: `packages/egress-proxy/src/admin.ts` only serves `GET /healthz`). */
  readonly egressSourceMapFile: string;
  readonly dockerSocketPath: string;
  /** One-shot Task mode (S2.8; design doc §7.3, docs/development-tasks.md S2.8). Default runtime
   *  cap for a Worker container before the reaper kills it (`TASK_MAX_RUNTIME_SEC`) — a per-spawn
   *  `timeoutSec` in the request body overrides this. */
  readonly taskMaxRuntimeSec: number;
  /** How long a finished Task's workspace directory is kept as an artifact before the retention
   *  sweep deletes it (`TASK_WORKDIR_RETENTION_HOURS`). */
  readonly taskWorkdirRetentionHours: number;
  /** Images `POST /task/spawn` may spawn: always includes `workerImage`, plus any comma-separated
   *  extras from `WORKER_IMAGE_ALLOWLIST`. Additive (not a replacement) so setting the override
   *  can never accidentally lock out the default image resident mode already trusts. */
  readonly taskImageAllowlist: readonly string[];
}

export const SUPERVISOR_ENV_PREFIX = 'nexttime';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const nextTimeData = env.NEXTTIME_DATA;
  if (!nextTimeData) {
    throw new Error(
      '@nexttime/worker-supervisor: NEXTTIME_DATA is not set (host path needed to compute bind-' +
        'mount sources for spawned containers — see config.ts)',
    );
  }

  const localDataDir = env.LOCAL_DATA_DIR ?? '/data';
  const workerImage = env.WORKER_IMAGE ?? 'nexttime-ai-worker-runtime';

  return {
    port: parseIntEnv(env.SUPERVISOR_PORT, DEFAULT_SUPERVISOR_PORT),
    workerImage,
    workerRuntime: env.WORKER_RUNTIME ?? 'runc',
    nextTimeData,
    localDataDir,
    networkWorkers: env.NETWORK_WORKERS || undefined,
    kernelUrl: env.KERNEL_URL ?? 'http://kernel:8080',
    kernelLlmUrl: env.KERNEL_LLM_URL ?? 'http://llm-proxy:8082',
    httpProxyForWorkers: env.HTTP_PROXY_FOR_WORKERS ?? 'http://egress-proxy:3128',
    noProxyForWorkers: env.NO_PROXY_FOR_WORKERS ?? 'kernel,llm-proxy,localhost,127.0.0.1',
    workerMemoryMb: parseIntEnv(env.WORKER_MEMORY_MB, 2048),
    workerPidsLimit: parseIntEnv(env.WORKER_PIDS_LIMIT, 512),
    workerTmpfsMb: parseIntEnv(env.WORKER_TMPFS_MB, 512),
    entryIdleTimeoutMs: parseIntEnv(env.ENTRY_IDLE_TIMEOUT_MS, 30 * 60 * 1000),
    egressSourceMapFile: env.EGRESS_SOURCE_MAP_FILE ?? `${localDataDir}/config/egress-sources.json`,
    dockerSocketPath: env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock',
    taskMaxRuntimeSec: parseIntEnv(env.TASK_MAX_RUNTIME_SEC, 3600),
    taskWorkdirRetentionHours: parseIntEnv(env.TASK_WORKDIR_RETENTION_HOURS, 72),
    taskImageAllowlist: buildTaskImageAllowlist(env.WORKER_IMAGE_ALLOWLIST, workerImage),
  };
}

/** `POST /task/spawn` 403s an `image` outside this list (docs/development-tasks.md S2.8
 *  acceptance: "非允许镜像 403"). */
export function isImageAllowed(config: SupervisorConfig, image: string): boolean {
  return config.taskImageAllowlist.includes(image);
}

/** `POST /resident/spawn` request body. */
export const SpawnRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    principalId: z.string().min(1),
    handle: z.string().min(1),
    kernelUrl: z.string().min(1).optional(),
    llmUrl: z.string().min(1).optional(),
  })
  .strict();
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/** `POST /resident/stop` request body. */
export const StopRequestSchema = z
  .object({
    principalId: z.string().min(1),
  })
  .strict();
export type StopRequest = z.infer<typeof StopRequestSchema>;

/** A single skill mounted read-only into a Worker container (docs/development-tasks.md S2.8:
 *  "只读挂载 ... 该定义 `uses` 的 Skill"). `name` becomes a path segment
 *  (`task-spawn-spec.ts`/`host-paths.ts` `taskSkillTargetInContainer`) — restricted to a safe
 *  single segment so it can never escape the skills directory it's mounted under. */
const TaskSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'must be a single safe path segment')
    .refine((name) => name !== '.' && name !== '..', 'must not be "." or ".."'),
  hostPath: z.string().min(1),
});

/** `POST /task/spawn` request body (S2.8 task brief). `onBehalfOf` carries the `principalId` the
 *  child Handle's `on_behalf_of` is scoped to (I13) — named per the task brief, not `principalId`,
 *  to keep the wire shape distinct from resident mode's own field of that name (this is a
 *  different Handle: a Task's, decayed and derived from the entry Handle that requested it, per
 *  S2.7 `invoke_worker` — see that task's own dispatch, not built by this package). */
export const TaskSpawnRequestSchema = z
  .object({
    taskId: z.string().min(1),
    workerRunId: z.string().min(1),
    workspaceId: z.string().min(1),
    onBehalfOf: z.string().min(1),
    capabilityHandle: z.string().min(1),
    image: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    skills: z.array(TaskSkillSchema).optional(),
    timeoutSec: z.number().int().positive().optional(),
  })
  .strict();
export type TaskSpawnRequest = z.infer<typeof TaskSpawnRequestSchema>;
