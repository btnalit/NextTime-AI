import { readFileSync, statSync } from 'node:fs';
import {
  type HandleBindingFileError,
  type HandleBindingReader,
  type HandleBindingSource,
  createHandleBindingReader,
  decideHandlePresentation,
  normalizePeerAddress,
} from '@nexttime/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../application/gateway/index.js';
import { createSubnetMatcher } from '../internal-auth/subnet.js';
import type { SubnetMatcher } from '../internal-auth/subnet.js';

/**
 * interfaces/source-binding: how the kernel serves the agent containers on the `workers` network
 * (@nexttime/shared handle-binding.ts has the design; design doc §7.3 / §11 "来源绑定").
 *
 * An entry agent's or a WorkerRun's Handle never enters its container. worker-supervisor binds it
 * to the container's address in the bindings file, and for a request whose TCP peer is on the
 * `workers` network the kernel:
 *
 *   - serves only `POST /api/cap/:name` and `GET /api/health` (`registerWorkersPlaneGuard`) —
 *     everything else (`/mcp`, `/ws`, `/api/auth/*`, the Explorer routes, `/internal/*`) answers
 *     403 before any credential is looked at, so a container cannot act with a token it found
 *     somewhere (a member's `issue_handle` token pasted into a file, an API key);
 *   - authenticates `/api/cap/:name` with the Handle bound to the peer address only
 *     (`boundHandleFor`): a request that also carries `Authorization` or a cookie is refused, and
 *     so is a peer with no binding.
 *
 * The peer address is the socket's own `remoteAddress` — never a forwarded-for header (nothing on
 * the `workers` network sits in front of the kernel), the same rule interfaces/internal-auth uses.
 * Agent containers cannot forge it: they run with every capability dropped (no `NET_RAW` /
 * `NET_ADMIN`).
 */

export interface SourceBindingConfig {
  /** `NEXTTIME_SUBNET_WORKERS` — the `workers` network's subnet. */
  readonly workersSubnet: string;
  /** Reads worker-supervisor's bindings file (`HANDLE_BINDINGS_FILE`). */
  readonly reader: HandleBindingReader;
}

export interface SourceBinding {
  /** Whether the request's TCP peer is on the `workers` network. */
  isFromWorkersNetwork(request: FastifyRequest): boolean;
  /**
   * For a request from the `workers` network: the Handle bound to its peer address. Throws
   * `UnauthorizedError` when nothing is bound to it (after waiting for a registration that may
   * still be landing) or when the request carries a credential of its own. `undefined` for any
   * other peer — the caller authenticates the request's own credential as before.
   */
  boundHandleFor(request: FastifyRequest): Promise<string | undefined>;
}

/** Why `boundHandleFor` refused a request, on the `UnauthorizedError` it throws (`cause`). */
export class SourceBindingRefused extends Error {
  readonly reason: 'unbound_source' | 'credential_from_bound_source';
  constructor(reason: SourceBindingRefused['reason']) {
    super(
      reason === 'unbound_source'
        ? 'no Handle is bound to this agent container address'
        : 'a request from an agent container must not carry a credential of its own',
    );
    this.name = 'SourceBindingRefused';
    this.reason = reason;
  }
}

function peerAddress(request: FastifyRequest): string | undefined {
  const address = request.socket?.remoteAddress;
  return address ? normalizePeerAddress(address) : undefined;
}

export function createSourceBinding(config: SourceBindingConfig): SourceBinding {
  const inWorkersSubnet: SubnetMatcher = createSubnetMatcher(config.workersSubnet);

  function isFromWorkersNetwork(request: FastifyRequest): boolean {
    const peer = peerAddress(request);
    return peer !== undefined && inWorkersSubnet(peer);
  }

  return {
    isFromWorkersNetwork,
    async boundHandleFor(request) {
      const peer = peerAddress(request);
      if (peer === undefined || !inWorkersSubnet(peer)) return undefined;
      if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
        throw new UnauthorizedError('invalid credentials', {
          cause: new SourceBindingRefused('credential_from_bound_source'),
        });
      }
      const binding = await config.reader.lookup(peer, { waitForRegistration: true });
      const presentation = decideHandlePresentation({ binding, fromWorkersSubnet: true });
      if (presentation.kind !== 'source') {
        throw new UnauthorizedError('invalid credentials', {
          cause: new SourceBindingRefused('unbound_source'),
        });
      }
      return presentation.binding.handle;
    },
  };
}

/** `node:fs` access to the bindings file for `createHandleBindingReader`. worker-supervisor
 *  replaces the file by rename, so inode + mtime + size changes on every write. */
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

/** The only routes a `workers`-network peer reaches (this module's own doc comment). Matched on
 *  Fastify's route pattern, so `/api/cap/<anything>` is one entry. */
export const WORKERS_PLANE_ROUTES: readonly { readonly method: string; readonly url: string }[] =
  Object.freeze([
    { method: 'POST', url: '/api/cap/:name' },
    { method: 'GET', url: '/api/health' },
  ]);

const FORBIDDEN_BODY = {
  ok: false,
  error: { code: 'forbidden', message: 'forbidden' },
} as const;

function isWorkersPlaneRoute(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  return WORKERS_PLANE_ROUTES.some(
    (allowed) => allowed.url === route && allowed.method === request.method,
  );
}

/**
 * Installs the `workers`-network route allow-list as a root-level `onRequest` hook (it also runs
 * for WebSocket upgrades). Registered before every route, so it answers before any handler or
 * credential check runs. A no-op when `binding` is undefined (no `NEXTTIME_SUBNET_WORKERS`).
 */
export function registerWorkersPlaneGuard(
  app: FastifyInstance,
  binding: SourceBinding | undefined,
): void {
  if (!binding) return;
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!binding.isFromWorkersNetwork(request) || isWorkersPlaneRoute(request)) return;
    request.log.warn(
      { method: request.method, route: request.routeOptions.url ?? null },
      'workers-network peer refused outside the agent-container routes',
    );
    await reply.code(403).send(FORBIDDEN_BODY);
  });
}
