import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { Socket } from 'node:net';
import type { CidrRange } from './net-utils.js';
import { normalizeAddress } from './net-utils.js';
import type { PolicyConfig, PolicyDecision, Resolver, SourcePolicy } from './policy.js';
import { decideEgress } from './policy.js';
import type { EgressObservation } from './report.js';

/**
 * The forward proxy itself (design doc §7.9): plain `http://` request forwarding on the
 * `request` event, and opaque `CONNECT` tunnelling for `https://` on the `connect` event — no TLS
 * interception either way. One `http.Server` handles both, since that's how HTTP clients speak to
 * a forward proxy over a single port.
 */

export interface EgressReporterLike {
  record(observation: EgressObservation): void;
}

export interface ProxyServerOptions {
  denyHosts: readonly string[];
  platformSubnets: readonly CidrRange[];
  /** See policy.ts `PolicyConfig.trustedResolvedCidrs` (`EGRESS_TRUSTED_RESOLVED_CIDRS`). */
  trustedResolvedCidrs?: readonly CidrRange[];
  /** Test-only: see policy.ts `PolicyConfig.allowLoopbackForTests`. Never set in production. */
  allowLoopbackForTests?: boolean;
  resolveSource: (clientIp: string) => SourcePolicy | undefined;
  /** Injectable DNS resolver for tests. Defaults to a literal-IP shortcut + `dns.promises.lookup`. */
  resolveHost?: Resolver;
  reporter: EgressReporterLike;
  maxTunnelsPerSource?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** CONNECT's `req.url` is `host:port` (optionally an IPv6 literal in brackets), not a full URI. */
function parseConnectTarget(target: string): { hostname: string; port: number } | undefined {
  try {
    const url = new URL(`http://${target}`);
    if (!url.hostname) return undefined;
    return { hostname: stripBrackets(url.hostname), port: url.port ? Number(url.port) : 443 };
  } catch {
    return undefined;
  }
}

export function createProxyServer(options: ProxyServerOptions): http.Server {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const maxTunnelsPerSource = options.maxTunnelsPerSource ?? 32;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const policyConfig: PolicyConfig = {
    denyHosts: options.denyHosts,
    platformSubnets: options.platformSubnets,
    trustedResolvedCidrs: options.trustedResolvedCidrs,
    allowLoopbackForTests: options.allowLoopbackForTests,
  };

  // Per-source concurrent-tunnel accounting (design doc §7.9 task spec: MAX_TUNNELS_PER_SOURCE).
  // Keyed by sourceId when SOURCE_MAP_FILE resolved one, else by client IP — shared between the
  // CONNECT and plain-HTTP paths, since both hold an upstream connection open on this source's
  // behalf.
  const tunnelCounts = new Map<string, number>();

  function tunnelKey(clientIp: string, source: SourcePolicy | undefined): string {
    return source?.sourceId ?? `ip:${clientIp}`;
  }

  function acquireTunnelSlot(key: string): boolean {
    const current = tunnelCounts.get(key) ?? 0;
    if (current >= maxTunnelsPerSource) return false;
    tunnelCounts.set(key, current + 1);
    return true;
  }

  function releaseTunnelSlot(key: string): void {
    const current = tunnelCounts.get(key) ?? 0;
    if (current <= 1) tunnelCounts.delete(key);
    else tunnelCounts.set(key, current - 1);
  }

  function recordObservation(args: {
    clientIp: string;
    source: SourcePolicy | undefined;
    hostname: string;
    port: number;
    protocol: 'http' | 'connect';
    decision: PolicyDecision | { allowed: false; reason: 'tunnel-limit' };
    bytesUp: number;
    bytesDown: number;
  }): void {
    options.reporter.record({
      type: 'EgressObserved',
      sourceId: args.source?.sourceId ?? 'unknown',
      clientIp: args.clientIp,
      domain: args.hostname,
      port: args.port,
      protocol: args.protocol,
      allowed: args.decision.allowed,
      reason: args.decision.reason,
      bytesUp: args.bytesUp,
      bytesDown: args.bytesDown,
      observedAt: new Date().toISOString(),
    });
  }

  const server = http.createServer();

  // --- Plain http:// forwarding -----------------------------------------------------------

  async function handleHttpRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
  ): Promise<void> {
    const clientIp = normalizeAddress(clientReq.socket.remoteAddress ?? '');

    let target: URL;
    try {
      target = new URL(clientReq.url ?? '');
    } catch {
      clientRes.writeHead(400, { 'content-type': 'text/plain' });
      clientRes.end(
        'Bad Request: expected an absolute-URI (configure this as an HTTP forward proxy)',
      );
      return;
    }
    if (target.protocol !== 'http:') {
      clientRes.writeHead(400, { 'content-type': 'text/plain' });
      clientRes.end('Bad Request: only http:// is forwarded this way; https:// uses CONNECT');
      return;
    }

    const hostname = target.hostname;
    const port = target.port ? Number(target.port) : 80;
    const source = options.resolveSource(clientIp);
    const decision = await decideEgress({
      hostname,
      source,
      config: policyConfig,
      resolve: resolveHost,
    });

    if (!decision.allowed) {
      recordObservation({
        clientIp,
        source,
        hostname,
        port,
        protocol: 'http',
        decision,
        bytesUp: 0,
        bytesDown: 0,
      });
      clientRes.writeHead(403, { 'content-type': 'text/plain' });
      clientRes.end('Forbidden by egress policy');
      return;
    }

    const key = tunnelKey(clientIp, source);
    if (!acquireTunnelSlot(key)) {
      recordObservation({
        clientIp,
        source,
        hostname,
        port,
        protocol: 'http',
        decision: { allowed: false, reason: 'tunnel-limit' },
        bytesUp: 0,
        bytesDown: 0,
      });
      clientRes.writeHead(503, { 'content-type': 'text/plain' });
      clientRes.end('Too many concurrent connections from this source');
      return;
    }

    let bytesUp = 0;
    let bytesDown = 0;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      releaseTunnelSlot(key);
      recordObservation({
        clientIp,
        source,
        hostname,
        port,
        protocol: 'http',
        decision,
        bytesUp,
        bytesDown,
      });
    };

