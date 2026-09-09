import Docker from 'dockerode';

/**
 * docker-client: the narrow slice of the Docker Engine API this collector needs — read-only
 * structural inventory only (list containers/images/networks/volumes, host info); no restart,
 * start, stop, exec, or any other execute-class call anywhere in this package (design doc §7.8
 * "只采结构性字段"; docs/development-tasks.md S3.3 acceptance "批准：否（只读）"). Talks to the Docker
 * Engine API via `dockerode`, never a shelled-out `docker`/`docker compose` binary (no docker CLI
 * in this package's image — same rule `gatekeepers/docker` already follows, for the same reason).
 *
 * Connection: `DOCKER_HOST=tcp://docker-socket-proxy-collector:2375` on the `dockerapi-collector`
 * network (`docker-compose.yml`) — a THIRD `tecnativa/docker-socket-proxy` instance, dedicated to
 * this collector, with a strictly read-only allowlist (`CONTAINERS=1, IMAGES=1, NETWORKS=1,
 * VOLUMES=1, INFO=1, POST=0` — no `ALLOW_START`/`ALLOW_STOP`/`ALLOW_RESTARTS`, unlike the other two
 * proxy instances in this file, which both grant at least one write verb to their own consumers).
 * This collector's own container never bind-mounts `/var/run/docker.sock` — see that compose
 * service's own comment for the full endpoint inventory this client's calls justify. `parseDockerConnection`
 * is duplicated here rather than imported from `gatekeepers/docker`/`@nexttime/worker-supervisor`/
 * `@nexttime/agent-host` — same reasoning each of those three already gives on their own copy: each
 * internal-plane Docker client owns its own IO-free env parsing, and importing across those package
 * boundaries would be a deeper coupling than four small, independently-evolving copies of one
 * ~15-line function.
 */

export interface HostInfo {
  readonly hostname: string;
}

export interface ContainerSummary {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly imageDigest: string | null;
  readonly state: string;
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly ports: readonly {
    readonly privatePort: number;
    readonly publicPort?: number;
    readonly ip?: string;
  }[];
  /** Named-volume mount names — `docker.sock`'s list endpoint's own `Mounts[]` field already
   *  carries this without a separate `inspect` call per container; bind mounts (no `Name`, a host
   *  path) are omitted — Volume's own identityKey (`ontology/ops-assets-v1.yaml`) is a *named*
   *  Docker volume, not an arbitrary host path. */
  readonly volumeNames: readonly string[];
  /** Docker network names this container is attached to — same "already in the list response"
   *  note as `volumeNames` above. */
  readonly networkNames: readonly string[];
}

export interface ImageSummary {
  readonly id: string;
  readonly digest: string | null;
  readonly repoTags: readonly string[];
}

export interface NetworkSummary {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface VolumeSummary {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_DEPENDS_ON_LABEL = 'com.docker.compose.depends_on';

export { COMPOSE_DEPENDS_ON_LABEL, COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL };

export interface DockerClient {
  info(): Promise<HostInfo>;
  listContainers(): Promise<ContainerSummary[]>;
  listImages(): Promise<ImageSummary[]>;
  listNetworks(): Promise<NetworkSummary[]>;
  listVolumes(): Promise<VolumeSummary[]>;
  /** Does not throw on an unreachable daemon — callers decide whether Docker facts are optional. */
  ping(): Promise<boolean>;
}

function stripLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/** A container's `Image` field is a tag (`nginx:latest`) or, once pulled, sometimes already a
 *  digest reference — `ImageID` is the one field guaranteed to be the content digest
 *  (`sha256:...`), matching Image's own identityKey (`ontology/ops-assets-v1.yaml`: "Image =
 *  digest"). `null` when dockerode reports an empty/malformed value rather than guessing. */
function extractDigest(imageId: string | undefined): string | null {
  return imageId && imageId.length > 0 ? imageId : null;
}

function summaryFromListEntry(entry: Docker.ContainerInfo): ContainerSummary {
  return {
    id: entry.Id,
    name: stripLeadingSlash(entry.Names[0] ?? entry.Id),
    image: entry.Image,
    imageDigest: extractDigest(entry.ImageID),
    state: entry.State,
    status: entry.Status,
    labels: entry.Labels ?? {},
    ports: (entry.Ports ?? []).map((p) => ({
      privatePort: p.PrivatePort,
      ...(p.PublicPort !== undefined ? { publicPort: p.PublicPort } : {}),
      ...(p.IP !== undefined ? { ip: p.IP } : {}),
    })),
    volumeNames: (entry.Mounts ?? [])
      .map((mount) => mount.Name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
    networkNames: Object.keys(entry.NetworkSettings?.Networks ?? {}),
  };
}

/** How this module reaches the Docker Engine API — a plain Unix socket (`socketPath`, used only
 *  by tests / a non-compose local run that never sets `DOCKER_HOST`) or a `docker-socket-proxy`
 *  instance's HTTP listener (`tcp`, this package's own compose service — see module doc comment).
 *  Duplicated from the sibling copies in `gatekeepers/docker`/`@nexttime/worker-supervisor`/
 *  `@nexttime/agent-host` — see this file's module doc comment for why. */
export type DockerConnection =
  | { readonly kind: 'socket'; readonly socketPath: string }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number };

export function parseDockerConnection(
  dockerHost: string | undefined,
  fallbackSocketPath: string,
): DockerConnection {
  const fallback: DockerConnection = { kind: 'socket', socketPath: fallbackSocketPath };
  if (!dockerHost || !dockerHost.startsWith('tcp://')) return fallback;
  let url: URL;
  try {
    url = new URL(dockerHost);
  } catch {
    return fallback;
  }
  if (!url.hostname) return fallback;
  const port = url.port ? Number.parseInt(url.port, 10) : 2375;
  if (!Number.isFinite(port) || port <= 0) return fallback;
  return { kind: 'tcp', host: url.hostname, port };
}

export interface CreateDockerClientOptions {
  readonly connection: DockerConnection;
}

export function createDockerClient(options: CreateDockerClientOptions): DockerClient {
  const docker =
    options.connection.kind === 'tcp'
      ? new Docker({ host: options.connection.host, port: options.connection.port })
      : new Docker({ socketPath: options.connection.socketPath });

  return {
    async info(): Promise<HostInfo> {
      const info = await docker.info();
      return { hostname: info.Name };
    },

    async listContainers(): Promise<ContainerSummary[]> {
      const entries = await docker.listContainers({ all: true });
      return entries.map(summaryFromListEntry);
    },

    async listImages(): Promise<ImageSummary[]> {
      const entries = await docker.listImages();
      return entries.map((entry) => ({
        id: entry.Id,
        digest: extractDigest(entry.Id),
        repoTags: entry.RepoTags ?? [],
      }));
    },

    async listNetworks(): Promise<NetworkSummary[]> {
      const entries = await docker.listNetworks();
      return entries.map((entry) => ({
        id: entry.Id,
        name: entry.Name,
        labels: entry.Labels ?? {},
      }));
    },

    async listVolumes(): Promise<VolumeSummary[]> {
      const result = await docker.listVolumes();
      return (result.Volumes ?? []).map((entry) => ({
        name: entry.Name,
        labels: entry.Labels ?? {},
      }));
    },

    async ping(): Promise<boolean> {
      try {
        await docker.ping();
        return true;
      } catch {
        return false;
      }
    },
  };
}
