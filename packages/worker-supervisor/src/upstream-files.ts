/**
 * upstream-files (S11 GO14; s11-w2/go14-default-plan.md): the files one goal
 * step's Worker leaves for later steps of the same goal, and the read-only mounts that hand them
 * on. The kernel decides which upstream Task a step reads (its plan's `filesFrom`, the same goal
 * run, the live step's accepted attempt) and never touches a file; this module is where the files
 * are, so it is where the rest is checked.
 *
 *   - **Handoff directory**: `/workspace/out` of a goal step's Task (`HANDOFF_DIR_NAME`), made by
 *     `spawn()` for every Task that carries a goal run. Only what the Worker puts there is handed
 *     on — its session record (`/workspace/.pi/sessions`), caches and drafts stay with its step.
 *   - **Owner marker**: `owner.json` in the Task's *platform* directory (`TASK_OWNER_FILE_NAME`),
 *     `{workspaceId, goalRunId}`, written by `spawn()`. The Worker mounts that directory
 *     read-only, so the marker says whose goal the directory belongs to whatever the Worker did.
 *     A mount is refused unless it names the reading Task's own workspace and goal run — a second
 *     line behind the kernel's own choice, so a kernel defect cannot hand one goal's files to
 *     another.
 *   - **Mount**: `/upstream/<stepKey>` (`UPSTREAM_MOUNT_ROOT`), read-only — outside the Worker's
 *     cwd (`/workspace`) and every directory above it, and outside pi's config directory
 *     (`/tmp/pi-agent`, deploy/worker-runtime/entrypoint.sh), so nothing in it is ever taken for
 *     an `AGENTS.md`, an extension or a Skill (STATUS legacy 422; `runtime-whitelist.test.ts`).
 *
 * Why the checks in `upstreamFilesState` are the ones they are: Docker resolves a bind source's
 * symbolic links on the *host*. The upstream Worker owned its `/workspace`, so `out` could be a
 * link to anywhere on the host, and mounting it would hand that place to the downstream Worker.
 * The source is therefore only ever a path this service made (`<task workspace>/out`), mounted
 * only when (1) no container of that Task is running, so nothing but this service writes there
 * any more; (2) `out` is, by `lstat`, a directory and not a link, a FIFO or a file; (3) its real
 * path is its parent's real path plus `out`. Between that check and the mount nothing can change
 * it, because no container of that Task will ever start again: the kernel never spawns a Task
 * that has ended (a goal step's attempt is not requeued), and this service does not rely on that
 * alone — a Task whose platform directory holds an owner marker has been spawned once, and
 * `spawn()` refuses it again (`TaskAlreadySpawnedError`, 409 `goal_task_spawned`). A link
 * *inside* `out` is resolved in the downstream container, where it can only reach that
 * container's own files.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { posix as posixPath } from 'node:path';
import type { StepFilesState } from '@nexttime/shared';
import { z } from 'zod';
import type { SupervisorConfig } from './config.js';
import { type TaskPaths, taskWorkspacePaths } from './host-paths.js';

export const HANDOFF_DIR_NAME = 'out';
export const UPSTREAM_MOUNT_ROOT = '/upstream';
export const TASK_OWNER_FILE_NAME = 'owner.json';

/** What a Task's handoff directory is to a Task of the same goal that wants to read it —
 *  `@nexttime/shared` `STEP_FILES_STATE_VALUES` says what each state means. */
export type UpstreamFilesState = StepFilesState;

export interface TaskOwner {
  readonly workspaceId: string;
  readonly goalRunId: string;
}

const TaskOwnerSchema = z
  .object({ workspaceId: z.string().min(1), goalRunId: z.string().min(1) })
  .strict();

/** Where `taskId`'s handoff directory is, as this process sees it and as the host does. */
export function taskHandoffPaths(paths: TaskPaths): { local: string; host: string } {
  return {
    local: posixPath.join(paths.localWorkspaceDir, HANDOFF_DIR_NAME),
    host: posixPath.join(paths.hostWorkspaceDir, HANDOFF_DIR_NAME),
  };
}

/** The mount target of the handoff directory of step `stepKey` (`StepKeySchema`: no `/`, and
 *  never `.` or `..`). */
export function upstreamMountTarget(stepKey: string): string {
  return posixPath.join(UPSTREAM_MOUNT_ROOT, stepKey);
}

