import { fileURLToPath } from 'node:url';
import { IllegalTransition, internalAuthorizationHeader } from '@nexttime/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { createPool, withWorkspace } from './adapters/db/pool.js';
import type { PoolLike } from './adapters/db/pool.js';
import { HttpGatekeeperClient } from './adapters/gatekeeper-client/index.js';
import { TaskSupervisorClient } from './adapters/supervisor-client/index.js';
import type { TaskSupervisorClientPort } from './adapters/supervisor-client/index.js';
import {
  chatMessageText,
  createChatEventSink,
  interruptStaleRunningTurns,
} from './application/chat/index.js';
import { setAgentRuntimeForHandlers } from './application/gateway/handlers.js';
import {
  createAdminWithTransaction,
  createGatekeeperActionExecutor,
  reapStaleExecutingActionRequests,
  registerActionRequestDrainConsumer,
  setConnectionHandlerDeps,
  setRequestActionDeps,
} from './application/gateway/index.js';
import type { GatekeeperActionExecutorDeps } from './application/gateway/index.js';
import type { AgentRuntime, ResolveTurnPrompt } from './application/host-bridge/index.js';
import {
  AgentHostRuntime,
  FakeAgentRuntime,
  registerTurnStartedConsumer,
} from './application/host-bridge/index.js';
import { registerLinkageConsumers } from './application/linkage/index.js';
import { OutboxDispatcher } from './application/outbox/index.js';
import {
  configureTaskRuntime,
  registerActionRequestRoutingConsumer,
  runTaskReaper,
} from './application/task/index.js';
import {
  ApprovalDrainer,
  expireOverduePendingApprovals,
  listDistinctExecutableGatekeepers,
} from './governance/approval/index.js';
import type { HandleKeyPair } from './governance/capability/index.js';
import { loadHandleKeyPair } from './governance/capability/index.js';
import { SYSTEM_ACTOR_PLACEHOLDER } from './governance/gatekeepers/index.js';
import type { CapabilityRouteDeps } from './interfaces/http/index.js';
import { registerCapabilityRoutes, registerExplorerHttpRoutes } from './interfaces/http/index.js';
import type { InternalRoutesDeps } from './interfaces/http/internal/index.js';
import { registerInternalRoutes } from './interfaces/http/internal/index.js';
import type { InternalPlaneAuthConfig } from './interfaces/internal-auth/index.js';
import { loadInternalToken, registerInternalPlaneGuard } from './interfaces/internal-auth/index.js';
import { registerMcpRoute } from './interfaces/mcp/index.js';
import {
  registerAgentHostWsRoute,
  registerWsRoute,
  setAgentHostRuntimeForWsRoute,
} from './interfaces/ws/index.js';
import type { InvariantCheckResult } from './substrate/audit/index.js';
import { renderInvariantMetricsPrometheus, runInvariantChecks } from './substrate/audit/index.js';

/**
 * The one canonical construction of "a `GatekeeperClient` + the admin-mode `ActionExecutor` over
 * it" (S2.4 coordinator review — "the single shared executor path"): both `createServer()` and
 * `createBackgroundServices` use it to build their own `ApprovalDrainer` — `createServer()` wires
 * its instance into `request_action`'s phase-2 continuation (`setRequestActionDeps`, P2-2 fix:
 * inline execution now routes through the drainer's per-Gatekeeper ordering rather than calling
 * `ActionExecutor` directly), `createBackgroundServices` wires its own into the outbox
 * consumer + periodic tick trigger paths. Two separate `ActionExecutor`/`ApprovalDrainer` instances
 * (one per caller) are behaviorally identical — neither type has meaningful internal state beyond
 * what `gatekeeperClient`/`withTransaction` already determine, and `ApprovalDrainer`'s own
 * in-memory single-flight set is an optimization, not a correctness mechanism (the DB row lock +
 * conditional UPDATE is) — so this is about having exactly one definition of *how* to build the
 * pieces, not about sharing a single JS object across the sync/async construction split below
 * (`createServer` has no async dependency and can build its own before the port opens;
 * `createBackgroundServices` is built later, once `AgentRuntime`'s own async bootstrap finishes).
 */
interface GatekeeperExecutionDeps extends GatekeeperActionExecutorDeps {
  readonly actionExecutor: ReturnType<typeof createGatekeeperActionExecutor>;
}

function buildGatekeeperExecutionDeps(pool: PoolLike): GatekeeperExecutionDeps {
  const gatekeeperClient = new HttpGatekeeperClient();
  const withTransaction = createAdminWithTransaction(pool);
  const actionExecutor = createGatekeeperActionExecutor({ gatekeeperClient, withTransaction });
  return { gatekeeperClient, withTransaction, actionExecutor };
}

/**
 * Builds the kernel's Fastify instance. This is the composition root (design doc §7.1, §7.10):
 * it is the one place allowed to import across every layer (substrate/governance/application/
 * adapters/interfaces) — `createPool()` (adapters) is built here and injected into
 * `interfaces/http`/`interfaces/ws` as `CapabilityRouteDeps`/`WsRouteDeps`, so neither
 * `interfaces` module itself ever imports adapters or substrate directly.
 *
 * S1.4 additions: `registerWsRoute` (the `/ws` chat WebSocket, design doc §9.4) is registered
 * here alongside the existing capability HTTP route. `createBackgroundServices`/`main()` below
 * wire the outbox dispatcher and the `AgentRuntime` — those are process-level, not per-request,
 * so they are deliberately *not* part of `createServer()` itself (a test that only needs the HTTP
 * surface, e.g. index.test.ts's existing `GET /api/health` check, must not accidentally start a
 * background poll loop against a pool that was never meant to be connected to).
 */
