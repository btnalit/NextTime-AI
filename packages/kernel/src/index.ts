import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { createPool } from './adapters/db/pool.js';
import type { PoolLike } from './adapters/db/pool.js';
import { HttpGatekeeperClient } from './adapters/gatekeeper-client/index.js';
import { TaskSupervisorClient } from './adapters/supervisor-client/index.js';
import type { TaskSupervisorClientPort } from './adapters/supervisor-client/index.js';
import { createChatEventSink, interruptStaleRunningTurns } from './application/chat/index.js';
import { setAgentRuntimeForHandlers } from './application/gateway/handlers.js';
import {
  createAdminWithTransaction,
  createGatekeeperActionExecutor,
  registerActionRequestDrainConsumer,
  setConnectionHandlerDeps,
  setRequestActionDeps,
} from './application/gateway/index.js';
import type { GatekeeperActionExecutorDeps } from './application/gateway/index.js';
import type { AgentRuntime } from './application/host-bridge/index.js';
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
import { registerCapabilityRoutes } from './interfaces/http/index.js';
import type { InternalRoutesDeps } from './interfaces/http/internal/index.js';
import { registerInternalRoutes } from './interfaces/http/internal/index.js';
import type { InternalPlaneAuthConfig } from './interfaces/internal-auth/index.js';
import { loadInternalToken, registerInternalPlaneGuard } from './interfaces/internal-auth/index.js';
import {
  registerAgentHostWsRoute,
  registerWsRoute,
  setAgentHostRuntimeForWsRoute,
} from './interfaces/ws/index.js';

/**
 * The one canonical construction of "a `GatekeeperClient` + the admin-mode `ActionExecutor` over
 * it" (S2.4 coordinator review — "the single shared executor path"): `createServer()` uses it to
 * wire `request_action`'s phase-2 continuation (`setRequestActionDeps`), `createBackgroundServices`
 * uses it to wire `ApprovalDrainer`. Two separate `ActionExecutor` instances (one per caller) are
 * behaviorally identical — the type has no internal state, it is purely a function of
 * `gatekeeperClient`/`withTransaction` — so this is about having exactly one definition of *how*
 * to build one, not about sharing a single JS object across the sync/async construction split
 * below (`createServer` has no async dependency and can build its own before the port opens;
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
  // (already in hand here). `ApprovalDrainer`'s other two trigger paths (outbox consumer +
  // periodic tick) do need the OutboxDispatcher, so those remain in createBackgroundServices
  // below — but phase 2 of `request_action` itself (request-action-handler.ts's `afterCommit`)
  // never waits on them.
  const { gatekeeperClient, actionExecutor } = buildGatekeeperExecutionDeps(deps.pool);
  setRequestActionDeps({
    gatekeeperClient,
    actionExecutor,
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
  registerWsRoute(app, deps);
  // `/internal/*` (S1.7): service-to-service routes for `llm-proxy` (usage reports, revocation
  // sync) and `egress-proxy` (egress observations). The kernel is dual-homed on `control` and
  // `workers` and binds every interface, so these are reachable from every agent container — the
  // guard above is what actually closes them (see interfaces/internal-auth's doc comment).
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
   * shape as the outbox dispatcher).
   */
  start(): Promise<void>;
  /** Stops the poll loop, the approval-expiry reaper's interval, and unregisters the `TurnStarted`
   *  consumer. Does not wait for an in-flight poll/reaper tick — see OutboxDispatcher.stop()'s own
   *  doc comment for why that is safe. */
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
  /** Overrides `interruptStaleRunningTurns`'s staleness threshold (default `DEFAULT_STALE_TURN_
   *  TIMEOUT_MS`, 15 minutes) — `main()` reads this from `TURN_INTERRUPT_TIMEOUT_MS` (docs/
   *  development-tasks.md S1.4 deliverable 7: "configurable timeout"). */
  readonly turnInterruptTimeoutMs?: number;
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
  /**
   * S2.7: `worker-supervisor`'s Task-mode base URL (`adapters/supervisor-client`'s
   * `TaskSupervisorClient`, e.g. `http://worker-supervisor:8081`) — `main()` reads this from
   * `SUPERVISOR_URL` (the same env var `packages/agent-host` already uses for the resident-mode
   * client, the deployment compose file). Ignored when `taskSupervisorClient` is given directly
   * (tests).
   */
  readonly supervisorUrl?: string;
  /** Overrides the constructed `TaskSupervisorClientPort` — for tests (a fake, no network). */
  readonly taskSupervisorClient?: TaskSupervisorClientPort;
  /** How often the S2.7 task reaper polls (duration-limit enforcement + supervisor-status
   *  reconciliation). Default `DEFAULT_TASK_REAPER_INTERVAL_MS` (30s — much tighter than the
   *  approval reaper's 5 minutes, matching `worker-supervisor`'s own 30s `reap()` cadence). */
  readonly taskReaperIntervalMs?: number;
  /** Called whenever a reaper tick's `runTaskReaper` call throws — same shape as
   *  `onApprovalReaperError`. Defaults to a no-op; `main()` passes `app.log.error`. */
  readonly onTaskReaperError?: (error: unknown) => void;
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

