import fastifyWebsocket from '@fastify/websocket';
import { AgentHostToKernelFrameSchema } from '@nexttime/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AgentHostLink, AgentHostRuntime } from '../../application/host-bridge/index.js';

/**
 * interfaces/ws/agent-host: `GET /internal/agent-host`, the one raw WebSocket connection
 * agent-host makes to the kernel (design doc §7.2, §7.10 "运行时适配层"; docs/development-tasks.md
 * S1.5, second half, architecture point 1). Pure transport: parses/validates every inbound frame
 * (zod, `@nexttime/shared`'s `AgentHostToKernelFrameSchema`) and hands it to whichever
 * `AgentHostRuntime` was registered via `setAgentHostRuntimeForWsRoute` — this file owns no
 * protocol state of its own (which turns are active, the entry Handle cache, the accept-timeout
 * clock all live on `AgentHostRuntime`, application/host-bridge/agent-host-runtime.ts).
 *
 * Trust boundary: this route is part of the kernel's internal plane and sits behind
 * `interfaces/internal-auth`'s guard — the upgrade request must carry agent-host's own credential
 * (`Authorization: Bearer <token>`; the route's allow-list admits no other caller) and must not
 * originate from `NEXTTIME_SUBNET_WORKERS`, or it is answered 401 *before* `handleConnection`
 * below ever runs (so no other service, let alone an unauthenticated peer, can register itself as
 * the link and read a `startTurn` frame's entry Handle). The earlier "reachable only on
 * `control`, hence no auth" assumption was wrong for a dual-homed kernel — see `@nexttime/shared`'s
 * `internal-token.ts` doc comment for the full threat model. This file itself still owns no auth
 * logic: the guard is a root-level hook installed by `packages/kernel/src/index.ts`'s
 * `createServer`, keyed on the `/internal/` route prefix.
 *
 * Single active connection (S1 scope — one agent-host process per deployment, design doc §7.2 "一
 * 个 Node 服务"): a second connection never replaces the registered one (R-03 — it used to, which
 * handed every user's next `startTurn` to whoever connected last). `AgentHostRuntime.connect`
 * refuses it, this file closes it with 1013 "try again later", and the registered socket is
 * probed: a ping it does not answer within `LINK_PROBE_TIMEOUT_MS` gets it terminated, so after a
 * genuine agent-host restart whose old socket was left half-open, agent-host's own reconnect loop
 * gets in on a later attempt. An old socket that closed normally has already run
 * `AgentHostRuntime.disconnect` and the reconnect is accepted at once.
 *
 * Registration seam: mirrors `application/gateway/handlers.ts`'s pre-existing
 * `setAgentRuntimeForHandlers` pattern exactly — `packages/kernel/src/index.ts` (composition root)
 * calls `registerAgentHostWsRoute(app)` while building the server (no runtime needed yet, since the
 * handler below only reads the module-level variable when a connection actually arrives) and
 * `setAgentHostRuntimeForWsRoute(runtime)` later, from `createBackgroundServices`, once the real
 * `AgentHostRuntime` exists (only when `AGENT_RUNTIME=agent-host`; under the default `fake` runtime
 * this variable is simply never set, and any connection attempt is closed immediately below).
 */

let activeRuntime: AgentHostRuntime | undefined;

/** How long the registered link has to answer a liveness ping (sent when a second connection is
 *  refused) before it is terminated as dead. `ws` answers pings itself, so a live agent-host
 *  answers in milliseconds whatever it is doing. */
export const LINK_PROBE_TIMEOUT_MS = 5_000;

/** WebSocket close code for a refused second connection: 1013 "Try Again Later" (RFC 6455
 *  registry) — the legitimate case is an agent-host reconnecting before its old socket is gone. */
export const LINK_REFUSED_CLOSE_CODE = 1013;

/** Registers the `AgentHostRuntime` instance `GET /internal/agent-host` connections are handed to.
 *  Call once, after constructing the runtime — see this module's doc comment. */
export function setAgentHostRuntimeForWsRoute(runtime: AgentHostRuntime): void {
  activeRuntime = runtime;
}

/** Test-only escape hatch: clears the registered runtime. Not needed by production code — a
 *  process never un-registers its runtime once `AGENT_RUNTIME=agent-host` has constructed one —
 *  but test suites that build multiple servers in one process need to avoid leaking a runtime
 *  from an earlier test into a later one. Not exported from index.ts. */
