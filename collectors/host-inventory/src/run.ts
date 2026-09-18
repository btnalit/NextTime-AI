import { readlink } from 'node:fs/promises';
import type { CollectorConfig } from './config.js';
import { createDockerClient, parseDockerConnection } from './docker-client.js';
import type { DockerClient } from './docker-client.js';
import { createKernelClient } from './kernel-client.js';
import type { KernelClient } from './kernel-client.js';
import {
  buildPhase1Observations,
  buildPhase2Observations,
  buildPhase3Observations,
  groupContainersByComposeProject,
} from './observation-builder.js';
import { collectProcessTree } from './process-tree.js';
import type { ProcessTreeResult } from './process-tree.js';
import { collectRagflowObservations } from './ragflow.js';
import { SecretRedactionError, sanitizeCommandLines } from './redact.js';
import { collectRepositories } from './repository.js';
import { collectSystemdServices } from './systemd.js';

/**
 * run: one full collector run (docs/development-tasks.md S3.3 — "Runs once per invocation (--once)
 * or on an interval env; one Activity per run"). Orchestrates, in order:
 *
 *   1. Collect every raw fact source (Docker, `/proc`, `systemctl`, `git remote`) — each one
 *      independently optional/best-effort except Docker itself, which this collector cannot do
 *      anything meaningful without.
 *   2. Sanitize every process command line (`redact.ts`) — **before** any Observation is built, and
 *      as a hard gate: a sanitization failure anywhere aborts this entire run **before this run
 *      makes its first kernel call of any kind** (including `register_source`) — this process then
 *      exits non-zero (S3.3 acceptance: "脱敏失败整批不提交").
 *   3. Only once collection and sanitization have both succeeded, resolve this run's `sourceId` —
 *      `register_source` on every run: since S5.3 the kernel is idempotent on (kind, name)
 *      (`ingest-handlers.ts`'s own doc comment; migration core 0028), so the same
 *      `config.sourceKind` / `config.sourceName` always resolves to the same Source and this
 *      process keeps nothing on disk (the pre-S5.3 state file is gone — a stale cached id from
 *      another workspace was what the S3 acceptance script had to delete between runs). Reusing
 *      the *same* Source across runs is not cosmetic — it is what makes `resolveFactOrigin`
 *      (S3.2, `substrate/epistemic/conflicts.ts`) resolve every run's Facts to the *same* origin,
 *      the entire mechanism behind this collector's own "两遍无重复无 Conflict" acceptance
 *      criterion and the S5.2 observation window's "this Source's Facts".
 *   4. Submit three dependency-ordered `submit_observations` phases sharing one `activityId`
 *      (`observation-builder.ts`'s own module doc comment has the full phase rationale) — Host/
 *      Repository/Image/Process; then ComposeProject/Volume/Network/SystemdService (needs Host's
 *      resolved id); then Container (needs each ComposeProject's resolved id).
 *   5. S3.4, optional: when `config.ragflowGatekeeperId` is set, a fourth phase —
 *      `ragflow.ts`'s `collectRagflowObservations` (independent of Host/Container, so it needs no
 *      previously-resolved id and does not block phases 1-3) — submitted under the same
 *      `activityId` as every other phase. **Not** subject to this run's own hard-failure contract:
 *      Docker is this collector's one required source (step 1's own `catch` throws
 *      `RunFailedError`); RAGFlow is optional infrastructure this collector merely *also* observes
 *      when configured, so an unreachable/erroring RAGFlow Gatekeeper only logs a warning and skips
 *      phase 4 for this run — it never fails the run steps 1-4 already completed.
 */

export class RunFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunFailedError';
  }
}

/** Registers (or, on every run after the first, re-resolves) this collector's Source — the kernel
 *  answers the same id for the same (kind, name) (see this module's own doc comment for why the
 *  identity must be stable). A 409 `source_identity_conflict` here means the name is taken by
 *  another owner in this workspace: pick another `HOST_INVENTORY_SOURCE_NAME`. */
async function resolveSourceId(
  config: CollectorConfig,
  kernelClient: KernelClient,
): Promise<string> {
  const source = await kernelClient.registerSource({
    kind: config.sourceKind,
    name: config.sourceName,
    visibility: 'workspace',
  });
  return source.id;
}

/** `/proc/<pid>/cwd` is a symlink to the process's current working directory — read separately
 *  from `process-tree.ts`'s own flat `{pid, ppid, commandLine}` scan (that module's own doc
 *  comment). Unreadable for a given pid (permission boundary, or the process already exited) maps
 *  to `''`, not a thrown error — `observation-builder.ts` already treats a missing entry the same
 *  way. */