export function createServer(
  deps: KernelServerDeps,
  options: CreateServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // S2.4: wired here (not createBackgroundServices) so `request_action` is servable as soon as
  // the port opens, not only once the async AgentRuntime bootstrap below finishes — building a
  // `GatekeeperClient` + admin-mode `ActionExecutor` needs nothing async, only `deps.pool`
  // (already in hand here). `createBackgroundServices` builds its own second `ApprovalDrainer`
  // instance (same construction, needed only once its own async bootstrap finishes) for the
  // outbox consumer + periodic tick trigger paths — this one is `request_action`'s own phase 2
  // (P2-2 fix: routing inline execution through the drainer, request-action-handler.ts's own doc
  // comment on `RequestActionHandlerDeps.drainer` has the full "two behaviorally-identical
  // instances" reasoning), which never waits on either of those.
  const { gatekeeperClient, actionExecutor, withTransaction } = buildGatekeeperExecutionDeps(
    deps.pool,
  );
  const requestActionDrainer = new ApprovalDrainer({ executor: actionExecutor, withTransaction });
  setRequestActionDeps({
    gatekeeperClient,
    drainer: requestActionDrainer,
    awaitDecisionTimeoutMs: options.requestActionAwaitDecisionTimeoutMs,
  });
  // S2.13: `create_connection`'s handler reuses the *same* `GatekeeperClient` instance
  // `request_action` uses — one HTTP client construction, same "single shared executor path"
  // reasoning `buildGatekeeperExecutionDeps`'s own doc comment gives for `ActionExecutor`.
  setConnectionHandlerDeps({ gatekeeperClient });

  app.get('/api/health', async () => ({ status: 'ok' }));

  // Internal-plane shared-secret guard (interfaces/internal-auth): one root-level `onRequest`
  // hook that 401s every route whose pattern starts with `/internal/` — the HTTP routes below
  // *and* the `/internal/agent-host` WebSocket upgrade — unless `Authorization: Bearer <token>`
  // matches `options.internalAuth.token` (constant-time) and the TCP peer is outside
  // `options.internalAuth.workersSubnet`. Installed before the routes purely for readability;
  // Fastify resolves hook chains at `preReady`. With no `internalAuth` (tests that never touch
  // the internal plane) the guard is fail-closed, never open — `main()` always supplies one and
  // refuses to start without the token file (`loadInternalToken`).
  registerInternalPlaneGuard(app, options.internalAuth);

  registerCapabilityRoutes(app, deps);
  // S3.5 (docs/development-tasks.md §S3.5, design doc §9.5): the nine Explorer endpoints, same
  // `deps` (only `pool`/`loadHandlePublicKey` are used — `ExplorerRouteDeps` is structurally a
  // subset of `CapabilityRouteDeps`).
  registerExplorerHttpRoutes(app, deps);
  registerWsRoute(app, deps);
  // `/mcp` (S3.6, docs/development-tasks.md W2-B): streamable HTTP MCP gateway, Handle channel
  // only — see interfaces/mcp/index.ts's own module doc comment for the full auth/tool-projection
  // contract. `deps` (CapabilityRouteDeps: `{pool, loadHandlePublicKey?}`) is directly assignable
  // to `McpRouteDeps` with no adaptation, same as the two calls above.
  registerMcpRoute(app, deps);
  // `/internal/*` (S1.7): service-to-service routes for `llm-proxy` (usage reports, revocation
  // sync) and `egress-proxy` (egress observations), plus `GET /internal/metrics` (S3.8). The
  // kernel is dual-homed on `control` and `workers` and binds every interface, so these are
  // reachable from every agent container — the guard above is what actually closes them (see
  // interfaces/internal-auth's doc comment). `deps.renderMetrics` (optional — `MetricsRoutesDeps`)
  // is `main()`'s `InvariantMetricsStore.renderMetrics`, so `/internal/metrics` reports whatever
  // `createBackgroundServices`'s scheduler tick below most recently wrote into that same store;
  // omitted here (any test building `deps` without it), the route still exists but reports "no
  // metrics source wired" (metrics.ts's own default).
  app.register(async (instance) => {
    await registerInternalRoutes(instance, deps);
  });
  // `/internal/agent-host` (S1.5, second half): agent-host's event-bridge WebSocket — behind the
  // same guard as the `/internal/*` HTTP routes above (the upgrade is rejected before `hello`).
  // Registered unconditionally (independent of AGENT_RUNTIME) — see interfaces/ws/agent-host.ts's
  // own doc comment for why a connection is simply closed when no AgentHostRuntime has been
  // registered.
  registerAgentHostWsRoute(app);

  return app;
}

export interface KernelServerDeps extends CapabilityRouteDeps, InternalRoutesDeps {}

export interface CreateServerOptions {
  /** Fastify's own `logger` option — the structured per-call log (§12) is written regardless of
   *  this setting (interfaces/http/capability-route.ts uses `request.log`, a no-op sink when
   *  `logger` is `false`); this only controls Fastify's own request/response access log. */
  logger?: boolean;
  /** `request_action`'s `await_decision:true` poll timeout (default 90s,
   *  request-action-handler.ts's own `DEFAULT_AWAIT_DECISION_TIMEOUT_MS`) — `main()` reads this
   *  from `REQUEST_ACTION_AWAIT_DECISION_TIMEOUT_MS`. */
  requestActionAwaitDecisionTimeoutMs?: number;
  /** Shared-secret authentication for the internal plane (`/internal/*` + the agent-host
   *  WebSocket) — interfaces/internal-auth. `main()` builds it from `NEXTTIME_INTERNAL_TOKEN_FILE`
   *  (`loadInternalToken`, default `/run/secrets/internal_token`) and `NEXTTIME_SUBNET_WORKERS`.
   *  Omitted → the internal plane is fail-closed (every request 401), never unauthenticated; a
   *  test that exercises an internal route must pass one. */
  internalAuth?: InternalPlaneAuthConfig;
}

// ---------------------------------------------------------------------------------------------
// Background services: the outbox dispatcher + AgentRuntime wiring (design doc §7.10 outbox;
// §7.1 host-bridge; docs/development-tasks.md S1.4 deliverable 5 "wires it in main() when
// AGENT_RUNTIME=fake (default until S1.5 lands — document)").
// ---------------------------------------------------------------------------------------------

/**
 * `AGENT_RUNTIME` values this kernel build knows how to construct: `"fake"` (`FakeAgentRuntime`,
 * S1.4 default) or `"agent-host"` (`AgentHostRuntime`, S1.5 second half — the real, pi-backed
 * runtime over agent-host's WebSocket bridge, design doc §7.1 host-bridge: "pi 是唯一计划的实现").
 * `resolveAgentRuntimeKind` below fails fast (before opening a DB pool or binding a port) on
 * anything else, rather than silently falling back, so a misconfigured deployment finds out
 * immediately instead of quietly running degraded.
 */
export type AgentRuntimeKind = 'fake' | 'agent-host';

export function resolveAgentRuntimeKind(env: NodeJS.ProcessEnv = process.env): AgentRuntimeKind {
  const raw = env.AGENT_RUNTIME ?? 'fake';
  if (raw !== 'fake' && raw !== 'agent-host') {
    throw new Error(
      `AGENT_RUNTIME="${raw}" is not a recognized kind — use "fake" or "agent-host". Unset AGENT_RUNTIME to default to "fake".`,
    );
  }
  return raw;
}

export interface BackgroundServices {
  readonly dispatcher: OutboxDispatcher;
  readonly runtime: AgentRuntime;
  /**
   * Runs the S1.4 deliverable-7 startup recovery scan (`interruptStaleRunningTurns` —
   * application/chat/recovery.ts, design doc §13 "内核重启：扫描 ... running Turn") and then starts
   * the outbox dispatcher's poll loop (design doc §13 "重启后重放未投递事件": the very first poll
   * after a kernel restart drains anything left undelivered by the previous process, same as every
   * later poll — there is no separate "replay" step). Recovery runs first so a client cannot
   * observe a Turn this process considers freshly `running` when it is actually a leftover from a
   * previous one — see recovery.ts's own doc comment for what `interrupted` means going forward.
   * Also starts the S2.3 approval-expiry reaper's interval loop (`governance/approval`'s
   * `expireOverduePendingApprovals` — same "poll on an interval, never one txn per workspace"
   * shape as the outbox dispatcher), the outbox-prune loop (`OutboxDispatcher.pruneDispatched`,
   * fix/invoke-worker-wait-and-outbox-prune — first tick shortly after this call, unlike the other
   * reapers here; see `OUTBOX_PRUNE_INITIAL_DELAY_MS`'s own doc comment), and the S3.8 invariant-
   * check loop (`substrate/audit`'s `runInvariantChecks` — also a short first-tick delay, same
   * reasoning as outbox-prune; see `INVARIANT_CHECK_INITIAL_DELAY_MS`'s own doc comment).
   */
  start(): Promise<void>;
  /** Stops the poll loop, the approval-expiry reaper's interval, the outbox-prune loop, the
   *  invariant-check loop, and unregisters the `TurnStarted` consumer. Does not wait for an
   *  in-flight poll/reaper/prune/check tick — see OutboxDispatcher.stop()'s own doc comment for
   *  why that is safe. */
  stop(): void;
}

