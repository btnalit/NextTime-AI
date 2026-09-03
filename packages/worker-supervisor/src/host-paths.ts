/**
 * host-paths: the host-vs-local path split `config.ts`'s doc comment describes. `host*` values go
 * into bind-mount source strings sent to the Docker Engine API (resolved by the daemon against the
 * **host** filesystem); `local*` values are this container's own view of the same files, used for
 * direct `fs` operations (`egress-map.ts`'s read-modify-write, and directory bootstrapping before
 * a container's first spawn — see `resident-service.ts`).
 *
 * `piAgentDir`/`piSessionDir` are workspace-relative on both sides (design doc §7.2: "该目录只挂给
 * 这个用户的入口容器"，"含 pi 的 --session-dir 与 PI_CODING_AGENT_DIR") — they live inside the same
 * per-user directory as everything else the entry container writes, not a separate host path.
 */

import type { SupervisorConfig } from './config.js';

export interface WorkspacePaths {
  readonly hostWorkspaceDir: string;
  readonly localWorkspaceDir: string;
  /** `PI_CODING_AGENT_DIR` inside the container — workspace-relative (`/workspace/.pi/agent`). */
  readonly piAgentDirInContainer: string;
  /** `--session-dir` inside the container (`/workspace/.pi/sessions`). */
  readonly piSessionDirInContainer: string;
  /** `models.json`'s bind-mount target inside the container
   *  (`${piAgentDirInContainer}/models.json`). */
  readonly modelsJsonTargetInContainer: string;
  /** This container's own view of `piAgentDirInContainer` — `resident-service.ts`'s spawn()
   *  `mkdirSync`s this *before* asking Docker to create the entry container. Host verification
   *  (S1.5a) found that skipping this step lets Docker auto-create `.pi/agent` (as the parent of
   *  the models.json bind-mount target) as **root**, while running as root — the entry
   *  container's own non-root `nexttime` (uid 10001) then can't `mkdir` the sibling
   *  `.pi/sessions` under that root-owned `.pi/`, and pi's own writes under `PI_CODING_AGENT_DIR`
   *  would fail the same way. Pre-creating it here (this process also runs as uid 10001) means
   *  Docker's bind-mount setup finds it already correctly owned. */
  readonly localPiAgentDir: string;
}

export const WORKSPACE_MOUNT_TARGET = '/workspace';

export function workspacePaths(config: SupervisorConfig, principalId: string): WorkspacePaths {
  return {
    hostWorkspaceDir: `${config.nextTimeData}/workspaces/${principalId}`,
    localWorkspaceDir: `${config.localDataDir}/workspaces/${principalId}`,
    piAgentDirInContainer: `${WORKSPACE_MOUNT_TARGET}/.pi/agent`,
    piSessionDirInContainer: `${WORKSPACE_MOUNT_TARGET}/.pi/sessions`,
    modelsJsonTargetInContainer: `${WORKSPACE_MOUNT_TARGET}/.pi/agent/models.json`,
    localPiAgentDir: `${config.localDataDir}/workspaces/${principalId}/.pi/agent`,
  };
}

export function hostModelsJsonPath(config: SupervisorConfig): string {
  return `${config.nextTimeData}/config/models.json`;
}

export function localModelsJsonPath(config: SupervisorConfig): string {
  return `${config.localDataDir}/config/models.json`;
}

/**
 * Task-mode analogue of `workspacePaths` (S2.8; design doc §7.3, docs/development-tasks.md S2.8
 * task brief): one directory per Task (not per user) — `workspaces/tasks/<taskId>` instead of
 * `workspaces/<principalId>` — mounted to the same `/workspace` target. Never overlaps a user's
 * entry workspace (I15: "其他用户的容器与任何 Worker 容器都不挂载" — a Worker's `hostWorkspaceDir`
 * always lives under the `tasks/` subtree, an entry container's never does).
 *
 * `piAgentDirInContainer`/`modelsJsonTargetInContainer` intentionally reuse the exact same
 * in-container path resident mode uses (`/workspace/.pi/agent[/models.json]`) even though the
 * task-mode env allowlist (spawn-spec's task builder) does not set `PI_CODING_AGENT_DIR`: pi
 * 0.84.4's own default (`packages/coding-agent/src/config.ts` `getAgentDir()`, verified against
 * the pinned reference checkout) is `join(homedir(), '.pi', 'agent')`, and `homedir()` resolves
 * from `HOME` — which the runtime image's own Dockerfile bakes in as `HOME=/workspace` at the
 * image level (`deploy/worker-runtime/Dockerfile`), present regardless of what this package's
 * `Env` array sets. So the default already lands exactly here without needing the env var.
 */
export interface TaskPaths {
  readonly hostWorkspaceDir: string;
  readonly localWorkspaceDir: string;
  readonly piAgentDirInContainer: string;
  readonly modelsJsonTargetInContainer: string;
  readonly skillsDirInContainer: string;
  /** This container's own view of `piAgentDirInContainer` — pre-created for the same reason
   *  `workspacePaths`' `localPiAgentDir` is (see that doc comment): Docker would otherwise create
   *  `.pi/` as root while preparing the `models.json` bind-mount, blocking the non-root Worker
   *  container from creating sibling directories under it. */
  readonly localPiAgentDir: string;
}

export function taskWorkspacePaths(config: SupervisorConfig, taskId: string): TaskPaths {
  const hostWorkspaceDir = `${config.nextTimeData}/workspaces/tasks/${taskId}`;
  const localWorkspaceDir = `${config.localDataDir}/workspaces/tasks/${taskId}`;
  const piAgentDirInContainer = `${WORKSPACE_MOUNT_TARGET}/.pi/agent`;
  return {
    hostWorkspaceDir,
    localWorkspaceDir,
    piAgentDirInContainer,
    modelsJsonTargetInContainer: `${piAgentDirInContainer}/models.json`,
    skillsDirInContainer: `${piAgentDirInContainer}/skills`,
    localPiAgentDir: `${localWorkspaceDir}/.pi/agent`,
  };
}

/** This container's own view of the `workspaces/tasks/` root — used by the retention sweep
 *  (`task-service.ts`) to enumerate finished Task directories. */
export function localTaskWorkspacesRootDir(config: SupervisorConfig): string {
  return `${config.localDataDir}/workspaces/tasks`;
}

/** Bind-mount target for one `skills[]` entry inside the container (`task-spawn-spec.ts`):
 *  `<agentDir>/skills/<name>` — pi 0.84.4's own default global-skills directory
 *  (`packages/coding-agent/src/core/skills.ts` `loadSkills`: `join(resolvedAgentDir, 'skills')`),
 *  verified against the pinned reference checkout, not a guess — see `TaskPaths`'s doc comment for
 *  why `resolvedAgentDir` lands at `piAgentDirInContainer` without `PI_CODING_AGENT_DIR` being set. */
export function taskSkillTargetInContainer(paths: TaskPaths, skillName: string): string {
  return `${paths.skillsDirInContainer}/${skillName}`;
}
