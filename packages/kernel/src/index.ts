import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createPool, withWorkspace } from './adapters/db/pool.js';
import { HttpGatekeeperClient } from './adapters/gatekeeper-client/index.js';
import { createChatEventSink, interruptStaleRunningTurns } from './application/chat/index.js';
import { setAgentRuntimeForHandlers } from './application/gateway/handlers.js';
import {
  createGatekeeperActionExecutor,
  registerActionRequestDrainConsumer,
  setRequestActionDeps,
} from './application/gateway/index.js';
import type { WithTransactionFn } from './application/gateway/index.js';
import type { AgentRuntime } from './application/host-bridge/index.js';
import {
  AgentHostRuntime,
  FakeAgentRuntime,
  registerTurnStartedConsumer,
} from './application/host-bridge/index.js';
import { OutboxDispatcher } from './application/outbox/index.js';
import {
  ApprovalDrainer,
  expireOverduePendingApprovals,
  listDistinctExecutableGatekeepers,
} from './governance/approval/index.js';
import type { HandleKeyPair } from './governance/capability/index.js';
import { loadHandleKeyPair } from './governance/capability/index.js';
import type { CapabilityRouteDeps } from './interfaces/http/index.js';
import { registerCapabilityRoutes } from './interfaces/http/index.js';
import type { InternalRoutesDeps } from './interfaces/http/internal/index.js';
import { registerInternalRoutes } from './interfaces/http/internal/index.js';
import {
  registerAgentHostWsRoute,
  registerWsRoute,
  setAgentHostRuntimeForWsRoute,
} from './interfaces/ws/index.js';

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
  // the port opens, not only once the async AgentRuntime bootstrap below finishes — it needs
  // nothing that bootstrap produces (see request-action-handler.ts's own doc comment: every
  // execution path runs on the capability call's own already-open `client`, never a pool it would
  // have to wait for). `ApprovalDrainer`'s async trigger paths (outbox consumer + periodic tick)
  // do need the OutboxDispatcher, so those remain in createBackgroundServices below.
  setRequestActionDeps({
    gatekeeperClient: new HttpGatekeeperClient(),
    awaitDecisionTimeoutMs: options.requestActionAwaitDecisionTimeoutMs,
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerCapabilityRoutes(app, deps);
  registerWsRoute(app, deps);
  // `/internal/*` (S1.7): service-to-service routes for `llm-proxy` (usage reports, revocation
  // sync). Reachable only on the `control` compose network — the kernel publishes no host port
  // (design doc §11) — so they carry no additional auth of their own.
  app.register(async (instance) => {
    await registerInternalRoutes(instance, deps);
  });
  // `/internal/agent-host` (S1.5, second half): agent-host's event-bridge WebSocket — same
  // `control`-network-only trust boundary as the `/internal/*` HTTP routes above. Registered
  // unconditionally (independent of AGENT_RUNTIME) — see interfaces/ws/agent-host.ts's own doc
  // comment for why a connection is simply closed when no AgentHostRuntime has been registered.
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
}

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

/** A fixed, non-dereferenced placeholder for the admin-mode (`skipRoleSwitch: true`) transactions
 *  the drainer/executor/periodic-drain-scan below run under — see
 *  `application/gateway/action-request-drain-consumer.ts`'s own doc comment for why an
 *  RLS-bypassing background actor never needs a real Principal id here. */
const SYSTEM_ACTOR_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

export function createBackgroundServices(
  options: CreateBackgroundServicesOptions,
): BackgroundServices {
  const dispatcher = new OutboxDispatcher(options.pool);
  const runtime = options.runtime ?? buildDefaultRuntime(options);

  setAgentRuntimeForHandlers(runtime);
  if (runtime instanceof AgentHostRuntime) setAgentHostRuntimeForWsRoute(runtime);
  const unsubscribeTurnStarted = registerTurnStartedConsumer(dispatcher, runtime);

  // S2.4: the ApprovalDrainer's async trigger paths — an outbox consumer on
  // ActionRequestUpdated{approved|auto_approved}, and a periodic tick as the crash-resilient
  // fallback (design doc §13 "outbox 派发器崩溃 ... 消费者幂等"). Both run admin-mode
  // (skipRoleSwitch): this is background, cross-workspace machinery in the same category as the
  // outbox dispatcher itself and the approval-expiry reaper above, not a per-request path — see
  // `governance/gatekeepers/registry.ts`'s own doc comment for why a Gatekeeper's endpoint is
  // itself only ever read (never RLS-sensitive) and `action-request-drain-consumer.ts`'s doc
  // comment for the full rationale.
  const adminWithTransaction: WithTransactionFn = (workspaceId, principalId, fn) =>
    withWorkspace(options.pool, { workspaceId, principalId }, fn, { skipRoleSwitch: true });
  const gatekeeperClient = new HttpGatekeeperClient();
  const actionExecutor = createGatekeeperActionExecutor({
    gatekeeperClient,
    withTransaction: adminWithTransaction,
  });
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
    },
    stop() {
      dispatcher.stop();
      unsubscribeTurnStarted();
      unsubscribeActionRequestDrain();
      if (approvalReaperTimer) {
        clearInterval(approvalReaperTimer);
        approvalReaperTimer = undefined;
      }
      if (gatekeeperDrainTimer) {
        clearInterval(gatekeeperDrainTimer);
        gatekeeperDrainTimer = undefined;
      }
    },
  };
}

export function main(): void {
  // Fail fast on a misconfigured AGENT_RUNTIME before doing anything else (opening the DB pool,
  // binding a port).
  const kind = resolveAgentRuntimeKind();

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
    const handleKeyPair = kind === 'agent-host' ? await loadHandleKeyPair() : undefined;

    const rawTurnInterruptTimeoutMs = process.env.TURN_INTERRUPT_TIMEOUT_MS;
    const rawEntryHandleTtlSeconds = process.env.ENTRY_HANDLE_TTL_SECONDS;
    const rawTurnAcceptedTimeoutMs = process.env.AGENT_HOST_TURN_ACCEPTED_TIMEOUT_MS;
    const rawApprovalTimeoutMs = process.env.APPROVAL_TIMEOUT_MS;
    const rawApprovalReaperIntervalMs = process.env.APPROVAL_REAPER_INTERVAL_MS;
    const rawGatekeeperDrainIntervalMs = process.env.GATEKEEPER_DRAIN_INTERVAL_MS;

    background = createBackgroundServices({
      pool,
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
