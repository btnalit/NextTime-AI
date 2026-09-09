/**
 * resident-service: orchestrates entry-container lifecycle (docs/development-tasks.md S1.5a task
 * brief) on top of `DockerClient` (docker-client.ts) and `EgressMapStore` (egress-map.ts):
 * idempotent spawn (reuse a running container, recreate one that isn't), stop, status, per-Turn
 * `touch` for the idle-timeout sweep, and startup reconciliation. This is the one place that owns
 * the small in-memory registry (`lastTouchedAt` per principal, for the idle sweep, and the last
 * known IP, so `stop`/the idle sweep can unregister it from the egress source map even after
 * Docker has already released it from a stopped container's network settings) — everything that
 * must survive a supervisor restart (the container itself, and its `nexttime.restarts` count) is
 * kept on the container as a label instead, read back via `inspectByName`/`listByLabel`.
 *
 * `restarts` semantics (task brief acceptance: "docker kill 某用户入口容器后再发消息 ... restarts
 * incremented"): incremented whenever `spawn` finds a previous container for this principal that
 * is no longer running and has to create a new container id for it — whether that container
 * stopped because it crashed, was `docker kill`ed, or was stopped by this service's own idle
 * sweep or an explicit `/resident/stop`. Distinguishing "crashed" from "we stopped it on purpose"
 * would need extra state that doesn't survive a supervisor restart either, and the task's own
 * acceptance criterion only exercises the crash path — so this is deliberately the simplest
 * design that satisfies it, not an oversight; see the PR body "假设与偏离". Also incremented by
 * the Handle-rotation case below — a healthy, still-running container replaced on purpose is the
 * same "new container id for this principal" event `restarts` was already tracking.
 *
 * **Handle rotation** (lane-6 review P2-5): an entry Handle is never re-issued into an already-
 * running resident container — the container keeps whatever `CAPABILITY_HANDLE` it was spawned
 * with in its env for as long as it lives, which combined with the 24h entry-Handle TTL
 * (`ENTRY_HANDLE_TTL_SECONDS`) and the 30-minute idle-stop meant a resident container that stayed
 * continuously busy past 24h would start getting 401s from `llm-proxy` on an expired Handle, and a
 * newly issued Grant (a capability added to the workspace's scope after the container was
 * spawned) would be invisible to it until the container happened to restart on its own. Every
 * `spawn` request now best-effort decodes the incoming Handle's `jti` (`handle-jti.ts` — no
 * verification, this process only cares whether it *changed*, not whether it's valid; validity is
 * llm-proxy's job per request) and compares it against the running container's own
 * `HANDLE_JTI_LABEL`: a mismatch means agent-host presented a Handle this container was never
 * spawned with, so `spawn` stops and recreates it (same shape as the crash-restart path below,
 * `restarts` incremented) instead of silently reusing a container holding a stale Handle.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { posix as posixPath } from 'node:path';
import type { SpawnRequest, SupervisorConfig, TaskSkillInline } from './config.js';
import type { DockerClient } from './docker-client.js';
import { entrySourceId } from './egress-map.js';
import type { EgressMapStore } from './egress-map.js';
import { decodeHandleJtiUnsafe } from './handle-jti.js';
import { localSystemPromptPath, workspacePaths } from './host-paths.js';
import {
  EGRESS_DENY_LABEL,
  ENTRY_ROLE_LABEL,
  ENTRY_ROLE_VALUE,
  HANDLE_JTI_LABEL,
  PRINCIPAL_LABEL,
  RESTARTS_LABEL,
  SKILLS_HASH_LABEL,
  WORKSPACE_LABEL,
  buildSpawnSpec,
  entryContainerName,
  hashSkillsInline,
} from './spawn-spec.js';

/** Splits `EGRESS_DENY_LABEL`'s comma-joined value back into a list — the inverse of
 *  `buildSpawnSpec`'s `(input.egressDeny ?? []).join(',')`. An empty/absent label (a container
 *  spawned before this field existed, or one whose WorkerDefinition declared no list) yields `[]`,
 *  which `registerEgress` below treats identically to `undefined` (no per-source deny list). */