async function resolveWorkingDirectories(pids: readonly number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (const pid of pids) {
    try {
      result.set(pid, await readlink(`/proc/${pid}/cwd`));
    } catch {
      result.set(pid, '');
    }
  }
  return result;
}

export interface RunLogger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
}

const consoleLogger: RunLogger = {
  info: (message, detail) => console.log(JSON.stringify({ level: 'info', message, ...detail })),
  warn: (message, detail) => console.warn(JSON.stringify({ level: 'warn', message, ...detail })),
};

export interface RunOptions {
  readonly config: CollectorConfig;
  readonly dockerClient?: DockerClient;
  readonly kernelClient?: KernelClient;
  readonly logger?: RunLogger;
  /** Overrides `collectProcessTree()`'s own result — test-only seam (this collector's real
   *  deployment always calls the real `/proc`-backed collector; see `process-tree.ts`'s own doc
   *  comment on why that legitimately returns `skipped:true` in the current default deployment
   *  anyway). Lets `run.test.ts` exercise the "a process resists redaction" abort path without
   *  needing a real `/proc`. */
  readonly processTreeOverride?: ProcessTreeResult;
}

export interface RunSummary {
  readonly activityId: string;
  readonly objectsUpserted: number;
  readonly factsAsserted: number;
  readonly factsSuperseded: number;
  /** S5.2: Facts this run's observation windows retired (`not_reobserved`). */
  readonly factsInvalidated: number;
}

/**
 * Runs one full collection cycle. Throws `RunFailedError` (never a partial/best-effort success) on
 * any hard failure: Docker unreachable, sanitization failure, or a kernel call that itself errors —
 * `index.ts` maps any throw here to a non-zero process exit.
 */
