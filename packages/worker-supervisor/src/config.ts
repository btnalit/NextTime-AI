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

/** Same contract as `parseIntEnv` but for a fractional value (`WORKER_CPUS`, e.g. `1.5`). */
function parseFloatEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `WORKER_DNS_SINKHOLE`: comma-separated DNS server IPs, or `undefined` when unset — Docker's
 *  own embedded DNS applies unchanged in that case (see `SupervisorConfig.workerDnsSinkhole`'s
 *  own doc comment). Blank/whitespace-only entries are dropped; an all-blank value (`","`, `" "`)
 *  is treated the same as unset rather than passing an empty `HostConfig.Dns` array through. */
function parseDnsSinkholeEnv(value: string | undefined): string[] | undefined {
  const entries = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function buildTaskImageAllowlist(raw: string | undefined, defaultImage: string): string[] {
  const extra = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([defaultImage, ...extra])];
}

/** How `docker-client.ts` reaches the Docker Engine API — a plain Unix socket (`socketPath`, the
 *  pre-fix/socket-proxy-and-backup-user default and what tests still use) or `docker-socket-
 *  proxy`'s HTTP listener over the `dockerapi` network (`tcp`, `DOCKER_HOST=tcp://docker-socket-
 *  proxy:2375` — docker-compose.yml). `DockerClient`'s callers never see this — it's consumed
 *  once, in `index.ts`'s `createDockerClient({ connection })` call. */
export type DockerConnection =
  | { readonly kind: 'socket'; readonly socketPath: string }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number };

/** Parses `DOCKER_HOST` into a `DockerConnection` (fix/socket-proxy-and-backup-user). Only the
 *  `tcp://host:port` shape this platform's own compose file ever sets is recognized — an unset,
 *  empty, unparsable, or non-`tcp://` value (e.g. a bare `unix:///var/run/docker.sock`, which
 *  nothing in this repo produces) falls back to `fallbackSocketPath` (`DOCKER_SOCKET_PATH`,
 *  default `/var/run/docker.sock`) rather than being guessed at — `dockerode`'s own `socketPath`
 *  option already covers the plain-Unix-socket case every existing test relies on, so silently
 *  misparsing an unexpected `DOCKER_HOST` shape into a broken TCP target would be worse than just
 *  not touching it. A missing port defaults to `2375` (the proxy's own `EXPOSE`, and Docker's own
 *  conventional plaintext-daemon port) so `DOCKER_HOST=tcp://docker-socket-proxy` alone would
 *  still resolve, even though the compose file always states the port explicitly. */
export function parseDockerConnection(
  dockerHost: string | undefined,
  fallbackSocketPath: string,
): DockerConnection {
  const fallback: DockerConnection = { kind: 'socket', socketPath: fallbackSocketPath };
  if (!dockerHost || !dockerHost.startsWith('tcp://')) return fallback;
  let url: URL;
  try {
    url = new URL(dockerHost);
  } catch {
    return fallback;
  }
  if (!url.hostname) return fallback;
  const port = url.port ? Number.parseInt(url.port, 10) : 2375;
  if (!Number.isFinite(port) || port <= 0) return fallback;
  return { kind: 'tcp', host: url.hostname, port };
}