export interface CreateBackgroundServicesOptions {
  readonly pool: Pool;
  /** Overrides the constructed `AgentRuntime` — for tests. Production always goes through
   *  `main()`'s `AGENT_RUNTIME` env switch (`resolveAgentRuntimeKind`/`kind` below). */
  readonly runtime?: AgentRuntime;
  /** Which `AgentRuntime` to construct when `runtime` is not given. Defaults to
   *  `resolveAgentRuntimeKind()` (reads `AGENT_RUNTIME`, defaults to `"fake"`) — `main()` passes
   *  its own already-resolved value explicitly so this function never re-reads `process.env` on
   *  its own. */
  readonly kind?: AgentRuntimeKind;
  /** The kernel's Handle-signing keypair (governance/capability/keys.ts `loadHandleKeyPair`) —
   *  required when `kind === 'agent-host'` (or when `runtime` is omitted and `AGENT_RUNTIME=
   *  agent-host`): `AgentHostRuntime` issues entry Handles and therefore needs the private half.
   *  `main()` loads this asynchronously before calling `createBackgroundServices` (this function
   *  itself stays synchronous, matching its pre-existing signature and every current caller,
   *  e.g. interfaces/ws/server.test.ts). Ignored for `kind === 'fake'`. */
  readonly handleKeyPair?: HandleKeyPair;
  /** `AgentHostRuntime`'s `kernelLlmUrl` (forwarded verbatim in every `startTurn` command — see
   *  its own doc comment). `main()` reads this from `KERNEL_LLM_URL`; defaults to
   *  `http://llm-proxy:8082` (worker-supervisor's own `config.ts` default for the same value) so
   *  a `kind: 'agent-host'` caller that omits it still gets a sane compose-network default. */
  readonly kernelLlmUrl?: string;
  /** `AgentHostRuntime`'s entry-Handle ttl override — `main()` reads this from
   *  `ENTRY_HANDLE_TTL_SECONDS` (design doc S1.5b architecture point 2: "default 86400"). */
  readonly entryHandleTtlSeconds?: number;
  /** `AgentHostRuntime`'s `turnAccepted`/`turnRejected` wait timeout override — `main()` reads
   *  this from `AGENT_HOST_TURN_ACCEPTED_TIMEOUT_MS` (architecture point 2: "e.g. 30s"). */
  readonly turnAcceptedTimeoutMs?: number;
  /** `expireOverduePendingApprovals`'s cutoff (default `DEFAULT_APPROVAL_TIMEOUT_MS`, 24h) —
   *  `main()` reads this from `APPROVAL_TIMEOUT_MS` (docs/development-tasks.md S2.3 "expire（reaper，
   *  可配置超时）"). */
  readonly approvalTimeoutMs?: number;
  /** How often the S2.3 approval-expiry reaper polls. Default `DEFAULT_APPROVAL_REAPER_INTERVAL_MS`
   *  (5 minutes) — `main()` reads this from `APPROVAL_REAPER_INTERVAL_MS`. */
  readonly approvalReaperIntervalMs?: number;
  /** Called whenever a reaper tick's `expireOverduePendingApprovals` call throws, so it never
   *  becomes an unhandled promise rejection — same shape as `OutboxDispatcher`'s own `onError`.
   *  Defaults to a no-op; `main()` passes `app.log.error`. */
  readonly onApprovalReaperError?: (error: unknown) => void;
  /** How often the S2.4 Gatekeeper-queue periodic drain tick runs. Default
   *  `DEFAULT_GATEKEEPER_DRAIN_INTERVAL_MS` (1 minute — much tighter than the approval reaper's 5,
   *  since a stuck executable queue directly blocks a Worker's already-approved action, not merely
   *  an unattended timeout). `main()` reads this from `GATEKEEPER_DRAIN_INTERVAL_MS`. */
  readonly gatekeeperDrainIntervalMs?: number;
  /** Called whenever the periodic drain tick's scan or any `drainGatekeeper` call throws
   *  unexpectedly (an `IllegalTransition` — a benign race with another drain trigger — is already
   *  swallowed inside `registerActionRequestDrainConsumer`/here, never reaches this hook). Defaults
   *  to a no-op; `main()` passes `app.log.error`. */
  readonly onGatekeeperDrainError?: (error: unknown) => void;
  /** How often the P1-3 stale-`executing`-ActionRequest reaper polls. Default
   *  `DEFAULT_ACTION_REQUEST_REAPER_INTERVAL_MS` (5 minutes — same cadence as the approval-expiry
   *  reaper; a stuck `executing` row is a crash-recovery backstop, not a latency-sensitive path).
   *  `main()` reads this from `ACTION_REQUEST_REAPER_INTERVAL_MS`. */
  readonly actionRequestReaperIntervalMs?: number;
  /** `reapStaleExecutingActionRequests`'s staleness threshold (default `DEFAULT_STALE_EXECUTING_
   *  TIMEOUT_MS`, 10 minutes — comfortably past any real `apply` call's expected latency, so this
   *  only ever catches a row a crash actually orphaned). `main()` reads this from
   *  `ACTION_REQUEST_STALE_EXECUTING_TIMEOUT_MS`. */
  readonly staleExecutingTimeoutMs?: number;
  /** Called for a stale-`executing` row whose replay genuinely failed (never for the benign "it
   *  was already resolved" race — see `reapStaleExecutingActionRequests`'s own doc comment).
   *  Defaults to a no-op; `main()` passes `app.log.error`. */
  readonly onActionRequestReaperError?: (actionRequestId: string, error: unknown) => void;
  /**
   * S2.7: `worker-supervisor`'s Task-mode base URL (`adapters/supervisor-client`'s
   * `TaskSupervisorClient`, e.g. `http://worker-supervisor:8081`) — `main()` reads this from
   * `SUPERVISOR_URL` (the same env var `packages/agent-host` already uses for the resident-mode
   * client, the deployment compose file). Ignored when `taskSupervisorClient` is given directly
   * (tests).
   */
  readonly supervisorUrl?: string;
  /**
   * `Authorization` header value the constructed `TaskSupervisorClient` sends on every request to
   * worker-supervisor (`POST /task/spawn` requires it — `packages/worker-supervisor/src/
   * internal-auth.ts`; lane-6 review follow-up, 2026-09). `main()` builds this with
   * `internalAuthorizationHeader(token)` from the *same* token `loadInternalToken()` already loaded
   * for the kernel's own `/internal/*` guard (`internalAuth.token` above) — no second env var, no
   * second file read. Ignored when `taskSupervisorClient` is given directly (tests).
   */
  readonly supervisorAuthorizationHeader?: string;
  /** Overrides the constructed `TaskSupervisorClientPort` — for tests (a fake, no network). */
  readonly taskSupervisorClient?: TaskSupervisorClientPort;
  /** How often the S2.7 task reaper polls (duration-limit enforcement + supervisor-status
   *  reconciliation). Default `DEFAULT_TASK_REAPER_INTERVAL_MS` (30s — much tighter than the
   *  approval reaper's 5 minutes, matching `worker-supervisor`'s own 30s `reap()` cadence). */
  readonly taskReaperIntervalMs?: number;
  /** Called whenever a reaper tick's `runTaskReaper` call throws — same shape as
   *  `onApprovalReaperError`. Defaults to a no-op; `main()` passes `app.log.error`. */
  readonly onTaskReaperError?: (error: unknown) => void;
  /**
   * `OutboxDispatcher.pruneDispatched`'s `olderThanDays` — deletes dispatched outbox rows older
   * than this many days on a periodic tick (fix/invoke-worker-wait-and-outbox-prune: `pruneDispatched`
   * itself landed in PR #76 with nothing calling it yet). Default `DEFAULT_OUTBOX_PRUNE_DAYS` (7).
   * `0` disables the prune loop entirely (no timer is ever started) — an explicit opt-out, not a
   * "prune everything" footgun. `main()` reads this from `OUTBOX_PRUNE_DAYS`.
   */
  readonly outboxPruneDays?: number;
  /** How often the outbox-prune tick runs. Default `DEFAULT_OUTBOX_PRUNE_INTERVAL_MS` (6 hours —
   *  pruning is cleanup, not a latency-sensitive path; much coarser than every other reaper here).
   *  `main()` reads this from `OUTBOX_PRUNE_INTERVAL_MS`. Ignored when `outboxPruneDays` is `0`. */
  readonly outboxPruneIntervalMs?: number;
  /** Called whenever a prune tick's `pruneDispatched` call throws — same shape as
   *  `onApprovalReaperError`. Defaults to a no-op; `main()` passes `app.log.error`. */
  readonly onOutboxPruneError?: (error: unknown) => void;
  /** Called after each successful prune tick with the number of rows deleted — the hook `main()`
   *  uses to log `{ deleted }` at info (task brief: "log `{ deleted }` at info"). Defaults to a
   *  no-op; a tick that deletes 0 rows still calls this (0 is a normal, expected outcome once the
   *  backlog is caught up, not worth suppressing). */
  readonly onOutboxPruneComplete?: (result: { deleted: number }) => void;
  /**
   * S3.8: how often `substrate/audit`'s `runInvariantChecks` runs. Default
   * `DEFAULT_INVARIANT_CHECK_INTERVAL_MS` (10 minutes); `0` disables the scheduler entirely (no
   * timer is ever started — see that constant's own doc comment). `main()` reads this from
   * `INVARIANT_CHECK_INTERVAL_MS`.
   */
  readonly invariantCheckIntervalMs?: number;
  /** Where the scheduler tick writes its snapshot for `GET /internal/metrics` to read
   *  (`createServer`'s `deps.renderMetrics` must be built over this same instance — see
   *  `InvariantMetricsStore`'s own doc comment). Optional so a test exercising other background
   *  services need not construct one; the tick still runs and still logs via
   *  `onInvariantCheckComplete` below, it just has nowhere durable to publish its snapshot. */
  readonly invariantMetrics?: InvariantMetricsStore;
  /** Called whenever a tick's `runInvariantChecks` call itself throws (a real connectivity/driver
   *  error, not "found violations") — same shape as `onApprovalReaperError`. Defaults to a no-op;
   *  `main()` passes `app.log.error`. */
  readonly onInvariantCheckError?: (error: unknown) => void;
  /** Called after each successful tick with the full result set (every check, violated or not) —
   *  the hook `main()` uses to log one structured line per *violated* invariant (task brief: "logs
   *  a structured line per violated invariant"); this file itself stays logger-agnostic, same
   *  convention as every other `onXComplete`/`onXError` hook above. Defaults to a no-op. */
  readonly onInvariantCheckComplete?: (results: readonly InvariantCheckResult[]) => void;
}

