import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { internalAuthorizationHeader } from '@nexttime/shared';
import type { LlmProxyConfig } from './config.js';
import { loadConfig, loadInternalToken, loadProvidersFile } from './config.js';
import { loadHandlePublicKey } from './handle-auth.js';
import { createProxyServer } from './proxy.js';
import { LlmUsageReporter } from './report.js';
import type { RevocationSync } from './revocation.js';
import { startRevocationSync } from './revocation.js';

/**
 * @nexttime/llm-proxy — per-provider passthrough proxy (design doc §7.7; docs/development-
 * tasks.md S1.7): verifies kernel-issued Handle signatures locally (`@nexttime/shared`'s
 * `handle-token` primitive, `handle-auth.ts`), syncs revocations out-of-band (`revocation.ts`),
 * injects real provider keys (`proxy.ts`), whitelists models, streams SSE byte-for-byte, and
 * reports usage back to the kernel with a bounded replay queue (`report.ts`). Stateless across
 * restarts (design doc §13): the revocation set and the usage-report queue are both in-memory
 * only — a restart just means "resync from the kernel" and "any not-yet-flushed usage rows are
 * lost", both accepted trade-offs the design already calls out for this proxy.
 *
 * fix/internal-plane-auth (2026-09): both `/internal/*` calls above (revocation sync, usage
 * reporting) now carry `Authorization: Bearer <internal-plane token>` — `config.ts`'s
 * `loadInternalToken`, called here only when `config.kernelUrl` is configured. An unreadable or
 * unusable token file fails `startLlmProxy` outright in that case (this proxy cannot function
 * without reporting/revocation once a kernel is configured); with no `kernelUrl` at all, the token
 * is never loaded, matching every other kernel-optional behavior in this file.
 */
export const VERSION = '0.1.0';

export interface LlmProxyApp {
  readonly server: Server;
  readonly reporter: LlmUsageReporter;
  readonly revocationSync: RevocationSync;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Loads config and `llm-providers.yaml`, imports the kernel's Handle public key, starts the
 * revocation sync and usage reporter, and binds the proxy server on all interfaces (reachable
 * from both `control` and `workers` docker networks, design doc §10.2 compose block) at
 * `config.port`. Callers that only want the pieces for a test without binding a real port should
 * construct them directly instead (see proxy.test.ts).
 */
export async function startLlmProxy(config: LlmProxyConfig = loadConfig()): Promise<LlmProxyApp> {
  const providersFile = await loadProvidersFile(config.providersFile);
  const publicKey = await loadHandlePublicKey(config.handlePublicKeyFile);
  // fix/internal-plane-auth (2026-09): only loaded when there is a kernel to reach — see
  // loadInternalToken's own doc comment for why this mirrors kernelUrl's existing "unset disables
  // the feature" posture rather than always requiring the token file.
  const authorizationHeader = config.kernelUrl
    ? internalAuthorizationHeader(await loadInternalToken())
    : undefined;

  const revocationSync = startRevocationSync({
    kernelUrl: config.kernelUrl,
    authorizationHeader,
    intervalMs: config.revocationSyncIntervalMs,
    overlapMs: config.revocationSyncOverlapMs,
  });

  const reporter = new LlmUsageReporter({
    kernelUrl: config.kernelUrl,
    authorizationHeader,
    flushIntervalMs: config.usageFlushIntervalMs,
    maxFlushIntervalMs: config.usageMaxFlushIntervalMs,
    maxQueueSize: config.usageMaxQueueSize,
  });

  const server = createProxyServer({
    providers: providersFile.providers,
    publicKey,
    isRevoked: (jti: string) => revocationSync.isRevoked(jti),
    reporter,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    upstreamConnectTimeoutMs: config.upstreamConnectTimeoutMs,
    upstreamIdleTimeoutMs: config.upstreamIdleTimeoutMs,
  });

  await listen(server, config.port, '0.0.0.0');

  return {
    server,
    reporter,
    revocationSync,
    async close(): Promise<void> {
      revocationSync.close();
      reporter.close();
      await closeServer(server);
    },
  };
}

export function main(): void {
  startLlmProxy().catch((err: unknown) => {
    console.error(
      JSON.stringify({ level: 'error', msg: 'llm-proxy: failed to start', error: String(err) }),
    );
    process.exitCode = 1;
  });
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
