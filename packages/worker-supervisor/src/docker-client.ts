/**
 * docker-client: the narrow slice of the Docker Engine API this supervisor needs (create/start/
 * stop/kill/remove/inspect one container, list containers by label, resolve the `workers` network
 * by its Compose label) — expressed as a small interface (`DockerClient`) so `resident-service.ts`
 * and its tests never depend on a real socket. `dockerode` (design doc §10.1 "worker-supervisor/
 * # docker socket") backs the real implementation: a typed client over the Engine API that already
 * handles the low-level HTTP-over-unix-socket / TLS transport, rather than hand-rolling that plus
 * the multiplexed-stream framing `attach`/`logs` use — the container's own stdio is out of this
 * half's scope (docs/development-tasks.md S1.5a task brief: "keep your API to spawn/stop/status
 * ... the next half attaches via the Docker API"), but even create/inspect/list benefit from a
 * maintained client over the alternative of parsing raw JSON HTTP responses by hand.
 *
 * Fastify was already the natural HTTP-server choice here (docs/development-tasks.md S1.5a task
 * brief calls for `Fastify inject` route tests, and it matches `@nexttime/kernel`'s own stack) —
 * dockerode is the Docker-side analogue: a well-tested, actively maintained client, not a bespoke
 * one for a package whose actual job is the *policy* around container lifecycle, not a Docker API
 * client.
 */

import Docker from 'dockerode';

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly env: readonly string[];
  readonly binds: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly networkName: string;
  readonly runtime: string;
  readonly memoryMb: number;
  readonly pidsLimit: number;
  readonly tmpfsMb: number;
  /** Container CMD, appended by `deploy/worker-runtime/entrypoint.sh`'s own `"$@"` after its
   *  fixed pi flags (e.g. `['--model', modelId]` — task-spawn-spec.ts). `undefined` runs the
   *  image's default CMD unmodified — resident mode's entry spec never sets this. */
  readonly cmd?: readonly string[];
}

export interface ContainerState {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  /** Docker's own `State.Status` (`running`/`exited`/`created`/`dead`/...). */
  readonly status: string;
  readonly startedAt: string | undefined;
  /** IP on the `workers` network — `undefined` when not running (Docker only assigns one to a
   *  running container's network endpoint). */
  readonly ip: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
  /** Docker's `State.ExitCode` — only meaningful (and only surfaced) once the container is no
   *  longer running; `undefined` while `running` is true (task-service.ts's status/reap logic). */
  readonly exitCode: number | undefined;
}

export interface DockerClient {
  /** Creates and starts a container from `spec`. Fails if a container with that name already
   *  exists — callers are expected to have already decided whether to reuse or recreate (see
   *  `resident-service.ts`'s spawn logic). */
  createAndStart(spec: ContainerSpec): Promise<ContainerState>;
  /** `undefined` when no container with that name exists. */
  inspectByName(name: string): Promise<ContainerState | undefined>;
  /** Graceful stop (SIGTERM, then SIGKILL after `timeoutSeconds`). No-op if already stopped. */
  stop(name: string, timeoutSeconds: number): Promise<void>;
  /** Force-removes a container (stops it first if still running). No-op if it doesn't exist. */
  remove(name: string): Promise<void>;
  /** Every container carrying `label=value`, running or not. */
  listByLabel(label: string, value: string): Promise<ContainerState[]>;
  /** Resolves the Docker network name to attach spawned containers to: `explicitName` verbatim
   *  when given (`NETWORK_WORKERS` env — config.ts), otherwise the one network Compose labelled
   *  `com.docker.compose.network=workers` (Compose stamps this label on every network/container/
   *  volume it creates, keyed by the network's name *inside* the compose file — `workers` — not
   *  the project-prefixed name Docker actually stores it under, e.g. `nexttime-ai_workers`; this
   *  is exactly why the label lookup exists instead of hardcoding the prefixed name). Throws if
   *  zero or more than one network matches and no explicit override was given. */
  resolveNetworkByComposeLabel(networkLabel: string, explicitName?: string): Promise<string>;
}

