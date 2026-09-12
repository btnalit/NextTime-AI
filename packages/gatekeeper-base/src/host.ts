import { readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { GateHostedDefinitionWire, Operation } from '@nexttime/shared';
import {
  GATE_SHARED_CREDENTIAL_SLOT,
  GateHostedDefinitionWireSchema,
  importHandlePublicKey,
  internalAuthorizationHeader,
  verifyGateHostToken,
} from '@nexttime/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type AnnounceBody,
  GATE_ID_PATTERN,
  loadInternalToken,
  postAnnouncement,
} from './announce.js';
import { ConnectedAccountStore, HostedCredentialResolver } from './credentials/index.js';
import { createGateAuthGuard, loadGateKernelToken } from './gate-auth.js';
import { GatekeeperBase } from './gatekeeper-base.js';
import { JsonFileIdempotencyStore } from './idempotency-store.js';
import { HttpTransport, McpTransport, importMcpTools, importOpenApi } from './kinds/index.js';
import type { OpenApiDocumentLike } from './kinds/index.js';
import type { Transport } from './kinds/types.js';
import { type GateRouteContext, registerGateRoutes } from './server.js';
import { assertTlsNotDisabled, buildTlsFetch, gateTlsOptionsFromEnv } from './tls.js';

/**
 * host: the generic gate host — one process serving N `http` / `mcp` gate instances an administrator
 * created on the integrations page (docs/platform-admin-design.md §6.3 "通用门宿主";
 * docs/development-tasks.md P-B 决定 ⑥–⑬).
 *
 * Loop (`GATE_ANNOUNCE_INTERVAL_SEC`, default 60; 1 s → 30 s backoff while the kernel is unreachable):
 *   pull `GET /internal/gate-host/instances` (internal token — the same trust direction as announce,
 *   决定 ⑥) → reconcile the in-memory table (build a transport + credential resolver + Operations for
 *   each new or changed definition, drop the ones the kernel no longer lists) → announce every built
 *   instance as `${GATE_PUBLIC_ENDPOINT}/i/<gateId>` so the kernel's P-B1 liveness / links / deny
 *   lists apply unchanged (决定 ⑦). An instance whose target cannot be reached (OpenAPI document or
 *   `tools/list` failed) is *not* announced — the kernel keeps showing "not taken over yet" and the
 *   host retries next tick; the reason is one warn line here.
 *
 * Routes (决定 ⑫): the `/gate/*` protocol once under `/i/:gateId`, resolved per request from the
 * table. Auth: `gate_token` (kernel) on every route; additionally, `POST`/`DELETE
 * /i/<gateId>/gate/connected-accounts` accepts a platform token (`verifyGateHostToken`, the kernel's
 * Handle public key from `GATE_HOST_PUBLIC_KEY_FILE`) whose `gate` claim equals the path — the
 * browser posting a credential straight here (决定 ⑩). The slot written is the token's `obo`, never
 * the body's. Credentials live in `/data/gate/<gateId>/` under one `GATE_STORE_KEY_FILE` (决定 ⑪).
 *
 * Never logs a token, a credential, or the internal token.
 */

export const GATE_HOST_DEFAULT_PORT = 8083;
const HOST_ROUTE_PREFIX = '/i/:gateId';
/** Per client IP, per minute, on the one route a browser reaches (the credential POST / DELETE). */
const CREDENTIAL_ROUTE_LIMIT_PER_MINUTE = 30;

/** Fixed-window counter, in-process (one gate host, no shared state needed). */
function createFixedWindowLimiter(
  limit: number,
  windowMs: number,
): { allow(key: string): boolean } {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key) {
      const now = Date.now();
      const entry = windows.get(key);
      if (!entry || now - entry.start >= windowMs) {
        if (windows.size > 10_000) windows.clear();
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  };
}
const DEFAULT_INTERVAL_SEC = 60;
const PULL_TIMEOUT_MS = 5_000;
const BUILD_TIMEOUT_MS = 10_000;

const HostedInstanceListSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    items: z.array(
      z.object({
        gateId: z.string().regex(GATE_ID_PATTERN),
        displayName: z.string().min(1),
        status: z.string(),
        definition: GateHostedDefinitionWireSchema,
      }),
    ),
  }),
});
type HostedInstanceListItem = z.infer<typeof HostedInstanceListSchema>['result']['items'][number];