export interface SupervisorConfig {
  /** `control`-network-only — never published to the host (design doc §11). */
  readonly port: number;
  /** Image name (and optional tag/digest) the resident containers are spawned from — built by
   *  `docker compose build worker-runtime` (deploy/worker-runtime/Dockerfile), never pulled. */
  readonly workerImage: string;
  /** `--runtime` for spawned containers: `runsc` (gVisor) or `runc`. **This process's own code
   *  default (`loadConfig` below, when `WORKER_RUNTIME` is unset) is `runc`**, not `runsc` — the
   *  conservative choice that works on any host, gVisor or not (lane-6 review P3: an earlier
   *  version of this comment claimed `runsc` was "the default", which was never true of the code,
   *  only of `.env.example`'s own explicit `WORKER_RUNTIME=runsc` line — see that file's own
   *  comment for why it deliberately overrides this fallback once gVisor has been verified
   *  working on the target host, docs/development-tasks.md E1). */
  readonly workerRuntime: string;
  /** Host-side `${NEXTTIME_DATA}` — see this file's own doc comment above. Required; the process
   *  refuses to start without it (a misconfigured value would silently bind-mount the wrong host
   *  directory into every future container). */
  readonly nextTimeData: string;
  /** This container's own view of the same data root (compose: `${NEXTTIME_DATA}/workspaces:
   *  /data/workspaces`, `.../config:/data/config:ro`) — used for local fs operations (mkdir,
   *  chown-equivalent, existence checks, the egress source-map read-modify-write). */
  readonly localDataDir: string;
  /** Host path of the `models.json` bind-mounted read-only into every spawned container
   *  (`host-paths.ts` `hostModelsJsonPath`). Defaults to `${NEXTTIME_DATA}/config/models.json`,
   *  the file `make gen-models` writes for the real provider. `MODELS_JSON_HOST_PATH` overrides
   *  it so an acceptance run can point spawned containers at a separately generated fake-provider
   *  file (deploy/accept/docker-compose.fake.yml, W6) without touching the production one. */
  readonly modelsJsonHostPath: string;
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
  /** `--cpus` equivalent for every spawned container (`WORKER_CPUS`, fractional — e.g. `1.5`),
   *  mapped to Docker's `HostConfig.NanoCpus` in `docker-client.ts`. Lane-6 review P3: previously
   *  unset entirely, meaning a spawned container had no CPU ceiling at all and could monopolize
   *  every core on the host — `Memory`/`PidsLimit`/`Tmpfs` were already bounded, this was the one
   *  resource dimension left unbounded. */
  readonly workerCpus: number;
  /** `HostConfig.Dns` for every spawned container (`WORKER_DNS_SINKHOLE`, comma-separated IPs) —
   *  lane-6 review P3 / the isolation checklist's own "LAN: P2-8 DNS" gap: Docker's embedded DNS
   *  (127.0.0.11) recurses out through the host's own resolver for any name it doesn't own
   *  itself, which is a potential covert egress channel for a compromised container on the
   *  otherwise `internal: true` `workers` network — HTTP(S) egress goes through egress-proxy's
   *  policy, but a DNS query does not. Unset by default (Docker's own embedded DNS, unchanged
   *  behavior) — this only gives an operator the *mechanism* to point every spawned container at
   *  a monitoring/sinkhole resolver instead; verifying that in practice (e.g. with `getent`) is
   *  host-verification work this fix does not do, see the isolation checklist note this addresses. */
  readonly workerDnsSinkhole: readonly string[] | undefined;
  readonly entryIdleTimeoutMs: number;
  /** Path (in this container's own filesystem — `localDataDir`-relative) to the `SOURCE_MAP_FILE`
   *  `@nexttime/egress-proxy` hot-reloads (its `source-map.ts`) — this is the "documented
   *  mechanism" docs/development-tasks.md points at in lieu of an admin HTTP endpoint egress-proxy
   *  doesn't expose (verified: `packages/egress-proxy/src/admin.ts` only serves `GET /healthz`). */
  readonly egressSourceMapFile: string;
  /** Kept for backward compatibility / the fallback branch of `dockerConnection` below — no
   *  longer read directly by `index.ts` (fix/socket-proxy-and-backup-user). */
  readonly dockerSocketPath: string;
  /** `docker-client.ts`'s actual connection target — `DOCKER_HOST`-derived when set (docker-
   *  socket-proxy over the `dockerapi` network), else `dockerSocketPath` (see
   *  `parseDockerConnection`'s own doc comment). */
  readonly dockerConnection: DockerConnection;
  /** One-shot Task mode (S2.8; design doc §7.3, docs/development-tasks.md S2.8). Default runtime
   *  cap for a Worker container before the reaper kills it (`TASK_MAX_RUNTIME_SEC`) — a per-spawn
   *  `timeoutSec` in the request body overrides this. */
  readonly taskMaxRuntimeSec: number;
  /** How long a finished Task's workspace directory is kept as an artifact before the retention
   *  sweep deletes it (`TASK_WORKDIR_RETENTION_HOURS`). */
  readonly taskWorkdirRetentionHours: number;
  /** How often `index.ts`'s reap timer runs (`TASK_REAP_INTERVAL_MS`) — kills timed-out Task
   *  containers and, via `task-service.ts`'s `reconcileOne`, notices and unregisters egress for
   *  any Task container that exited on its own since the last tick. Lane-6 review P2-7: a longer
   *  interval widens the window during which a Docker-assigned IP the reaper hasn't yet noticed
   *  was released could be reused for an unrelated container, misattributing its egress to the
   *  just-exited Task's `sourceId` — shortened from a fixed 30s to a configurable default of 10s
   *  as a bounded mitigation (the review's own "or at reap with a shorter interval" alternative to
   *  event-driven unregistration via Docker's own event stream, which this fix does not add). */
  readonly taskReapIntervalMs: number;
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
  const dockerSocketPath = env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';

