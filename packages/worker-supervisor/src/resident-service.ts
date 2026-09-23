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
import type { DockerClient, RuntimeImageInfo } from './docker-client.js';
import { IMAGE_PI_VERSION_LABEL } from './docker-client.js';
import { entrySourceId } from './egress-map.js';
import type { EgressMapStore, SourceMapFile } from './egress-map.js';
import { decodeHandleJtiUnsafe } from './handle-jti.js';
import { localSystemPromptPath, workspacePaths } from './host-paths.js';
import {
  EGRESS_DENY_LABEL,
  ENTRY_ROLE_LABEL,
  ENTRY_ROLE_VALUE,
  HANDLE_JTI_LABEL,
  IMAGE_LABEL,
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

/** The `deny` list currently registered in SOURCE_MAP_FILE for `ip`, but only when its own
 *  `sourceId` still matches `sourceId` — Docker can reassign a released IP to an unrelated
 *  container, and a stale leftover entry from that IP's previous occupant must never be
 *  attributed to this principal. Used by `reconcile()`'s union below (遗留22 /
 *  code-review-2026-09-10.md §3.5: EGRESS_DENY_LABEL only reflects the list a container was
 *  (re)created with, but a reuse call can change SOURCE_MAP_FILE past it without ever being able
 *  to update the label). */
function registeredDenyFor(
  map: SourceMapFile,
  ip: string | undefined,
  sourceId: string,
): readonly string[] {
  if (!ip) return [];
  const entry = map[ip];
  return entry && entry.sourceId === sourceId ? (entry.deny ?? []) : [];
}

/** Order-independent equality for two egressDeny lists — 遗留22 / code-review-2026-09-10.md
 *  §3.5: `spawn()`'s reuse-drift check needs "did the set change at all", not "did it grow",
 *  since a persistent divergence in *either* direction (tightened or loosened) must eventually
 *  re-stamp EGRESS_DENY_LABEL. */
function egressDenySetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((entry) => bSet.has(entry));
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

/** S7-E (P-C §6.5 "入口容器列表（用户、工作区、镜像 digest、启动时间、是否空闲）"): one row of `GET
 *  /residents` — raw facts only. Whether a container "待重建" is derived by the *kernel*
 *  (`runtime_inventory`), not here: this process knows the platform's own active-image setting
 *  never (that lives in `platform_settings`, which only the kernel reads), so it can only ever
 *  report what a container *is*, never whether it matches what it *should* be. */
export interface ResidentInventoryEntry {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly containerId: string;
  readonly running: boolean;
  readonly status: string;
  /** The image reference this container was last (re)created with (`IMAGE_LABEL`) — `undefined`
   *  for a container predating this label. */
  readonly image: string | undefined;
  /** This container's own resolved image id (`ContainerState.imageId`) — `undefined` when not
   *  running (Docker releases it, same convention `ip` already follows). */
  readonly imageId: string | undefined;
  readonly startedAt: string | undefined;
  readonly lastTouchedAt: string | undefined;
}

interface RegistryEntry {
  workspaceId: string;
  containerId: string;
  ip: string | undefined;
  lastTouchedAt: number;
  /** 遗留22 / code-review-2026-09-10.md §3.5: the `egressDeny` a `spawn()` create-or-reuse call
   *  for this principal last actually applied — deliberately **not** re-derived from
   *  SOURCE_MAP_FILE, because `reconcile()` also writes that file (its own label ∪ file union,
   *  see that method below) and would otherwise erase the very drift signal `spawn()`'s own
   *  `egressDenyDrifted` check needs: a reconnect landing between two reuses must not make the
   *  second reuse think nothing diverged. `undefined` means "this process has no record" (never
   *  spawned this principal, or spawned by an instance that has since restarted) — deliberately
   *  distinct from "recorded as no list", so a post-restart `reconcile()`/`touch()` recovery path
   *  never manufactures a false drift out of an empty registry. `reconcile()`'s own registry.set
   *  (below) preserves whatever is already here rather than clearing it — reconciling a
   *  container's idle clock says nothing about what was last *published* for it. */
  lastAppliedEgressDeny?: readonly string[];
}

function restartsFromLabels(labels: Readonly<Record<string, string>>): number {
  const raw = labels[RESTARTS_LABEL];
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export interface ResidentServiceDeps {
  readonly config: SupervisorConfig;
  readonly docker: DockerClient;
  /** v0.16.2 (fix/supervisor-images-proxy): the read-only `DockerClient` `listImages()` below
   *  calls, pointed at `config.dockerImagesConnection` (`docker-socket-proxy-images`, `IMAGES=1`
   *  only) instead of `docker` above's `config.dockerConnection` (`docker-socket-proxy`,
   *  `IMAGES=0`) — see `config.ts`'s `dockerImagesConnection` doc comment for why they're
   *  deliberately two different proxy instances. Optional and defaults to `docker` so every
   *  existing caller (this package's own tests, and any future non-compose run that only ever
   *  configures one Docker connection) keeps working unchanged — only `index.ts`'s real wiring
   *  passes a genuinely distinct client. */
  readonly imagesDocker?: DockerClient;
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
  /** S7-E: `GET /residents` — every entry container across every workspace, raw facts (see
   *  `ResidentInventoryEntry`'s own doc comment for why no "待重建" field lives here). */
  list(): Promise<ResidentInventoryEntry[]>;
  /** S7-E: `GET /images` — every image carrying the platform's `ai.nexttime.pi-version` label
   *  (`docker-client.ts`'s `IMAGE_PI_VERSION_LABEL`), plus this process's own `config.workerImage`
   *  (`defaultImage`) — the kernel has no other way to learn worker-supervisor's actual configured
   *  default (the two processes only ever talk over HTTP), and a host may set `WORKER_IMAGE` away
   *  from the image's own build-time default name. */
  listImages(): Promise<RuntimeImageInventory>;
}

/** S7-E: `GET /images`'s full response — see `ResidentService.listImages`'s own doc comment for
 *  why `defaultImage` travels alongside the image list rather than being a kernel-side guess.
 *  `allowedImages` (P1-a hotfix, post-v0.16.0 review): `config.taskImageAllowlist` verbatim — the
 *  exact static, additive allowlist `isImageAllowed`/`/task/spawn`/`/resident/spawn` already
 *  enforce (`config.ts`). Before this field existed, the kernel's `set_active_runtime_image` only
 *  checked an image appeared in `images` (built), not that it was allowlisted — a non-allowlisted
 *  active image 403s every future spawn platform-wide, discovered only once a Worker/entry
 *  container tries to start. Exposing the same list here lets the kernel reject that target up
 *  front, one security boundary (env-configured allowlist), never re-implemented kernel-side. */
export interface RuntimeImageInventory {
  readonly defaultImage: string;
  readonly images: RuntimeImageInfo[];
  readonly allowedImages: readonly string[];
}

export function createResidentService(deps: ResidentServiceDeps): ResidentService {
  const { config, docker, egressMap } = deps;
  const imagesDocker = deps.imagesDocker ?? docker;
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

  // 遗留22 / code-review-2026-09-10.md §3.5: best-effort, same convention as
  // registerEgress/unregisterEgress above — reading SOURCE_MAP_FILE to find an egressDeny
  // tightening an earlier reuse already applied (registeredDenyFor's own doc comment) must never
  // fail a spawn/reconcile. A read failure falls back to `{}`, i.e. both callers below behave as
  // if nothing had been registered yet — the same as before this fix existed.
  function readEgressMap(): SourceMapFile {
    try {
      return egressMap.read();
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'egress source-map read failed (egressDeny reconciliation best-effort skipped)',
          error: String(err),
        }),
      );
      return {};
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
      // S7-E (P-C §6.5 决定 E1): resolved once, at the top — every use below (the drift check, the
      // (re)create spec, the returned/stamped label) reads this one value, matching how `handle`/
      // `skillsInline` are already destructured once rather than re-read from `input`.
      const image = input.image ?? config.workerImage;

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

      // S7-E (P-C §6.5 决定 E1/E2): same shape again — a mismatch between the resolved `image`
      // this call requests and the running container's own `IMAGE_LABEL` means the platform's
      // active runtime image changed since this container was (re)created, and Docker cannot swap
      // a running container's image out from under it, so reuse must not apply. `existingImage`
      // empty/absent (a container predating this label) never forces a recreate on its own — only
      // an actual, observed mismatch does, matching `handleRotated`/`skillsChanged`'s own "unknown
      // never rotates" convention.
      const existingImage = existing?.labels[IMAGE_LABEL];
      const imageChanged = Boolean(existing && existingImage && existingImage !== image);

      // 遗留22 / code-review-2026-09-10.md §3.5: EGRESS_DENY_LABEL only ever reflects the list
      // this container was (re)created with — an *earlier* reuse call's own `registerEgress`
      // below (unconditional on every reuse, so a newly published list takes effect without
      // waiting for a restart) may already have applied a list the label itself could never
      // catch up to (Docker can't relabel a running container). Left alone, that gap would linger
      // until some unrelated recreate happened to close it. This compares that earlier reuse's
      // own last-applied list (`RegistryEntry.lastAppliedEgressDeny` — its own doc comment has
      // why this reads the in-memory registry and not SOURCE_MAP_FILE) against the label
      // *before* this call's own apply below, so *any* persistent divergence — either direction —
      // gets folded into the existing recreate decision and the label re-stamped with whatever is
      // currently published — same shape as `skillsChanged`/`handleRotated` above. Symmetric on
      // purpose: a *tightening* left unconverged would let `reconcile()`'s label half of its
      // union (see that method below) keep contributing a stale, narrower deny set forever; a
      // *loosening* left unconverged is just as broken the other way — `reconcile()`'s union
      // would keep re-adding the label's now-stale, wider set on every docker-events reconnect,
      // silently undoing a legitimately published loosening each time it fires, with nothing else
      // ever forcing the label to catch up. Compared against the *previous* applied list, not
      // this call's own incoming `egressDeny` — a list first published in *this* request still
      // applies live on reuse with no restart, exactly as before this fix (see "refreshes
      // egressDeny on every reuse spawn" test below); only a divergence an earlier reuse already
      // left behind forces the resync. `undefined` (no prior record — first spawn this process
      // has seen this principal, e.g. right after a restart) never forces a recreate on its own,
      // same "unknown never rotates" shape as `HANDLE_JTI_LABEL` above — `reconcile()`'s own union
      // is the safety-biased-toward-denial net for that window; it can only ever add to what a
      // reconnect restores, never subtract, so it must never be the only mechanism relied on to
      // converge a loosening.
      const lastAppliedEgressDeny = registry.get(principalId)?.lastAppliedEgressDeny;
      const egressDenyDrifted =
        lastAppliedEgressDeny !== undefined &&
        !egressDenySetsEqual(
          lastAppliedEgressDeny,
          splitEgressDenyLabel(existing?.labels[EGRESS_DENY_LABEL]),
        );

      const rotated = handleRotated || skillsChanged || egressDenyDrifted || imageChanged;

      if (existing?.running && !rotated) {
        registry.set(principalId, {
          workspaceId,
          containerId: existing.id,
          ip: existing.ip,
          lastTouchedAt: now(),
          // Records what *this* reuse actually applied — the next call's own egressDenyDrifted
          // check above compares against this, not against SOURCE_MAP_FILE (see
          // RegistryEntry.lastAppliedEgressDeny's own doc comment).
          lastAppliedEgressDeny: egressDeny,
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
        image,
      });
      const created = await docker.createAndStart(spec);

      registry.set(principalId, {
        workspaceId,
        containerId: created.id,
        ip: created.ip,
        lastTouchedAt: now(),
        // The label this container was just (re)created with, in `egressDeny` above, matches
        // this exactly — see RegistryEntry.lastAppliedEgressDeny's own doc comment.
        lastAppliedEgressDeny: egressDeny,
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
      // 遗留22 / code-review-2026-09-10.md §3.5: read once, outside the loop below.
      // EGRESS_DENY_LABEL alone is only what a container was (re)created with; a reuse call since
      // then may already have tightened SOURCE_MAP_FILE past it (spawn()'s own reuse-branch
      // registerEgress runs on every reuse, unconditionally) without ever being able to update
      // the label. Unioning the two here — instead of restoring from the label alone — means a
      // docker-events reconnect (this method's other caller; see this module's own doc comment)
      // never re-widens a deny list a reuse already narrowed. spawn()'s own drift check
      // (`egressDenyDrifted` above) is what eventually re-stamps the label itself; this union is
      // the safety net for the window before that resync happens.
      const currentMap = readEgressMap();
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
            // Preserve whatever spawn()'s own drift check last recorded here — reconciling a
            // container's idle clock/egress registration says nothing about what was last
            // *published* for it, and clearing this on every reconnect would erase the very
            // signal that check depends on (RegistryEntry.lastAppliedEgressDeny's own doc
            // comment; 遗留22 / code-review-2026-09-10.md §3.5).
            lastAppliedEgressDeny: registry.get(principalId)?.lastAppliedEgressDeny,
          });
          // Restores the egress deny list this container was (re)created with (EGRESS_DENY_LABEL),
          // unioned with whatever SOURCE_MAP_FILE already has registered for it (see this
          // function's own doc comment above, and 遗留22 / code-review-2026-09-10.md §3.5). The
          // label half covers a supervisor restart where SOURCE_MAP_FILE itself was lost/reset —
          // without it, every still-running entry container's source-map entry would be
          // re-registered with no deny list at all, silently widening its egress until its next
          // startTurn (see EGRESS_DENY_LABEL's own doc comment). The union half covers a
          // reuse-applied tightening the label never learned about — without it, that tightening
          // would revert on every docker-events reconnect in between.
          const sourceId = entrySourceId(workspaceId, principalId);
          const effectiveDeny = Array.from(
            new Set([
              ...splitEgressDenyLabel(state.labels[EGRESS_DENY_LABEL]),
              ...registeredDenyFor(currentMap, state.ip, sourceId),
            ]),
          );
          registerEgress(workspaceId, principalId, state.ip, effectiveDeny);
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

    async list(): Promise<ResidentInventoryEntry[]> {
      const containers = await docker.listByLabel(ENTRY_ROLE_LABEL, ENTRY_ROLE_VALUE);
      return containers
        .map((state): ResidentInventoryEntry | undefined => {
          const principalId = state.labels[PRINCIPAL_LABEL];
          const workspaceId = state.labels[WORKSPACE_LABEL];
          if (!principalId || !workspaceId) return undefined;
          const entry = registry.get(principalId);
          return {
            principalId,
            workspaceId,
            containerId: state.id,
            running: state.running,
            status: state.status,
            image: state.labels[IMAGE_LABEL] || undefined,
            imageId: state.running ? state.imageId : undefined,
            startedAt: state.startedAt,
            lastTouchedAt: entry ? new Date(entry.lastTouchedAt).toISOString() : undefined,
          };
        })
        .filter((entry): entry is ResidentInventoryEntry => entry !== undefined);
    },

    async listImages(): Promise<RuntimeImageInventory> {
      // v0.16.2: `imagesDocker`, not `docker` — see `ResidentServiceDeps.imagesDocker`'s own doc
      // comment for why image reads go through a separate, dedicated read-only proxy connection.
      const images = await imagesDocker.listImages(IMAGE_PI_VERSION_LABEL);
      return { defaultImage: config.workerImage, images, allowedImages: config.taskImageAllowlist };
    },
  };
}
