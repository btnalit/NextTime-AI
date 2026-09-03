import Docker from 'dockerode';

/**
 * docker-client: the narrow slice of the Docker Engine API this gate's transport needs (list/
 * inspect/restart/start/stop one or more containers, tail logs, ping) — expressed as a small
 * interface (`DockerClient`) so `transport.ts` and its tests never depend on a real socket, the
 * same pattern `packages/worker-supervisor/src/docker-client.ts` established for this repo
 * (dockerode wraps the low-level HTTP-over-unix-socket transport and the multiplexed-stream log
 * framing, rather than hand-rolling either).
 *
 * This gate never shells out to the `docker` CLI (task brief: "no docker CLI in the image") —
 * every Operation in `../manifest.json` is `binding.kind: 'cli'` for `params_schema`/wire-shape
 * consistency with the base package's `CliBindingSchema`, but the *implementation* backing it is
 * this dockerode client, not `@nexttime/gatekeeper-base`'s own shell-executing `CliTransport`
 * (`kinds/cli.ts`) — see `transport.ts`'s module doc for why `main()`'s env-driven bootstrap
 * cannot be reused here.
 */

export interface ContainerSummary {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  /** Docker's short state word (`running`/`exited`/`created`/`dead`/...). */
  readonly state: string;
  /** A human-readable status string (`Up 3 hours`, `Exited (0) 2 minutes ago`, ...). */
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export interface ListContainersOptions {
  /** `false` restricts to running containers only; default (and docker ps's own default without
   *  `--all`) is running-only — this gate defaults to `all: true` in `transport.ts` so `simulate`/
   *  `compose.ls` see stopped containers too, matching `docker ps --all`. */
  readonly all?: boolean;
  /** Filters to containers labelled `com.docker.compose.project=<project>`. */
  readonly project?: string;
}

export interface DockerClient {
  listContainers(options?: ListContainersOptions): Promise<ContainerSummary[]>;
  /** Throws if no container with this id/name exists (dockerode's own 404, not swallowed — a
   *  gate observe/simulate call for an unknown container should surface as an error, not a
   *  silently empty result). */
  inspectContainer(id: string): Promise<ContainerSummary>;
  /** Returns de-multiplexed stdout+stderr text (Docker's log stream frames each line with an
   *  8-byte header — see `demuxDockerLogBuffer` below). */
  logsTail(id: string, tail: number): Promise<string>;
  restart(id: string, timeoutSeconds: number): Promise<void>;
  start(id: string): Promise<void>;
  /** No-op if already stopped. */
  stop(id: string, timeoutSeconds?: number): Promise<void>;
  ping(): Promise<void>;
}

function stripLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

function summaryFromListEntry(entry: Docker.ContainerInfo): ContainerSummary {
  return {
    id: entry.Id,
    name: stripLeadingSlash(entry.Names[0] ?? entry.Id),
    image: entry.Image,
    state: entry.State,
    status: entry.Status,
    labels: entry.Labels ?? {},
  };
}

function summaryFromInspect(inspect: Docker.ContainerInspectInfo): ContainerSummary {
  const state = inspect.State;
  const status =
    state?.Running === true
      ? `Up since ${state.StartedAt ?? 'unknown'}`
      : `Exited (${state?.ExitCode ?? 'unknown'})`;
  return {
    id: inspect.Id,
    name: stripLeadingSlash(inspect.Name ?? inspect.Id),
    image: inspect.Config?.Image ?? '',
    state: state?.Status ?? 'unknown',
    status,
    labels: inspect.Config?.Labels ?? {},
  };
}

/**
 * Docker's `container.logs()` response for a non-TTY container multiplexes stdout/stderr as a
 * sequence of frames: 1-byte stream type (0=stdin, 1=stdout, 2=stderr), 3 reserved zero bytes, a
 * 4-byte big-endian payload length, then that many payload bytes. A `Tty: true` container's logs
 * are not framed at all — this returns the raw text unchanged whenever the buffer does not start
 * with a recognizable frame header, rather than misparsing it.
 */
export function demuxDockerLogBuffer(buf: Buffer): string {
  if (buf.length < 8 || !isFrameHeader(buf, 0)) return buf.toString('utf8');
  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length && isFrameHeader(buf, offset)) {
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break;
    chunks.push(buf.subarray(start, end).toString('utf8'));
    offset = end;
  }
  return chunks.join('');
}

function isFrameHeader(buf: Buffer, offset: number): boolean {
  const streamType = buf[offset];
  return (
    (streamType === 0 || streamType === 1 || streamType === 2) &&
    buf[offset + 1] === 0 &&
    buf[offset + 2] === 0 &&
    buf[offset + 3] === 0
  );
}

function isNotModified(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 304;
}

export interface CreateDockerClientOptions {
  readonly socketPath: string;
}

export function createDockerClient(options: CreateDockerClientOptions): DockerClient {
  const docker = new Docker({ socketPath: options.socketPath });

  return {
    async listContainers(listOptions: ListContainersOptions = {}): Promise<ContainerSummary[]> {
      const filters: Record<string, string[]> = {};
      if (listOptions.project) filters.label = [`${COMPOSE_PROJECT_LABEL}=${listOptions.project}`];
      const entries = await docker.listContainers({
        all: listOptions.all ?? true,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      });
      return entries.map(summaryFromListEntry);
    },

    async inspectContainer(id: string): Promise<ContainerSummary> {
      const inspect = await docker.getContainer(id).inspect();
      return summaryFromInspect(inspect);
    },

    async logsTail(id: string, tail: number): Promise<string> {
      const raw = await docker
        .getContainer(id)
        .logs({ stdout: true, stderr: true, tail, follow: false, timestamps: false });
      return demuxDockerLogBuffer(
        Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as string),
      );
    },

    async restart(id: string, timeoutSeconds: number): Promise<void> {
      await docker.getContainer(id).restart({ t: timeoutSeconds });
    },

    async start(id: string): Promise<void> {
      await docker.getContainer(id).start();
    },

    async stop(id: string, timeoutSeconds?: number): Promise<void> {
      try {
        await docker
          .getContainer(id)
          .stop(timeoutSeconds !== undefined ? { t: timeoutSeconds } : {});
      } catch (err) {
        if (isNotModified(err)) return;
        throw err;
      }
    },

    async ping(): Promise<void> {
      await docker.ping();
    },
  };
}