  return {
    port: parseIntEnv(env.SUPERVISOR_PORT, DEFAULT_SUPERVISOR_PORT),
    workerImage,
    workerRuntime: env.WORKER_RUNTIME ?? 'runc',
    nextTimeData,
    localDataDir,
    modelsJsonHostPath: env.MODELS_JSON_HOST_PATH || `${nextTimeData}/config/models.json`,
    networkWorkers: env.NETWORK_WORKERS || undefined,
    kernelUrl: env.KERNEL_URL ?? 'http://kernel:8080',
    kernelLlmUrl: env.KERNEL_LLM_URL ?? 'http://llm-proxy:8082',
    httpProxyForWorkers: env.HTTP_PROXY_FOR_WORKERS ?? 'http://egress-proxy:3128',
    noProxyForWorkers: env.NO_PROXY_FOR_WORKERS ?? 'kernel,llm-proxy,localhost,127.0.0.1',
    workerMemoryMb: parseIntEnv(env.WORKER_MEMORY_MB, 2048),
    workerPidsLimit: parseIntEnv(env.WORKER_PIDS_LIMIT, 512),
    workerTmpfsMb: parseIntEnv(env.WORKER_TMPFS_MB, 512),
    workerCpus: parseFloatEnv(env.WORKER_CPUS, 2),
    workerDnsSinkhole: parseDnsSinkholeEnv(env.WORKER_DNS_SINKHOLE),
    entryIdleTimeoutMs: parseIntEnv(env.ENTRY_IDLE_TIMEOUT_MS, 30 * 60 * 1000),
    egressSourceMapFile: env.EGRESS_SOURCE_MAP_FILE ?? `${localDataDir}/config/egress-sources.json`,
    dockerSocketPath,
    dockerConnection: parseDockerConnection(env.DOCKER_HOST, dockerSocketPath),
    taskMaxRuntimeSec: parseIntEnv(env.TASK_MAX_RUNTIME_SEC, 3600),
    taskWorkdirRetentionHours: parseIntEnv(env.TASK_WORKDIR_RETENTION_HOURS, 72),
    taskReapIntervalMs: parseIntEnv(env.TASK_REAP_INTERVAL_MS, 10_000),
    taskImageAllowlist: buildTaskImageAllowlist(env.WORKER_IMAGE_ALLOWLIST, workerImage),
  };
}

/** `POST /task/spawn` 403s an `image` outside this list (docs/development-tasks.md S2.8
 *  acceptance: "非允许镜像 403"). */
export function isImageAllowed(config: SupervisorConfig, image: string): boolean {
  return config.taskImageAllowlist.includes(image);
}

/** Every identifier in this codebase (`workspaceId`/`principalId`/`taskId`/`workerRunId`/...) is a
 *  Postgres `gen_random_uuid()` / Node `randomUUID()` value — see
 *  `packages/shared/src/handle-token.ts` `uuidClaim`, `packages/kernel/src/governance/llm-usage/
 *  service.ts`'s own `z.string().uuid()` fields, and `application/host-bridge/
 *  egress-observations.ts`'s `ENTRY_SOURCE_ID_PATTERN` doc comment ("both halves are UUIDs...a
 *  plain UUID-shaped check is enough to reject garbage"). Reused here, not invented for this
 *  package. Applied to both request families below because several of these ids become host
 *  path segments or container names (resident: `workspaces/<principalId>` bind-mount source and
 *  `nexttime-entry-<principalId>`; task: `workspaces/tasks/<taskId>` and
 *  `nexttime-task-<workerRunId>`) — an unvalidated `../../pgdata` would mount an arbitrary host
 *  directory into an agent container. Exported so `server.ts` can apply the same rule to
 *  `:principalId` route params. */
export const IdClaimSchema = z.string().uuid();

