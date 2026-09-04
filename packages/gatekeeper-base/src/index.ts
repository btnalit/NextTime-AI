import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Operation } from '@nexttime/shared';
import {
  ConnectedAccountCredentialResolver,
  ConnectedAccountStore,
  SharedEnvCredentialResolver,
} from './credentials/index.js';
import type { CredentialResolver } from './credentials/index.js';
import { resolveGateDataDir } from './data-dir.js';
import { GatekeeperBase } from './gatekeeper-base.js';
import { JsonFileIdempotencyStore } from './idempotency-store.js';
import { CliTransport, HttpTransport, McpTransport, SshTransport } from './kinds/index.js';
import type { SshPolicyRule, SshTarget, Transport } from './kinds/index.js';
import { createGatekeeperServer } from './server.js';
import { buildTlsFetch, gateTlsOptionsFromEnv, insecureTlsEnvWarning } from './tls.js';

/**
 * @nexttime/gatekeeper-base — protocol, four transport kinds (http/mcp/cli/ssh), manifest model,
 * credential resolution, idempotent apply storage (design doc §7.5). A concrete Gatekeeper
 * instance (S2.5's `gatekeepers/docker`/`gatekeepers/ragflow`, or a future S2.13-registered
 * instance) is this package's own `main()` for the common `http`/`cli` cases below, driven
 * entirely by env vars and a manifest file — no per-system code required, matching this task's own
 * "门不是逐系统写的代码" goal. A gate needing `mcp`/`ssh` transports, or non-file-based manifest
 * loading, constructs `GatekeeperBase`/`createGatekeeperServer` directly instead of using `main()`.
 */
export const VERSION = '0.1.0';

export { GatekeeperBase } from './gatekeeper-base.js';
export { buildTlsFetch, gateTlsOptionsFromEnv, insecureTlsEnvWarning } from './tls.js';
export type { GateTlsOptions } from './tls.js';
export type {
  ApplyResult,
  GatekeeperBaseCallContext,
  GatekeeperBaseOptions,
  HealthResult,
  ObserveResult,
  RevertResult,
  SimulateResult,
} from './gatekeeper-base.js';

export { createGatekeeperServer, mapGatekeeperError } from './server.js';
export type { CreateGatekeeperServerOptions } from './server.js';

export {
  ApplyRequestSchema,
  DescribeOperationsRequestSchema,
  DescribeOperationsResponseSchema,
  HealthResponseSchema,
  ObservedFactCandidateSchema,
  ObserveRequestSchema,
  ObserveResponseSchema,
  RevertRequestSchema,
  RevertResponseSchema,
  SimulateRequestSchema,
  SimulateResponseSchema,
} from './protocol.js';
export type {
  ApplyRequest,
  ApplyResponse,
  DescribeOperationsRequest,
  DescribeOperationsResponse,
  HealthResponse,
  ObservedFactCandidate,
  ObserveRequest,
  ObserveResponse,
  RevertRequest,
  RevertResponse,
  SimulateRequest,
  SimulateResponse,
} from './protocol.js';

export * from './errors.js';

export { resolveGateDataDir } from './data-dir.js';

export { assertParamsValid } from './params-validation.js';

export { applyResultMapping } from './result-mapping.js';

export {
  JsonFileIdempotencyStore,
  InMemoryIdempotencyStore,
} from './idempotency-store.js';
export type { IdempotencyStore } from './idempotency-store.js';

export {
  SharedEnvCredentialResolver,
  ConnectedAccountStore,
  ConnectedAccountCredentialResolver,
} from './credentials/index.js';
export type { CredentialResolver, ResolvedCredential } from './credentials/index.js';

export {
  HttpTransport,
  importOpenApi,
  McpTransport,
  importMcpTools,
  CliTransport,
  renderCommandTemplate,
  SshTransport,
  classifyCommand,
} from './kinds/index.js';
export type {
  Transport,
  TransportKind,
  TransportInvokeContext,
  TransportInvokeResult,
  HttpTransportOptions,
  OpenApiDocumentLike,
  McpTransportOptions,
  McpToolLike,
  McpToolsListResult,
  CliTransportOptions,
  ExecFileFn,
  SshTransportOptions,
  SshTarget,
  SshPolicyRule,
  SshClassification,
  SshExecFn,
} from './kinds/index.js';

// -------------------------------------------------------------------------------------------
// main() — env-driven bootstrap for the common http/cli/ssh single-transport case.
// -------------------------------------------------------------------------------------------

async function loadManifest(path: string | undefined): Promise<Operation[]> {
  if (!path) return [];
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Operation[];
}

/**
 * S2.13: also returns the `ConnectedAccountStore` instance itself (`undefined` in shared mode) —
 * `startGatekeeperServer` below passes it to `createGatekeeperServer` so `POST`/
 * `DELETE /gate/connected-accounts` can write to the *same* store `observe`/`apply` read
 * credentials from, rather than constructing (and discarding) a second one.
 */
