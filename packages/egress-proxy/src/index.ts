import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAdminServer } from './admin.js';
import type { EgressProxyConfig } from './config.js';
import { loadConfig } from './config.js';
import { createProxyServer } from './proxy.js';
import { EgressReporter } from './report.js';
import { createSourceMap } from './source-map.js';

/**
 * @nexttime/egress-proxy — forward proxy on the `control`/`workers` networks: allows public
 * egress, denies RFC1918/link-local/CGNAT/unique-local-v6/platform-subnet addresses and internal
 * service names, applies per-source allow/deny lists, and reports every decision (design doc
 * §7.9, §5.4 I10). See README.md for env vars and the policy summary.
 */
export const VERSION = '0.1.0';

export interface EgressProxyApp {
  proxyServer: Server;
  adminServer: Server;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Wires config, the hot-reloading source map, the batched reporter, the proxy server (all
 * interfaces, `PROXY_PORT`), and the admin server (loopback only, `ADMIN_PORT`), then starts
 * listening on both. Callers that only want to construct the app for a test without binding real
 * ports should build the pieces directly instead (see proxy.test.ts).
 */
export async function startEgressProxy(
  config: EgressProxyConfig = loadConfig(),
): Promise<EgressProxyApp> {
  const sourceMap = createSourceMap(config.sourceMapFile);
  const reporter = new EgressReporter({ kernelUrl: config.kernelUrl });

  const proxyServer = createProxyServer({
    denyHosts: config.denyHosts,
    platformSubnets: config.platformSubnets,
    trustedResolvedCidrs: config.trustedResolvedCidrs,
    allowLoopbackForTests: config.allowLoopbackForTests,
    resolveSource: (clientIp) => sourceMap.resolveSource(clientIp),
    reporter,
    maxTunnelsPerSource: config.maxTunnelsPerSource,
    idleTimeoutMs: config.idleTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
  });
  const adminServer = createAdminServer();

  // Proxy listens on every interface (agent containers on the `workers` network reach it there);
  // admin/healthz is loopback-only, per the task spec, so it's never reachable from either
  // network. Bind both with allSettled, not all — a plain Promise.all would reject as soon as
  // either failed while leaving whichever one *did* bind still open and orphaned (no reference
  // ever reaches a caller who could close it). On any failure here, close whatever did bind
  // before rethrowing, so a partial startup can't leave a zombie listener behind.
  const results = await Promise.allSettled([
    listen(proxyServer, config.proxyPort),
    listen(adminServer, config.adminPort, '127.0.0.1'),
  ]);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) {
    sourceMap.close();
    reporter.close();
    await Promise.allSettled([closeServer(proxyServer), closeServer(adminServer)]);
    throw failure.reason;
  }

  return {
    proxyServer,
    adminServer,
    async close(): Promise<void> {
      sourceMap.close();
      reporter.close();
      await Promise.all([closeServer(proxyServer), closeServer(adminServer)]);
    },
  };
}

export function main(): void {
  startEgressProxy().catch((err: unknown) => {
    console.error(
      JSON.stringify({ level: 'error', msg: 'egress-proxy: failed to start', error: String(err) }),
    );
    process.exitCode = 1;
  });
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
