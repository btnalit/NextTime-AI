/**
 * task-service: orchestrates one-shot Task/Worker container lifecycle (S2.8; docs/development-
 * tasks.md S2.8 task brief; design doc §7.3, §7.9, §11) on top of `DockerClient` (docker-client.ts)
 * and `EgressMapStore` (egress-map.ts) — the Task-mode analogue of `resident-service.ts`. Owns the
 * in-memory registry `(workerRunId → {...})` the task brief asks for. A Task's *workspace
 * directory* — not this in-memory registry — is the durable artifact: the registry does not need
 * to survive a supervisor restart the way resident mode's container-label-encoded state does,
 * because a one-shot Worker whose result was never collected is already indistinguishable, from
 * every caller's point of view, from "the Worker failed" — noticing and reacting to that is S2.7's
 * reaper/retry logic, not this package's. `reconcile()` below is still provided, best-effort, so a
 * restart doesn't orphan a still-running container's egress registration or leak it forever, but it
 * cannot recover the original `timeoutSec` a spawn request carried (never persisted anywhere) —
 * see that method's own doc comment.
 *
 * **Status classification** (the task brief's four states — `running|exited|terminated|failed` —
 * aren't fully spelled out beyond "kill after timeoutSec ... status terminated with reason", so
 * this is stated here as an explicit assumption, not inferred silently — see PR body "假设与偏离"):
 * `terminated` is any exit **this service caused** (explicit `POST /task/:id/terminate`, or the
 * timeout reaper) — regardless of the underlying exit code, which after a SIGKILL is often
 * non-zero and would otherwise misleadingly read as "failed". Every other exit is classified by
 * Docker's own exit code: `0` → `exited` (the Worker's own process finished normally), non-zero →
 * `failed`. This mirrors the Kubernetes Job Complete/Failed split, and keeps the caller (S2.9's
 * `task/result.ts`, not built yet) from having to re-derive "did the platform kill this, or did it
 * fail on its own" from a raw exit code.
 *
 * `onBehalfOf` (`TaskSpawnInput`) is accepted and Zod-validated (`config.ts`
 * `TaskSpawnRequestSchema`) because it's part of the documented `/task/spawn` wire contract, but is
 * not otherwise used by this service: `on_behalf_of` scoping (I13) is already baked into
 * `capabilityHandle` itself by the time it reaches this API (S2.7's `invoke_worker`, not this
 * package) — there is nothing left for the container spec or registry to do with the raw value.
 *
 * **`systemPrompt` (P-A2; design doc §6.6)**: same mechanism as `skillsInline` below — `spawn()`
 * writes it to `system-prompt.md` in this Task's own platform directory (`host-paths.ts`, mounted
 * read-only at `/opt/nexttime/platform`) before `docker.createAndStart`, which is where
 * `deploy/worker-runtime/entrypoint.sh` looks before falling back to its own static default.
 * Resident mode carries the identical field for entry containers (`resident-service.ts`'s
 * `writeSystemPromptIfChanged`).
 *
 * **`skillsInline` (S2.14)**: carries Skill file *content*, not a host path — the kernel has no
 * writable data mount of its own to stage a host path from (I9-adjacent). `spawn()` below writes
 * every entry's files under `skills/<name>/` in this Task's own platform directory before calling
 * `docker.createAndStart` — the directory the container mounts read-only, which the Worker can
 * read but not edit. Validated structurally by `config.ts`'s `TaskSkillInlineSchema` (safe
 * names/paths, per-file and total size caps) before this function ever sees it. This is the only
 * way a spawn request can put a Skill into a Worker container — an earlier `skills[]` host-path
 * variant (a caller-supplied absolute path bind-mounted read-only) was removed (lane-6 review
 * P1-3: its allowlist covered all of `${NEXTTIME_DATA}/`, including `secrets/handle.key`, and
 * nothing in this codebase ever sent it — see `config.ts`'s `TaskSkillInlineSchema` doc comment).
 */

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { posix as posixPath } from 'node:path';
import { isValidCorrelationId } from '@nexttime/shared';
import type { SupervisorConfig, TaskUpstreamFiles } from './config.js';
import type { TaskSkillInline } from './config.js';
import type { ContainerState, DockerClient } from './docker-client.js';
import { denyAllEntryFields, taskSourceId } from './egress-map.js';
import type { EgressMapStore } from './egress-map.js';
import { type HandleBindingStore, bindExclusive, containerAtAddress } from './handle-bindings.js';
import {
  localSkillsDir,
  localTaskPlatformRootDir,
  localTaskWorkspacesRootDir,
  taskSystemPromptPath,
  taskWorkspacePaths,
} from './host-paths.js';
import { assertRuntimeContract } from './runtime-contract.js';
import {
  type TaskRuntimeReport,
  readModelsConfigDigest,
  taskRuntimeReport,
} from './runtime-report.js';
import {
  TASK_CORRELATION_ID_LABEL,
  TASK_EGRESS_DENY_ALL_LABEL,
  TASK_EGRESS_DENY_LABEL,
  TASK_ID_LABEL,
  TASK_ROLE_LABEL,
  TASK_ROLE_VALUE,
  TASK_WORKSPACE_LABEL,
  WORKER_RUN_ID_LABEL,
  buildTaskSpawnSpec,
  taskContainerName,
} from './task-spawn-spec.js';
import {
  TaskAlreadySpawnedError,
  type UpstreamFilesState,
  UpstreamFilesUnavailableError,
  hasTaskOwnerMarker,
  prepareGoalTaskDirs,
  upstreamFilesState,
} from './upstream-files.js';

