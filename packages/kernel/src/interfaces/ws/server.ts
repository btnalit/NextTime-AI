import fastifyWebsocket from '@fastify/websocket';
import { CAPABILITY_REGISTRY } from '@nexttime/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { ChatPushEvent, PrincipalPushEvent } from '../../application/chat/index.js';
import {
  publishChatPushEvent,
  subscribeToChatPushEvents,
  subscribeToPrincipalPushEvents,
} from '../../application/chat/index.js';
import type {
  DispatchDeps,
  ResolveCallerDeps,
  ResolvedCaller,
} from '../../application/gateway/index.js';
import { dispatchCapability, resolveCaller } from '../../application/gateway/index.js';
import type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
} from './rpc.js';
import {
  JsonRpcRequestSchema,
  WS_ERROR_CODES,
  errorResponse,
  mapDispatchError,
  notification,
  successResponse,
} from './rpc.js';

/**
 * interfaces/ws/server: the `/ws` chat WebSocket endpoint (design doc §9.4; docs/development-
 * tasks.md S1.4 deliverable 4). One Fastify route on the same instance as `/api/cap/:name`
 * (interfaces/http); every chat method except `subscribe_chat` is a thin pass-through to
 * `dispatchCapability` (application/gateway) — same auth/authorization/param-validation/audit as
 * HTTP, just a different transport. `subscribe_chat` additionally registers this socket on
 * `application/chat`'s push bus and replays persisted history after `startAfter`, by calling
 * `dispatchCapability` a second time for `get_chat_history` — reusing the same handler (and its
 * audit trail) rather than a bespoke read path.
 *
 * Depends only on application/governance service interfaces (application/gateway,
 * application/chat) — never reaches into substrate directly (depcruise
 * `kernel-interfaces-must-not-reach-into-substrate-directly`).
 */

export interface WsRouteDeps extends ResolveCallerDeps, DispatchDeps {}

/** The WS-eligible method set: every capability in the `chat` group (packages/shared/src/
 *  capabilities.ts) — derived from the registry rather than hand-duplicated, so it can never drift
 *  from what `dispatchCapability` itself already knows about. */
const CHAT_METHOD_NAMES: ReadonlySet<string> = new Set(
  CAPABILITY_REGISTRY.filter((c) => c.group === 'chat').map((c) => c.name),
);

/** Safety cap on how many persisted messages `subscribe_chat` replays in one go (docs/
 *  development-tasks.md S1.4: "replay persisted chat.message events with sequence > startAfter").
 *  A client that needs more than this should page the rest with `get_chat_history` — subscribing
 *  first still guarantees no live event is missed while it does (§9.4's whole point). */
const SUBSCRIBE_REPLAY_LIMIT = 500;

/** The shape `get_chat_history`'s handler (application/gateway/handlers.ts) returns as `result` —
 *  duplicated here as a narrow read-side type rather than imported, since `dispatchCapability`'s
 *  return type is deliberately `unknown` (application/gateway/dispatch.ts: every capability's
 *  result shape is its own handler's business, not the dispatcher's). */
interface ChatHistoryResult {
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly text: string;
    /** Structured message content (S2.12) — `system.*` cards carry `kind`/`actionRequestId`/… */
    readonly content?: Record<string, unknown>;
    readonly createdAt: string;
    readonly sequence: number;
  }[];
  readonly nextCursor?: string;
}

function isChatHistoryResult(value: unknown): value is ChatHistoryResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

interface ConnectionState {
  caller: ResolvedCaller | undefined;
  authFailed: boolean;
  authReady: boolean;
  readonly pendingFrames: RawData[];
  subscription: { chatId: string; unsubscribe: () => void } | undefined;
  /** S2.11 (docs/development-tasks.md S2.11 deliverable 2, §9.4): every authenticated connection's
   *  own `action.pending`/`action.updated`/`task.updated` push subscription — set once, right after
   *  `state.caller` itself, never re-subscribed or torn down until the socket closes (unlike
   *  `subscription` above, which is per-Chat and changes on every `subscribe_chat`). "reuse
   *  authenticate's session" (the task brief's own words) rather than a separate
   *  `subscribe_principal` request. */
  principalUnsubscribe: (() => void) | undefined;
}

type WsOutgoingMessage = JsonRpcSuccessResponse | JsonRpcErrorResponse | JsonRpcNotification;

