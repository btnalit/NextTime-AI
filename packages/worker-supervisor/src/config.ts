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

import { posix as posixPath } from 'node:path';
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

/** A single skill mounted by *content*, not a host path (S2.14; docs/development-tasks.md S2.14
 *  deliverable 4: "extend the supervisor Task spawn API additively with `skillsInline?: [{name,
 *  files: {"SKILL.md": string, ...}}]`"). The kernel has no writable data mount of its own
 *  (I9-adjacent — see `docs/development-tasks.md` S2.8's own read-first note "the kernel has NO
 *  writable data mount, only `config:ro`"), so a published Skill's rendered file content travels
 *  in the spawn request body itself; this service writes it to disk (`task-service.ts`'s `spawn()`)
 *  under the Task's own workspace directory before the container starts — no bind mount needed,
 *  the whole Task workspace is already bind-mounted at `/workspace`.
 *
 * `name` reuses the exact same safe-single-path-segment rule as `TaskSkillSchema.name` above (not
 * refactored into a shared schema — the two are validated independently by design, so a future
 * change to one's rule does not silently change the other's). Each entry in `files` becomes
 * `<agentDir>/skills/<name>/<fileName>` (`host-paths.ts` `taskSkillTargetInContainer` — same target
 * directory the host-path variant mounts to, just populated by writing instead of bind-mounting);
 * `fileName` must be a safe relative path (`isSafeSkillInlineFileName` below) — no leading `/`, no
 * `.`/`..` path segments, so it can never escape the skill's own directory. Every entry must
 * include a `"SKILL.md"` file (pi's own required entry point, `docs/skills.md` "Skill Structure")
 * — `application/worker/skills.ts`'s `renderSkillMarkdownFile` (kernel) is the one place that
 * produces this shape today. Per-file and total-payload size caps
 * (`MAX_SKILL_INLINE_FILE_BYTES`/`MAX_SKILL_INLINE_TOTAL_BYTES`) bound how much a single spawn
 * request can make this process write to disk. */
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
    skills: z.array(TaskSkillSchema).optional(),
    skillsInline: z.array(TaskSkillInlineSchema).optional(),
    timeoutSec: z.number().int().positive().optional(),
  })
  .strict();
export type TaskSpawnRequest = z.infer<typeof TaskSpawnRequestSchema>;
export type TaskSkillInline = z.infer<typeof TaskSkillInlineSchema>;

/** `skills[].hostPath` must resolve under this supervisor's own host data root
 *  (`${config.nextTimeData}/`) — otherwise a caller could mount an arbitrary host path (e.g.
 *  `/var/run/docker.sock`, `/etc`) read-only into a Worker container. `TaskSkillSchema` cannot
 *  enforce this itself (it has no access to `config`, and this package's Zod schemas are static,
 *  built once at module scope, matching every other schema in this file) — same pattern as
 *  `isImageAllowed` below: a small pure function, called by `server.ts` after the structural Zod
 *  parse succeeds, 400s the request if any skill fails it.
 *
 * `hostPath` must be absolute, and — after `path.posix.normalize` — contain no residual `..`
 * segment and lie at or under the normalized root. Both checks are applied even though, for an
 * absolute path, `posix.normalize` already resolves every resolvable `..` (an absolute path has no
 * parent above `/`, so `posix.normalize('/a/../../etc')` is `/etc`, never a string containing
 * `..`) — the explicit `..`-segment check is cheap, explicit defense-in-depth, not load-bearing on
 * its own; the root-prefix check is what actually rejects an escaped path like that example. */
export function isSkillHostPathAllowed(config: SupervisorConfig, hostPath: string): boolean {
  if (!hostPath.startsWith('/')) return false;
  const normalized = posixPath.normalize(hostPath);
  if (normalized.split('/').includes('..')) return false;
  const root = posixPath.normalize(`${config.nextTimeData}/`);
  return normalized === root.slice(0, -1) || normalized.startsWith(root);
}