/** A single skill mounted by *content*, not a host path (S2.14; docs/development-tasks.md S2.14
 *  deliverable 4: "extend the supervisor Task spawn API additively with `skillsInline?: [{name,
 *  files: {"SKILL.md": string, ...}}]`"). The kernel has no writable data mount of its own
 *  (I9-adjacent — see `docs/development-tasks.md` S2.8's own read-first note "the kernel has NO
 *  writable data mount, only `config:ro`"), so a published Skill's rendered file content travels
 *  in the spawn request body itself; this service writes it to disk (`task-service.ts`'s `spawn()`)
 *  under the Task's own workspace directory before the container starts — no bind mount needed,
 *  the whole Task workspace is already bind-mounted at `/workspace`.
 *
 * This is now the *only* way a spawn request can put a Skill into a Worker container — the
 * earlier host-path variant (`skills[].hostPath`, a caller-supplied absolute path this process
 * bind-mounted read-only) was removed (lane-6 review P1-3): it had been dead since this
 * `skillsInline` variant shipped (the kernel only ever sends `skillsInline`, never `skills`), and
 * its allowlist — any path under `${NEXTTIME_DATA}/`, not just a `skills/` subtree — let any
 * caller of this unauthenticated-until-now API mount `secrets/handle.key` (the Handle signing
 * key, 0640 group-readable by the Worker uid) or any other user's workspace read-only into a
 * Worker container. Closed by deleting the feature rather than narrowing the allowlist: nothing
 * in this codebase ever sent `skills[]`, so there was no behavior to preserve. See `server.ts`'s
 * internal-plane-auth guard (`internal-auth.ts`) for the other half of P1-3 — `POST /task/spawn`
 * itself is no longer reachable without the shared secret either.
 *
 * `name` must be a safe single path segment — `isSafeSkillInlineFileName` below applies the
 * matching rule to `fileName`. Each entry in `files` becomes `<agentDir>/skills/<name>/<fileName>`
 * (`host-paths.ts`'s `TaskPaths.skillsDirInContainer`); `fileName` must be a safe relative path —
 * no leading `/`, no `.`/`..` path segments, so it can never escape the skill's own directory.
 * Every entry must include a `"SKILL.md"` file (pi's own required entry point, `docs/skills.md`
 * "Skill Structure") — `application/worker/skills.ts`'s `renderSkillMarkdownFile` (kernel) is the
 * one place that produces this shape today. Per-file and total-payload size caps
 * (`MAX_SKILL_INLINE_FILE_BYTES`/`MAX_SKILL_INLINE_TOTAL_BYTES`) bound how much a single spawn
 * request can make this process write to disk.
 *
 * S3.13: this same schema (and shape, `TaskSkillInline`) is reused verbatim by resident mode's own
 * `SpawnRequestSchema.skillsInline` below — one Skill-mount validation rule for both spawn APIs,
 * not a second copy. */
export const MAX_SKILL_INLINE_FILE_BYTES = 512 * 1024;
export const MAX_SKILL_INLINE_TOTAL_BYTES = 2 * 1024 * 1024;

function isSafeSkillInlineFileName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (name.startsWith('/') || name.includes('\\')) return false;
  return name
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