/** Writes the owner marker and makes the (empty) handoff directory — `spawn()`, for a Task that
 *  carries a goal run, after both of the Task's directories exist. */
export function prepareGoalTaskDirs(paths: TaskPaths, owner: TaskOwner): void {
  writeFileSync(
    posixPath.join(paths.localPlatformDir, TASK_OWNER_FILE_NAME),
    `${JSON.stringify({ workspaceId: owner.workspaceId, goalRunId: owner.goalRunId })}\n`,
    'utf8',
  );
  mkdirSync(taskHandoffPaths(paths).local, { recursive: true });
}

/** Whether the Task's platform directory holds an owner marker of any kind (`lstat`: a link or
 *  a FIFO counts, and is not followed) — a goal step's Task that has been spawned before. */
export function hasTaskOwnerMarker(paths: TaskPaths): boolean {
  try {
    lstatSync(posixPath.join(paths.localPlatformDir, TASK_OWNER_FILE_NAME));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** The owner marker, read through one descriptor: opened without following a link
 *  (`O_NOFOLLOW`) or waiting on a FIFO (`O_NONBLOCK`), checked to be a regular file by `fstat` on
 *  that descriptor, and read from it — so what is checked is what is read (CodeQL
 *  js/file-system-race). Anything else, or a marker that does not parse, is no marker. */
function readTaskOwner(paths: TaskPaths): TaskOwner | undefined {
  const file = posixPath.join(paths.localPlatformDir, TASK_OWNER_FILE_NAME);
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return undefined;
    const parsed = TaskOwnerSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isDirectoryOfItsOwn(path: string): boolean | 'missing' {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return false;
  }
}

/** What `taskId`'s handoff directory is to a reader in `owner`'s workspace and goal run — see
 *  {@link UpstreamFilesState} and this module's doc comment for the checks. `runningTaskIds`:
 *  the Tasks with a container this service still counts as running. */
export function upstreamFilesState(
  config: SupervisorConfig,
  taskId: string,
  owner: TaskOwner,
  runningTaskIds: ReadonlySet<string>,
): UpstreamFilesState {
  if (runningTaskIds.has(taskId)) return 'running';
  const paths = taskWorkspacePaths(config, taskId);
  const workspace = isDirectoryOfItsOwn(paths.localWorkspaceDir);
  if (workspace === 'missing') return 'missing';
  if (!workspace) return 'not_a_directory';
  const marker = readTaskOwner(paths);
  if (
    marker === undefined ||
    marker.workspaceId !== owner.workspaceId ||
    marker.goalRunId !== owner.goalRunId
  ) {
    return 'not_owned';
  }
  const handoff = taskHandoffPaths(paths).local;
  const out = isDirectoryOfItsOwn(handoff);
  if (out === 'missing') return 'missing';
  if (!out) return 'not_a_directory';
  try {
    const expected = posixPath.join(realpathSync(paths.localWorkspaceDir), HANDOFF_DIR_NAME);
    if (realpathSync(handoff) !== expected) return 'not_a_directory';
  } catch {
    return 'not_a_directory';
  }
  return 'kept';
}

/** Thrown by `spawn()` when an upstream handoff directory cannot be mounted — `server.ts` answers
 *  409 `upstream_unavailable` with the step and the state. Nothing of the spawn has been written. */
export class UpstreamFilesUnavailableError extends Error {
  readonly code = 'upstream_unavailable';
  readonly stepKey: string;
  readonly taskId: string;
  readonly state: Exclude<UpstreamFilesState, 'kept'>;
  constructor(stepKey: string, taskId: string, state: Exclude<UpstreamFilesState, 'kept'>) {
    super(`the files of step ${stepKey} (task ${taskId}) cannot be mounted: ${state}`);
    this.name = 'UpstreamFilesUnavailableError';
    this.stepKey = stepKey;
    this.taskId = taskId;
    this.state = state;
  }
}

/** Thrown by `spawn()` for a Task whose platform directory already holds an owner marker: a goal
 *  step's Task is spawned once, so its handoff directory, once checked for a later step, is never
 *  written by a Worker again (this module's doc comment). `server.ts` answers 409
 *  `goal_task_spawned`. Nothing of the spawn has been written. */
export class TaskAlreadySpawnedError extends Error {
  readonly code = 'goal_task_spawned';
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task ${taskId} is a goal step's Task that was spawned before; it is not spawned again`);
    this.name = 'TaskAlreadySpawnedError';
    this.taskId = taskId;
  }
}
