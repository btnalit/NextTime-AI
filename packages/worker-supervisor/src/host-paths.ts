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