export async function runOnce(options: RunOptions): Promise<RunSummary> {
  const { config } = options;
  const logger = options.logger ?? consoleLogger;
  const dockerClient =
    options.dockerClient ??
    createDockerClient({
      connection: parseDockerConnection(config.dockerHost, '/var/run/docker.sock'),
    });
  const kernelClient =
    options.kernelClient ??
    createKernelClient({ kernelUrl: config.kernelUrl, handleTokenFile: config.handleTokenFile });

  // Collect and sanitize *before* any kernel call at all (including `register_source`) — a
  // sanitization failure must leave no trace of this run reaching the kernel (S3.3 acceptance:
  // "脱敏失败整批不提交").
  let hostInfo: { hostname: string };
  let containers: Awaited<ReturnType<DockerClient['listContainers']>>;
  let images: Awaited<ReturnType<DockerClient['listImages']>>;
  let networks: Awaited<ReturnType<DockerClient['listNetworks']>>;
  let volumes: Awaited<ReturnType<DockerClient['listVolumes']>>;
  try {
    [hostInfo, containers, images, networks, volumes] = await Promise.all([
      dockerClient.info(),
      dockerClient.listContainers(),
      dockerClient.listImages(),
      dockerClient.listNetworks(),
      dockerClient.listVolumes(),
    ]);
  } catch (err) {
    throw new RunFailedError('run: failed to collect from the Docker Engine API', { cause: err });
  }

  const systemdResult = await collectSystemdServices({ runSystemdPath: config.runSystemdPath });
  if (systemdResult.skipped)
    logger.info('systemd collection skipped', { reason: systemdResult.reason });

  const repositories = await collectRepositories(config.repositoryPaths);

  const processTreeResult = options.processTreeOverride ?? (await collectProcessTree());
  if (processTreeResult.skipped) {
    logger.info('process-tree collection skipped', { reason: processTreeResult.reason });
  }
  const workingDirectories = await resolveWorkingDirectories(
    processTreeResult.processes.map((p) => p.pid),
  );

  // Sanitize *before* any Observation is built — a failure here aborts the whole run before any
  // network call to the kernel (S3.3 acceptance: "脱敏失败整批不提交").
  let sanitizedProcesses: typeof processTreeResult.processes;
  try {
    sanitizedProcesses = sanitizeCommandLines(processTreeResult.processes);
  } catch (err) {
    throw new RunFailedError(
      'run: command-line sanitization failed — dropping the whole batch, submitting nothing',
      { cause: err instanceof SecretRedactionError ? err : new SecretRedactionError(String(err)) },
    );
  }

  // Only now — after every collection step and sanitization have both succeeded — does this run
  // make its first kernel call.
  const sourceId = await resolveSourceId(config, kernelClient);

  // Phase 1: Host, Repository, Image, Process — no dependency on any previously-resolved id.
  const phase1 = buildPhase1Observations({
    hostname: hostInfo.hostname,
    repositories,
    images,
    processes: sanitizedProcesses,
    workingDirectories,
  });
  const phase1Result = await kernelClient.submitObservations({ sourceId, observations: phase1 });
  const activityId = phase1Result.activityId;
  const hostId = phase1Result.objects.find((o) => o.objectType === 'Host')?.id;
  if (!hostId) {
    throw new RunFailedError('run: phase 1 submission did not return a resolved Host graph id');
  }

  // Phase 2: ComposeProject, Volume, Network, SystemdService — needs Host's resolved id.
  const composeProjects = groupContainersByComposeProject(containers);
  const phase2 = buildPhase2Observations({
    hostname: hostInfo.hostname,
    hostId,
    composeProjects,
    volumes,
    networks,
    systemdServices: systemdResult.services,
  });
  const phase2Result = await kernelClient.submitObservations({
    sourceId,
    activityId,
    observations: phase2,
  });
  const composeProjectIds = new Map(
    phase2Result.objects
      .filter((o) => o.objectType === 'ComposeProject')
      .map((o) => [String(o.identity.projectName), o.id] as const),
  );

  // Phase 3: Container — needs each ComposeProject's resolved id. Always submitted, even with no
  // compose-managed container at all: it carries this run's observation window (S5.2, docs/
  // development-tasks.md §5b S5.2) — "this run is this Source's complete view of these
  // ObjectTypes" — and the kernel retires every Fact of this Source at such an Object that no
  // phase of this run re-observed (`invalidation_reason = 'not_reobserved'`; leftover 28's phantom
  // Containers are exactly those). One window on the last phase, not one per phase: the three
  // phases share one Activity and phases 2 and 3 both write Container edges, so a per-phase window
  // would retire what an earlier phase of the same run just wrote. The window's types are only
  // what this run *actually* collected: the Docker-backed types are unconditional (a Docker
  // failure threw before any submission), the optional scans join only when they ran — a skipped
  // process tree must never declare every Process on the host absent.
  const windowObjectTypes = [
    'Host',
    'Image',
    'ComposeProject',
    'Container',
    'Volume',
    'Network',
    'Endpoint',
    ...(config.repositoryPaths.length > 0 ? ['Repository'] : []),
    ...(systemdResult.skipped ? [] : ['SystemdService']),
    ...(processTreeResult.skipped ? [] : ['Process']),
  ];
  const phase3 = buildPhase3Observations({
    hostname: hostInfo.hostname,
    hostId,
    composeProjectIds,
    composeProjects,
  });
  const phase3Result = await kernelClient.submitObservations({
    sourceId,
    activityId,
    observations: phase3,
    window: { complete: true, objectTypes: windowObjectTypes },
  });

  // Phase 4 (S3.4, optional, non-fatal): KnowledgeBase/Document, only when a RAGFlow Gatekeeper is
  // configured — independent of Host/Container, needs no previously-resolved id. Any failure here
  // (gate unreachable, kb.list erroring, a kernel/network error) is logged and skipped, never
  // thrown — see this module's own doc comment for why RAGFlow's own optionality does not follow
  // Docker's hard-required contract.
  let phase4Result: {
    objectsUpserted: number;
    factsAsserted: number;
    factsSuperseded: number;
    factsInvalidated?: number;
  } = { objectsUpserted: 0, factsAsserted: 0, factsSuperseded: 0 };
  if (config.ragflowGatekeeperId) {
    try {
      const phase4 = await collectRagflowObservations({
        kernelClient,
        gatekeeperId: config.ragflowGatekeeperId,
        logger,
      });
      // S5.2: submitted even when empty — an empty batch with a window is how a knowledge base
      // that lost every Document gets its Facts retired. A collection failure above throws past
      // this call, so a gate that could not be read never declares anything absent.
      phase4Result = await kernelClient.submitObservations({
        sourceId,
        activityId,
        observations: phase4,
        window: { complete: true, objectTypes: ['KnowledgeBase', 'Document'] },
      });
    } catch (err) {
      logger.warn('ragflow observation phase failed — skipped, rest of this run still succeeds', {
        gatekeeperId: config.ragflowGatekeeperId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary: RunSummary = {
    activityId,
    objectsUpserted:
      phase1Result.objectsUpserted +
      phase2Result.objectsUpserted +
      phase3Result.objectsUpserted +
      phase4Result.objectsUpserted,
    factsAsserted:
      phase1Result.factsAsserted +
      phase2Result.factsAsserted +
      phase3Result.factsAsserted +
      phase4Result.factsAsserted,
    factsSuperseded:
      phase1Result.factsSuperseded +
      phase2Result.factsSuperseded +
      phase3Result.factsSuperseded +
      phase4Result.factsSuperseded,
    factsInvalidated: (phase3Result.factsInvalidated ?? 0) + (phase4Result.factsInvalidated ?? 0),
  };
  logger.info('run complete', { ...summary });
  return summary;
}
