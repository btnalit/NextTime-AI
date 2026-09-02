import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Resolver, SourcePolicy } from './policy.js';
import { createProxyServer } from './proxy.js';
import type { EgressObservation } from './report.js';

/**
 * Integration tests for the forward proxy (design doc §7.9 task spec, scenarios (a)-(d) from the
 * S1.11 task description). Every server here binds to 127.0.0.1 only, so `remoteAddress` is
 * always a plain IPv4 loopback string (never `::ffff:...`), which keeps SOURCE_MAP_FILE-style
 * per-IP lookups in test (d) deterministic.
 */

const DEFAULT_DENY_HOSTS = [
  'kernel',
  'postgres',
  'llm-proxy',
  'egress-proxy',
  'worker-supervisor',
  'agent-host',
  'caddy',
];

function addressPort(server: http.Server | net.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  return address.port;
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function closeNetServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface TestProxy {
  port: number;
  recordings: EgressObservation[];
  close(): Promise<void>;
}

async function startTestProxy(
  overrides: {
    resolveSource?: (clientIp: string) => SourcePolicy | undefined;
    resolveHost?: Resolver;
    allowLoopbackForTests?: boolean;
    maxTunnelsPerSource?: number;
  } = {},
): Promise<TestProxy> {
  const recordings: EgressObservation[] = [];
  const server = createProxyServer({
    denyHosts: DEFAULT_DENY_HOSTS,
    platformSubnets: [],
    allowLoopbackForTests: overrides.allowLoopbackForTests ?? false,
    resolveSource: overrides.resolveSource ?? (() => undefined),
    resolveHost: overrides.resolveHost,
    reporter: { record: (o) => recordings.push(o) },
    maxTunnelsPerSource: overrides.maxTunnelsPerSource,
    connectTimeoutMs: 2000,
    idleTimeoutMs: 2000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: addressPort(server), recordings, close: () => closeHttpServer(server) };
}

async function startUpstream(body: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: addressPort(server), close: () => closeHttpServer(server) };
}

async function startEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: addressPort(server), close: () => closeNetServer(server) };
}

