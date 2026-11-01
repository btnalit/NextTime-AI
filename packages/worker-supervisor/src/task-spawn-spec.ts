/**
 * task-spawn-spec: pure builder for a one-shot Task/Worker container's `ContainerSpec` (S2.8;
 * docs/development-tasks.md S2.8 task brief; design doc §7.3, §7.9, §11). No I/O — same shape and
 * same reason for existing as `spawn-spec.ts`'s `buildSpawnSpec` for resident mode, kept as a
 * separate file/function rather than a branch inside `buildSpawnSpec` because the two modes differ
 * in almost everything that matters (env allowlist, mount set, container identity, CMD) and
 * resident mode's own tests/behavior must stay untouched (task brief: "keep resident mode's
 * behavior unchanged").
 *
 * Env is **exactly** `KERNEL_URL`, `KERNEL_LLM_URL`, `CAPABILITY_HANDLE` (the marker
 * `SOURCE_BOUND_CAPABILITY_HANDLE`, never the Handle — spawn-spec.ts), `TASK_ID`,
 * `WORKSPACE_ID`, `WORKER_RUN_ID`, `NEXTTIME_MODE=worker`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`
 * — plus the same lowercase `http_proxy`/`https_proxy`/`no_proxy` mirrors resident mode's own
 * `spawn-spec.ts` documents (verified there against the "httpoxy" plain-`http://`-only-honors-
 * lowercase behavior; identical proxy setup, identical reasoning, not re-verified here).
 *
 * Deliberately **not** in this list, unlike resident mode's entry spec: `HOME`, already
 * `/workspace` at the image level (`deploy/worker-runtime/Dockerfile`). Neither mode sets
 * `PI_CODING_AGENT_DIR`: entrypoint.sh owns pi's config directory (rebuilt in `/tmp` at every
 * start, STATUS leftover 422). The mounts match resident mode's: the Task workspace read-write,
 * the Task's platform directory (published system prompt and Skills, written by
 * `task-service.ts`'s `spawn()`) and `models.json` read-only — plus, for a goal step that reads
 * earlier steps' files (S11 GO14, `upstream-files.ts`), each one's handoff directory read-only at
 * `/upstream/<stepKey>`.
 *
 * Nothing from this process's own env is ever forwarded (`docker-client.ts` passes exactly the
 * array built here, never inherits `process.env`) — `task-spawn-spec.test.ts` asserts this
 * explicitly (a `SOME_API_KEY` set on the test process must never appear in the built env).
 */

import {
  CORRELATION_ID_ENV,
  SOURCE_BOUND_CAPABILITY_HANDLE,
  isValidCorrelationId,
} from '@nexttime/shared';
import type { SupervisorConfig, TaskUpstreamFiles } from './config.js';
import type { ContainerSpec } from './docker-client.js';
import {
  MODELS_JSON_MOUNT_TARGET,
  PLATFORM_MOUNT_TARGET,
  WORKSPACE_MOUNT_TARGET,
  hostModelsJsonPath,
  taskWorkspacePaths,
} from './host-paths.js';
import { EGRESS_DENY_LABEL, ENTRY_ROLE_LABEL as TASK_ROLE_LABEL } from './spawn-spec.js';
import { taskHandoffPaths, upstreamMountTarget } from './upstream-files.js';

/** Shares the `nexttime.role` label *key* with resident mode's `ENTRY_ROLE_LABEL`
 *  (`spawn-spec.ts`) — only the value differs (`worker` vs `entry`). Re-exported under this name
 *  so callers of this module never need a separate import from `spawn-spec.ts`. */
export { TASK_ROLE_LABEL };
export const TASK_ROLE_VALUE = 'worker';
export const TASK_ID_LABEL = 'nexttime.task-id';
export const WORKER_RUN_ID_LABEL = 'nexttime.worker-run-id';
export const TASK_WORKSPACE_LABEL = 'nexttime.workspace-id';
/** feat/egress-definition-lists: shares the `nexttime.egress-deny` label *key* with resident
 *  mode's `EGRESS_DENY_LABEL` (`spawn-spec.ts`) — same purpose, same encoding (comma-joined),
 *  re-exported under this name for the same reason `TASK_ROLE_LABEL` is above. Stamped so
 *  `task-service.ts`'s `reconcile()` (post supervisor-restart) can restore the invoked
 *  WorkerDefinition's own egress deny list for a still-running Task container it did not itself
 *  just spawn, instead of silently widening its egress until that Task's own natural end (never
 *  re-registered by `reap()`/`status()` otherwise). */
export { EGRESS_DENY_LABEL as TASK_EGRESS_DENY_LABEL };

/** Leftover 87: the correlation id this Worker run inherited (its delegating call's id), stamped
 *  on the container so `reconcile()` can restore it into the egress source map after a supervisor
 *  restart and an operator can find a delegation's containers with
 *  `docker ps --filter label=nexttime.correlation-id=<id>`. Only set when an id was given. */
export const TASK_CORRELATION_ID_LABEL = 'nexttime.correlation-id';

/** S10 E3-2-0: `'true'` on an evaluation Task's container, whose egress source entry is
 *  deny-all — read back by `task-service.ts`'s `reconcile()` after a supervisor restart, like
 *  `TASK_EGRESS_DENY_LABEL`. Absent on every other container. */