function splitEgressDenyLabel(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STOP_TIMEOUT_SECONDS = 10;

export interface SpawnOutcome {
  readonly containerId: string;
  readonly ip: string | undefined;
  readonly status: string;
  readonly created: boolean;
  readonly restarts: number;
}

export interface ResidentStatus {
  readonly principalId: string;
  readonly containerId: string;
  readonly ip: string | undefined;
  readonly running: boolean;
  readonly status: string;
  readonly startedAt: string | undefined;
  readonly restarts: number;
  readonly lastTouchedAt: string | undefined;
}

interface RegistryEntry {
  workspaceId: string;
  containerId: string;
  ip: string | undefined;
  lastTouchedAt: number;
}

function restartsFromLabels(labels: Readonly<Record<string, string>>): number {
  const raw = labels[RESTARTS_LABEL];
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export interface ResidentServiceDeps {
  readonly config: SupervisorConfig;
  readonly docker: DockerClient;
  readonly egressMap: EgressMapStore;
  readonly now?: () => number;
}

export interface ResidentService {
  spawn(input: SpawnRequest): Promise<SpawnOutcome>;
  stop(principalId: string): Promise<void>;
  status(principalId: string): Promise<ResidentStatus | undefined>;
  /** Refreshes the idle clock for `principalId`. Returns `false` when the container isn't known
   *  (never spawned, or spawned by a supervisor instance that has since restarted and not yet
   *  reconciled — see `reconcile`). */
  touch(principalId: string): Promise<boolean>;
  /** Lists containers labelled `nexttime.role=entry`, re-registers each running one's IP with the
   *  egress source map, and seeds the idle-timeout registry — called once at startup (design doc
   *  §13 "agent-host 重启...事件桥重连"; the supervisor's own analogue for its egress registrations
   *  and idle clocks, which are both in-memory). feat/egress-docker-events: also called again after
   *  every docker-events reconnect (`index.ts`/`docker-events.ts`) — see its own doc comment for
   *  why that's safe to do repeatedly. */
  reconcile(): Promise<void>;
  /** Stops every resident container whose `lastTouchedAt` is older than `entryIdleTimeoutMs`
   *  (design doc §7.2 "空闲超时停容器"). Call on an interval — see `index.ts`. */
  sweepIdle(): Promise<void>;
  /** feat/egress-docker-events: called by `index.ts`'s docker-events subscriber for every
   *  container-lifecycle event (`die`/`destroy`/`kill`/`stop`) matching the platform's own label
   *  filter — see `docker-events.ts`'s module doc comment. `containerId` is Docker's own event
   *  `Actor.ID` (full container id), matched against this service's in-memory registry the same
   *  way `spawn()`'s own crash-detection path already does. Re-inspects the container before
   *  treating it as gone: Docker's `kill` event fires when the signal is *sent*, not once the
   *  process has actually died (`docker stop`'s graceful SIGTERM can take up to
   *  `STOP_TIMEOUT_SECONDS` before the container truly exits) — unregistering egress and dropping
   *  the registry entry at that point would fail-close a container that's still legitimately
   *  running mid-Turn, with no recovery path (`touch()`'s own recovery path re-registers the
   *  registry entry but never re-registers egress). Idempotent: a container can emit `kill` → `die`
   *  → `destroy`/`stop` for one exit, and this returns `false` on every call after the first that
   *  actually unregisters it (or for a container this instance never knew about). Returns `true`
   *  only when it actually unregistered a known, now-confirmed-not-running container. */
  notifyContainerExited(containerId: string, action: string): Promise<boolean>;
}

export function createResidentService(deps: ResidentServiceDeps): ResidentService {
  const { config, docker, egressMap } = deps;
  const now = deps.now ?? (() => Date.now());
  const registry = new Map<string, RegistryEntry>();
  let cachedNetworkName: string | undefined;

  async function resolveNetworkName(): Promise<string> {
    if (cachedNetworkName) return cachedNetworkName;
    cachedNetworkName = await docker.resolveNetworkByComposeLabel('workers', config.networkWorkers);
    return cachedNetworkName;
  }

  // Best-effort: a broken SOURCE_MAP_FILE (missing, wrong ownership/permissions on the host —
  // host verification hit exactly this) must never fail a spawn/stop. The entry container being
  // usable matters far more than egress attribution for that one source; this matches how the
  // rest of the platform treats egress/usage reporting as best-effort elsewhere (e.g.
  // @nexttime/llm-proxy's usage reporter, @nexttime/egress-proxy's own reporter — both queue and
  // retry rather than block their caller).
  function registerEgress(
    workspaceId: string,
    principalId: string,
    ip: string | undefined,
    egressDeny?: readonly string[],
  ): void {
    if (!ip) return;
    try {
      egressMap.register(ip, {
        sourceId: entrySourceId(workspaceId, principalId),
        // Omit `deny` entirely when there is nothing to narrow — keeps the SOURCE_MAP_FILE entry
        // byte-for-byte identical to before this field existed for the common "no list" case,
        // rather than writing a needless `"deny": []`.
        ...(egressDeny && egressDeny.length > 0 ? { deny: egressDeny } : {}),
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'egress registration failed (spawn still succeeds)',
          principalId,
          ip,
          error: String(err),
        }),
      );
    }
  }

  function unregisterEgress(ip: string | undefined): void {
    if (!ip) return;
    try {
      egressMap.unregister(ip);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'egress unregistration failed (stop still succeeds)',
          ip,
          error: String(err),
        }),
      );
    }
  }

  // S2.6: writes/overwrites `/workspace/.nexttime/system-prompt.md` (host-paths.ts
  // `localSystemPromptPath`) before every spawn — both the create and the reuse-a-running-
  // container paths, so a workspace's *next* restart always picks up the current published entry
  // WorkerDefinition's prompt even when this particular call only reuses an already-running
  // container (writing to the file has no effect on a container pi already started). Best-effort,
  // same convention as `registerEgress`/`unregisterEgress` above and this package's own S1.5a
  // precedent (egress registration must never fail a spawn): a broken/unwritable workspace
  // directory must not block the entry container from coming up — `entrypoint.sh`'s own
  // write-if-missing static fallback still applies if this never succeeds. Only writes when
  // `systemPrompt` is given and differs from what's already on disk, so a spawn call carrying no
  // `systemPrompt` (or with the caller's own file byte-for-byte in place) is a cheap read + no-op,
  // not a needless write.
  function writeSystemPromptIfChanged(principalId: string, systemPrompt: string | undefined): void {
    if (systemPrompt === undefined) return;
    const filePath = localSystemPromptPath(config, principalId);
    try {
      let existing: string | undefined;
      try {
        existing = readFileSync(filePath, 'utf8');
      } catch {
        existing = undefined;
      }
      if (existing === systemPrompt) return;
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, systemPrompt, 'utf8');
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'system-prompt.md write failed (spawn still succeeds; entrypoint.sh’s static fallback applies)',
          principalId,
          error: String(err),
        }),
      );
    }
  }

  /**
   * S3.13: writes every `skillsInline[]` entry's files under `<agentDir>/skills/<name>/` — the
   * same layout `task-service.ts`'s own `spawn()` already writes for Task mode. Only ever called
   * from the (re)create branch below, never on a plain reuse: a Skill-set change is exactly what
   * forces the recreate in the first place (`SKILLS_HASH_LABEL`'s own comparison, see `spawn()`),
   * so a reused container's already-mounted `skills/` directory is, by construction, still the
   * correct set — writing again there would be a needless no-op at best.
   *
   * Clears the whole `skills/` subdirectory first — unlike Task mode's always-fresh workspace, a
   * resident entry container's workspace directory persists across recreations, so a Skill
   * removed from the caller's AgentProfile must not linger on disk merely because its own
   * directory was never deleted (S3.13's own "never widen" invariant applies here too: a
   * container must never end up mounting a Skill the caller's current AgentProfile no longer
   * selects). Best-effort, same convention as `writeSystemPromptIfChanged` above — a broken/
   * unwritable workspace directory must never block the entry container from coming up.
   */
  function writeSkillsInline(principalId: string, skillsInline: readonly TaskSkillInline[]): void {
    const paths = workspacePaths(config, principalId);
    const skillsDir = posixPath.join(paths.localPiAgentDir, 'skills');
    try {
      rmSync(skillsDir, { recursive: true, force: true });
      for (const skill of skillsInline) {
        const skillDir = posixPath.join(skillsDir, skill.name);
        for (const [fileName, content] of Object.entries(skill.files)) {
          const filePath = posixPath.join(skillDir, fileName);
          mkdirSync(path.dirname(filePath), { recursive: true });
          writeFileSync(filePath, content, 'utf8');
        }
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'skills/ write failed (spawn still succeeds; the entry container mounts whatever skills/ already contains)',
          principalId,
          error: String(err),
        }),
      );
    }
  }

  return {
    async spawn(input): Promise<SpawnOutcome> {
      const {
        workspaceId,
        principalId,
        handle,
        kernelUrl,
        llmUrl,
        systemPrompt,
        model,
        egressDeny,
        skillsInline,
      } = input;
      const name = entryContainerName(principalId);
      const paths = workspacePaths(config, principalId);

      // The supervisor's own container runs as uid:gid 10001 (Dockerfile `USER nexttime`,
      // matching every other @nexttime/* image) — a directory this process creates is therefore
      // already owned by that uid, satisfying I15 ("only that user's dir") without a separate
      // chown step. localPiAgentDir must be pre-created here too (not left for Docker or
      // entrypoint.sh) — see its doc comment in host-paths.ts for why: Docker auto-creating it
      // as root (as the parent of the models.json bind-mount target) would block the non-root
      // entry container from creating its sibling `.pi/sessions`.
      mkdirSync(paths.localWorkspaceDir, { recursive: true });
      mkdirSync(paths.localPiAgentDir, { recursive: true });

      // S2.6: before deciding reuse-vs-(re)create, so the file is current for whichever the
      // container actually loads at its *next* start (see this function's own doc comment above).
      writeSystemPromptIfChanged(principalId, systemPrompt);

      const existing = await docker.inspectByName(name);

      // Handle rotation (P2-5, see this module's own doc comment): a mismatch between the
      // incoming Handle's jti and the running container's own label means this container was
      // spawned with a Handle that is no longer the caller's current one — reuse must not apply.
      // `existingJti` empty/absent (older container predating this label, or a decode failure at
      // spawn time) never forces a recreation on its own — only an actual, decodable mismatch does.
      const incomingJti = decodeHandleJtiUnsafe(handle);
      const existingJti = existing?.labels[HANDLE_JTI_LABEL];
      const handleRotated = Boolean(
        existing && incomingJti !== undefined && existingJti && existingJti !== incomingJti,
      );

      // S3.13: same shape as the Handle-rotation check above — a mismatch between the incoming
      // `skillsInline` set's own digest and the running container's `SKILLS_HASH_LABEL` means the
      // caller's effective.enabledSkills has changed since this container was (re)created, and
      // pi only loads Skills at startup, so reuse must not apply here either.
      const incomingSkillsHash = hashSkillsInline(skillsInline ?? []);
      const existingSkillsHash = existing?.labels[SKILLS_HASH_LABEL] ?? '';
      const skillsChanged = Boolean(existing && existingSkillsHash !== incomingSkillsHash);

      const rotated = handleRotated || skillsChanged;

      if (existing?.running && !rotated) {
        registry.set(principalId, {
          workspaceId,
          containerId: existing.id,
          ip: existing.ip,
          lastTouchedAt: now(),
        });
        // Refreshed on every reuse (not just a fresh spawn) so a WorkerDefinition's egress list
        // published *after* this container started still takes effect immediately, without
        // waiting for the container itself to restart — see registerEgress's own doc comment.
        registerEgress(workspaceId, principalId, existing.ip, egressDeny);
        return {
          containerId: existing.id,
          ip: existing.ip,
          status: existing.status,
          created: false,
          restarts: restartsFromLabels(existing.labels),
        };
      }

      const restarts = existing ? restartsFromLabels(existing.labels) + 1 : 0;
      if (existing) {
        if (existing.running) {
          // Rotation while otherwise healthy — retire it gracefully (same timeout an explicit
          // /resident/stop uses) rather than force-killing outright.
          await docker.stop(name, STOP_TIMEOUT_SECONDS);
          unregisterEgress(existing.ip);
        } else {
          // Crash path (lane-6 review P2-7's IP-reuse-misattribution concern, resident-mode half):
          // Docker already clears `ip` once a container isn't running (`ContainerState.ip`'s own
          // doc comment), so `existing.ip` is `undefined` here — the only place that still knows
          // what this principal's now-dead container was last registered under is this service's
          // own in-memory `registry`, untouched since the crash (nothing else evicts it before the
          // next successful spawn or an explicit stop/idle-sweep). Unregistering it *here*, the
          // moment a crash is actually noticed, closes the window during which a Docker-assigned
          // IP reuse could otherwise get a different container's egress mis-attributed to this
          // principal — rather than leaving the stale entry in place for up to a full
          // `entryIdleTimeoutMs` (idle-sweep is the only other thing that would ever clear it).
          unregisterEgress(registry.get(principalId)?.ip);
        }
        await docker.remove(name);
      }

      // S3.13: written only in this (re)create branch — see writeSkillsInline's own doc comment
      // for why a plain reuse above never needs it.
      writeSkillsInline(principalId, skillsInline ?? []);

      const networkName = await resolveNetworkName();
      const spec = buildSpawnSpec({
        config,
        workspaceId,
        principalId,
        handle,
        kernelUrl,
        llmUrl,
        networkName,
        restarts,
        model,
        handleJti: incomingJti,
        egressDeny,
        skillsHash: incomingSkillsHash,
      });
      const created = await docker.createAndStart(spec);

      registry.set(principalId, {
        workspaceId,
        containerId: created.id,
        ip: created.ip,
        lastTouchedAt: now(),
      });
      registerEgress(workspaceId, principalId, created.ip, egressDeny);

      return {
        containerId: created.id,
        ip: created.ip,
        status: created.status,
        created: true,
        restarts,
      };
    },

    async stop(principalId: string): Promise<void> {
      const name = entryContainerName(principalId);
      const entry = registry.get(principalId);
      const existing = entry ? undefined : await docker.inspectByName(name);
      const ip = entry?.ip ?? existing?.ip;

      await docker.stop(name, STOP_TIMEOUT_SECONDS);
      unregisterEgress(ip);
      registry.delete(principalId);
    },

    async status(principalId: string): Promise<ResidentStatus | undefined> {
      const name = entryContainerName(principalId);
      const state = await docker.inspectByName(name);
      if (!state) return undefined;

      const entry = registry.get(principalId);
      return {
        principalId,
        containerId: state.id,
        ip: state.ip,
        running: state.running,
        status: state.status,
        startedAt: state.startedAt,
        restarts: restartsFromLabels(state.labels),
        lastTouchedAt: entry ? new Date(entry.lastTouchedAt).toISOString() : undefined,
      };
    },

    async touch(principalId: string): Promise<boolean> {
      const existing = registry.get(principalId);
      if (existing) {
        existing.lastTouchedAt = now();
        return true;
      }

      // Recovery path: this supervisor process doesn't remember this principal (e.g. it
      // restarted since the container was spawned) but the container itself is still there.
      const name = entryContainerName(principalId);
      const state = await docker.inspectByName(name);
      if (!state?.running) return false;

      const workspaceId = state.labels[WORKSPACE_LABEL] ?? '';
      registry.set(principalId, {
        workspaceId,
        containerId: state.id,
        ip: state.ip,
        lastTouchedAt: now(),
      });
      return true;
    },

    async reconcile(): Promise<void> {
      const containers = await docker.listByLabel(ENTRY_ROLE_LABEL, ENTRY_ROLE_VALUE);
      for (const state of containers) {
        const principalId = state.labels[PRINCIPAL_LABEL];
        const workspaceId = state.labels[WORKSPACE_LABEL];
        if (!principalId || !workspaceId) continue;

        if (state.running) {
          registry.set(principalId, {
            workspaceId,
            containerId: state.id,
            ip: state.ip,
            // feat/egress-docker-events: preserve an already-known principal's existing idle
            // clock rather than unconditionally resetting it to `now()` — this method used to run
            // only once, at process startup (an empty registry, so this branch was always a first
            // write). It now also re-runs after every docker-events reconnect
            // (`docker-events.ts`'s own doc comment), and a flapping proxy connection reconnecting
            // every few seconds would otherwise keep refreshing every running container's
            // `lastTouchedAt` forever, silently disabling `sweepIdle()` for as long as the
            // flapping continues. A genuine restart still starts from an empty registry, so this
            // branch behaves exactly as before in that case.
            lastTouchedAt: registry.get(principalId)?.lastTouchedAt ?? now(),
          });
          // Restores the egress deny list this container was (re)created with (EGRESS_DENY_LABEL)
          // — without this, a supervisor restart would re-register every still-running entry
          // container's source-map entry with no deny list at all, silently widening its egress
          // until its next startTurn (see EGRESS_DENY_LABEL's own doc comment).
          registerEgress(
            workspaceId,
            principalId,
            state.ip,
            splitEgressDenyLabel(state.labels[EGRESS_DENY_LABEL]),
          );
        }
      }
    },

    async sweepIdle(): Promise<void> {
      const cutoff = now() - config.entryIdleTimeoutMs;
      const idle = [...registry.entries()].filter(([, entry]) => entry.lastTouchedAt < cutoff);
      for (const [principalId, entry] of idle) {
        const name = entryContainerName(principalId);
        await docker.stop(name, STOP_TIMEOUT_SECONDS);
        unregisterEgress(entry.ip);
        registry.delete(principalId);
      }
    },

    async notifyContainerExited(containerId: string, action: string): Promise<boolean> {
      const match = [...registry.entries()].find(([, entry]) => entry.containerId === containerId);
      if (!match) return false;
      const [principalId, entry] = match;

      // Docker's `kill` event fires when the signal is sent, not once the container has actually
      // exited — see this method's own doc comment. Re-inspect rather than trust the event alone;
      // `state === undefined` (404, e.g. after a `destroy` following `docker rm`) counts as "not
      // running" just like `state.running === false`.
      const state = await docker.inspectByName(entryContainerName(principalId));
      if (state?.running) return false;

      unregisterEgress(entry.ip);
      registry.delete(principalId);
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'resident container exited (docker event)',
          principalId,
          containerId,
          action,
        }),
      );
      return true;
    },
  };
}
