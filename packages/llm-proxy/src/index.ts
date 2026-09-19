import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { internalAuthorizationHeader } from '@nexttime/shared';
import type { KernelAuditEvent } from './admin-api.js';
import { createAdminApi } from './admin-api.js';
import type { BudgetSync } from './budget-sync.js';
import { startBudgetSync } from './budget-sync.js';
import { ProviderCatalog } from './catalog.js';
import type { LlmProxyConfig } from './config.js';
import { loadConfig, loadInternalToken, loadProvidersFile } from './config.js';
import {
  buildModelsJsonFromCatalog,
  serializeModelsJson,
  writeModelsJsonAtomic,
} from './gen-models-json.js';
import { loadHandlePublicKey } from './handle-auth.js';
import { ProviderStore } from './provider-store.js';
import { runProviderTest } from './provider-test.js';
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
 *
 * S6-B (docs/console-completion-plan.md §5.4): the one exception to "stateless" is the console-
 * managed provider store (`provider-store.ts`, `/data/state/providers.json`) — merged over the
 * operator's yaml by `catalog.ts` and edited through the admin API (`admin-api.ts`, `/admin/*`,
 * caddy `/api/llm-admin/*`). Two more kernel round trips join the internal plane: the budget-
 * exhausted poll (`budget-sync.ts`, leftover 19) and the per-mutation platform audit row
 * (`postKernelAudit` below → `POST /internal/llm-admin-audit`), both under the same internal
 * token. `models.json` is rewritten only after an admin mutation — never at startup (see
 * `LlmProxyConfig.modelsJsonOutFile`); a mismatch found at startup is logged instead.
 */
export const VERSION = '0.1.0';

export interface LlmProxyApp {
  readonly server: Server;
  readonly reporter: LlmUsageReporter;
  readonly revocationSync: RevocationSync;
  readonly budgetSync: BudgetSync;
  readonly catalog: ProviderCatalog;
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

/** S6-B: one kernel platform audit row per admin mutation (design line "隔离与审计只增不减":
 *  the kernel's `platform_audit_query` shows provider changes next to every other administrator
 *  action, keyed by the token `jti` `issue_llm_admin_token` audited). Best-effort, one attempt —
 *  the proxy's own `level: 'audit'` line is written first and unconditionally. */
function makeKernelAuditPoster(
  kernelUrl: string,
  authorizationHeader: string,
  fetchImpl: typeof fetch = fetch,
): (event: KernelAuditEvent) => Promise<void> {
  return async (event) => {
    const res = await fetchImpl(`${kernelUrl}/internal/llm-admin-audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authorizationHeader },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`kernel responded ${res.status}`);
  };
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

  const store = new ProviderStore(config.providerStoreFile);
  await store.load();
  const catalog = new ProviderCatalog(providersFile.providers, store);
  const log = (line: string) => console.log(line);

  // Report (never fix) a stale models.json at startup — see the module doc comment.
  const desired = serializeModelsJson(
    buildModelsJsonFromCatalog(catalog, { llmProxyPort: config.port }),
  );
  const current = await readFile(config.modelsJsonOutFile, 'utf8').catch(() => undefined);
  if (current !== desired) {
    log(
      JSON.stringify({
        level: current === undefined ? 'info' : 'warn',
        msg:
          current === undefined
            ? 'llm-proxy: models.json not readable at startup (fine on a dev machine); it is written after the first admin mutation or by `make gen-models`'
            : 'llm-proxy: models.json differs from the merged provider catalog — run `make gen-models`, or save any provider in the console, to regenerate it',
        modelsJsonOutFile: config.modelsJsonOutFile,
        storeProviders: store.entries().length,
      }),
    );
  }

  const revocationSync = startRevocationSync({
    kernelUrl: config.kernelUrl,
    authorizationHeader,
    intervalMs: config.revocationSyncIntervalMs,
    overlapMs: config.revocationSyncOverlapMs,
  });

  const budgetSync = startBudgetSync({
    kernelUrl: config.kernelUrl,
    authorizationHeader,
    intervalMs: config.budgetSyncIntervalMs,
  });

  const reporter = new LlmUsageReporter({
    kernelUrl: config.kernelUrl,
    authorizationHeader,
    flushIntervalMs: config.usageFlushIntervalMs,
    maxFlushIntervalMs: config.usageMaxFlushIntervalMs,
    maxQueueSize: config.usageMaxQueueSize,
  });

  const adminHandler = createAdminApi({
    catalog,
    store,
    publicKey,
    writeModelsJson: () =>
      writeModelsJsonAtomic(
        config.modelsJsonOutFile,
        buildModelsJsonFromCatalog(catalog, { llmProxyPort: config.port }),
      ),
    kernelAudit:
      config.kernelUrl && authorizationHeader
        ? makeKernelAuditPoster(config.kernelUrl, authorizationHeader)
        : undefined,
    runTest: (provider, model, realKey) =>
      runProviderTest({ provider, model, realKey, timeoutMs: config.providerTestTimeoutMs }),
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    log,
  });

  const server = createProxyServer({
    providers: (name) => catalog.getRoutable(name),
    publicKey,
    isRevoked: (jti: string) => revocationSync.isRevoked(jti),
    isBudgetExhausted: (workspaceId: string) => budgetSync.isExhausted(workspaceId),
    adminHandler,
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
    budgetSync,
    catalog,
    async close(): Promise<void> {
      revocationSync.close();
      budgetSync.close();
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