/** Splits `TASK_EGRESS_DENY_LABEL`'s comma-joined value back into a list — the inverse of
 *  `buildTaskSpawnSpec`'s `(input.egressDeny ?? []).join(',')`. Same convention as
 *  `resident-service.ts`'s own `splitEgressDenyLabel` (not shared between the two files — same
 *  reason `spawn-spec.ts`/`task-spawn-spec.ts` keep separate `ContainerSpec` builders: the two
 *  modes' registries and reconcile paths are otherwise independent). */
function splitEgressDenyLabel(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Shorter than resident mode's `STOP_TIMEOUT_SECONDS` (10s, `resident-service.ts`) — a one-shot
 *  Worker being terminated (explicit request or timeout) should be reaped promptly; there is no
 *  user waiting on a graceful shutdown the way a resident entry container's occupant might be. */
const TERMINATE_STOP_TIMEOUT_SECONDS = 5;

export type TaskState = 'running' | 'exited' | 'terminated' | 'failed';

export interface TaskSpawnInput {
  readonly taskId: string;
  readonly workerRunId: string;
  readonly workspaceId: string;
  /** See this module's doc comment — accepted for the wire contract, not otherwise used here. */
  readonly onBehalfOf: string;
  readonly capabilityHandle: string;
  /** Already validated by the caller (`server.ts`) against `config.taskImageAllowlist` — this
   *  service does not re-check it. */
  readonly image: string;
  readonly model?: string;
  /** P-A2: the system prompt this Worker runs with — written to disk by `spawn()` itself before
   *  the container starts, see this module's own doc comment. Omitted leaves `entrypoint.sh`'s
   *  static default in place. */
  readonly systemPrompt?: string;
  /** Skills mounted by content, not a host path (S2.14) — written to disk by `spawn()` itself
   *  before the container starts, see this module's own doc comment's addition below. */
  readonly skillsInline?: readonly TaskSkillInline[];
  readonly timeoutSec?: number;
  /** feat/egress-definition-lists: the invoked WorkerDefinition's own `egressDeny`
   *  (`@nexttime/shared`'s `worker-definition.ts`, `kind='worker'` content) — written into this
   *  WorkerRun's `SOURCE_MAP_FILE` entry (`registerEgress` below) and stamped onto the container
   *  as `TASK_EGRESS_DENY_LABEL` so `reconcile()` can restore it after a supervisor restart. */
  readonly egressDeny?: readonly string[];
  /** S10 E3-2-0: an evaluation Task's run — its `SOURCE_MAP_FILE` entry is deny-all, written
   *  with its Handle binding, before `spawn()` returns, and stamped as
   *  `TASK_EGRESS_DENY_ALL_LABEL` for `reconcile()`. A run whose entry cannot be written is never
   *  left running: `spawn()` fails, `reconcile()` terminates it. */
  readonly egressDenyAll?: boolean;
  /** Leftover 87: the delegating call's correlation id (`server.ts` passes the request's own id —
   *  the kernel's `x-correlation-id`, or one minted here). Becomes the container's
   *  `NEXTTIME_CORRELATION_ID` and label, and this run's egress source-map `correlationId`. */
  readonly correlationId?: string;
  /** S11 GO14 (`upstream-files.ts`): the goal run a goal step's Task works for — `spawn()` makes
   *  its handoff directory and writes its owner marker. */
  readonly goalRunId?: string;
  /** S11 GO14: earlier steps' handoff directories to mount — each checked by `spawn()` first
   *  (`upstreamFilesState`), which refuses the spawn ({@link UpstreamFilesUnavailableError})
   *  before writing anything when one cannot be mounted. Validated by `config.ts`
   *  (`TaskSpawnRequestSchema`): only with `goalRunId`, distinct, never this Task. */
  readonly upstream?: readonly TaskUpstreamFiles[];
}

/** S11 GO14: one Task of a `keepTaskDirs` call, and what its handoff directory was found to be. */
export interface TaskDirsKeepEntry {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly goalRunId: string;
}
export interface TaskDirsKeepResult {
  readonly taskId: string;
  readonly state: UpstreamFilesState;
}

/** One Worker container reaching a terminal state (leftover 87 metrics / log line). */
export interface TaskFinishedEvent {
  readonly workerRunId: string;
  readonly taskId: string;
  readonly state: Exclude<TaskState, 'running'>;
  readonly exitCode: number | undefined;
  readonly reason: string | undefined;
  readonly correlationId: string | undefined;
}

export interface TaskSpawnOutcome {
  readonly containerId: string;
  readonly ip: string | undefined;
  /** S11 W1a: what the container actually runs (runtime-report.ts). */
  readonly runtime: TaskRuntimeReport;
}

export interface TaskStatus {
  readonly workerRunId: string;
  readonly status: TaskState;
  readonly exitCode: number | undefined;
  readonly containerId: string;
  readonly ip: string | undefined;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  /** Set when `status === 'terminated'` (`'requested'` or `'timeout'`) — undefined otherwise. */
  readonly reason: string | undefined;
}

interface RegistryEntry {
  taskId: string;
  workspaceId: string;
  containerId: string;
  ip: string | undefined;
  startedAt: string | undefined;
  timeoutAt: number;
  state: TaskState;
  exitCode: number | undefined;
  finishedAt: string | undefined;
  reason: string | undefined;
  /** Set as soon as this service starts terminating the container (explicit request or timeout) —
   *  read by `reconcileOne` so the subsequent "no longer running" observation is classified
   *  `terminated`, not misread by exit code as `failed`. */
  terminating: boolean;
  /** Leftover 87 — see `TaskSpawnInput.correlationId`. */
  correlationId: string | undefined;
}

export interface TaskServiceDeps {
  readonly config: SupervisorConfig;
  readonly docker: DockerClient;
  /** The read-only images connection (`resident-service.ts`'s `ResidentServiceDeps.imagesDocker`
   *  has why it is a separate one) — read by the runtime contract check before every spawn
   *  (`runtime-contract.ts`). Defaults to `docker`, as there. */
  readonly imagesDocker?: DockerClient;
  readonly egressMap: EgressMapStore;
  /** Where the container's Handle is bound to its address (handle-bindings.ts) — never its env. */
  readonly handleBindings: HandleBindingStore;
  readonly now?: () => number;
  /** Leftover 87: called once per Worker container reaching a terminal state (metrics). */
  readonly onTaskFinished?: (event: TaskFinishedEvent) => void;
}

export interface TaskService {
  spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome>;
  /** `false` when `workerRunId` is unknown (never spawned, or spawned by a supervisor instance
   *  that has since restarted without reconciling it — see `reconcile`). Idempotent: terminating an
   *  already-finished Task is a no-op success. */
  terminate(workerRunId: string): Promise<boolean>;
  status(workerRunId: string): Promise<TaskStatus | undefined>;
  /** Re-registers every still-running Worker container's IP/egress entry after a supervisor
   *  restart — see this module's doc comment for what it deliberately cannot recover. */
  reconcile(): Promise<void>;
  /** Kills any Task past its deadline, and reaps (records exit code, unregisters egress, removes
   *  the container for) any that exited on their own since the last sweep. Call on an interval —
   *  see `index.ts`. */
  reap(): Promise<void>;
  /** Deletes finished Task workspace directories older than `taskWorkdirRetentionHours`. Call on
   *  an interval, separate from `reap()`: this one walks the filesystem, not the registry, and
   *  belongs on a much longer, "boring" cadence. */
  sweepRetention(): Promise<void>;
  /** S11 GO14: the kernel's lease on goal step Tasks' directories (`POST /task-dirs/keep`) — for
   *  each, its handoff directory's state for a reader of that workspace and goal run
   *  (`upstreamFilesState`); a `kept` one has both of its directories marked used now, so
   *  `sweepRetention` leaves them for another retention period. Touches nothing else. */
  keepTaskDirs(tasks: readonly TaskDirsKeepEntry[]): Promise<readonly TaskDirsKeepResult[]>;
  /** feat/egress-docker-events: called by `index.ts`'s docker-events subscriber for every
   *  container-lifecycle event (`die`/`destroy`/`kill`/`stop`) matching the platform's own label
   *  filter — see `docker-events.ts`'s module doc comment. `containerId` is Docker's own event
   *  `Actor.ID`, matched against this service's in-memory registry by `RegistryEntry.containerId`.
   *  Reuses `reconcileOne` verbatim — the exact same finalize/unregister/remove path a `reap()`
   *  tick would eventually take for this entry — so the classification (`exited`/`failed`) and
   *  egress unregistration are identical to the reaper's own behavior, just triggered promptly
   *  instead of on the next poll. Returns `false` (no-op) both for a `workerRunId` this instance
   *  doesn't know about *and* for a still-`running` entry after `reconcileOne` — Docker's `kill`
   *  event fires when the signal is sent, not once the process has actually died, and
   *  `reconcileOne` itself no-ops when `docker.inspectByName` still reports it running (see that
   *  method's own doc comment) — a container can emit `kill` → `die` → `destroy`/`stop` for one
   *  exit, so this must be safe to call more than once for the same exit. */
  notifyContainerExited(containerId: string, action: string): Promise<boolean>;
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { config, docker, egressMap, handleBindings } = deps;
  const imagesDocker = deps.imagesDocker ?? docker;
  const isAt = containerAtAddress(docker);
  const now = deps.now ?? (() => Date.now());
  const registry = new Map<string, RegistryEntry>();
  let cachedNetworkName: string | undefined;

  async function resolveNetworkName(): Promise<string> {
    if (cachedNetworkName) return cachedNetworkName;
    cachedNetworkName = await docker.resolveNetworkByComposeLabel('workers', config.networkWorkers);
    return cachedNetworkName;
  }

  // Best-effort, matching resident-service.ts's own registerEgress/unregisterEgress — a broken
  // SOURCE_MAP_FILE must never fail a spawn/terminate/reap. The one exception is a deny-all
  // (evaluation) run: its callers act on the `false` this returns (`TaskSpawnInput.egressDenyAll`).
  function registerEgress(
    workspaceId: string,
    workerRunId: string,
    ip: string | undefined,
    egressDeny?: readonly string[],
    correlationId?: string,
    denyAll = false,
  ): boolean {
    if (!ip) return false;
    try {
      egressMap.register(ip, {
        sourceId: taskSourceId(workspaceId, workerRunId),
        // S10 E3-2-0: omitted entirely for every other run, same convention as `deny` below.
        ...(denyAll ? denyAllEntryFields() : {}),
        // Omit `deny` entirely when there is nothing to narrow — same convention as
        // resident-service.ts's own registerEgress (keeps the common "no list" case byte-for-byte
        // identical to before this field existed).
        ...(egressDeny && egressDeny.length > 0 ? { deny: egressDeny } : {}),
        // Leftover 87: same "omit when absent" convention.
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
      return true;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: denyAll ? 'error' : 'warn',
          msg: denyAll
            ? 'task egress registration failed (deny-all run is not left running)'
            : 'task egress registration failed (spawn still succeeds)',
          workerRunId,
          ip,
          error: String(err),
        }),
      );
      return false;
    }
  }

  function unregisterEgress(workerRunId: string, entry: RegistryEntry): void {
    const { ip } = entry;
    if (!ip) return;
    try {
      egressMap.unregister(ip);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'task egress unregistration failed',
          workerRunId,
          ip,
          error: String(err),
        }),
      );
    }
    // The Handle binding goes with the egress registration (handle-bindings.ts): once this
    // container is gone, nothing may be authenticated as it from that address.
    unbindHandle(workerRunId, entry);
  }

  /** Removes the Handle bound to the entry's address if it is still this container's
   *  (handle-bindings.ts) — before a terminate stops the container, while it still holds the
   *  address, and again with its egress unregistration, when Docker may already have given the
   *  address to another container, whose binding stays. */
  function unbindHandle(workerRunId: string, entry: RegistryEntry): void {
    const { ip, containerId } = entry;
    if (!ip) return;
    try {
      handleBindings.unbind(ip, containerId);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'task handle unbinding failed (reconcile drops it later)',
          workerRunId,
          ip,
          error: String(err),
        }),
      );
    }
  }

  // Applies a fresh `docker.inspectByName` result to a registry entry still marked `running`,
  // finalizing it the moment Docker reports it isn't running anymore. Used by both `status()` (so
  // a caller polling right after exit sees it immediately, not up to one `reap()` tick late) and
  // `reap()` itself — the one place either of them touches Docker or the registry's terminal state.
  async function reconcileOne(workerRunId: string, entry: RegistryEntry): Promise<void> {
    if (entry.state !== 'running') return;
    const name = taskContainerName(workerRunId);
    const state = await docker.inspectByName(name);
    if (state?.running) return;

    entry.finishedAt = new Date(now()).toISOString();
    entry.exitCode = state?.exitCode;
    const finalState: TaskFinishedEvent['state'] = entry.terminating
      ? 'terminated'
      : entry.exitCode === 0
        ? 'exited'
        : 'failed';
    entry.state = finalState;
    unregisterEgress(workerRunId, entry);
    // Leftover 87: one line per finished Worker run, carrying the delegation's correlation id.
    const finished: TaskFinishedEvent = {
      workerRunId,
      taskId: entry.taskId,
      state: finalState,
      exitCode: entry.exitCode,
      reason: entry.reason,
      correlationId: entry.correlationId,
    };
    console.log(JSON.stringify({ level: 'info', msg: 'task container finished', ...finished }));
    deps.onTaskFinished?.(finished);

    // Best-effort: a removal failure must not stop this service from reporting the (already
    // accurate) terminal state — the container just lingers, visible to `docker ps -a`, until an
    // operator or the next reap tick's retry cleans it up.
    try {
      await docker.remove(name);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'task container removal failed after exit',
          workerRunId,
          error: String(err),
        }),
      );
    }
  }

  async function terminateOne(
    workerRunId: string,
    entry: RegistryEntry,
    reason: string,
  ): Promise<void> {
    entry.terminating = true;
    entry.reason = reason;
    unbindHandle(workerRunId, entry);
    await docker.stop(taskContainerName(workerRunId), TERMINATE_STOP_TIMEOUT_SECONDS);
    await reconcileOne(workerRunId, entry);
  }

  /** The Tasks with a container this service counts as running — never swept, never mounted. */
  function runningTaskIds(): Set<string> {
    return new Set(
      [...registry.values()].filter((e) => e.state === 'running').map((e) => e.taskId),
    );
  }

  /** Removes every per-Task directory under `root` older than the retention cutoff whose Task
   *  isn't running. A missing `root` is nothing to sweep (it appears with the first spawn). */
  function sweepTaskDirs(
    root: string,
    runningTaskIds: ReadonlySet<string>,
    cutoffMs: number,
  ): void {
    let taskDirs: string[];
    try {
      taskDirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const taskId of taskDirs) {
      if (runningTaskIds.has(taskId)) continue; // never delete a still-active Task's workdir
      const dir = `${root}/${taskId}`;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (now() - mtimeMs <= cutoffMs) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        console.log(
          JSON.stringify({ level: 'info', msg: 'task workdir retention swept', taskId, dir }),
        );
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'warn',
            msg: 'task workdir retention sweep failed',
            taskId,
            dir,
            error: String(err),
          }),
        );
      }
    }
  }

  function toStatus(workerRunId: string, entry: RegistryEntry): TaskStatus {
    return {
      workerRunId,
      status: entry.state,
      exitCode: entry.exitCode,
      containerId: entry.containerId,
      ip: entry.ip,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      reason: entry.reason,
    };
  }

  return {
    async spawn(input): Promise<TaskSpawnOutcome> {
      const {
        taskId,
        workerRunId,
        workspaceId,
        capabilityHandle,
        image,
        model,
        systemPrompt,
        skillsInline,
        timeoutSec,
        egressDeny,
        egressDenyAll,
        correlationId,
        goalRunId,
        upstream,
      } = input;
      const paths = taskWorkspacePaths(config, taskId);

      // Refused before anything is written (runtime-contract.ts).
      await assertRuntimeContract(imagesDocker, image, { mode: 'task', taskId, workerRunId });

      // S11 GO14 (review #493 on #884): a goal step's Task is spawned once — the one whose platform
      // directory already holds an owner marker is refused, so a handoff directory checked for a
      // later step is never written by a Worker again (`upstream-files.ts`). A Task outside a goal
      // has no marker, and its crash requeue is unaffected.
      if (hasTaskOwnerMarker(paths)) throw new TaskAlreadySpawnedError(taskId);

      // S11 GO14: every earlier step's handoff directory is checked before anything is written
      // (`upstream-files.ts` has why these checks). Running is asked of Docker as well as of the
      // registry, which a restart empties until `reconcile()` has run.
      if (upstream && upstream.length > 0) {
        if (goalRunId === undefined) {
          throw new Error('task spawn: upstream files need the goal run they belong to');
        }
        const running = runningTaskIds();
        for (const entry of upstream) {
          const containers = await docker.listByLabel(TASK_ID_LABEL, entry.taskId);
          if (containers.some((container) => container.running)) running.add(entry.taskId);
          const state = upstreamFilesState(
            config,
            entry.taskId,
            { workspaceId, goalRunId },
            running,
          );
          if (state !== 'kept') {
            throw new UpstreamFilesUnavailableError(entry.stepKey, entry.taskId, state);
          }
        }
      }

      // This process also runs as uid 10001, so a directory it creates here is already correctly
      // owned; both are bind sources, which Docker would otherwise create as root.
      mkdirSync(paths.localWorkspaceDir, { recursive: true });
      mkdirSync(paths.localPlatformDir, { recursive: true });
      // S11 GO14: a goal step's handoff directory and owner marker (`upstream-files.ts`).
      if (goalRunId !== undefined) prepareGoalTaskDirs(paths, { workspaceId, goalRunId });

      // P-A2: the Task-mode counterpart of resident mode's `writeSystemPromptIfChanged` — put the
      // caller's prompt in this Task's platform directory (host-paths.ts `taskSystemPromptPath`)
      // *before* `docker.createAndStart` below, so `entrypoint.sh` reads it instead of its own
      // static default. Written unconditionally, with no "did it change" comparison: unlike
      // resident mode there is no reuse-a-running-container branch here to skip the write for —
      // every spawn creates a container, and the prompt this call carries is the one it must
      // start with. For the same reason an earlier WorkerRun's prompt or Skills never carry over
      // to this one: the file is removed when this call carries none, and `skills/` is cleared.
      const promptPath = taskSystemPromptPath(paths);
      if (systemPrompt !== undefined) {
        writeFileSync(promptPath, systemPrompt, 'utf8');
      } else {
        rmSync(promptPath, { force: true });
      }

      // S2.14: write every `skillsInline[]` entry's files under `skills/<name>/` in the same
      // directory, *before* `docker.createAndStart` below.
      const skillsDir = localSkillsDir(paths.localPlatformDir);
      rmSync(skillsDir, { recursive: true, force: true });
      for (const skill of skillsInline ?? []) {
        const skillDir = posixPath.join(skillsDir, skill.name);
        for (const [fileName, content] of Object.entries(skill.files)) {
          const filePath = posixPath.join(skillDir, fileName);
          mkdirSync(posixPath.dirname(filePath), { recursive: true });
          writeFileSync(filePath, content, 'utf8');
        }
      }
      // Retention (`sweepRetention`) goes by each directory's own mtime, which rewriting a file
      // already there doesn't move: mark both as used by this spawn.
      const usedAt = new Date(now());
      utimesSync(paths.localWorkspaceDir, usedAt, usedAt);
      utimesSync(paths.localPlatformDir, usedAt, usedAt);

      const networkName = await resolveNetworkName();
      // S11 W1a: read right before the create, which binds the same file into the container.
      const modelsConfigDigest = readModelsConfigDigest(config);
      const spec = buildTaskSpawnSpec({
        config,
        taskId,
        workerRunId,
        workspaceId,
        image,
        model,
        networkName,
        egressDeny,
        egressDenyAll,
        correlationId,
        upstream,
      });
      // Only what the spec builder accepted (a valid id) is remembered and registered.
      const acceptedCorrelationId = spec.labels[TASK_CORRELATION_ID_LABEL];
      const denyAll = egressDenyAll === true;
      let created: ContainerState;
      try {
        created = await docker.createAndStart(spec);
      } catch (err) {
        // L6-18 (docs/code-review-2026-10-02.md, R-09): the create can succeed and the start (or
        // the inspect after it) fail. That leaves a container that is never registered below, so nothing here would ever stop or remove it — Task
        // container names are per-WorkerRun and never reused. Force-remove it (best-effort; a
        // container that was never created is a no-op) before the spawn error propagates.
        try {
          await docker.remove(spec.name);
        } catch (removeErr) {
          console.error(
            JSON.stringify({
              level: 'warn',
              msg: 'task container removal failed after a failed spawn',
              workerRunId,
              error: String(removeErr),
            }),
          );
        }
        throw err;
      }
      // The Worker's Handle is bound to its address before this call returns (handle-bindings.ts)
      // — never put in its environment. No binding means a Worker that cannot call anything, and
      // an address another running container still holds is refused (`bindExclusive`), so a
      // failure here removes the container and fails the spawn, like a failed start above.
      try {
        if (!created.ip) throw new Error('the container has no address on the workers network');
        await bindExclusive(
          handleBindings,
          created.ip,
          {
            handle: capabilityHandle,
            sourceId: taskSourceId(workspaceId, workerRunId),
            containerId: created.id,
          },
          isAt,
        );
      } catch (err) {
        try {
          await docker.remove(spec.name);
        } catch (removeErr) {
          console.error(
            JSON.stringify({
              level: 'warn',
              msg: 'task container removal failed after a failed handle binding',
              workerRunId,
              error: String(removeErr),
            }),
          );
        }
        throw new Error(`binding the Worker's Handle failed: ${String(err)}`);
      }

      // S10 E3-2-0: an evaluation run's deny-all entry is written right after its Handle binding
      // (which has just proved the address is this container's, so no other container's entry
      // is overwritten). A run whose entry can't be written doesn't start: its Handle is unbound
      // and the container removed, as for a failed binding.
      if (
        denyAll &&
        !registerEgress(
          workspaceId,
          workerRunId,
          created.ip,
          egressDeny,
          acceptedCorrelationId,
          true,
        )
      ) {
        try {
          handleBindings.unbind(created.ip as string, created.id);
        } catch (unbindErr) {
          console.error(
            JSON.stringify({
              level: 'error',
              msg: 'task handle unbinding failed after a failed deny-all egress registration',
              workerRunId,
              error: String(unbindErr),
            }),
          );
        }
        try {
          await docker.remove(spec.name);
        } catch (removeErr) {
          console.error(
            JSON.stringify({
              level: 'warn',
              msg: 'task container removal failed after a failed deny-all egress registration',
              workerRunId,
              error: String(removeErr),
            }),
          );
        }
        throw new Error("writing the evaluation run's deny-all egress entry failed");
      }

      registry.set(workerRunId, {
        taskId,
        workspaceId,
        containerId: created.id,
        ip: created.ip,
        startedAt: created.startedAt,
        timeoutAt: now() + (timeoutSec ?? config.taskMaxRuntimeSec) * 1000,
        state: 'running',
        exitCode: undefined,
        finishedAt: undefined,
        reason: undefined,
        terminating: false,
        correlationId: acceptedCorrelationId,
      });
      if (!denyAll) {
        registerEgress(workspaceId, workerRunId, created.ip, egressDeny, acceptedCorrelationId);
      }

      return {
        containerId: created.id,
        ip: created.ip,
        runtime: taskRuntimeReport(image, created, modelsConfigDigest),
      };
    },

    async terminate(workerRunId: string): Promise<boolean> {
      const entry = registry.get(workerRunId);
      if (!entry) return false;
      if (entry.state !== 'running') return true; // idempotent — already terminal
      await terminateOne(workerRunId, entry, 'requested');
      return true;
    },

    async status(workerRunId: string): Promise<TaskStatus | undefined> {
      const entry = registry.get(workerRunId);
      if (!entry) return undefined;
      await reconcileOne(workerRunId, entry);
      return toStatus(workerRunId, entry);
    },

    async reconcile(): Promise<void> {
      const containers = await docker.listByLabel(TASK_ROLE_LABEL, TASK_ROLE_VALUE);
      for (const state of containers) {
        const taskId = state.labels[TASK_ID_LABEL];
        const workerRunId = state.labels[WORKER_RUN_ID_LABEL];
        const workspaceId = state.labels[TASK_WORKSPACE_LABEL];
        if (!taskId || !workerRunId || !workspaceId || registry.has(workerRunId)) continue;
        // A label is only as trustworthy as whoever set it: re-check the charset before this id
        // reaches a log line or the egress source map again (it was validated at spawn).
        const labelCorrelationId = state.labels[TASK_CORRELATION_ID_LABEL];
        const restoredCorrelationId = isValidCorrelationId(labelCorrelationId)
          ? labelCorrelationId
          : undefined;

        const entry: RegistryEntry = {
          taskId,
          workspaceId,
          containerId: state.id,
          ip: state.ip,
          startedAt: state.startedAt,
          // The original timeoutSec is not recoverable across a restart (never persisted — see
          // this module's doc comment) — re-arm the configured default from now rather than leave
          // a resurrected entry with no deadline at all.
          timeoutAt: now() + config.taskMaxRuntimeSec * 1000,
          state: state.running ? 'running' : state.exitCode === 0 ? 'exited' : 'failed',
          exitCode: state.exitCode,
          finishedAt: state.running ? undefined : new Date(now()).toISOString(),
          reason: undefined,
          terminating: false,
          correlationId: restoredCorrelationId,
        };
        registry.set(workerRunId, entry);
        // Restores the egress deny list this container was spawned with (TASK_EGRESS_DENY_LABEL)
        // — without this, a supervisor restart would re-register a still-running Task's source-map
        // entry with no deny list at all, silently widening its egress for the rest of its run
        // (never re-registered again — reap()/status() only reconcile *exit* state, not egress).
        // S10 E3-2-0: and a deny-all (evaluation) run's entry, from TASK_EGRESS_DENY_ALL_LABEL —
        // one that can't be re-written is terminated rather than left running without it.
        if (state.running) {
          const denyAll = state.labels[TASK_EGRESS_DENY_ALL_LABEL] === 'true';
          const registered = registerEgress(
            workspaceId,
            workerRunId,
            state.ip,
            splitEgressDenyLabel(state.labels[TASK_EGRESS_DENY_LABEL]),
            restoredCorrelationId,
            denyAll,
          );
          if (denyAll && !registered) {
            try {
              await terminateOne(workerRunId, entry, 'egress_registration_failed');
            } catch (err) {
              // Docker refused the stop: the run stays until its timeout's own terminate (whose
              // reason, `timeout`, then replaces this one). `terminateOne` already unbound its
              // Handle, and the failed write left the file as it was: the deny-all entry written at
              // spawn if the file still has it, else no entry, which egress-proxy denies
              // (EGRESS_DENY_UNKNOWN_SOURCE, on by default).
              console.error(
                JSON.stringify({
                  level: 'error',
                  msg: 'terminating a deny-all task without its egress entry failed',
                  workerRunId,
                  error: String(err),
                }),
              );
            }
          }
        }
      }
    },

    async reap(): Promise<void> {
      const cutoff = now();
      for (const [workerRunId, entry] of registry) {
        if (entry.state !== 'running') continue;
        if (entry.timeoutAt <= cutoff) {
          await terminateOne(workerRunId, entry, 'timeout');
        } else {
          await reconcileOne(workerRunId, entry);
        }
      }
    },

    async sweepRetention(): Promise<void> {
      const cutoffMs = config.taskWorkdirRetentionHours * 60 * 60 * 1000;
      const running = runningTaskIds();
      // A Task's platform directory (host-paths.ts) follows the same rule as its workspace,
      // swept on its own mtime so one left behind without its workspace still goes.
      sweepTaskDirs(localTaskWorkspacesRootDir(config), running, cutoffMs);
      sweepTaskDirs(localTaskPlatformRootDir(config), running, cutoffMs);
    },

    async keepTaskDirs(tasks): Promise<readonly TaskDirsKeepResult[]> {
      const running = runningTaskIds();
      const usedAt = new Date(now());
      return tasks.map((task) => {
        const state = upstreamFilesState(
          config,
          task.taskId,
          { workspaceId: task.workspaceId, goalRunId: task.goalRunId },
          running,
        );
        if (state === 'kept') {
          const paths = taskWorkspacePaths(config, task.taskId);
          try {
            utimesSync(paths.localWorkspaceDir, usedAt, usedAt);
            utimesSync(paths.localPlatformDir, usedAt, usedAt);
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'warn',
                msg: 'task dirs keep failed',
                taskId: task.taskId,
                error: String(err),
              }),
            );
            return { taskId: task.taskId, state: 'missing' as const };
          }
        }
        return { taskId: task.taskId, state };
      });
    },

    async notifyContainerExited(containerId: string, action: string): Promise<boolean> {
      const match = [...registry.entries()].find(
        ([, entry]) => entry.containerId === containerId && entry.state === 'running',
      );
      if (!match) return false;
      const [workerRunId, entry] = match;

      await reconcileOne(workerRunId, entry);
      // `reconcileOne` itself no-ops (leaves `entry.state === 'running'`) when Docker still
      // reports the container running — Docker's `kill` event fires when the signal is sent, not
      // once the process has actually died. Only report this event as "handled" once the
      // container is confirmed no longer running.
      if (entry.state === 'running') return false;

      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'task container exited (docker event)',
          workerRunId,
          containerId,
          action,
        }),
      );
      return true;
    },
  };
}