export function _resetAgentHostRuntimeForWsRouteForTests(): void {
  activeRuntime = undefined;
}

function handleConnection(socket: WebSocket, probeTimeoutMs: number): void {
  const runtime = activeRuntime;
  if (!runtime) {
    // No AgentRuntime=agent-host configured on this process (e.g. AGENT_RUNTIME=fake) — nothing
    // to bridge to. Close rather than accept-and-ignore, so a misconfigured agent-host process
    // finds out immediately instead of silently sending frames nobody reads.
    socket.close();
    return;
  }

  let probing = false;
  const link: AgentHostLink = {
    send(frame) {
      // `ws`'s OPEN readyState is `1` — compared numerically to avoid importing the `WebSocket`
      // value (only its type is imported above) just for this one constant, same convention
      // interfaces/ws/server.ts's own `send()` helper uses.
      if (socket.readyState !== 1) {
        throw new Error('agent-host WebSocket is not open');
      }
      socket.send(JSON.stringify(frame));
    },
    probe() {
      if (probing) return;
      if (socket.readyState !== 1) {
        // Not open, so its `close` (which disconnects the link) is on its way or overdue.
        socket.terminate();
        return;
      }
      probing = true;
      const timer = setTimeout(() => socket.terminate(), probeTimeoutMs);
      timer.unref?.();
      socket.once('pong', () => {
        clearTimeout(timer);
        probing = false;
      });
      socket.ping();
    },
  };
  if (!runtime.connect(link)) {
    socket.close(LINK_REFUSED_CLOSE_CODE, 'agent-host link already registered');
    return;
  }

  socket.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return; // malformed frame — ignored, not fatal (agent-host will simply see no effect)
    }
    const result = AgentHostToKernelFrameSchema.safeParse(parsed);
    if (!result.success) return;
    runtime.handleFrame(result.data);
  });

  socket.once('close', () => {
    runtime.disconnect(link);
  });
}

/** Registers `GET /internal/agent-host` on `app`, including the `@fastify/websocket` plugin
 *  registration itself — guarded by `hasRequestDecorator('ws')` so this composes safely alongside
 *  `interfaces/ws/server.ts`'s own, separate registration of the same plugin on the same instance
 *  (`packages/kernel/src/index.ts`'s `createServer` calls both, `registerWsRoute` first). Despite
 *  `@fastify/websocket` being wrapped in `fastify-plugin` upstream, Fastify does **not** dedupe two
 *  independent top-level `app.register(fastifyWebsocket)` calls on the same instance — verified
 *  empirically (both throw `FST_ERR_DEC_ALREADY_PRESENT` on the `ws` request decorator without
 *  this guard). The guard is evaluated *inside* the nested `.register()` callback below, not at
 *  the time this function is called — `app.register(...)` only queues a plugin for avvio's
 *  (asynchronous) boot sequence, so a synchronous check right here would always see "not yet
 *  decorated" regardless of call order; avvio runs top-level registrations sequentially (each
 *  one's own subtree fully completes before the next starts), so by the time *this* callback
 *  actually executes, `registerWsRoute`'s own `fastifyWebsocket` registration — if it was called
 *  first, as `createServer` does — has already finished and the decorator is really there.
 *  `options.probeTimeoutMs` overrides `LINK_PROBE_TIMEOUT_MS` (tests). */
export function registerAgentHostWsRoute(
  app: FastifyInstance,
  options: { readonly probeTimeoutMs?: number } = {},
): void {
  const probeTimeoutMs = options.probeTimeoutMs ?? LINK_PROBE_TIMEOUT_MS;
  app.register(async (instance) => {
    // Only register the plugin if this instance doesn't already see the `ws` request decorator
    // it adds — inherited from a parent that registered it already (`registerWsRoute`, run first
    // by `createServer`), not just set directly on `instance`. Awaited: `@fastify/websocket` also
    // installs an `onRoute` hook that the `{websocket: true}` route option below depends on, which
    // must be active *before* that `.get()` call when this is the one doing the registering.
    if (!instance.hasRequestDecorator('ws')) {
      await instance.register(fastifyWebsocket);
    }
    instance.get('/internal/agent-host', { websocket: true }, (socket) => {
      handleConnection(socket, probeTimeoutMs);
    });
  });
}
