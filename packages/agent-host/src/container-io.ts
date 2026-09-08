import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import Docker from 'dockerode';

/**
 * container-io: attaches to a resident entry container's stdio over the Docker Engine API
 * (design doc §7.2 "把容器 stdout 的 JSONL 事件桥到内核"; docs/development-tasks.md S1.5, second
 * half). `worker-supervisor` creates every entry container with `OpenStdin:true, StdinOnce:false,
 * Tty:false` (docs/runbooks/host-worker-runtime.md §9's own contract for the next half — this is
 * that next half) — `Tty:false` means Docker multiplexes stdout/stderr on the read side (an
 * 8-byte frame header per chunk, Docker's own "stream protocol"); `dockerode`'s `Docker.modem.
 * demuxStream` (typed in `@types/docker-modem`) un-multiplexes it. Writes (stdin) need no such
 * framing — they are raw bytes
 * straight into the container's stdin once the connection is hijacked (`hijack: true`, required
 * for a genuinely bidirectional attach; read-only `demuxStream` consumers in dockerode's own
 * README examples omit it because they never write back).
 *
 * Line framing on read matches pi's own documented RPC contract exactly (`docs/rpc.md`
 * "Framing": "strict JSONL semantics with LF (\n) as the only record delimiter ... Accept
 * optional \r\n input by stripping a trailing \r ... Node readline is not protocol-compliant ...
 * it also splits on U+2028/U+2029" — cited in this task's dispatch) — implemented as the same
 * manual buffer-and-indexOf('\n') loop `docs/rpc.md`'s own "Interactive Client (Node.js)" example
 * uses, not `node:readline`.
 *
 * This module owns the one place agent-host needs the Docker Engine API (see docker-compose.yml's
 * `agent-host` service and the PR body for why this package, not `worker-supervisor`, does the
 * attaching: architecture point 3's own text leaves the choice open, and duplicating a *narrow*,
 * attach-only Docker client here keeps `worker-supervisor` — already host-verified in S1.5a —
 * completely untouched).
 *
 * Connection (fix/socket-proxy-and-backup-user): `docker-compose.yml` no longer bind-mounts
 * `/var/run/docker.sock` into this container — `attach()` now goes through `docker-socket-proxy`
 * over the `dockerapi` network (`DOCKER_HOST=tcp://docker-socket-proxy:2375`, parsed by
 * `parseDockerConnection` below). `dockerode`'s hijacked-connection attach protocol (`hijack:
 * true` + `demuxStream`, used below) is transport-agnostic — the same HTTP request/response pair
 * hijacks the underlying `net.Socket` whether that socket is a Unix domain socket or a TCP
 * connection to the proxy, so no change to the attach logic itself was needed, only to how the
 * `Docker` client is constructed. `DOCKER_SOCKET_PATH` (plain Unix socket) survives as the
 * fallback for tests and any non-compose run that never sets `DOCKER_HOST`.
 */

export interface AttachedContainerIo {
  /** Writes one JSON value as a single LF-terminated line to the container's stdin (pi RPC
   *  `docs/rpc.md` "Commands": "JSON objects sent to stdin, one per line"). No-op once closed. */
  writeLine(value: unknown): void;
  /** Registers a listener for every complete stdout line (LF-delimited, already stripped of a
   *  trailing `\r` and never split on U+2028/U+2029). Multiple listeners are supported. */
  onLine(listener: (line: string) => void): void;
  /** Registers a listener fired exactly once, when the underlying attach stream ends, closes, or
   *  errors — `err` is set only for the error case. This is agent-host's own signal that the
   *  container's stdio pipe is gone (crash, `docker kill`, or a clean exit) — see host.ts's own
   *  doc comment for how a mid-turn occurrence of this becomes `turnEnded {status:'interrupted'}`
   *  plus a re-spawn on the next Turn (design doc §13, architecture point 3). */
  onClose(listener: (err: Error | undefined) => void): void;
  /** Ends the stream from this side. Idempotent. Does **not** fire `onClose` — a deliberate close
   *  initiated by the caller (e.g. `host.ts` dropping a stale attachment) is not the same signal
   *  as the container's stdio pipe disappearing out from under it; `onClose` is reserved for the
   *  latter. */
  close(): void;
}

export interface ContainerIoClient {
  /** Attaches to `containerId`'s stdio. One call per attachment — `host.ts` caches at most one
   *  attached stream per principal and re-attaches (after a fresh `/resident/spawn`) once the
   *  previous one closes. */
  attach(containerId: string): Promise<AttachedContainerIo>;
}

/** How this module reaches the Docker Engine API — a plain Unix socket (`socketPath`, the pre-
 *  fix/socket-proxy-and-backup-user default and what tests still use) or `docker-socket-proxy`'s
 *  HTTP listener over the `dockerapi` network (`tcp`, `DOCKER_HOST=tcp://docker-socket-
 *  proxy:2375` — docker-compose.yml). Duplicated from `@nexttime/worker-supervisor`'s identical
 *  `config.ts` type rather than shared: same reasoning as this package's own `loadInternalToken`
 *  doc comment in `index.ts` — each internal-plane client owns its own IO-free env parsing. */
export type DockerConnection =
  | { readonly kind: 'socket'; readonly socketPath: string }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number };

/** Parses `DOCKER_HOST` into a `DockerConnection` — same contract (and same reasoning: only
 *  `tcp://host:port` is recognized, everything else falls back to `fallbackSocketPath`) as
 *  `@nexttime/worker-supervisor`'s `config.ts` `parseDockerConnection`, duplicated for the reason
 *  given on `DockerConnection` above. */
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

export interface CreateContainerIoClientOptions {
  readonly connection: DockerConnection;
}

export function createContainerIoClient(
  options: CreateContainerIoClientOptions,
): ContainerIoClient {
  const docker =
    options.connection.kind === 'tcp'
      ? new Docker({ host: options.connection.host, port: options.connection.port })
      : new Docker({ socketPath: options.connection.socketPath });

  return {
    async attach(containerId: string): Promise<AttachedContainerIo> {
      const container = docker.getContainer(containerId);
      const rawStream = (await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      })) as NodeJS.ReadWriteStream & { end(): void; destroy?(): void };

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(rawStream, stdout, stderr);
      stderr.resume(); // drained, never parsed — pi writes its RPC events to stdout only (docs/rpc.md)

      const lineListeners: Array<(line: string) => void> = [];
      const closeListeners: Array<(err: Error | undefined) => void> = [];
      let closed = false;

      const emitClose = (err: Error | undefined): void => {
        if (closed) return;
        closed = true;
        for (const listener of closeListeners) listener(err);
      };

      // Manual JSONL split — see this file's module doc comment for why not node:readline.
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      stdout.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        for (;;) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) break;
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          for (const listener of lineListeners) listener(line);
        }
      });

      rawStream.on('error', (err: Error) => emitClose(err));
      rawStream.on('close', () => emitClose(undefined));
      rawStream.on('end', () => emitClose(undefined));

      return {
        writeLine(value: unknown): void {
          if (closed) return;
          rawStream.write(`${JSON.stringify(value)}\n`);
        },
        onLine(listener: (line: string) => void): void {
          lineListeners.push(listener);
        },
        onClose(listener: (err: Error | undefined) => void): void {
          closeListeners.push(listener);
        },
        close(): void {
          if (closed) return;
          closed = true;
          rawStream.end();
          rawStream.destroy?.();
        },
      };
    },
  };
}