/**
 * `application/task`'s `TaskRuntimeDeps` (Handle-signing private key + a `TaskSupervisorClientPort`)
 * is configured **only when a Handle-signing keypair is actually available**
 * (`options.handleKeyPair`) — regardless of `kind`/`AGENT_RUNTIME`, since `invoke_worker` needs to
 * mint Handles independent of which `AgentRuntime` is wired (design doc §5.1.4; docs/development-
 * tasks.md S2.7). When no keypair is supplied (e.g. a test that only exercises chat/WS and never
 * sets one — `interfaces/ws/server.test.ts`'s existing `createBackgroundServices({pool})` call,
 * unchanged by this addition), the task runtime is simply never configured: an `invoke_worker` call
 * in that configuration throws `TaskRuntimeNotConfiguredError` (application/task/runtime.ts) only
 * if and when someone actually calls it — never an eager startup failure. This mirrors
 * `buildDefaultRuntime`'s own "only load what `kind` needs" discipline one level further: nothing
 * here *requires* `main()` to always supply a keypair, but `main()` does so unconditionally in
 * practice (see its own updated doc comment) because the target deployment's `handle_key` secret
 * is mounted into the kernel container regardless of `AGENT_RUNTIME` (the deployment compose
 * file).
 */
const DEFAULT_TASK_SUPERVISOR_URL = 'http://worker-supervisor:8081';
const DEFAULT_TASK_REAPER_INTERVAL_MS = 30 * 1000;

const DEFAULT_AGENT_HOST_KERNEL_LLM_URL = 'http://llm-proxy:8082';

/** Builds the default `AgentRuntime` (used whenever `options.runtime` is not given) per
 *  `options.kind` (or `resolveAgentRuntimeKind()` when `kind` itself is omitted). Wiring an
 *  `AgentHostRuntime` into `interfaces/ws/agent-host.ts`'s connection seam
 *  (`setAgentHostRuntimeForWsRoute`) happens unconditionally whenever the resolved runtime *is*
 *  one — by `instanceof`, not by `kind` — so a test that passes a pre-built `AgentHostRuntime` as
 *  `options.runtime` gets wired the same way a freshly constructed one does. */
function buildDefaultRuntime(options: CreateBackgroundServicesOptions): AgentRuntime {
  const kind = options.kind ?? resolveAgentRuntimeKind();
  const sink = createChatEventSink({ pool: options.pool });

  if (kind === 'fake') return new FakeAgentRuntime({ sink });

  if (!options.handleKeyPair) {
    throw new Error(
      'createBackgroundServices: AGENT_RUNTIME=agent-host requires options.handleKeyPair ' +
        '(main() loads it via loadHandleKeyPair() before calling this function)',
    );
  }
  return new AgentHostRuntime({
    pool: options.pool,
    sink,
    privateKey: options.handleKeyPair.privateKey,
    kernelLlmUrl: options.kernelLlmUrl ?? DEFAULT_AGENT_HOST_KERNEL_LLM_URL,
    entryHandleTtlSeconds: options.entryHandleTtlSeconds,
    turnAcceptedTimeoutMs: options.turnAcceptedTimeoutMs,
  });
}