    const {
      'proxy-connection': _proxyConnection,
      connection: _connection,
      ...forwardedHeaders
    } = clientReq.headers;
    const headers: http.OutgoingHttpHeaders = { ...forwardedHeaders, host: target.host };

    const upstreamReq = http.request({
      host: decision.address,
      port,
      method: clientReq.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: connectTimeoutMs,
      agent: false, // always a fresh socket, so 'connect' below fires for every request
    });

    // `timeout: connectTimeoutMs` above covers the TCP handshake; once connected, swap to the
    // (usually much longer) idle timeout so a slow-but-alive download isn't cut off at 10s.
    upstreamReq.on('socket', (socket) => {
      socket.once('connect', () => socket.setTimeout(idleTimeoutMs));
    });

    upstreamReq.on('response', (upstreamRes) => {
      upstreamRes.on('data', (chunk: Buffer) => {
        bytesDown += chunk.length;
      });
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
      upstreamRes.on('close', finish);
      upstreamRes.on('error', finish);
    });
    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('upstream connect timeout'));
    });
    upstreamReq.on('error', () => {
      finish();
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end('Bad Gateway');
    });
    clientReq.on('error', () => {
      upstreamReq.destroy();
      finish();
    });
    clientReq.on('data', (chunk: Buffer) => {
      bytesUp += chunk.length;
    });
    clientReq.pipe(upstreamReq);
  }

  server.on('request', (clientReq, clientRes) => {
    void handleHttpRequest(clientReq, clientRes);
  });

  // --- CONNECT tunnelling (https://, no TLS interception) ----------------------------------

  async function handleConnect(
    req: http.IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): Promise<void> {
    clientSocket.on('error', () => clientSocket.destroy());

    const clientIp = normalizeAddress(clientSocket.remoteAddress ?? '');
    const target = parseConnectTarget(req.url ?? '');
    if (!target) {
      clientSocket.end(
        'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    const { hostname, port } = target;
    const source = options.resolveSource(clientIp);
    const decision = await decideEgress({
      hostname,
      source,
      config: policyConfig,
      resolve: resolveHost,
    });

    if (!decision.allowed) {
      recordObservation({
        clientIp,
        source,
        hostname,
        port,
        protocol: 'connect',
        decision,
        bytesUp: 0,
        bytesDown: 0,
      });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }

    const key = tunnelKey(clientIp, source);
    if (!acquireTunnelSlot(key)) {
      recordObservation({
        clientIp,
        source,
        hostname,
        port,
        protocol: 'connect',
        decision: { allowed: false, reason: 'tunnel-limit' },
        bytesUp: 0,
        bytesDown: 0,
      });
      clientSocket.end(
        'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseTunnelSlot(key);
    };

    // decision.address is required whenever decision.allowed is true — decideEgress always sets it.
    const upstream = net.connect({ host: decision.address as string, port });
    upstream.setTimeout(connectTimeoutMs);
    upstream.on('error', () => {
      /* swallowed: 'close' always follows and finish() (bound below) does cleanup + reporting. */
    });

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      release();
      recordObservation({
        clientIp,
        source,
        hostname,
        port,
        protocol: 'connect',
        decision,
        bytesUp: upstream.bytesWritten,
        bytesDown: upstream.bytesRead,
      });
      if (!upstream.destroyed) upstream.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    };

    upstream.once('connect', () => {
      upstream.setTimeout(idleTimeoutMs);
      clientSocket.setTimeout(idleTimeoutMs);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on('timeout', () => upstream.destroy(new Error('idle timeout')));
    clientSocket.on('timeout', () => clientSocket.destroy(new Error('idle timeout')));
    upstream.on('close', finish);
    clientSocket.on('close', finish);
  }

  server.on('connect', (req, clientSocket, head) => {
    void handleConnect(req, clientSocket as Socket, head);
  });

  return server;
}