function buildCredentialResolver(
  mode: string,
  dataDir: string,
  env: NodeJS.ProcessEnv,
): { resolver: CredentialResolver; connectedAccountStore: ConnectedAccountStore | undefined } {
  if (mode === 'connected_account') {
    const keyFilePath = env.GATE_STORE_KEY_FILE;
    if (!keyFilePath) {
      throw new Error('GATE_CREDENTIAL_MODE=connected_account requires GATE_STORE_KEY_FILE');
    }
    const store = new ConnectedAccountStore({ dataDir, keyFilePath });
    return {
      resolver: new ConnectedAccountCredentialResolver(store),
      connectedAccountStore: store,
    };
  }
  return { resolver: new SharedEnvCredentialResolver({ env }), connectedAccountStore: undefined };
}

function buildTransport(kind: string, env: NodeJS.ProcessEnv): Transport {
  // GATE_TLS_CA_FILE / GATE_TLS_SERVERNAME (tls.ts): only the two fetch-based transports have a
  // TLS client to configure; `undefined` keeps the plain global fetch.
  const tls = gateTlsOptionsFromEnv(env);
  const fetchImpl = tls ? buildTlsFetch(tls) : undefined;
  if (kind === 'http') {
    const baseUrl = env.GATE_TARGET_BASE_URL;
    if (!baseUrl) throw new Error('GATE_TRANSPORT_KIND=http requires GATE_TARGET_BASE_URL');
    return new HttpTransport({ baseUrl, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  if (kind === 'mcp') {
    const endpoint = env.GATE_TARGET_ENDPOINT;
    if (!endpoint) throw new Error('GATE_TRANSPORT_KIND=mcp requires GATE_TARGET_ENDPOINT');
    return new McpTransport({ endpoint, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  if (kind === 'cli') {
    return new CliTransport();
  }
  if (kind === 'ssh') {
    const host = env.GATE_SSH_HOST;
    const user = env.GATE_SSH_USER;
    if (!host || !user) {
      throw new Error('GATE_TRANSPORT_KIND=ssh requires GATE_SSH_HOST and GATE_SSH_USER');
    }
    const strict = env.GATE_SSH_STRICT_HOST_KEY_CHECKING;
    if (strict !== undefined && strict !== 'yes' && strict !== 'accept-new' && strict !== 'no') {
      throw new Error(
        `GATE_SSH_STRICT_HOST_KEY_CHECKING must be yes | accept-new | no (got "${strict}")`,
      );
    }
    const target: SshTarget = {
      host,
      user,
      port: env.GATE_SSH_PORT ? Number(env.GATE_SSH_PORT) : undefined,
      identityFile: env.GATE_SSH_IDENTITY_FILE,
      // Host-key policy (kinds/ssh.ts): production gates pin the target's key in a known_hosts
      // file (`yes` + GATE_SSH_KNOWN_HOSTS_FILE); test fixtures may use `no`. Unset → OpenSSH's
      // own default, which under BatchMode fails closed on an unknown host.
      strictHostKeyChecking: strict,
      knownHostsFile: env.GATE_SSH_KNOWN_HOSTS_FILE,
    };
    const policyTable: SshPolicyRule[] = env.GATE_SSH_POLICY_FILE
      ? (JSON.parse(env.GATE_SSH_POLICY_FILE) as SshPolicyRule[])
      : [];
    return new SshTransport({ target, policyTable });
  }
  throw new Error(`unknown GATE_TRANSPORT_KIND "${kind}" (expected http/mcp/cli/ssh)`);
}

export async function startGatekeeperServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ app: ReturnType<typeof createGatekeeperServer>; close(): Promise<void> }> {
  const dataDir = resolveGateDataDir(env);
  const manifest = await loadManifest(env.GATE_MANIFEST_FILE);
  const insecure = insecureTlsEnvWarning(env);
  if (insecure) console.warn(JSON.stringify({ level: 'warn', msg: insecure }));
  const transport = buildTransport(env.GATE_TRANSPORT_KIND ?? 'http', env);
  const { resolver: credentialResolver, connectedAccountStore } = buildCredentialResolver(
    env.GATE_CREDENTIAL_MODE ?? 'shared',
    dataDir,
    env,
  );
  const idempotencyStore = new JsonFileIdempotencyStore(dataDir);

  const gate = new GatekeeperBase({ manifest, transport, credentialResolver, idempotencyStore });
  const app = createGatekeeperServer({ gate, logger: true, connectedAccountStore });

  const port = Number(env.GATE_PORT ?? 8090);
  const host = env.GATE_BIND_ADDR ?? '0.0.0.0';
  await app.listen({ port, host });

  return { app, close: () => app.close() };
}

export function main(): void {
  startGatekeeperServer().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'gatekeeper-base: failed to start',
        error: String(err),
      }),
    );
    process.exitCode = 1;
  });
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
