import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createPool } from './adapters/db/pool.js';
import { createChatEventSink, interruptStaleRunningTurns } from './application/chat/index.js';
import { setAgentRuntimeForHandlers } from './application/gateway/handlers.js';
import type { AgentRuntime } from './application/host-bridge/index.js';
import { FakeAgentRuntime, registerTurnStartedConsumer } from './application/host-bridge/index.js';
import { OutboxDispatcher } from './application/outbox/index.js';
import type { CapabilityRouteDeps } from './interfaces/http/index.js';
import { registerCapabilityRoutes } from './interfaces/http/index.js';
import { registerWsRoute } from './interfaces/ws/index.js';

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

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerCapabilityRoutes(app, deps);
  registerWsRoute(app, deps);

  return app;
}

export interface KernelServerDeps extends CapabilityRouteDeps {}

export interface CreateServerOptions {
  /** Fastify's own `logger` option — the structured per-call log (§12) is written regardless of
   *  this setting (interfaces/http/capability-route.ts uses `request.log`, a no-op sink when
   *  `logger` is `false`); this only controls Fastify's own request/response access log. */
  logger?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Background services: the outbox dispatcher + AgentRuntime wiring (design doc §7.10 outbox;
// §7.1 host-bridge; docs/development-tasks.md S1.4 deliverable 5 "wires it in main() when
// AGENT_RUNTIME=fake (default until S1.5 lands — document)").
// ---------------------------------------------------------------------------------------------

/**
 * `AGENT_RUNTIME` values this kernel build knows how to construct. `"fake"` is the only one until
 * S1.5 lands the real agent-host-backed runtime (design doc §7.1 host-bridge: "pi 是唯一计划的实
 * 现") — `resolveAgentRuntimeKind` below fails fast (before opening a DB pool or binding a port)
 * on anything else, rather than silently falling back, so a misconfigured deployment finds out
 * immediately instead of quietly running degraded.
 */
export type AgentRuntimeKind = 'fake';

export function resolveAgentRuntimeKind(env: NodeJS.ProcessEnv = process.env): AgentRuntimeKind {
  const raw = env.AGENT_RUNTIME ?? 'fake';
  if (raw !== 'fake') {
    throw new Error(
      `AGENT_RUNTIME="${raw}" is not implemented yet — only "fake" exists until S1.5 ships the real agent-host-backed runtime. Unset AGENT_RUNTIME or set it to "fake".`,
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
   */
  start(): Promise<void>;
  /** Stops the poll loop and unregisters the `TurnStarted` consumer. Does not wait for an
   *  in-flight poll — see OutboxDispatcher.stop()'s own doc comment for why that is safe. */
  stop(): void;
}

export interface CreateBackgroundServicesOptions {
  readonly pool: Pool;
  /** Overrides the constructed `AgentRuntime` — for tests. Production always goes through
   *  `main()`'s `AGENT_RUNTIME` env switch (`resolveAgentRuntimeKind`), which as of S1.4 always
   *  resolves to a fresh `FakeAgentRuntime`. */
  readonly runtime?: AgentRuntime;
  /** Overrides `interruptStaleRunningTurns`'s staleness threshold (default `DEFAULT_STALE_TURN_
   *  TIMEOUT_MS`, 15 minutes) — `main()` reads this from `TURN_INTERRUPT_TIMEOUT_MS` (docs/
   *  development-tasks.md S1.4 deliverable 7: "configurable timeout"). */
  readonly turnInterruptTimeoutMs?: number;
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
export function createBackgroundServices(
  options: CreateBackgroundServicesOptions,
): BackgroundServices {
  const dispatcher = new OutboxDispatcher(options.pool);
  const runtime =
    options.runtime ?? new FakeAgentRuntime({ sink: createChatEventSink({ pool: options.pool }) });

  setAgentRuntimeForHandlers(runtime);
  const unsubscribeTurnStarted = registerTurnStartedConsumer(dispatcher, runtime);

  return {
    dispatcher,
    runtime,
    async start() {
      await interruptStaleRunningTurns({
        pool: options.pool,
        timeoutMs: options.turnInterruptTimeoutMs,
      });
      dispatcher.start();
    },
    stop() {
      dispatcher.stop();
      unsubscribeTurnStarted();
    },
  };
}

export function main(): void {
  // Fail fast on a misconfigured AGENT_RUNTIME before doing anything else (opening the DB pool,
  // binding a port).
  resolveAgentRuntimeKind();

  const pool = createPool();
  const app = createServer({ pool }, { logger: true });
  const rawTurnInterruptTimeoutMs = process.env.TURN_INTERRUPT_TIMEOUT_MS;
  const background = createBackgroundServices({
    pool,
    turnInterruptTimeoutMs: rawTurnInterruptTimeoutMs
      ? Number(rawTurnInterruptTimeoutMs)
      : undefined,
  });

  // Not awaited: startup recovery + the dispatcher's first poll should not block the port from
  // opening. A request that races the still-in-flight recovery scan is not unsafe — the partial
  // unique index (migrations/core/0008_chat_messages.sql) still prevents two Turns from ever
  // running for the same Chat at once regardless of how far recovery has gotten.
  background.start().catch((err: unknown) => {
    app.log.error(err);
  });

  const port = Number(process.env.KERNEL_PORT ?? 8080);
  const host = process.env.KERNEL_BIND_ADDR ?? '0.0.0.0';

  app.listen({ port, host }).catch((err: unknown) => {
    app.log.error(err);
    process.exitCode = 1;
  });

  const shutdown = (): void => {
    background.stop();
    void app.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
