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
 * **`skillsInline` (S2.14)**: unlike `skills[]` (a host path this process bind-mounts read-only),
 * `skillsInline[]` carries file *content* — the kernel has no writable data mount of its own to
 * stage a host path from (I9-adjacent). `spawn()` below writes every entry's files directly under
 * this Task's own `<agentDir>/skills/<name>/` before calling `docker.createAndStart` — no new bind
 * mount, the whole Task workspace directory is already mounted at `/workspace`. Validated
 * structurally by `config.ts`'s `TaskSkillInlineSchema` (safe names/paths, per-file and total size
 * caps) before this function ever sees it.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { posix as posixPath } from 'node:path';
import type { SupervisorConfig } from './config.js';
import type { TaskSkillInline } from './config.js';
import type { DockerClient } from './docker-client.js';
import { taskSourceId } from './egress-map.js';
import type { EgressMapStore } from './egress-map.js';
import { localTaskWorkspacesRootDir, taskWorkspacePaths } from './host-paths.js';
import {
  TASK_ID_LABEL,
  TASK_ROLE_LABEL,
  TASK_ROLE_VALUE,
  TASK_WORKSPACE_LABEL,
  WORKER_RUN_ID_LABEL,
  buildTaskSpawnSpec,
  taskContainerName,
} from './task-spawn-spec.js';

/** Shorter than resident mode's `STOP_TIMEOUT_SECONDS` (10s, `resident-service.ts`) — a one-shot
 *  Worker being terminated (explicit request or timeout) should be reaped promptly; there is no
 *  user waiting on a graceful shutdown the way a resident entry container's occupant might be. */
const TERMINATE_STOP_TIMEOUT_SECONDS = 5;

export type TaskState = 'running' | 'exited' | 'terminated' | 'failed';

export interface TaskSkillMount {
  readonly name: string;
  readonly hostPath: string;
}

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
  readonly skills?: readonly TaskSkillMount[];
  /** Skills mounted by content, not a host path (S2.14) — written to disk by `spawn()` itself
   *  before the container starts, see this module's own doc comment's addition below. */
  readonly skillsInline?: readonly TaskSkillInline[];
  readonly timeoutSec?: number;
}

export interface TaskSpawnOutcome {
  readonly containerId: string;
  readonly ip: string | undefined;
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
}

export interface TaskServiceDeps {
  readonly config: SupervisorConfig;
  readonly docker: DockerClient;
  readonly egressMap: EgressMapStore;
  readonly now?: () => number;
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
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { config, docker, egressMap } = deps;
  const now = deps.now ?? (() => Date.now());
  const registry = new Map<string, RegistryEntry>();
  let cachedNetworkName: string | undefined;

  async function resolveNetworkName(): Promise<string> {
    if (cachedNetworkName) return cachedNetworkName;
    cachedNetworkName = await docker.resolveNetworkByComposeLabel('workers', config.networkWorkers);
    return cachedNetworkName;
  }

  // Best-effort, matching resident-service.ts's own registerEgress/unregisterEgress — a broken
  // SOURCE_MAP_FILE must never fail a spawn/terminate/reap.
  function registerEgress(workspaceId: string, workerRunId: string, ip: string | undefined): void {
    if (!ip) return;
    try {
      egressMap.register(ip, { sourceId: taskSourceId(workspaceId, workerRunId) });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'task egress registration failed (spawn still succeeds)',
          workerRunId,
          ip,
          error: String(err),
        }),
      );
    }
  }

  function unregisterEgress(workerRunId: string, ip: string | undefined): void {
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
    entry.state = entry.terminating ? 'terminated' : entry.exitCode === 0 ? 'exited' : 'failed';
    unregisterEgress(workerRunId, entry.ip);

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
    await docker.stop(taskContainerName(workerRunId), TERMINATE_STOP_TIMEOUT_SECONDS);
    await reconcileOne(workerRunId, entry);
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
        skills,
        skillsInline,
        timeoutSec,
      } = input;
      const paths = taskWorkspacePaths(config, taskId);

      // Same rationale as resident-service.ts's own pre-creation of localPiAgentDir: this process
      // also runs as uid 10001, so a directory it creates here is already correctly owned,
      // avoiding Docker auto-creating `.pi/` as root while preparing the models.json bind-mount
      // (which would then block the non-root Worker container from creating sibling directories
      // under it).
      mkdirSync(paths.localWorkspaceDir, { recursive: true });
      mkdirSync(paths.localPiAgentDir, { recursive: true });

      // S2.14: write every `skillsInline[]` entry's files under this container's own local view
      // of `<agentDir>/skills/<name>/` (same target directory `taskSkillTargetInContainer` mounts
      // the host-path variant to) — the whole Task workspace is already bind-mounted at
      // `/workspace`, so no new bind mount is needed, only the write happening *before*
      // `docker.createAndStart` below.
      for (const skill of skillsInline ?? []) {
        const skillDir = posixPath.join(paths.localPiAgentDir, 'skills', skill.name);
        for (const [fileName, content] of Object.entries(skill.files)) {
          const filePath = posixPath.join(skillDir, fileName);
          mkdirSync(posixPath.dirname(filePath), { recursive: true });
          writeFileSync(filePath, content, 'utf8');
        }
      }

      const networkName = await resolveNetworkName();
      const spec = buildTaskSpawnSpec({
        config,
        taskId,
        workerRunId,
        workspaceId,
        capabilityHandle,
        image,
        model,
        skills,
        networkName,
      });
      const created = await docker.createAndStart(spec);

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
      });
      registerEgress(workspaceId, workerRunId, created.ip);

      return { containerId: created.id, ip: created.ip };
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

        registry.set(workerRunId, {
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
        });
        if (state.running) registerEgress(workspaceId, workerRunId, state.ip);
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
      const root = localTaskWorkspacesRootDir(config);
      let taskDirs: string[];
      try {
        taskDirs = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        return; // nothing to sweep yet — the root doesn't exist until the first spawn
      }

      const cutoffMs = config.taskWorkdirRetentionHours * 60 * 60 * 1000;
      const runningTaskIds = new Set(
        [...registry.values()].filter((e) => e.state === 'running').map((e) => e.taskId),
      );

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
    },
  };
}