function send(socket: WebSocket, message: WsOutgoingMessage): void {
  // `ws`'s OPEN readyState is `1`; compared numerically to avoid importing the `WebSocket` value
  // (only its type is imported above) just for this one constant.
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function parseFrame(raw: RawData): unknown {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
}

/**
 * After a successful `send_chat_message` dispatch (post-commit — `dispatchCapability`'s promise
 * resolves only once its transaction has committed, application/gateway/dispatch.ts), publishes a
 * live `chat.message` push for the user's own message too. Without this, only assistant/tool
 * messages push live (application/chat/event-sink.ts, driven by the AgentRuntime's `message`
 * events, published strictly after their own insert's transaction commits) — a second session/tab
 * subscribed to the same chat would otherwise only learn about a message it did not itself send
 * via the next `get_chat_history` page or a fresh `subscribe_chat`.
 *
 * Scoped to this transport only: `send_chat_message` reached via `interfaces/http` has no
 * equivalent post-dispatch hook available without changing that module, which is out of this
 * task's ownership — see the PR body "假设与偏离" for this deviation. `createdAt` here is the
 * push-time wall clock, not the authoritative DB `created_at`; a client that needs the precise
 * value already has `get_chat_history` for that.
 */
function publishSentMessagePush(rawParams: unknown, callResult: unknown): void {
  const params = (rawParams ?? {}) as { chatId?: unknown; text?: unknown };
  const result = callResult as { messageId?: unknown; sequence?: unknown };
  if (typeof params.chatId !== 'string' || typeof params.text !== 'string') return;
  if (typeof result.messageId !== 'string' || typeof result.sequence !== 'number') return;

  publishChatPushEvent({
    type: 'chat.message',
    chatId: params.chatId,
    message: {
      id: result.messageId,
      role: 'user',
      text: params.text,
      createdAt: new Date().toISOString(),
      sequence: result.sequence,
    },
  });
}

async function handleSubscribeChat(
  socket: WebSocket,
  deps: WsRouteDeps,
  caller: ResolvedCaller,
  id: JsonRpcId,
  rawParams: unknown,
  state: ConnectionState,
): Promise<void> {
  const params = (rawParams ?? {}) as { chatId?: unknown; startAfter?: unknown };
  const chatId = typeof params.chatId === 'string' ? params.chatId : undefined;
  const startAfter = typeof params.startAfter === 'string' ? params.startAfter : undefined;

  if (!chatId) {
    send(
      socket,
      errorResponse(
        id,
        WS_ERROR_CODES.INVALID_PARAMS,
        'subscribe_chat requires params.chatId (string)',
      ),
    );
    return;
  }

  // Same auth/authorization/audit path as every other chat method — `subscribe_chat` has a
  // no-op access-check handler registered for it in application/gateway/handlers.ts (docs/
  // development-tasks.md S1.4 deliverable 4: "dispatch a no-op access-check handler so audit is
  // written").
  try {
    await dispatchCapability(deps, caller, 'subscribe_chat', { chatId, startAfter });
  } catch (err) {
    const mapped = mapDispatchError(err);
    send(socket, errorResponse(id, mapped.code, mapped.message));
    return;
  }

  // Switching chats (or re-subscribing to the same one) drops any prior subscription first — one
  // active chat subscription per socket (S1 simplicity; §9.4 does not describe multi-chat sockets).
  state.subscription?.unsubscribe();

  let normalizedStartAfter = startAfter !== undefined ? Number(startAfter) : 0;
  if (!Number.isFinite(normalizedStartAfter) || normalizedStartAfter < 0) normalizedStartAfter = 0;

  // Sequences already sent to this socket for *this* subscription (live push and replay below
  // share the same set) — membership-tested, not a monotonic high-water mark. A high-water mark
  // (the previous implementation: "sequence <= highest sequence seen so far => already delivered")
  // is only correct if chat.message pushes for one chat always arrive in ascending sequence order,
  // which they do not: the user's own message is pushed by interfaces/ws/server.ts's
  // publishSentMessagePush *after* its dispatchCapability call resolves, while the assistant's
  // reply is pushed independently by application/chat/event-sink.ts, driven by the outbox
  // dispatcher's own poll tick picking up the just-committed TurnStarted event — two unsynchronized
  // code paths. The DB commit order between the two is still guaranteed (the assistant's row can
  // only be inserted after the user's row + TurnStarted have committed in the same transaction),
  // but which one's *push* reaches this listener first is not. Under the old high-water-mark
  // dedupe, an assistant push (sequence N+1) arriving before its own turn's user push (sequence N)
  // would bump the mark to N+1 and then silently drop N as "already delivered" when it arrived
  // moments later — never actually sent, never replayed (the replay cursor tracked the same
  // polluted mark). A plain per-sequence Set has no such ordering assumption: each sequence is
  // deduped independently of every other, so an out-of-order arrival is delivered exactly once,
  // whichever path (live or replay) reaches it first.
  const deliveredSequences = new Set<number>();

  function shouldDeliver(sequence: number): boolean {
    if (sequence <= normalizedStartAfter || deliveredSequences.has(sequence)) return false;
    deliveredSequences.add(sequence);
    return true;
  }

  // Registered *before* the replay read below, and before the success response is even sent — any
  // chat.message committed from this point on is guaranteed to reach this socket via the live
  // path, so the replay query below can never create a gap, only (harmlessly, given the shared
  // dedupe set) an overlap with it.
  const unsubscribe = subscribeToChatPushEvents(chatId, (event: ChatPushEvent) => {
    if (event.type === 'chat.message' && !shouldDeliver(event.message.sequence)) return;
    send(socket, notification(event.type, event));
  });
  state.subscription = { chatId, unsubscribe };

  send(socket, successResponse(id, { subscribed: true, chatId }));

  // Replay persisted chat.message rows with sequence > startAfter (§9.4's "subscribe first, then
  // page history" rule turned into an automatic catch-up on (re)subscribe, rather than requiring
  // the client to separately call get_chat_history for the exact gap it just closed by
  // subscribing) — reuses the get_chat_history capability (and its audit trail) rather than a
  // bespoke read. The cursor is the fixed `normalizedStartAfter` (not a value mutated by live
  // delivery) — the shared `deliveredSequences` set is what prevents double-delivery against
  // whatever the live path has already sent while this query was in flight.
  let replayResult: unknown;
  try {
    replayResult = await dispatchCapability(deps, caller, 'get_chat_history', {
      chatId,
      cursor: String(normalizedStartAfter),
      limit: SUBSCRIBE_REPLAY_LIMIT,
    });
  } catch {
    // The subscribe itself already succeeded and was acknowledged; a replay failure only means
    // the client falls back to its own get_chat_history call, same as after any subscribe — not
    // worth tearing down the subscription for.
    return;
  }
  if (!isChatHistoryResult(replayResult)) return;

  for (const message of replayResult.messages) {
    if (!shouldDeliver(message.sequence)) continue;
    send(
      socket,
      notification('chat.message', {
        type: 'chat.message',
        chatId,
        message,
      }),
    );
  }
}

/** I13: the acting principal for a `ResolvedCaller` — always the Handle's `on_behalf_of` for a
 *  handle caller, never a session/agent id of its own. Mirrors `application/gateway/dispatch.ts`'s
 *  own (unexported) `callerContext` exactly; duplicated rather than imported since dispatch.ts's
 *  version also resolves `workspaceId`, which this call site does not need (the socket's push
 *  events are already implicitly workspace-scoped — a principal id is unique per workspace). */
function callerPrincipalId(caller: ResolvedCaller): string {
  return caller.channel === 'human' ? caller.principal.id : caller.claims.obo;
}

/** S2.11 deliverable 2: subscribes `socket` to `caller`'s own `action.pending`/`action.updated`/
 *  `task.updated` push events (§9.4's "no `id`" notification shape, same as `subscribe_chat`'s live
 *  path) and records the unsubscribe function on `state`. Called once, immediately after
 *  `state.caller` is set, from both places that happens below (an `Authorization` header present
 *  at upgrade, or the first-frame `authenticate` RPC) — "reuse authenticate's session" per the
 *  task brief, rather than a separate `subscribe_principal` request the web client would have to
 *  remember to send. */
function subscribeCallerToPrincipalPush(
  socket: WebSocket,
  caller: ResolvedCaller,
  state: ConnectionState,
): void {
  state.principalUnsubscribe = subscribeToPrincipalPushEvents(
    callerPrincipalId(caller),
    (event: PrincipalPushEvent) => {
      send(socket, notification(event.type, event));
    },
  );
}

function handleConnection(socket: WebSocket, request: FastifyRequest, deps: WsRouteDeps): void {
  const state: ConnectionState = {
    caller: undefined,
    authFailed: false,
    authReady: false,
    pendingFrames: [],
    subscription: undefined,
    principalUnsubscribe: undefined,
  };

  socket.once('close', () => {
    state.subscription?.unsubscribe();
    state.subscription = undefined;
    state.principalUnsubscribe?.();
    state.principalUnsubscribe = undefined;
  });

  socket.on('message', (raw: RawData) => {
    if (!state.authReady) {
      state.pendingFrames.push(raw);
      return;
    }
    void handleFrame(raw);
  });

  async function authenticateFromParams(rawParams: unknown): Promise<ResolvedCaller | undefined> {
    const params = (rawParams ?? {}) as { token?: unknown };
    const token = typeof params.token === 'string' ? params.token : undefined;
    if (!token) return undefined;
    try {
      return await resolveCaller(`Bearer ${token}`, {
        pool: deps.pool,
        loadHandlePublicKey: deps.loadHandlePublicKey,
      });
    } catch {
      return undefined;
    }
  }

  async function handleFrame(raw: RawData): Promise<void> {
    const parsed = parseFrame(raw);
    const result = JsonRpcRequestSchema.safeParse(parsed);
    if (!result.success) {
      send(socket, errorResponse(null, WS_ERROR_CODES.PARSE_ERROR, 'invalid JSON-RPC 2.0 request'));
      return;
    }
    const req = result.data;

    // First-frame auth (no Authorization header was present at upgrade — see initAuth below):
    // the very first frame this connection ever processes must be `authenticate`, or the
    // connection is closed (§9.4 dispatch: "any other frame before auth → error and close").
    if (!state.caller) {
      if (req.method !== 'authenticate') {
        send(socket, errorResponse(req.id, WS_ERROR_CODES.UNAUTHORIZED, 'must authenticate first'));
        socket.close();
        return;
      }
      const caller = await authenticateFromParams(req.params);
      if (!caller) {
        send(socket, errorResponse(req.id, WS_ERROR_CODES.UNAUTHORIZED, 'unauthorized'));
        socket.close();
        return;
      }
      state.caller = caller;
      subscribeCallerToPrincipalPush(socket, caller, state);
      send(socket, successResponse(req.id, { authenticated: true }));
      return;
    }

    if (req.method === 'authenticate') {
      send(socket, errorResponse(req.id, WS_ERROR_CODES.INVALID_REQUEST, 'already authenticated'));
      return;
    }

    if (!CHAT_METHOD_NAMES.has(req.method)) {
      send(
        socket,
        errorResponse(req.id, WS_ERROR_CODES.METHOD_NOT_FOUND, `unknown method "${req.method}"`),
      );
      return;
    }

    if (req.method === 'subscribe_chat') {
      await handleSubscribeChat(socket, deps, state.caller, req.id, req.params, state);
      return;
    }

    try {
      const callResult = await dispatchCapability(deps, state.caller, req.method, req.params ?? {});
      if (req.method === 'send_chat_message') publishSentMessagePush(req.params, callResult);
      send(socket, successResponse(req.id, callResult));
    } catch (err) {
      const mapped = mapDispatchError(err);
      send(socket, errorResponse(req.id, mapped.code, mapped.message));
    }
  }

  async function initAuth(): Promise<void> {
    const authHeader = request.headers.authorization;
    if (authHeader) {
      try {
        state.caller = await resolveCaller(authHeader, {
          pool: deps.pool,
          loadHandlePublicKey: deps.loadHandlePublicKey,
        });
        subscribeCallerToPrincipalPush(socket, state.caller, state);
      } catch {
        send(socket, errorResponse(null, WS_ERROR_CODES.UNAUTHORIZED, 'unauthorized'));
        socket.close();
        state.authFailed = true;
      }
    }
    state.authReady = true;
    if (state.authFailed) return;
    const queued = state.pendingFrames.splice(0);
    for (const raw of queued) {
      await handleFrame(raw);
    }
  }

  void initAuth();
}

/** Registers `GET /ws` (design doc §9.4) on `app`, including the `@fastify/websocket` plugin
 *  registration itself — a caller (index.ts's `createServer`) never needs to know about that
 *  dependency directly. Safe to call once per Fastify instance. */
export function registerWsRoute(app: FastifyInstance, deps: WsRouteDeps): void {
  app.register(fastifyWebsocket);
  app.register((instance, _opts, done) => {
    instance.get('/ws', { websocket: true }, (socket, request) => {
      handleConnection(socket, request, deps);
    });
    done();
  });
}
