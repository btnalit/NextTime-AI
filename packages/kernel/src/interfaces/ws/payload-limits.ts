import type { WebsocketPluginOptions } from '@fastify/websocket';
import type { WebSocket } from 'ws';

/**
 * interfaces/ws/payload-limits: how large a message each of the kernel's two WebSocket routes
 * accepts (review 2026-10-02 L1-16 / L5-12(b)).
 *
 * `ws` applies one `maxPayload` per `WebSocketServer`, and `@fastify/websocket` builds exactly one
 * server per Fastify instance, shared by `/ws` (server.ts) and `/internal/agent-host`
 * (agent-host.ts) — a second registration would answer every upgrade twice (see
 * `registerAgentHostWsRoute`'s doc comment). So the shared registration carries the *small* limit,
 * which bounds every WebSocket route unless it opts out, and the one route that must accept more
 * raises the limit for its own sockets ({@link setSocketMaxPayload}).
 */

/** The largest message `/ws` accepts, and the default for every route on the shared registration:
 *  1 MiB, the same as Fastify's default `bodyLimit` that `/api/cap/*` runs with (and `/mcp`'s
 *  explicit one). The largest legitimate console→kernel frame is a `send_chat_message`, which
 *  carries text only (no attachments on the wire); the same message sent over HTTP already stops at
 *  1 MiB. `ws` closes the socket with 1009 "Message Too Big" as soon as a frame header announces
 *  more, before the frame is buffered. */
export const WS_MAX_PAYLOAD_BYTES = 1_048_576;

/** Options for the one shared `@fastify/websocket` registration, whichever module registers it. */
export const WS_PLUGIN_OPTIONS: WebsocketPluginOptions = {
  options: { maxPayload: WS_MAX_PAYLOAD_BYTES },
};

/** `/internal/agent-host` keeps `ws`'s own default (100 MiB, its limit before the shared
 *  registration had one): raw gate outputs ride this link in `toolCallEnded.result` until L5-12(a)
 *  truncates them in agent-host's bridge. Only agent-host reaches this route: the internal-plane
 *  guard checks its credential before the upgrade. */
export const AGENT_HOST_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Sets the receive limit of one socket. `ws` has no public per-socket setter; the limit lives on
 * the socket's Receiver (`_receiver._maxPayload`, read at every frame header). Call it from the
 * route handler: `@fastify/websocket` runs that synchronously inside the upgrade callback, before
 * the socket has read any frame. Returns `false` if those internals have moved (a `ws` upgrade); the
 * socket then keeps the shared registration's limit. agent-host.test.ts's large-frame test fails in
 * that case.
 */
export function setSocketMaxPayload(socket: WebSocket, maxPayloadBytes: number): boolean {
  const receiver = (socket as unknown as { _receiver?: { _maxPayload?: unknown } })._receiver;
  if (receiver === undefined || typeof receiver._maxPayload !== 'number') return false;
  receiver._maxPayload = maxPayloadBytes;
  return true;
}
