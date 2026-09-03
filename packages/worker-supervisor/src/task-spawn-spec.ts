/**
 * task-spawn-spec: pure builder for a one-shot Task/Worker container's `ContainerSpec` (S2.8;
 * docs/development-tasks.md S2.8 task brief; design doc §7.3, §7.9, §11). No I/O — same shape and
 * same reason for existing as `spawn-spec.ts`'s `buildSpawnSpec` for resident mode, kept as a
 * separate file/function rather than a branch inside `buildSpawnSpec` because the two modes differ
 * in almost everything that matters (env allowlist, mount set, container identity, CMD) and
 * resident mode's own tests/behavior must stay untouched (task brief: "keep resident mode's
 * behavior unchanged").
 *
 * Env is **exactly** `KERNEL_URL`, `KERNEL_LLM_URL`, `CAPABILITY_HANDLE`, `TASK_ID`,
 * `WORKSPACE_ID`, `WORKER_RUN_ID`, `NEXTTIME_MODE=worker`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`
 * — plus the same lowercase `http_proxy`/`https_proxy`/`no_proxy` mirrors resident mode's own
 * `spawn-spec.ts` documents (verified there against the "httpoxy" plain-`http://`-only-honors-
 * lowercase behavior; identical proxy setup, identical reasoning, not re-verified here).
 *
 * Deliberately **not** in this list, unlike resident mode's entry spec: `PI_CODING_AGENT_DIR` and
 * `HOME`. Both are already correct without being set — `HOME=/workspace` is baked into
 * `deploy/worker-runtime/Dockerfile` at the image level (present in every container regardless of
 * this package's own `Env` array), and pi 0.84.4's default agent dir
 * (`packages/coding-agent/src/config.ts` `getAgentDir()`, pinned reference checkout) is
 * `join(homedir(), '.pi', 'agent')` — `homedir()` reads `HOME`, so the default already resolves to
 * `/workspace/.pi/agent`, exactly where `host-paths.ts` `taskWorkspacePaths` mounts `models.json`
 * and each skill. `on_behalf_of`/`WORKSPACE_ID` needing to reach the extension the way resident
 * mode's own doc comment describes is unaffected — `WORKSPACE_ID` IS one of this list's env vars.
 *
 * Nothing from this process's own env is ever forwarded (`docker-client.ts` passes exactly the
 * array built here, never inherits `process.env`) — `task-spawn-spec.test.ts` asserts this
 * explicitly (a `SOME_API_KEY` set on the test process must never appear in the built env).
 */

import type { SupervisorConfig } from './config.js';
import type { ContainerSpec } from './docker-client.js';
import {
  hostModelsJsonPath,
  taskSkillTargetInContainer,
  taskWorkspacePaths,
} from './host-paths.js';
import { ENTRY_ROLE_LABEL as TASK_ROLE_LABEL } from './spawn-spec.js';

/** Shares the `nexttime.role` label *key* with resident mode's `ENTRY_ROLE_LABEL`
 *  (`spawn-spec.ts`) — only the value differs (`worker` vs `entry`). Re-exported under this name
 *  so callers of this module never need a separate import from `spawn-spec.ts`. */
export { TASK_ROLE_LABEL };
export const TASK_ROLE_VALUE = 'worker';
export const TASK_ID_LABEL = 'nexttime.task-id';
export const WORKER_RUN_ID_LABEL = 'nexttime.worker-run-id';
export const TASK_WORKSPACE_LABEL = 'nexttime.workspace-id';

export function taskContainerName(workerRunId: string): string {
  return `nexttime-task-${workerRunId}`;
}

export interface TaskSkillMount {
  readonly name: string;
  readonly hostPath: string;
}

export interface BuildTaskSpawnSpecInput {
  readonly config: SupervisorConfig;
  readonly taskId: string;
  readonly workerRunId: string;
  readonly workspaceId: string;
  readonly capabilityHandle: string;
  /** Already validated against `config.taskImageAllowlist` by the caller (`server.ts`) — this
   *  builder does not re-check it; it only ever places the value into the spec. */
  readonly image: string;
  /** When given, becomes container CMD `['--model', model]` — `entrypoint.sh` appends any CMD
   *  after its own fixed pi flags. `undefined` sets no CMD (pi's own default model selection). */
  readonly model?: string;
  readonly skills?: readonly TaskSkillMount[];
  readonly networkName: string;
}

export function buildTaskSpawnSpec(input: BuildTaskSpawnSpecInput): ContainerSpec {
  const { config } = input;
  const paths = taskWorkspacePaths(config, input.taskId);

  const env: string[] = [
    `KERNEL_URL=${config.kernelUrl}`,
    `KERNEL_LLM_URL=${config.kernelLlmUrl}`,
    `CAPABILITY_HANDLE=${input.capabilityHandle}`,
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

  const binds: string[] = [
    `${paths.hostWorkspaceDir}:/workspace`,
    `${hostModelsJsonPath(config)}:${paths.modelsJsonTargetInContainer}:ro`,
    ...(input.skills ?? []).map(
      (skill) => `${skill.hostPath}:${taskSkillTargetInContainer(paths, skill.name)}:ro`,
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
    },
    networkName: input.networkName,
    runtime: config.workerRuntime,
    memoryMb: config.workerMemoryMb,
    pidsLimit: config.workerPidsLimit,
    tmpfsMb: config.workerTmpfsMb,
  };
}