/**
 * Wires together the S1.4 background machinery: one `OutboxDispatcher` over `options.pool`, one
 * `AgentRuntime` (a `FakeAgentRuntime` fed by `application/chat`'s event sink, unless `options.
 * runtime` overrides it), `application/host-bridge`'s `TurnStarted` consumer connecting the two,
 * `application/gateway/handlers.ts`'s `stop_agent` handler wired to the same runtime instance
 * (`setAgentRuntimeForHandlers`) — see that file's own doc comment for why this seam exists — and
 * the deliverable-7 stale-Turn recovery scan (run from `start()`, see `BackgroundServices.start`'s
 * own doc comment). Neither `application/chat` nor `application/host-bridge` import each other
 * directly anywhere in this wiring; this function is the one place they meet (see host-bridge/
 * index.ts's doc comment).
 */
/** Default reaper poll interval — 5 minutes. Deliberately much coarser than the outbox
 *  dispatcher's 200ms: an ActionRequest overdue by `approvalTimeoutMs` (default 24h) does not
 *  need sub-second expiry latency. */
export const DEFAULT_APPROVAL_REAPER_INTERVAL_MS = 5 * 60 * 1000;

/** Default S2.4 Gatekeeper-queue periodic drain tick interval — 1 minute. */
export const DEFAULT_GATEKEEPER_DRAIN_INTERVAL_MS = 60 * 1000;

/** Default P1-3 stale-`executing`-ActionRequest reaper poll interval — 5 minutes, same cadence as
 *  the approval-expiry reaper (a crash-recovery backstop, not a latency-sensitive path). */
export const DEFAULT_ACTION_REQUEST_REAPER_INTERVAL_MS = 5 * 60 * 1000;

/** Default `OutboxDispatcher.pruneDispatched` retention — 7 days. */
export const DEFAULT_OUTBOX_PRUNE_DAYS = 7;

/** Default outbox-prune tick interval — 6 hours (pruning is cleanup, not latency-sensitive —
 *  deliberately the coarsest interval of any reaper in this file). */
export const DEFAULT_OUTBOX_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delay before the *first* outbox-prune tick — short, but deliberately not `0`/immediate, so it
 *  never competes with `start()`'s own synchronous recovery scan (`interruptStaleRunningTurns`)
 *  or the other reapers' own startup wiring for the same tick of the event loop. Every other
 *  reaper in this file instead waits a full interval for its first tick (`setInterval` alone,
 *  no immediate call) — pruning gets its own short initial delay instead of that same
 *  wait-a-full-interval treatment because its own interval (6h) would otherwise leave a
 *  freshly-started kernel's outbox unpruned for up to 6 hours after every restart. */
export const OUTBOX_PRUNE_INITIAL_DELAY_MS = 10 * 1000;

/** Default S3.8 invariant-check tick interval — 10 minutes (docs/development-tasks.md S3.8
 *  deliverable 1: "`INVARIANT_CHECK_INTERVAL_MS`, default 10 min, 0 disables"). `main()` reads
 *  this from `INVARIANT_CHECK_INTERVAL_MS`; `0` disables the scheduler entirely (no timer is ever
 *  started) — the same explicit-opt-out convention `outboxPruneDays === 0` already established
 *  above, not a "check nothing but pretend to" footgun. */
export const DEFAULT_INVARIANT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** Delay before the *first* invariant-check tick — short, not `0`, mirroring
 *  `OUTBOX_PRUNE_INITIAL_DELAY_MS`'s own reasoning and the task brief's own "first tick shortly
 *  after start" (unlike the interval-only reapers above, whose first tick waits a full interval —
 *  a freshly-started kernel would otherwise report zero `/internal/metrics` series, indistinguishable
 *  from "checked and clean", for up to `DEFAULT_INVARIANT_CHECK_INTERVAL_MS` after every restart). */
export const INVARIANT_CHECK_INITIAL_DELAY_MS = 10 * 1000;

/**
 * The live state `GET /internal/metrics` (interfaces/http/internal/metrics.ts) reports: the most
 * recent `runInvariantChecks` result plus when it ran. A tiny mutable cell, not global module
 * state — `main()` constructs exactly one per process and threads it into both `createServer()`
 * (so the route can read it) and `createBackgroundServices()` (so the scheduler tick can write to
 * it); see `createServer`'s own doc comment on why these two halves of the sync/async startup
 * split cannot simply share a value some other way. A test that constructs its own `createServer`/
 * `createBackgroundServices` pair independently gets its own independent store, never leaking
 * counters across test cases the way a module-level singleton would.
 */
export interface InvariantMetricsStore {
  /** Called by the scheduler tick after each run — replaces the stored snapshot outright (never
   *  merged), since each run is a fresh, complete pass over every check. */
  record(results: readonly InvariantCheckResult[]): void;
  /** `MetricsRoutesDeps.renderMetrics`'s own shape — Prometheus text, always safe to call, even
   *  before the first tick has completed (renders the "never run yet" `0` timestamp — see
   *  `renderInvariantMetricsPrometheus`'s own doc comment). */
  renderMetrics(): string;
}

export function createInvariantMetricsStore(): InvariantMetricsStore {
  let lastResults: readonly InvariantCheckResult[] = [];
  let lastRunAt: Date | undefined;
  return {
    record(results) {
      lastResults = results;
      lastRunAt = new Date();
    },
    renderMetrics() {
      return renderInvariantMetricsPrometheus(lastResults, lastRunAt);
    },
  };
}