export const TASK_EGRESS_DENY_ALL_LABEL = 'nexttime.egress-deny-all';

export function taskContainerName(workerRunId: string): string {
  return `nexttime-task-${workerRunId}`;
}

export interface BuildTaskSpawnSpecInput {
  readonly config: SupervisorConfig;
  readonly taskId: string;
  readonly workerRunId: string;
  readonly workspaceId: string;
  /** Already validated against `config.taskImageAllowlist` by the caller (`server.ts`) — this
   *  builder does not re-check it; it only ever places the value into the spec. */
  readonly image: string;
  /** When given, becomes container CMD `['--model', model]` — `entrypoint.sh` appends any CMD
   *  after its own fixed pi flags. `undefined` sets no CMD (pi's own default model selection). */
  readonly model?: string;
  readonly networkName: string;
  /** feat/egress-definition-lists: the invoked WorkerDefinition's own `egressDeny`, stamped as
   *  `TASK_EGRESS_DENY_LABEL` (comma-joined) — see that label's own doc comment. `undefined`/empty
   *  stamps an empty label. */
  readonly egressDeny?: readonly string[];
  /** S10 E3-2-0: stamps `TASK_EGRESS_DENY_ALL_LABEL` — see that label's own doc comment. */
  readonly egressDenyAll?: boolean;
  /** Leftover 87: the delegating call's correlation id — becomes the container's
   *  `NEXTTIME_CORRELATION_ID` (the platform extension's worker mode sends it on every kernel
   *  call) and `TASK_CORRELATION_ID_LABEL`. Ignored unless valid (`@nexttime/shared`). */
  readonly correlationId?: string;
  /** S11 GO14: earlier steps' handoff directories, each bound read-only at `/upstream/<stepKey>`
   *  (`upstream-files.ts`) — already checked by `task-service.ts`'s `spawn()`. */
  readonly upstream?: readonly TaskUpstreamFiles[];
}

export function buildTaskSpawnSpec(input: BuildTaskSpawnSpecInput): ContainerSpec {
  const { config } = input;
  const paths = taskWorkspacePaths(config, input.taskId);

  const env: string[] = [
    `KERNEL_URL=${config.kernelUrl}`,
    `KERNEL_LLM_URL=${config.kernelLlmUrl}`,
    // The marker, never the Handle — see spawn-spec.ts (the Handle is bound to the container's
    // address by task-service.ts).
    `CAPABILITY_HANDLE=${SOURCE_BOUND_CAPABILITY_HANDLE}`,
    `TASK_ID=${input.taskId}`,
    `WORKSPACE_ID=${input.workspaceId}`,
    `WORKER_RUN_ID=${input.workerRunId}`,
    'NEXTTIME_MODE=worker',
    `HTTP_PROXY=${config.httpProxyForWorkers}`,
    `HTTPS_PROXY=${config.httpProxyForWorkers}`,
    `NO_PROXY=${config.noProxyForWorkers}`,
    // Lowercase mirrors — see this module's doc comment (same httpoxy rationale as spawn-spec.ts).
    `http_proxy=${config.httpProxyForWorkers}`,
    `https_proxy=${config.httpProxyForWorkers}`,
    `no_proxy=${config.noProxyForWorkers}`,
  ];
  const correlationId = isValidCorrelationId(input.correlationId) ? input.correlationId : undefined;
  if (correlationId !== undefined) env.push(`${CORRELATION_ID_ENV}=${correlationId}`);

  const binds: string[] = [
    `${paths.hostWorkspaceDir}:${WORKSPACE_MOUNT_TARGET}`,
    `${paths.hostPlatformDir}:${PLATFORM_MOUNT_TARGET}:ro`,
    `${hostModelsJsonPath(config)}:${MODELS_JSON_MOUNT_TARGET}:ro`,
    ...(input.upstream ?? []).map(
      (entry) =>
        `${taskHandoffPaths(taskWorkspacePaths(config, entry.taskId)).host}:${upstreamMountTarget(entry.stepKey)}:ro`,
    ),
  ];

  return {
    name: taskContainerName(input.workerRunId),
    image: input.image,
    cmd: input.model ? ['--model', input.model] : undefined,
    env,
    binds,
    labels: {
      [TASK_ROLE_LABEL]: TASK_ROLE_VALUE,
      [TASK_ID_LABEL]: input.taskId,
      [WORKER_RUN_ID_LABEL]: input.workerRunId,
      [TASK_WORKSPACE_LABEL]: input.workspaceId,
      [EGRESS_DENY_LABEL]: (input.egressDeny ?? []).join(','),
      ...(input.egressDenyAll === true ? { [TASK_EGRESS_DENY_ALL_LABEL]: 'true' } : {}),
      ...(correlationId !== undefined ? { [TASK_CORRELATION_ID_LABEL]: correlationId } : {}),
    },
    networkName: input.networkName,
    runtime: config.workerRuntime,
    memoryMb: config.workerMemoryMb,
    pidsLimit: config.workerPidsLimit,
    tmpfsMb: config.workerTmpfsMb,
    cpus: config.workerCpus,
    dns: config.workerDnsSinkhole,
  };
}