const SkillInlineFilesSchema = z
  .record(z.string(), z.string().max(MAX_SKILL_INLINE_FILE_BYTES))
  .superRefine((files, ctx) => {
    const names = Object.keys(files);
    if (names.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'files must include at least one entry',
      });
      return;
    }
    if (!names.includes('SKILL.md')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'files must include a "SKILL.md" entry',
      });
    }
    for (const name of names) {
      if (!isSafeSkillInlineFileName(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `file name must be a safe relative path (no leading "/", no "."/".." segments): ${name}`,
        });
      }
    }
    const totalBytes = Object.values(files).reduce(
      (sum, content) => sum + Buffer.byteLength(content, 'utf8'),
      0,
    );
    if (totalBytes > MAX_SKILL_INLINE_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total inline skill content exceeds ${MAX_SKILL_INLINE_TOTAL_BYTES} bytes`,
      });
    }
  });

const TaskSkillInlineSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'must be a single safe path segment')
    .refine((name) => name !== '.' && name !== '..', 'must not be "." or ".."'),
  files: SkillInlineFilesSchema,
});
export type TaskSkillInline = z.infer<typeof TaskSkillInlineSchema>;

/** `POST /resident/spawn` request body. `systemPrompt`/`model` are S2.6 additions (the workspace's
 *  published entry WorkerDefinition, resolved by the kernel and forwarded by agent-host verbatim —
 *  see `spawn-spec.ts`'s own doc comment and `resident-service.ts`'s `spawn()` for how each is
 *  used). `workspaceId`/`principalId` are UUID-validated (`IdClaimSchema`, same rule as
 *  `TaskSpawnRequestSchema` — S2.8 flagged this as the same class of path-segment gap). */
export const SpawnRequestSchema = z
  .object({
    workspaceId: IdClaimSchema,
    principalId: IdClaimSchema,
    handle: z.string().min(1),
    kernelUrl: z.string().min(1).optional(),
    llmUrl: z.string().min(1).optional(),
    systemPrompt: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    /** feat/egress-definition-lists: the published entry WorkerDefinition's own `egressDeny`
     *  (`@nexttime/shared`'s `worker-definition.ts`), forwarded by agent-host from the `startTurn`
     *  command's own field of the same name (`@nexttime/shared`'s `agent-host-protocol.ts`) —
     *  written into this principal's `SOURCE_MAP_FILE` entry on every spawn (reuse or fresh), same
     *  "refresh every call" convention as `systemPrompt` above. Omitted leaves the existing/no
     *  per-source deny list untouched. */
    egressDeny: z.array(z.string().min(1)).optional(),
    /** S3.13: the caller's own `effective.enabledSkills`, rendered by the kernel and forwarded by
     *  agent-host from the `startTurn` command's own `skillsInline` field — mirrors Task mode's
     *  `TaskSpawnRequestSchema.skillsInline` exactly (same schema, same write-to-disk mechanism,
     *  `resident-service.ts`'s `spawn()`). Omitted/empty means no Skill is mounted. */
    skillsInline: z.array(TaskSkillInlineSchema).optional(),
  })
  .strict();
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/** `POST /resident/stop` request body. */
export const StopRequestSchema = z
  .object({
    principalId: IdClaimSchema,
  })
  .strict();
export type StopRequest = z.infer<typeof StopRequestSchema>;

/** Same UUID rule as the resident schemas above (see `IdClaimSchema`'s doc comment). */
const idClaim = IdClaimSchema;

/** `POST /task/spawn` request body (S2.8 task brief). `onBehalfOf` carries the `principalId` the
 *  child Handle's `on_behalf_of` is scoped to (I13) — named per the task brief, not `principalId`,
 *  to keep the wire shape distinct from resident mode's own field of that name (this is a
 *  different Handle: a Task's, decayed and derived from the entry Handle that requested it, per
 *  S2.7 `invoke_worker` — see that task's own dispatch, not built by this package).
 *
 * `taskId`/`workerRunId`/`workspaceId`/`onBehalfOf` are validated as UUIDs (`idClaim`), not just
 * `z.string().min(1)`: `taskId` becomes a bind-mount source path segment
 * (`host-paths.ts` `taskWorkspacePaths`: `${nextTimeData}/workspaces/tasks/<taskId>`) and
 * `workerRunId` becomes the container name (`task-spawn-spec.ts` `taskContainerName`) — an
 * unvalidated value like `../../pgdata` would let a caller mount an arbitrary host directory into
 * an agent container. `workspaceId`/`onBehalfOf` are tightened to the same rule for consistency
 * with how every id of this kind is generated and validated elsewhere in the platform (see
 * `idClaim`'s doc comment) — not because either is currently used to build a path in this package.
 * Resident mode's own `SpawnRequestSchema`/`StopRequestSchema` above apply the same rule (S2.8
 * had left them at `z.string().min(1)` and flagged it as the same class of gap; closed in the
 * follow-up that introduced `IdClaimSchema`). */
export const TaskSpawnRequestSchema = z
  .object({
    taskId: idClaim,
    workerRunId: idClaim,
    workspaceId: idClaim,
    onBehalfOf: idClaim,
    capabilityHandle: z.string().min(1),
    image: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    skillsInline: z.array(TaskSkillInlineSchema).optional(),
    timeoutSec: z.number().int().positive().optional(),
    /** feat/egress-definition-lists: the invoked WorkerDefinition's own `egressDeny`
     *  (`@nexttime/shared`'s `worker-definition.ts`, `kind='worker'` content), resolved by the
     *  kernel (`application/task/spawn.ts`) and forwarded here — written into this WorkerRun's
     *  `SOURCE_MAP_FILE` entry on spawn. Omitted (no list declared) registers no per-source deny
     *  list, same as before this field existed. */
    egressDeny: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type TaskSpawnRequest = z.infer<typeof TaskSpawnRequestSchema>;
