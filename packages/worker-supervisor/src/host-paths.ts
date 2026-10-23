/**
 * host-paths: the host-vs-local path split `config.ts`'s doc comment describes. `host*` values go
 * into bind-mount source strings sent to the Docker Engine API (resolved by the daemon against the
 * **host** filesystem); `local*` values are this container's own view of the same files, used for
 * direct `fs` operations (`egress-map.ts`'s read-modify-write, and directory bootstrapping before
 * a container's first spawn — see `resident-service.ts`).
 *
 * Whitelist start (STATUS leftover 422, `deploy/worker-runtime/entrypoint.sh` header): nothing the
 * runtime loads from pi's own directories lives in the workspace any more. The workspace (mounted
 * read-write at `/workspace`) holds only the agent's own files and pi's session JSONL
 * (`/workspace/.pi/sessions`, the `--session-dir` entrypoint.sh passes). What the platform hands
 * pi — the published system prompt and Skills — lives in a separate per-principal / per-Task
 * **platform directory** under `workspaces/.platform/`, bind-mounted **read-only** at
 * `PLATFORM_MOUNT_TARGET`, so the agent can read but never edit what its next start loads. pi's
 * own config directory (`PI_CODING_AGENT_DIR`) is entrypoint.sh's business: rebuilt in `/tmp`
 * at every start, never a mount.
 */

import type { SupervisorConfig } from './config.js';

export const WORKSPACE_MOUNT_TARGET = '/workspace';
/** entrypoint.sh's `PLATFORM_DIR`: `system-prompt.md` and `skills/<name>/` (read-only bind). */
export const PLATFORM_MOUNT_TARGET = '/opt/nexttime/platform';
/** entrypoint.sh's `MODELS_JSON`, which it links into the fresh pi config directory. */
export const MODELS_JSON_MOUNT_TARGET = '/opt/nexttime/models.json';

/** Platform directories live under `workspaces/` (already the supervisor's own mount and the
 *  backup's) but outside every per-principal and per-Task workspace directory. Principal and
 *  Task ids are UUIDs (`config.ts` `IdClaimSchema`), so `.platform` can never collide with one. */
const PLATFORM_ROOT_RELATIVE_PATH = 'workspaces/.platform';

const SYSTEM_PROMPT_FILE_NAME = 'system-prompt.md';
const SKILLS_DIR_NAME = 'skills';

export interface WorkspacePaths {
  readonly hostWorkspaceDir: string;
  readonly localWorkspaceDir: string;
  /** The platform directory's bind-mount source (`workspaces/.platform/principals/<id>`). */
  readonly hostPlatformDir: string;
  /** This container's own view of `hostPlatformDir`. `resident-service.ts`'s spawn() creates it
   *  before asking Docker to create the entry container, so Docker never auto-creates the bind
   *  source as root. */
  readonly localPlatformDir: string;
}

export function workspacePaths(config: SupervisorConfig, principalId: string): WorkspacePaths {
  return {
    hostWorkspaceDir: `${config.nextTimeData}/workspaces/${principalId}`,
    localWorkspaceDir: `${config.localDataDir}/workspaces/${principalId}`,
    hostPlatformDir: `${config.nextTimeData}/${PLATFORM_ROOT_RELATIVE_PATH}/principals/${principalId}`,
    localPlatformDir: `${config.localDataDir}/${PLATFORM_ROOT_RELATIVE_PATH}/principals/${principalId}`,
  };
}

/** Host-side source of the models.json bind mount — `MODELS_JSON_HOST_PATH` when set (an
 *  acceptance run's fake-provider file), else `${NEXTTIME_DATA}/models/models.json` (S7-A,
 *  docs/STATUS.md 维护者决定 2026-09-22 ⑤: moved out of config/ into its own directory). */
export function hostModelsJsonPath(config: SupervisorConfig): string {
  return config.modelsJsonHostPath;
}