interface HostedInstance {
  readonly gateId: string;
  readonly displayName: string;
  readonly definition: GateHostedDefinitionWire;
  readonly definitionKey: string;
  readonly store: ConnectedAccountStore;
  /** Set once the target answered and the Operations were imported. */
  gate?: GatekeeperBase;
  operations: readonly Operation[];
  /** Last build failure, for `GET /healthz` and the log; cleared on success. */
  buildError?: string;
}

export interface GateHostOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
  /** Tests: skip `listen` and drive `tick()` by hand. */
  readonly listen?: boolean;
}

export interface GateHost {
  readonly app: FastifyInstance;
  /** One pull → reconcile → announce round; `true` when the kernel answered the pull. */
  tick(): Promise<boolean>;
  start(): void;
  close(): Promise<void>;
  /** Read-only view for tests and `/healthz`. */
  instances(): ReadonlyArray<{
    gateId: string;
    ready: boolean;
    operationCount: number;
    buildError?: string;
  }>;
}

/** Identity of what the instance is built from — the definition only. A rename keeps the built
 *  gate and its credentials; any change to kind / target / mode / manifest rebuilds AND wipes them. */
function definitionKey(item: HostedInstanceListItem): string {
  return JSON.stringify(item.definition);
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  setTimer: typeof setTimeout,
  clearTimer: typeof clearTimeout,
): Promise<{ status: number; ok: boolean; json: unknown }> {
  const controller = new AbortController();
  const timeout = setTimer(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, ok: response.ok, json };
  } finally {
    clearTimer(timeout);
  }
}

