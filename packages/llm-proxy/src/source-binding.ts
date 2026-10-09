import { readFileSync, statSync } from 'node:fs';
import {
  type CidrRange,
  type HandleBindingFileError,
  type HandleBindingReader,
  type HandleBindingSource,
  createHandleBindingReader,
  isInCidr,
  normalizePeerAddress,
  parseCidr,
} from '@nexttime/shared';

/**
 * source-binding: how llm-proxy serves the agent containers on the `workers` network
 * (@nexttime/shared handle-binding.ts has the design; design doc §7.7 "来源绑定"; the kernel's twin
 * is packages/kernel/src/interfaces/source-binding).
 *
 * An entry agent's or a WorkerRun's Handle never enters its container: pi's `models.json` still
 * names `$CAPABILITY_HANDLE` as the provider key, but the container's value is the
 * `source-bound` marker, so the SDK sends `Authorization: Bearer source-bound` (or
 * `x-api-key: source-bound`). For a request whose TCP peer is on the `workers` network proxy.ts
 * takes the Handle worker-supervisor bound to that address instead, and refuses
 *   - a peer with no binding (after waiting for a registration that may still be landing),
 *   - a request whose Handle header carries anything but that marker (a token the model found
 *     somewhere — a member's `issue_handle` token pasted into a file, say),
 *   - every route but the model traffic and `/healthz` (`/admin/*`, `/internal/metrics`).
 * From any other peer a container-held Handle (`hld: container`) is refused outright — a copy that
 * leaked out of the platform is useless anywhere but at its container's own address.
 *
 * The peer address is the socket's own `remoteAddress`; nothing on the `workers` network sits in
 * front of this proxy, and agent containers run with every capability dropped (no `NET_RAW` /
 * `NET_ADMIN`), so they cannot forge it.
 */
export interface ProxySourceBinding {
  /** Whether `peerAddress` (normalized, `::ffff:` stripped) is on the `workers` network. */
  isFromWorkersNetwork(peerAddress: string): boolean;
  /** Reads worker-supervisor's bindings file. */
  readonly reader: HandleBindingReader;
}

/** `peerAddress` for a socket's `remoteAddress` — `undefined` for a closed socket. */
export function socketPeerAddress(remoteAddress: string | undefined): string | undefined {
  return remoteAddress ? normalizePeerAddress(remoteAddress) : undefined;
}

export function createProxySourceBinding(options: {
  /** `NEXTTIME_SUBNET_WORKERS`. A malformed value throws — a startup failure, never a guard that
   *  quietly turns itself off. */
  readonly workersSubnet: string;
  readonly reader: HandleBindingReader;
}): ProxySourceBinding {
  const range: CidrRange = parseCidr(options.workersSubnet.trim());
  return {
    isFromWorkersNetwork: (peerAddress) => isInCidr(peerAddress, range),
    reader: options.reader,
  };
}

/** `node:fs` access to the bindings file (the kernel's `createFileHandleBindingSource` twin).
 *  worker-supervisor replaces the file by rename, so inode + mtime + size changes on every write. */
export function createFileHandleBindingSource(filePath: string): HandleBindingSource {
  return {
    version() {
      try {
        const stat = statSync(filePath, { bigint: true });
        return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },
    read() {
      return readFileSync(filePath, 'utf8');
    },
  };
}

export function createFileHandleBindingReader(
  filePath: string,
  onError: (err: HandleBindingFileError) => void,
): HandleBindingReader {
  return createHandleBindingReader({ source: createFileHandleBindingSource(filePath), onError });
}