const COMPOSE_NETWORK_LABEL = 'com.docker.compose.network';

function toContainerState(inspect: Docker.ContainerInspectInfo): ContainerState {
  const networks = inspect.NetworkSettings?.Networks ?? {};
  const firstNetwork = Object.values(networks)[0];
  return {
    id: inspect.Id,
    name: inspect.Name.replace(/^\//, ''),
    running: inspect.State?.Running ?? false,
    status: inspect.State?.Status ?? 'unknown',
    startedAt:
      inspect.State?.StartedAt && inspect.State.StartedAt !== '0001-01-01T00:00:00Z'
        ? inspect.State.StartedAt
        : undefined,
    ip: firstNetwork?.IPAddress || undefined,
    labels: inspect.Config?.Labels ?? {},
    exitCode: inspect.State?.Running ? undefined : inspect.State?.ExitCode,
  };
}

export interface CreateDockerClientOptions {
  readonly socketPath: string;
}

export function createDockerClient(options: CreateDockerClientOptions): DockerClient {
  const docker = new Docker({ socketPath: options.socketPath });

  return {
    async createAndStart(spec: ContainerSpec): Promise<ContainerState> {
      const container = await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Cmd: spec.cmd ? [...spec.cmd] : undefined,
        Env: [...spec.env],
        Labels: { ...spec.labels },
        OpenStdin: true,
        StdinOnce: false,
        Tty: false,
        HostConfig: {
          Binds: [...spec.binds],
          CapDrop: ['ALL'],
          // `no-new-privileges` (S2.8 task brief) applies to every spawned container, entry and
          // Worker alike — it only blocks setuid/setgid privilege escalation, which neither mode
          // relies on (both already run as non-root `nexttime`, uid 10001), so this is a no-op
          // hardening addition for resident mode, not a behavior change.
          SecurityOpt: ['no-new-privileges'],
          ReadonlyRootfs: true,
          Tmpfs: { '/tmp': `size=${spec.tmpfsMb}m` },
          Memory: spec.memoryMb * 1024 * 1024,
          PidsLimit: spec.pidsLimit,
          NetworkMode: spec.networkName,
          RestartPolicy: { Name: 'no' },
          Runtime: spec.runtime,
        },
      });
      await container.start();
      const inspect = await container.inspect();
      return toContainerState(inspect);
    },

    async inspectByName(name: string): Promise<ContainerState | undefined> {
      try {
        const inspect = await docker.getContainer(name).inspect();
        return toContainerState(inspect);
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    },

    async stop(name: string, timeoutSeconds: number): Promise<void> {
      try {
        await docker.getContainer(name).stop({ t: timeoutSeconds });
      } catch (err) {
        if (isNotFound(err) || isNotModified(err)) return;
        throw err;
      }
    },

    async remove(name: string): Promise<void> {
      try {
        await docker.getContainer(name).remove({ force: true });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },

    async listByLabel(label: string, value: string): Promise<ContainerState[]> {
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`${label}=${value}`] },
      });
      const states = await Promise.all(
        containers.map((c) => docker.getContainer(c.Id).inspect().then(toContainerState)),
      );
      return states;
    },

    async resolveNetworkByComposeLabel(
      networkLabel: string,
      explicitName?: string,
    ): Promise<string> {
      if (explicitName) return explicitName;
      const networks = await docker.listNetworks({
        filters: { label: [`${COMPOSE_NETWORK_LABEL}=${networkLabel}`] },
      });
      if (networks.length === 1) {
        const name = networks[0]?.Name;
        if (name) return name;
      }
      throw new Error(
        networks.length === 0
          ? `no Docker network found with label ${COMPOSE_NETWORK_LABEL}=${networkLabel} — set NETWORK_WORKERS explicitly if this is not running under docker compose`
          : `${networks.length} Docker networks found with label ${COMPOSE_NETWORK_LABEL}=${networkLabel} — set NETWORK_WORKERS explicitly to disambiguate`,
      );
    },
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 404;
}

function isNotModified(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 304;
}