export function createBackgroundServices(
  options: CreateBackgroundServicesOptions,
): BackgroundServices {
  const dispatcher = new OutboxDispatcher(options.pool);
  const runtime = options.runtime ?? buildDefaultRuntime(options);

  setAgentRuntimeForHandlers(runtime);
  if (runtime instanceof AgentHostRuntime) setAgentHostRuntimeForWsRoute(runtime);

  // lane-1 P2 fix: TurnStarted now carries a chat_messages reference (chatMessageId), not the
  // prompt text inline (see shared/src/events.ts's TurnStartedEvent doc comment) — this is the
  // one place that resolves it back to text, reading the row under the originating principal's
  // own RLS context (the same visibility the Chat itself has) rather than the outbox's
  // workspace-wide access.
  const resolveTurnPrompt: ResolveTurnPrompt = async (event) => {
    const row = await withWorkspace(
      options.pool,
      { workspaceId: event.workspaceId, principalId: event.principalId },
      async (client) => {
        const result = await client.query<{ content: Record<string, unknown> }>(
          'select content from chat_messages where workspace_id = $1 and id = $2',
          [event.workspaceId, event.chatMessageId],
        );
        return result.rows[0];
      },
    );
    if (!row) {
      throw new Error(
        `resolveTurnPrompt: no chat_messages row for workspace ${event.workspaceId}, id ${event.chatMessageId}`,
      );
    }
    return chatMessageText(row.content);
  };
  const unsubscribeTurnStarted = registerTurnStartedConsumer(
    dispatcher,
    runtime,
    resolveTurnPrompt,
  );

  // S2.11: application/linkage's TaskUpdated/ActionRequestPending/ActionRequestUpdated/
  // BudgetWarning consumers — chat system messages + the action.pending/action.updated/
  // task.updated WS push frames + pending_context_items. Unconditional on `options.pool` alone
  // (unlike the task-reaper wiring below, which needs `options.handleKeyPair`) — this module never
  // touches Handle signing or the supervisor, only reads governance/approval's and
  // application/task's public surfaces.
  const unsubscribeLinkage = registerLinkageConsumers(dispatcher, { pool: options.pool });

  // S2.4: the ApprovalDrainer's async trigger paths — an outbox consumer on
  // ActionRequestUpdated{approved|auto_approved}, and a periodic tick as the crash-resilient
  // fallback (design doc §13 "outbox 派发器崩溃 ... 消费者幂等"). Both run admin-mode
  // (skipRoleSwitch): this is background, cross-workspace machinery in the same category as the
  // outbox dispatcher itself and the approval-expiry reaper above, not a per-request path.
  // `buildGatekeeperExecutionDeps` is the same construction `createServer()` uses for
  // `request_action`'s own phase-2 continuation — see that function's own doc comment.
  const { actionExecutor, withTransaction: adminWithTransaction } = buildGatekeeperExecutionDeps(
    options.pool,
  );
  const drainer = new ApprovalDrainer({
    executor: actionExecutor,
    withTransaction: adminWithTransaction,
  });
  const unsubscribeActionRequestDrain = registerActionRequestDrainConsumer(
    dispatcher,
    drainer,
    adminWithTransaction,
    options.onGatekeeperDrainError ?? (() => {}),
  );

  const onApprovalReaperError = options.onApprovalReaperError ?? (() => {});
  let approvalReaperTimer: NodeJS.Timeout | undefined;
  const onGatekeeperDrainError = options.onGatekeeperDrainError ?? (() => {});
  let gatekeeperDrainTimer: NodeJS.Timeout | undefined;
  const onActionRequestReaperError = options.onActionRequestReaperError ?? (() => {});
  let actionRequestReaperTimer: NodeJS.Timeout | undefined;
  const onOutboxPruneError = options.onOutboxPruneError ?? (() => {});
  const onOutboxPruneComplete = options.onOutboxPruneComplete ?? (() => {});
  let outboxPruneInitialTimer: NodeJS.Timeout | undefined;
  let outboxPruneIntervalTimer: NodeJS.Timeout | undefined;

  // S3.8: same "composition root holds the timer handle, start()/stop() paired" shape as every
  // reaper above — see this file's own doc comment on `DEFAULT_INVARIANT_CHECK_INTERVAL_MS`/
  // `INVARIANT_CHECK_INITIAL_DELAY_MS` for the interval/first-tick reasoning.
  const onInvariantCheckError = options.onInvariantCheckError ?? (() => {});
  const onInvariantCheckComplete = options.onInvariantCheckComplete ?? (() => {});
  let invariantCheckInitialTimer: NodeJS.Timeout | undefined;
  let invariantCheckIntervalTimer: NodeJS.Timeout | undefined;

  // S2.7: configure application/task's runtime deps (Handle-signing key + supervisor client) only
  // when a keypair is actually available — see this file's own doc comment above
  // `DEFAULT_TASK_SUPERVISOR_URL` for why this is unconditional on `kind`/`AGENT_RUNTIME` but
  // conditional on `options.handleKeyPair`.
  const onTaskReaperError = options.onTaskReaperError ?? (() => {});
  let taskReaperTimer: NodeJS.Timeout | undefined;
  let unsubscribeActionRequestRouting: (() => void) | undefined;
  let taskDeps:
    | {
        pool: typeof options.pool;
        privateKey: CryptoKey;
        supervisorClient: TaskSupervisorClientPort;
      }
    | undefined;

  if (options.handleKeyPair) {
    const taskSupervisorClient: TaskSupervisorClientPort =
      options.taskSupervisorClient ??
      new TaskSupervisorClient({
        supervisorUrl: options.supervisorUrl ?? DEFAULT_TASK_SUPERVISOR_URL,
        authorizationHeader: options.supervisorAuthorizationHeader,
      });
    taskDeps = {
      pool: options.pool,
      privateKey: options.handleKeyPair.privateKey,
      supervisorClient: taskSupervisorClient,
    };
    configureTaskRuntime(taskDeps);
    unsubscribeActionRequestRouting = registerActionRequestRoutingConsumer(dispatcher, taskDeps);
  }

  return {
    dispatcher,
    runtime,
    async start() {
      await interruptStaleRunningTurns({ pool: options.pool });
      dispatcher.start();

      const approvalTick = (): void => {
        expireOverduePendingApprovals(options.pool, {
          timeoutMs: options.approvalTimeoutMs,
        }).catch(onApprovalReaperError);
      };
      approvalReaperTimer = setInterval(
        approvalTick,
        options.approvalReaperIntervalMs ?? DEFAULT_APPROVAL_REAPER_INTERVAL_MS,
      );
      approvalReaperTimer.unref?.();

      const drainTick = async (): Promise<void> => {
        const drainable = await listDistinctExecutableGatekeepers(options.pool);
        for (const { workspaceId, gatekeeperId } of drainable) {
          try {
            await drainer.drainGatekeeper(workspaceId, SYSTEM_ACTOR_PLACEHOLDER, gatekeeperId);
          } catch (err) {
            // A benign race with another drain trigger (the outbox consumer, or an inline
            // execution from request-action-handler.ts) — see action-request-drain-consumer.ts's
            // own doc comment. One pair's race must not stop the rest of this tick's batch.
            if (err instanceof IllegalTransition) continue;
            onGatekeeperDrainError(err);
          }
        }
      };
      gatekeeperDrainTimer = setInterval(() => {
        drainTick().catch(onGatekeeperDrainError);
      }, options.gatekeeperDrainIntervalMs ?? DEFAULT_GATEKEEPER_DRAIN_INTERVAL_MS);
      gatekeeperDrainTimer.unref?.();

      // P1-3: the stale-`executing` reaper — same admin-mode `actionExecutor` the drainer above
      // already uses (`buildGatekeeperExecutionDeps`, "the single shared executor path").
      const actionRequestReaperTick = (): void => {
        reapStaleExecutingActionRequests(options.pool, actionExecutor, {
          staleAfterMs: options.staleExecutingTimeoutMs,
          onRowError: onActionRequestReaperError,
        }).catch((err: unknown) => onActionRequestReaperError('unknown', err));
      };
      actionRequestReaperTimer = setInterval(
        actionRequestReaperTick,
        options.actionRequestReaperIntervalMs ?? DEFAULT_ACTION_REQUEST_REAPER_INTERVAL_MS,
      );
      actionRequestReaperTimer.unref?.();

      if (taskDeps) {
        const taskTick = (): void => {
          runTaskReaper(taskDeps as NonNullable<typeof taskDeps>).catch(onTaskReaperError);
        };
        taskReaperTimer = setInterval(
          taskTick,
          options.taskReaperIntervalMs ?? DEFAULT_TASK_REAPER_INTERVAL_MS,
        );
        taskReaperTimer.unref?.();
      }

      // fix/invoke-worker-wait-and-outbox-prune: `pruneDispatched` (PR #76) had nothing calling
      // it — wire it up the same "composition root holds the timer handle, start()/stop() paired"
      // way every reaper above does. `outboxPruneDays === 0` is a deliberate opt-out (no timer
      // ever starts, distinct from every other reaper here — see this file's own doc comment on
      // `outboxPruneDays`); every other value, including the compiled-in default, prunes.
      const outboxPruneDays = options.outboxPruneDays ?? DEFAULT_OUTBOX_PRUNE_DAYS;
      if (outboxPruneDays > 0) {
        const outboxPruneTick = (): void => {
          dispatcher
            .pruneDispatched(outboxPruneDays)
            .then((deleted) => onOutboxPruneComplete({ deleted }))
            .catch(onOutboxPruneError);
        };
        // First tick fires shortly after start (OUTBOX_PRUNE_INITIAL_DELAY_MS), not after a full
        // OUTBOX_PRUNE_INTERVAL_MS (6h) — see that constant's own doc comment for why pruning
        // deliberately does not follow the "wait a full interval for the first tick" convention
        // every other reaper in this file uses.
        outboxPruneInitialTimer = setTimeout(() => {
          outboxPruneTick();
          outboxPruneIntervalTimer = setInterval(
            outboxPruneTick,
            options.outboxPruneIntervalMs ?? DEFAULT_OUTBOX_PRUNE_INTERVAL_MS,
          );
          outboxPruneIntervalTimer.unref?.();
        }, OUTBOX_PRUNE_INITIAL_DELAY_MS);
        outboxPruneInitialTimer.unref?.();
      }

      // S3.8: `substrate/audit`'s periodic invariant scan (docs/development-tasks.md S3.8
      // deliverable 1). `invariantCheckIntervalMs === 0` is a deliberate opt-out (no timer ever
      // starts), the same convention `outboxPruneDays === 0` established above; every other value,
      // including the compiled-in default, runs. First tick fires shortly after start
      // (`INVARIANT_CHECK_INITIAL_DELAY_MS`), matching outbox-prune's own "do not report zero
      // series for a whole interval after every restart" reasoning, not the wait-a-full-interval
      // convention the other reapers in this file use.
      const invariantCheckIntervalMs =
        options.invariantCheckIntervalMs ?? DEFAULT_INVARIANT_CHECK_INTERVAL_MS;
      if (invariantCheckIntervalMs > 0) {
        const invariantCheckTick = (): void => {
          runInvariantChecks(options.pool)
            .then((results) => {
              options.invariantMetrics?.record(results);
              onInvariantCheckComplete(results);
            })
            .catch(onInvariantCheckError);
        };
        invariantCheckInitialTimer = setTimeout(() => {
          invariantCheckTick();
          invariantCheckIntervalTimer = setInterval(invariantCheckTick, invariantCheckIntervalMs);
          invariantCheckIntervalTimer.unref?.();
        }, INVARIANT_CHECK_INITIAL_DELAY_MS);
        invariantCheckInitialTimer.unref?.();
      }
    },
    stop() {
      dispatcher.stop();
      unsubscribeTurnStarted();
      unsubscribeLinkage();
      unsubscribeActionRequestDrain();
      unsubscribeActionRequestRouting?.();
      if (approvalReaperTimer) {
        clearInterval(approvalReaperTimer);
        approvalReaperTimer = undefined;
      }
      if (gatekeeperDrainTimer) {
        clearInterval(gatekeeperDrainTimer);
        gatekeeperDrainTimer = undefined;
      }
      if (actionRequestReaperTimer) {
        clearInterval(actionRequestReaperTimer);
        actionRequestReaperTimer = undefined;
      }
      if (taskReaperTimer) {
        clearInterval(taskReaperTimer);
        taskReaperTimer = undefined;
      }
      if (outboxPruneInitialTimer) {
        clearTimeout(outboxPruneInitialTimer);
        outboxPruneInitialTimer = undefined;
      }
      if (outboxPruneIntervalTimer) {
        clearInterval(outboxPruneIntervalTimer);
        outboxPruneIntervalTimer = undefined;
      }
      if (invariantCheckInitialTimer) {
        clearTimeout(invariantCheckInitialTimer);
        invariantCheckInitialTimer = undefined;
      }
      if (invariantCheckIntervalTimer) {
        clearInterval(invariantCheckIntervalTimer);
        invariantCheckIntervalTimer = undefined;
      }
    },
  };
}

