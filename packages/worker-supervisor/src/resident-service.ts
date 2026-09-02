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
 * design that satisfies it, not an oversight; see the PR body "假设与偏离".
 */

import { mkdirSync } from 'node:fs';
import type { SpawnRequest, SupervisorConfig } from './config.js';
import type { DockerClient } from './docker-client.js';
import { entrySourceId } from './egress-map.js';
import type { EgressMapStore } from './egress-map.js';
import { workspacePaths } from './host-paths.js';
import {
  ENTRY_ROLE_LABEL,
  ENTRY_ROLE_VALUE,
  PRINCIPAL_LABEL,
  RESTARTS_LABEL,
  WORKSPACE_LABEL,
  buildSpawnSpec,
  entryContainerName,
} from './spawn-spec.js';

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
   *  and idle clocks, which are both in-memory). */
  reconcile(): Promise<void>;
  /** Stops every resident container whose `lastTouchedAt` is older than `entryIdleTimeoutMs`
   *  (design doc §7.2 "空闲超时停容器"). Call on an interval — see `index.ts`. */
  sweepIdle(): Promise<void>;
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
  function registerEgress(workspaceId: string, principalId: string, ip: string | undefined): void {
    if (!ip) return;
    try {
      egressMap.register(ip, { sourceId: entrySourceId(workspaceId, principalId) });
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

  return {
    async spawn(input): Promise<SpawnOutcome> {
      const { workspaceId, principalId, handle, kernelUrl, llmUrl } = input;
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

      const existing = await docker.inspectByName(name);

      if (existing?.running) {
        registry.set(principalId, {
          workspaceId,
          containerId: existing.id,
          ip: existing.ip,
          lastTouchedAt: now(),
        });
        registerEgress(workspaceId, principalId, existing.ip);
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
        await docker.remove(name);
      }

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
      });
      const created = await docker.createAndStart(spec);

      registry.set(principalId, {
        workspaceId,
        containerId: created.id,
        ip: created.ip,
        lastTouchedAt: now(),
      });
      registerEgress(workspaceId, principalId, created.ip);

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
            lastTouchedAt: now(),
          });
          registerEgress(workspaceId, principalId, state.ip);
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
  };
}