export function createBackgroundServices(
  options: CreateBackgroundServicesOptions,
): BackgroundServices {
  const dispatcher = new OutboxDispatcher(options.pool);
  const runtime = options.runtime ?? buildDefaultRuntime(options);

  setAgentRuntimeForHandlers(runtime);
  if (runtime instanceof AgentHostRuntime) setAgentHostRuntimeForWsRoute(runtime);
  const unsubscribeTurnStarted = registerTurnStartedConsumer(dispatcher, runtime);

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
      await interruptStaleRunningTurns({
        pool: options.pool,
        timeoutMs: options.turnInterruptTimeoutMs,
      });
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
      if (taskReaperTimer) {
        clearInterval(taskReaperTimer);
        taskReaperTimer = undefined;
      }
    },
  };
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
  const rawRequestActionAwaitDecisionTimeoutMs =
    process.env.REQUEST_ACTION_AWAIT_DECISION_TIMEOUT_MS;
  const app = createServer(
    { pool },
    {
      logger: true,
      requestActionAwaitDecisionTimeoutMs: rawRequestActionAwaitDecisionTimeoutMs
        ? Number(rawRequestActionAwaitDecisionTimeoutMs)
        : undefined,
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

    const rawTurnInterruptTimeoutMs = process.env.TURN_INTERRUPT_TIMEOUT_MS;
    const rawEntryHandleTtlSeconds = process.env.ENTRY_HANDLE_TTL_SECONDS;
    const rawTurnAcceptedTimeoutMs = process.env.AGENT_HOST_TURN_ACCEPTED_TIMEOUT_MS;
    const rawApprovalTimeoutMs = process.env.APPROVAL_TIMEOUT_MS;
    const rawApprovalReaperIntervalMs = process.env.APPROVAL_REAPER_INTERVAL_MS;
    const rawGatekeeperDrainIntervalMs = process.env.GATEKEEPER_DRAIN_INTERVAL_MS;
    const rawTaskReaperIntervalMs = process.env.TASK_REAPER_INTERVAL_MS;

    background = createBackgroundServices({
      pool,
      supervisorUrl: process.env.SUPERVISOR_URL,
      taskReaperIntervalMs: rawTaskReaperIntervalMs ? Number(rawTaskReaperIntervalMs) : undefined,
      onTaskReaperError: (err: unknown) => app.log.error(err),
      kind,
      handleKeyPair,
      kernelLlmUrl: process.env.KERNEL_LLM_URL,
      entryHandleTtlSeconds: rawEntryHandleTtlSeconds
        ? Number(rawEntryHandleTtlSeconds)
        : undefined,
      turnAcceptedTimeoutMs: rawTurnAcceptedTimeoutMs
        ? Number(rawTurnAcceptedTimeoutMs)
        : undefined,
      turnInterruptTimeoutMs: rawTurnInterruptTimeoutMs
        ? Number(rawTurnInterruptTimeoutMs)
        : undefined,
      approvalTimeoutMs: rawApprovalTimeoutMs ? Number(rawApprovalTimeoutMs) : undefined,
      approvalReaperIntervalMs: rawApprovalReaperIntervalMs
        ? Number(rawApprovalReaperIntervalMs)
        : undefined,
      onApprovalReaperError: (err: unknown) => app.log.error(err),
      gatekeeperDrainIntervalMs: rawGatekeeperDrainIntervalMs
        ? Number(rawGatekeeperDrainIntervalMs)
        : undefined,
      onGatekeeperDrainError: (err: unknown) => app.log.error(err),
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