export function localModelsJsonPath(config: SupervisorConfig): string {
  return `${config.localDataDir}/models/models.json`;
}

/** The published system prompt entrypoint.sh passes to `--system-prompt`
 *  (`/opt/nexttime/platform/system-prompt.md` inside the container) — this container's own view.
 *  `resident-service.ts`'s spawn() writes it (S2.6) before deciding whether to reuse or
 *  (re)create the entry container, so the container's next start always loads the current
 *  published prompt. */
export function localSystemPromptPath(config: SupervisorConfig, principalId: string): string {
  return `${workspacePaths(config, principalId).localPlatformDir}/${SYSTEM_PROMPT_FILE_NAME}`;
}

/** The published Skills entrypoint.sh passes to `--skill` (`/opt/nexttime/platform/skills`, one
 *  `<name>/` directory per Skill) — this container's own view, for either mode's platform
 *  directory. */
export function localSkillsDir(localPlatformDir: string): string {
  return `${localPlatformDir}/${SKILLS_DIR_NAME}`;
}

/**
 * Task-mode analogue of `workspacePaths` (S2.8; design doc §7.3, docs/development-tasks.md S2.8
 * task brief): one directory per Task (not per user) — `workspaces/tasks/<taskId>` instead of
 * `workspaces/<principalId>` — mounted to the same `/workspace` target. Never overlaps a user's
 * entry workspace (I15: "其他用户的容器与任何 Worker 容器都不挂载" — a Worker's `hostWorkspaceDir`
 * always lives under the `tasks/` subtree, an entry container's never does).
 *
 * The Task's platform directory (`workspaces/.platform/tasks/<taskId>`) follows the same split
 * as resident mode's (see this module's doc comment).
 */
export interface TaskPaths {
  readonly hostWorkspaceDir: string;
  readonly localWorkspaceDir: string;
  readonly hostPlatformDir: string;
  /** This container's own view of `hostPlatformDir` — created by `task-service.ts`'s spawn()
   *  before the container, for the same reason as `WorkspacePaths.localPlatformDir`. */
  readonly localPlatformDir: string;
}

export function taskWorkspacePaths(config: SupervisorConfig, taskId: string): TaskPaths {
  return {
    hostWorkspaceDir: `${config.nextTimeData}/workspaces/tasks/${taskId}`,
    localWorkspaceDir: `${config.localDataDir}/workspaces/tasks/${taskId}`,
    hostPlatformDir: `${config.nextTimeData}/${PLATFORM_ROOT_RELATIVE_PATH}/tasks/${taskId}`,
    localPlatformDir: `${config.localDataDir}/${PLATFORM_ROOT_RELATIVE_PATH}/tasks/${taskId}`,
  };
}

/** Task-mode analogue of `localSystemPromptPath` (P-A2; docs/platform-admin-design.md §6.6),
 *  inside this Task's own platform directory. Takes the already-resolved `TaskPaths` rather than
 *  `(config, taskId)` because every caller (`task-service.ts`'s `spawn()`) has them in hand for
 *  the bind mounts anyway. */
export function taskSystemPromptPath(paths: TaskPaths): string {
  return `${paths.localPlatformDir}/${SYSTEM_PROMPT_FILE_NAME}`;
}

/** This container's own view of the `workspaces/tasks/` root — used by the retention sweep
 *  (`task-service.ts`) to enumerate finished Task directories. */
export function localTaskWorkspacesRootDir(config: SupervisorConfig): string {
  return `${config.localDataDir}/workspaces/tasks`;
}

/** This container's own view of the `workspaces/.platform/tasks/` root — swept by the same
 *  retention rule as the Task workspaces themselves (`task-service.ts`). */
export function localTaskPlatformRootDir(config: SupervisorConfig): string {
  return `${config.localDataDir}/${PLATFORM_ROOT_RELATIVE_PATH}/tasks`;
}