/**
 * Parses an optional numeric env var (every one of them below is a timeout or a poll interval in
 * ms/s) — throws immediately, before opening the DB pool or binding a port, rather than letting
 * `Number(raw)` silently become `NaN` (P2-9 fix: an unvalidated `NaN` deadline turns a reaper's
 * `Date.now() + NaN` comparison and `setInterval(fn, NaN)` into a tight loop instead of a
 * misconfiguration error) — same fail-fast posture `resolveAgentRuntimeKind` already established
 * for `AGENT_RUNTIME`. Also rejects `<= 0`: every one of these is a deadline/interval, and a
 * non-positive one is the same tight-loop failure mode by a different route
 * (`setInterval(fn, 0)`). `undefined` when `raw` is `undefined` — every caller already has its own
 * compiled-in default for that case.
 */
export function parsePositiveIntEnvVar(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${name}="${raw}" is not a positive, finite number — unset it to use the compiled-in default`,
    );
  }
  return parsed;
}

/**
 * Same fail-fast contract as {@link parsePositiveIntEnvVar} — except `0` is accepted rather than
 * rejected, since `OUTBOX_PRUNE_DAYS=0` is a deliberate "disable pruning" sentinel
 * (`CreateBackgroundServicesOptions.outboxPruneDays`'s own doc comment), not a misconfiguration a
 * caller could not possibly have meant. A negative value is still rejected — `-1` cannot mean
 * "disable" when `0` already does, so it can only be a mistake.
 */
export function parseNonNegativeIntEnvVar(
  name: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `${name}="${raw}" is not a non-negative, finite number — unset it to use the compiled-in default`,
    );
  }
  return parsed;
}

export function main(): void {
  // Fail fast on a misconfigured AGENT_RUNTIME before doing anything else (opening the DB pool,
  // binding a port).
  const kind = resolveAgentRuntimeKind();

  // Same fail-fast slot for the internal plane's shared secret: a missing / empty / too-short
  // `NEXTTIME_INTERNAL_TOKEN_FILE` (default `/run/secrets/internal_token`, the compose secret
  // `internal_token`) throws `InternalTokenError` here with the path in the message — the kernel
  // never starts with the internal plane either open or unusable. `NEXTTIME_SUBNET_WORKERS`
  // (the same value the compose file gives `egress-proxy`) enables the peer rule: a request from
  // inside the Worker subnet is rejected even with the right token (a Worker must never hold it).
  const workersSubnet = process.env.NEXTTIME_SUBNET_WORKERS?.trim();
  const internalAuth: InternalPlaneAuthConfig = {
    token: loadInternalToken(),
    workersSubnet: workersSubnet ? workersSubnet : undefined,
  };

  const pool = createPool();
  const requestActionAwaitDecisionTimeoutMs = parsePositiveIntEnvVar(
    'REQUEST_ACTION_AWAIT_DECISION_TIMEOUT_MS',
    process.env.REQUEST_ACTION_AWAIT_DECISION_TIMEOUT_MS,
  );
  // S3.8: constructed once here, before `createServer` — the same instance is threaded into
  // `createBackgroundServices` below (async, once its own bootstrap finishes) so the scheduler
  // tick and the `/internal/metrics` route share one live store, not two independent copies. See
  // `InvariantMetricsStore`'s own doc comment for why this cannot simply be a module-level
  // singleton instead.
  const invariantMetrics = createInvariantMetricsStore();
  const app = createServer(
    { pool, renderMetrics: invariantMetrics.renderMetrics },
    {
      logger: true,
      requestActionAwaitDecisionTimeoutMs,
      internalAuth,
    },
  );

  const port = Number(process.env.KERNEL_PORT ?? 8080);
  const host = process.env.KERNEL_BIND_ADDR ?? '0.0.0.0';
  app.listen({ port, host }).catch((err: unknown) => {
    app.log.error(err);
    process.exitCode = 1;
  });

  // Background services (the outbox dispatcher + AgentRuntime wiring) are built asynchronously
  // and only *after* the port is already opening — same "do not block the port on background
  // init" rule the pre-existing recovery-scan comment below already establishes, now also
  // covering `kind === 'agent-host'`'s async `loadHandleKeyPair()` read (PEM files off disk).
  // `background` starts `undefined` so `shutdown` (registered synchronously, before either
  // `await` below can run) is always safe to call even if a signal arrives before this IIFE
  // finishes — there is nothing to stop yet in that case.
  let background: BackgroundServices | undefined;
  const shutdown = (): void => {
    background?.stop();
    void app.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  void (async (): Promise<void> => {
    // S2.7: `invoke_worker` needs a Handle-signing keypair regardless of `AGENT_RUNTIME` (unlike
    // `AgentHostRuntime`'s own need for one, which is `kind === 'agent-host'`-only) — the target
    // deployment mounts the `handle_key` secret into the kernel container unconditionally (the
    // deployment compose file), so this always attempts the load now rather than only for
    // `kind === 'agent-host'`. Failure is tolerated, not fatal: a local/dev/test kernel process
    // with no Handle keys configured still starts and serves chat/WS normally — only `invoke_worker`
    // (and, if `kind === 'agent-host'`, entry-Handle issuance) would be unavailable, and
    // `application/task/runtime.ts`'s `TaskRuntimeNotConfiguredError` reports that clearly, lazily,
    // the moment (if ever) someone actually calls it — see createBackgroundServices's own doc
    // comment on `DEFAULT_TASK_SUPERVISOR_URL` for the full reasoning.
    let handleKeyPair: HandleKeyPair | undefined;
    try {
      handleKeyPair = await loadHandleKeyPair();
    } catch (err) {
      if (kind === 'agent-host') throw err; // AgentHostRuntime cannot function without one.
      app.log.warn(
        { err },
        'no Handle-signing keypair configured — invoke_worker will be unavailable until one is',
      );
    }

    const entryHandleTtlSeconds = parsePositiveIntEnvVar(
      'ENTRY_HANDLE_TTL_SECONDS',
      process.env.ENTRY_HANDLE_TTL_SECONDS,
    );
    const turnAcceptedTimeoutMs = parsePositiveIntEnvVar(
      'AGENT_HOST_TURN_ACCEPTED_TIMEOUT_MS',
      process.env.AGENT_HOST_TURN_ACCEPTED_TIMEOUT_MS,
    );
    const approvalTimeoutMs = parsePositiveIntEnvVar(
      'APPROVAL_TIMEOUT_MS',
      process.env.APPROVAL_TIMEOUT_MS,
    );
    const approvalReaperIntervalMs = parsePositiveIntEnvVar(
      'APPROVAL_REAPER_INTERVAL_MS',
      process.env.APPROVAL_REAPER_INTERVAL_MS,
    );
    const gatekeeperDrainIntervalMs = parsePositiveIntEnvVar(
      'GATEKEEPER_DRAIN_INTERVAL_MS',
      process.env.GATEKEEPER_DRAIN_INTERVAL_MS,
    );
    const actionRequestReaperIntervalMs = parsePositiveIntEnvVar(
      'ACTION_REQUEST_REAPER_INTERVAL_MS',
      process.env.ACTION_REQUEST_REAPER_INTERVAL_MS,
    );
    const staleExecutingTimeoutMs = parsePositiveIntEnvVar(
      'ACTION_REQUEST_STALE_EXECUTING_TIMEOUT_MS',
      process.env.ACTION_REQUEST_STALE_EXECUTING_TIMEOUT_MS,
    );
    const taskReaperIntervalMs = parsePositiveIntEnvVar(
      'TASK_REAPER_INTERVAL_MS',
      process.env.TASK_REAPER_INTERVAL_MS,
    );
    const outboxPruneDays = parseNonNegativeIntEnvVar(
      'OUTBOX_PRUNE_DAYS',
      process.env.OUTBOX_PRUNE_DAYS,
    );
    const outboxPruneIntervalMs = parsePositiveIntEnvVar(
      'OUTBOX_PRUNE_INTERVAL_MS',
      process.env.OUTBOX_PRUNE_INTERVAL_MS,
    );
    // `0` is a deliberate opt-out (same convention as OUTBOX_PRUNE_DAYS), not a misconfiguration —
    // parseNonNegativeIntEnvVar, not parsePositiveIntEnvVar.
    const invariantCheckIntervalMs = parseNonNegativeIntEnvVar(
      'INVARIANT_CHECK_INTERVAL_MS',
      process.env.INVARIANT_CHECK_INTERVAL_MS,
    );

    background = createBackgroundServices({
      pool,
      supervisorUrl: process.env.SUPERVISOR_URL,
      // Reuses the exact token already loaded above for the kernel's own /internal/* guard
      // (`internalAuth.token`) — same file, same loader, no second read (lane-6 review follow-up).
      supervisorAuthorizationHeader: internalAuthorizationHeader(internalAuth.token),
      taskReaperIntervalMs,
      onTaskReaperError: (err: unknown) => app.log.error(err),
      kind,
      handleKeyPair,
      kernelLlmUrl: process.env.KERNEL_LLM_URL,
      entryHandleTtlSeconds,
      turnAcceptedTimeoutMs,
      approvalTimeoutMs,
      approvalReaperIntervalMs,
      onApprovalReaperError: (err: unknown) => app.log.error(err),
      gatekeeperDrainIntervalMs,
      onGatekeeperDrainError: (err: unknown) => app.log.error(err),
      actionRequestReaperIntervalMs,
      staleExecutingTimeoutMs,
      onActionRequestReaperError: (actionRequestId: string, err: unknown) =>
        app.log.error({ actionRequestId, err }),
      outboxPruneDays,
      outboxPruneIntervalMs,
      onOutboxPruneError: (err: unknown) => app.log.error(err),
      onOutboxPruneComplete: ({ deleted }: { deleted: number }) =>
        app.log.info({ deleted }, 'outbox prune complete'),
      invariantCheckIntervalMs,
      invariantMetrics,
      onInvariantCheckError: (err: unknown) => app.log.error(err),
      // Task brief: "logs a structured line per violated invariant" — a clean tick (every check
      // at violations: 0) logs nothing here; `invariantMetrics.record()` above (called
      // unconditionally by createBackgroundServices's own tick) is what keeps /internal/metrics
      // current either way.
      onInvariantCheckComplete: (results: readonly InvariantCheckResult[]) => {
        for (const result of results) {
          if (result.violations > 0) {
            app.log.warn(
              { invariant: result.invariant, violations: result.violations, sample: result.sample },
              'invariant check violated',
            );
          }
        }
      },
    });

    // A request that races the still-in-flight recovery scan is not unsafe — the partial unique
    // index (migrations/core/0008_chat_messages.sql) still prevents two Turns from ever running
    // for the same Chat at once regardless of how far recovery has gotten.
    await background.start();
  })().catch((err: unknown) => {
    app.log.error(err);
  });
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
