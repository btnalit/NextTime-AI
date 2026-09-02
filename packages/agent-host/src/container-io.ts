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
 * This module owns the one place agent-host needs the Docker socket (`DOCKER_SOCKET_PATH`,
 * mounted read-only — see docker-compose.yml's `agent-host` service and the PR body for why this
 * package, not `worker-supervisor`, does the attaching: architecture point 3's own text leaves
 * the choice open, and duplicating a *narrow*, read-only-mount, attach-only Docker client here
 * keeps `worker-supervisor` — already host-verified in S1.5a — completely untouched).
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

export interface CreateContainerIoClientOptions {
  readonly dockerSocketPath: string;
}

export function createContainerIoClient(
  options: CreateContainerIoClientOptions,
): ContainerIoClient {
  const docker = new Docker({ socketPath: options.dockerSocketPath });

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