export async function createGateHost(options: GateHostOptions = {}): Promise<GateHost> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;

  // Fail closed before any IO, same order as `startGatekeeperServer`.
  const gateToken = loadGateKernelToken(env);
  assertTlsNotDisabled(env);
  const kernelUrl = env.KERNEL_URL?.trim().replace(/\/$/, '');
  if (!kernelUrl) throw new Error('gate host: KERNEL_URL is required');
  const internalToken = loadInternalToken(env);
  const publicKeyFile = env.GATE_HOST_PUBLIC_KEY_FILE;
  if (!publicKeyFile) {
    throw new Error(
      'gate host: GATE_HOST_PUBLIC_KEY_FILE (the kernel Handle public key, config/handle.pub) is required to verify platform tokens',
    );
  }
  const publicKey = await importHandlePublicKey(await readFile(publicKeyFile, 'utf8'));
  const storeKeyFile = env.GATE_STORE_KEY_FILE;
  if (!storeKeyFile) throw new Error('gate host: GATE_STORE_KEY_FILE is required');
  const dataDir = env.GATE_DATA_DIR ?? './data';
  const port = Number(env.GATE_PORT ?? GATE_HOST_DEFAULT_PORT);
  const publicEndpoint = (
    env.GATE_PUBLIC_ENDPOINT ?? `http://${env.GATE_SERVICE_NAME ?? hostname()}:${port}`
  ).replace(/\/$/, '');
  const intervalMs =
    Math.max(5, Number(env.GATE_ANNOUNCE_INTERVAL_SEC ?? DEFAULT_INTERVAL_SEC)) * 1000;
  const tls = gateTlsOptionsFromEnv(env);
  const targetFetch = options.fetchImpl ?? (tls ? buildTlsFetch(tls) : fetch);
  const kernelFetch = options.fetchImpl ?? fetch;

  const table = new Map<string, HostedInstance>();
  const guard = createGateAuthGuard(gateToken);

  // ---- server -----------------------------------------------------------------------------
  const app = Fastify({ logger: false });
  const forcedSlot = new WeakMap<FastifyRequest, string>();

  // Route classes are decided by the *registered* route pattern (`routeOptions.url`, fixed at
  // registration), never by anything the request carries. Two classes, two credentials:
  //   - `CREDENTIAL_ROUTE` (POST / DELETE …/gate/connected-accounts): the platform JWT and nothing
  //     else — `gate_token` is one shared secret every kernel → gate call carries (also on the
  //     kernel's own `create_connection` path, which a workspace owner can aim at any URL), so
  //     accepting it here would let any workspace write any slot of any hosted instance through
  //     the kernel (review finding).
  //   - every other `/i/*` route: `gate_token`, kernel-only.
  const CREDENTIAL_ROUTE = `${HOST_ROUTE_PREFIX}/gate/connected-accounts`;
  const credentialRateLimit = createFixedWindowLimiter(CREDENTIAL_ROUTE_LIMIT_PER_MINUTE, 60_000);

  async function platformSlotFor(request: FastifyRequest): Promise<string | undefined> {
    const gateId = (request.params as { gateId?: string } | undefined)?.gateId;
    if (!gateId) return undefined;
    const presented = request.headers.authorization;
    const bearer =
      typeof presented === 'string' && /^Bearer\s+/i.test(presented)
        ? presented.replace(/^Bearer\s+/i, '').trim()
        : undefined;
    if (!bearer) return undefined;
    try {
      const claims = await verifyGateHostToken(bearer, publicKey, { expectedGateId: gateId });
      return claims.obo;
    } catch {
      // 401 below — never log the token or the reason detail
      return undefined;
    }
  }

  function unauthorized(reply: FastifyReply) {
    reply.code(401);
    reply.header('www-authenticate', 'Bearer');
    return reply.send({ ok: false, error: { code: 'unauthorized', message: 'unauthorized' } });
  }

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url;
    if (typeof route !== 'string' || !route.startsWith(`${HOST_ROUTE_PREFIX}/`)) return;
    if (route === CREDENTIAL_ROUTE) {
      // The only route a browser reaches: bound the rate at which signatures can be tried per
      // client, then verify the platform JWT.
      if (!credentialRateLimit.allow(request.ip)) {
        reply.code(429);
        return reply.send({
          ok: false,
          error: { code: 'rate_limited', message: 'too many requests' },
        });
      }
      const slot = await platformSlotFor(request);
      if (slot === undefined) return unauthorized(reply);
      forcedSlot.set(request, slot);
      return;
    }
    if (!guard.evaluate(request)) return unauthorized(reply);
  });

  registerGateRoutes(app, {
    prefix: HOST_ROUTE_PREFIX,
    resolve: (request): GateRouteContext | undefined => {
      const gateId = (request.params as { gateId?: string } | undefined)?.gateId;
      const instance = gateId ? table.get(gateId) : undefined;
      if (!instance?.gate) return undefined;
      const forced = forcedSlot.get(request);
      return {
        gate: instance.gate,
        connectedAccountStore: instance.store,
        ...(forced !== undefined ? { forcedOnBehalfOf: forced } : {}),
      };
    },
  });

  app.get('/healthz', async () => ({
    ok: true,
    result: {
      instances: [...table.values()].map((i) => ({
        gateId: i.gateId,
        ready: i.gate !== undefined,
        operationCount: i.operations.length,
        ...(i.buildError ? { buildError: i.buildError } : {}),
      })),
    },
  }));

  // ---- build -------------------------------------------------------------------------------
  async function buildInstance(instance: HostedInstance): Promise<void> {
    const { definition } = instance;
    const transport: Transport =
      definition.transportKind === 'http'
        ? new HttpTransport({ baseUrl: definition.target, fetchImpl: targetFetch })
        : new McpTransport({ endpoint: definition.target, fetchImpl: targetFetch });
    const resolver = new HostedCredentialResolver(instance.store, definition.credentialMode);
    let operations: Operation[];
    if (definition.transportKind === 'mcp') {
      const shared =
        definition.credentialMode === 'shared'
          ? await instance.store.get(GATE_SHARED_CREDENTIAL_SLOT)
          : undefined;
      operations = importMcpTools(await (transport as McpTransport).listTools(shared));
    } else if (definition.manifestSource) {
      const fetched = await fetchJsonWithTimeout(
        targetFetch,
        definition.manifestSource,
        { method: 'GET' },
        BUILD_TIMEOUT_MS,
        setTimer,
        clearTimer,
      );
      if (!fetched.ok || fetched.json === undefined) {
        throw new Error(`OpenAPI document responded ${fetched.status}`);
      }
      operations = importOpenApi(fetched.json as OpenApiDocumentLike);
    } else {
      operations = [];
    }
    instance.gate = new GatekeeperBase({
      manifest: operations,
      transport,
      credentialResolver: resolver,
      idempotencyStore: new JsonFileIdempotencyStore(join(dataDir, instance.gateId)),
    });
    instance.operations = operations;
    instance.buildError = undefined;
  }

  /** Credentials belong to one definition (决定 ⑪): when an instance is removed, or re-created with
   *  another target, whatever was stored for it must not follow the id to the new system. */
  async function wipeInstanceData(gateId: string): Promise<void> {
    try {
      await rm(join(dataDir, gateId), { recursive: true, force: true });
    } catch (err) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'gate host: could not remove instance data directory',
          gateId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  async function reconcile(items: readonly HostedInstanceListItem[]): Promise<void> {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.gateId);
      const key = definitionKey(item);
      const existing = table.get(item.gateId);
      if (existing && existing.definitionKey === key) {
        if (existing.displayName !== item.displayName) {
          table.set(item.gateId, { ...existing, displayName: item.displayName });
        }
        continue;
      }
      if (existing) await wipeInstanceData(item.gateId);
      table.set(item.gateId, {
        gateId: item.gateId,
        displayName: item.displayName,
        definition: item.definition,
        definitionKey: key,
        store: new ConnectedAccountStore({
          dataDir: join(dataDir, item.gateId),
          keyFilePath: storeKeyFile as string,
        }),
        operations: [],
      });
      log(
        JSON.stringify({
          level: 'info',
          msg: existing ? 'gate host: instance definition changed' : 'gate host: instance added',
          gateId: item.gateId,
          transportKind: item.definition.transportKind,
        }),
      );
    }
    for (const gateId of [...table.keys()]) {
      if (!seen.has(gateId)) {
        table.delete(gateId);
        await wipeInstanceData(gateId);
        log(JSON.stringify({ level: 'info', msg: 'gate host: instance removed', gateId }));
      }
    }
  }

  async function pull(): Promise<readonly HostedInstanceListItem[] | undefined> {
    try {
      const fetched = await fetchJsonWithTimeout(
        kernelFetch,
        `${kernelUrl}/internal/gate-host/instances`,
        { method: 'GET', headers: { authorization: internalAuthorizationHeader(internalToken) } },
        PULL_TIMEOUT_MS,
        setTimer,
        clearTimer,
      );
      const parsed = HostedInstanceListSchema.safeParse(fetched.json);
      if (!fetched.ok || !parsed.success) {
        log(
          JSON.stringify({
            level: 'warn',
            msg: 'gate host: kernel refused or malformed instance list',
            status: fetched.status,
          }),
        );
        return undefined;
      }
      return parsed.data.result.items;
    } catch (err) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'gate host: kernel unreachable',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return undefined;
    }
  }

  function announceBodyOf(instance: HostedInstance): AnnounceBody {
    const endpoint = `${publicEndpoint}/i/${instance.gateId}`;
    return {
      gateId: instance.gateId,
      connector: instance.definition.transportKind,
      transportKind: instance.definition.transportKind,
      target: instance.definition.target,
      endpoint,
      healthEndpoint: `${endpoint}/gate/health`,
      displayName: instance.displayName,
      operations: instance.operations,
    };
  }

  async function tick(): Promise<boolean> {
    const items = await pull();
    if (!items) return false;
    await reconcile(items);
    for (const instance of table.values()) {
      // Rebuild while not ready (target was unreachable) or while it still has no Operations (an
      // MCP server that listed nothing yet, an OpenAPI document that was empty) — retried every tick.
      if (!instance.gate || instance.operations.length === 0) {
        try {
          await buildInstance(instance);
        } catch (err) {
          instance.buildError = err instanceof Error ? err.message : String(err);
          log(
            JSON.stringify({
              level: 'warn',
              msg: 'gate host: instance not ready (target or manifest unreachable), will retry',
              gateId: instance.gateId,
              error: instance.buildError,
            }),
          );
          continue;
        }
      }
      await postAnnouncement({
        url: `${kernelUrl}/internal/gates/announce`,
        token: internalToken,
        body: announceBodyOf(instance),
        fetchImpl: kernelFetch,
        log,
        setTimer,
        clearTimer,
      });
    }
    return true;
  }

  // ---- loop --------------------------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let backoffMs = 1_000;

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      void loop();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
  }

  async function loop(): Promise<void> {
    const ok = await tick();
    if (stopped) return;
    if (ok) {
      backoffMs = 1_000;
      schedule(intervalMs);
    } else {
      schedule(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  if (options.listen !== false) {
    await app.listen({ port, host: env.GATE_BIND_ADDR ?? '0.0.0.0' });
  } else {
    await app.ready();
  }

  return {
    app,
    tick,
    start() {
      schedule(0);
    },
    async close() {
      stopped = true;
      if (timer) clearTimer(timer);
      await app.close();
    },
    instances() {
      return [...table.values()].map((i) => ({
        gateId: i.gateId,
        ready: i.gate !== undefined,
        operationCount: i.operations.length,
        ...(i.buildError ? { buildError: i.buildError } : {}),
      }));
    },
  };
}

/** Env-driven bootstrap, `GATE_MODE=host` in `main()`. */
export async function startGateHost(env: NodeJS.ProcessEnv = process.env): Promise<GateHost> {
  const host = await createGateHost({ env });
  host.start();
  return host;
}