function httpGetThroughProxy(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Sends a raw CONNECT request and resolves with the response status line, without using
 * Node's http client CONNECT handling — full control over exactly what's on the wire. */
function rawConnect(proxyPort: number, target: string): Promise<{ statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout waiting for CONNECT response'));
    }, 3000);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n')) {
        clearTimeout(timer);
        const statusLine = buffer.split('\r\n')[0] ?? '';
        socket.destroy();
        resolve({ statusLine });
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Establishes a CONNECT tunnel, sends `payload` through it, and resolves once it's echoed back. */
function connectTunnelRoundTrip(
  proxyPort: number,
  target: string,
  payload: string,
): Promise<{ statusLine: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let phase: 'headers' | 'body' = 'headers';
    let buffer = '';
    let statusLine = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout waiting for tunnel round trip'));
    }, 3000);
    socket.on('data', (chunk: Buffer) => {
      if (phase === 'headers') {
        buffer += chunk.toString('utf8');
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        statusLine = buffer.split('\r\n')[0] ?? '';
        phase = 'body';
        socket.write(payload);
        return;
      }
      clearTimeout(timer);
      socket.destroy();
      resolve({ statusLine, echoed: chunk.toString('utf8') });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('createProxyServer', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('(a) denies a plain http:// request to a loopback address with 403', async () => {
    const upstream = await startUpstream('hello');
    cleanups.push(upstream.close);
    const proxy = await startTestProxy();
    cleanups.push(proxy.close);

    const res = await httpGetThroughProxy(proxy.port, `http://127.0.0.1:${upstream.port}/`);
    expect(res.status).toBe(403);

    await vi.waitFor(() => expect(proxy.recordings).toHaveLength(1));
    expect(proxy.recordings[0]).toMatchObject({ allowed: false, reason: 'private-address' });
  });

  it('(b) allows a loopback request with ALLOW_LOOPBACK_FOR_TESTS and reports bytes', async () => {
    const upstream = await startUpstream('hello-world');
    cleanups.push(upstream.close);
    const proxy = await startTestProxy({ allowLoopbackForTests: true });
    cleanups.push(proxy.close);

    const res = await httpGetThroughProxy(proxy.port, `http://127.0.0.1:${upstream.port}/`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello-world');

    await vi.waitFor(() => expect(proxy.recordings).toHaveLength(1));
    const obs = proxy.recordings[0];
    expect(obs).toMatchObject({ allowed: true, protocol: 'http' });
    expect(obs?.bytesDown).toBeGreaterThan(0);
  });

  it('(b, alt) allows via an injected resolver mapping a public-looking hostname to the local upstream', async () => {
    const upstream = await startUpstream('via-resolver');
    cleanups.push(upstream.close);
    const resolveHost: Resolver = async (hostname) => {
      expect(hostname).toBe('allowed.example.test');
      return ['127.0.0.1'];
    };
    const proxy = await startTestProxy({ allowLoopbackForTests: true, resolveHost });
    cleanups.push(proxy.close);

    const res = await httpGetThroughProxy(
      proxy.port,
      `http://allowed.example.test:${upstream.port}/`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('via-resolver');
  });

  it('(c) denies CONNECT to a denied host with 403 before any upstream connection is attempted', async () => {
    const resolveHost: Resolver = async () => {
      throw new Error('resolve() must not be called for a DENY_HOSTS entry');
    };
    const proxy = await startTestProxy({ resolveHost });
    cleanups.push(proxy.close);

    const { statusLine } = await rawConnect(proxy.port, 'kernel:443');
    expect(statusLine).toContain('403');

    await vi.waitFor(() => expect(proxy.recordings).toHaveLength(1));
    expect(proxy.recordings[0]).toMatchObject({
      allowed: false,
      reason: 'deny-host',
      protocol: 'connect',
    });
  });

  it('(d) a per-source deny list from SOURCE_MAP_FILE blocks an otherwise-allowed host', async () => {
    const upstream = await startUpstream('should-not-reach');
    cleanups.push(upstream.close);
    const source: SourcePolicy = { sourceId: 'worker-1', deny: ['allowed.example.test'] };
    const resolveHost: Resolver = async () => ['127.0.0.1'];
    const proxy = await startTestProxy({
      allowLoopbackForTests: true,
      resolveHost,
      resolveSource: () => source,
    });
    cleanups.push(proxy.close);

    const res = await httpGetThroughProxy(
      proxy.port,
      `http://allowed.example.test:${upstream.port}/`,
    );
    expect(res.status).toBe(403);

    await vi.waitFor(() => expect(proxy.recordings).toHaveLength(1));
    expect(proxy.recordings[0]).toMatchObject({
      allowed: false,
      reason: 'source-deny',
      sourceId: 'worker-1',
    });
  });

  it('tunnels a CONNECT stream end to end and reports both byte directions', async () => {
    const echo = await startEchoServer();
    cleanups.push(echo.close);
    const proxy = await startTestProxy({ allowLoopbackForTests: true });
    cleanups.push(proxy.close);

    const { statusLine, echoed } = await connectTunnelRoundTrip(
      proxy.port,
      `127.0.0.1:${echo.port}`,
      'ping-through-tunnel',
    );
    expect(statusLine).toContain('200');
    expect(echoed).toBe('ping-through-tunnel');

    await vi.waitFor(() => expect(proxy.recordings).toHaveLength(1));
    const obs = proxy.recordings[0];
    expect(obs).toMatchObject({ allowed: true, protocol: 'connect' });
    expect(obs?.bytesUp).toBeGreaterThan(0);
    expect(obs?.bytesDown).toBeGreaterThan(0);
  });

  it('enforces MAX_TUNNELS_PER_SOURCE with a 503 once the per-source limit is reached', async () => {
    const echo = await startEchoServer();
    cleanups.push(echo.close);
    const proxy = await startTestProxy({ allowLoopbackForTests: true, maxTunnelsPerSource: 1 });
    cleanups.push(proxy.close);

    // Hold the first tunnel open (never send/close) while attempting a second concurrently.
    const held = net.connect(proxy.port, '127.0.0.1', () => {
      held.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    });
    await new Promise<void>((resolve) => held.once('data', () => resolve()));

    const { statusLine } = await rawConnect(proxy.port, `127.0.0.1:${echo.port}`);
    expect(statusLine).toContain('503');

    held.destroy();
  });
});
