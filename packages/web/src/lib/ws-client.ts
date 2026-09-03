import type { ActionRequestStatus, ChatStreamPayload, TaskStatus } from '@nexttime/shared';

/**
 * lib/ws-client: typed JSON-RPC 2.0 client for the kernel's `/ws` chat socket (design doc §9.4;
 * docs/development-tasks.md S1.8 deliverable 1). This is the one place the "subscribe first, then
 * page history" rule (§9.4: "先 subscribe_chat 再 get_chat_history 翻页，否则会丢事件") is
 * implemented — every caller (the chat page) only sees a `subscribeChat()` call and a stream of
 * deduped, in-order `onMessage` callbacks; it never has to reason about the race between a live
 * push and a history page itself.
 *
 * Wire contract this codes against (packages/kernel/src/interfaces/ws/{server,rpc}.ts,
 * packages/shared/src/{capabilities,events}.ts — read, not modified, per this task's ownership):
 *   - One `/ws` connection, JSON-RPC 2.0 requests/responses (carry `id`) plus server-initiated
 *     notifications (no `id`, `method` = the pushed event's own `type`).
 *   - First frame must be `{method: "authenticate", params: {token}}` — the server closes the
 *     socket on anything else arriving first (interfaces/ws/server.ts `handleConnection`).
 *   - `subscribe_chat(chatId, startAfter)` takes `startAfter` as a **string** (packages/shared/src/
 *     capabilities.ts `subscribeChat`'s paramsSchema), even though `chat_messages.sequence` is a
 *     number on the wire (packages/shared/src/events.ts `ChatMessageEvent`) — this module is the
 *     one place that conversion happens.
 *   - `get_chat_history(chatId, cursor, limit)` pages ascending by `sequence`; `cursor` is also a
 *     string, and a page's `nextCursor` (present only when a *full* page came back) is the next
 *     cursor to request (application/chat/service.ts `getChatHistory`).
 *   - `send_chat_message` rejects with JSON-RPC error code `-32010`
 *     (`WS_ERROR_CODES.TURN_ALREADY_RUNNING`) while a Turn is already running on that Chat —
 *     surfaced here as `TurnAlreadyRunningError` so a caller can `catch` it specifically instead of
 *     string-matching an error message.
 */

// -------------------------------------------------------------------------------------------
// Wire types
// -------------------------------------------------------------------------------------------

/** The shape of one `chat_messages` row as every WS response/push carries it (`toWireChatMessage`,
 *  packages/kernel/src/application/gateway/handlers.ts; `ChatMessageEvent`, packages/shared/src/
 *  events.ts). `kind`/`content` (S2.11 addition) are present only on the three `role==='system'`
 *  message kinds `application/linkage` writes (`system.task_update` / `system.action_pending` /
 *  `system.action_update`, packages/shared/src/chat-message-content.ts) — `undefined` for every
 *  ordinary user/assistant/tool message. `content` is loosened to a bare record here (not the
 *  stricter `SystemMessageContent` union) for the same reason `events.ts` loosens it on the wire:
 *  this module does not import `@nexttime/shared`'s Zod schemas at runtime (S1.8's "type-only
 *  import, erased at compile time" bundle-size convention) — `lib/action-card.ts` (S2.10) narrows
 *  it by `kind` at the point it actually needs the fields. */
export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly text: string;
  readonly createdAt: string;
  readonly sequence: number;
  readonly kind?: string;
  readonly content?: Readonly<Record<string, unknown>>;
}

// -------------------------------------------------------------------------------------------
// S2.10 principal-scoped pushes (design doc §9.4; docs/development-tasks.md S2.10 deliverable 1).
// Unlike `chat.message`/`chat.stream`/`chat.metadata` above, these three carry no `chatId` — the
// kernel subscribes every authenticated connection to its own principal's `action.pending`/
// `action.updated`/`task.updated` push events once, right after `authenticate` succeeds
// (packages/kernel/src/interfaces/ws/server.ts `subscribeCallerToPrincipalPush`), independent of
// whatever Chat (if any) is currently `subscribeChat`-ed on this same socket. `handleNotification`
// below dispatches these three by `method` *before* the chatId-scoped switch for exactly that
// reason — filtering them by `activeSubscription.chatId` (as every `chat.*` push is) would silently
// drop every one of them, since they have no `chatId` field to match against.
// -------------------------------------------------------------------------------------------

/** `action.pending` (packages/shared/src/events.ts `ActionPendingEvent`) — the only source that
 *  carries `title`/a human-readable `description`/`simulated`; none of these three fields exist on
 *  a persisted `system.action_pending` chat message or on a `list_pending`/`get_action` row (see
 *  `lib/action-card.ts`'s own module doc comment for why). */
export interface ActionPendingPush {
  readonly actionRequestId: string;
  readonly gatekeeperId: string;
  readonly title: string;
  readonly description: string;
  readonly actionKind: { readonly tag: string; readonly label: string };
  readonly awaitDecision: boolean;
  readonly simulated?: unknown;
}

/** `action.updated` (packages/shared/src/events.ts `ActionUpdatedEvent`). */
export interface ActionUpdatedPush {
  readonly actionRequestId: string;
  readonly status: ActionRequestStatus;
}

/** `task.updated` (packages/shared/src/events.ts `TaskUpdatedPushEvent`). */
export interface TaskUpdatedPush {
  readonly taskId: string;
  readonly status: TaskStatus;
}

interface ChatHistoryResult {
  readonly messages: readonly ChatMessage[];
  readonly nextCursor?: string;
}

interface SendChatMessageResult {
  readonly messageId: string;
  readonly sequence: number;
  readonly turnId: string;
}

/** Handlers a `subscribeChat` caller supplies. `onMessage` fires at most once per distinct
 *  `sequence` — already deduped across the initial `get_chat_history` paging and any live
 *  `chat.message` push that arrives while paging is still in flight (and again transparently
 *  across a reconnect's re-subscribe). `onCaughtUp` fires once the initial history paging has
 *  drained (i.e. the client is now purely live) — useful for a one-time "history loaded" UI
 *  transition; not required for correctness. */
export interface ChatSubscriptionHandlers {
  readonly onMessage: (message: ChatMessage) => void;
  readonly onStream: (turnId: string, payload: ChatStreamPayload) => void;
  readonly onMetadata: (metadata: Readonly<Record<string, unknown>>) => void;
  readonly onCaughtUp?: () => void;
}

export type Unsubscribe = () => void;

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** A JSON-RPC error response, typed by its wire `code` (interfaces/ws/rpc.ts `WS_ERROR_CODES`). */
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** `WS_ERROR_CODES.TURN_ALREADY_RUNNING` (-32010, interfaces/ws/rpc.ts) — thrown instead of a
 *  generic `RpcError` so a caller can `catch (err) { if (err instanceof TurnAlreadyRunningError) }`
 *  rather than checking a magic number itself (docs/development-tasks.md S1.8 deliverable 3: "-32010
 *  surfaces as a typed error"). */
export class TurnAlreadyRunningError extends RpcError {
  constructor(message: string) {
    super(TURN_ALREADY_RUNNING_CODE, message);
    this.name = 'TurnAlreadyRunningError';
  }
}

const TURN_ALREADY_RUNNING_CODE = -32010;

function toTypedError(error: { readonly code: number; readonly message: string }): RpcError {
  if (error.code === TURN_ALREADY_RUNNING_CODE) return new TurnAlreadyRunningError(error.message);
  return new RpcError(error.code, error.message);
}

// -------------------------------------------------------------------------------------------
// Minimal WebSocket surface — lets tests inject a fake without pulling in a real socket
// implementation. Matches the subset of the browser `WebSocket` API this client actually uses
// (assignment-style handlers, not addEventListener, to keep the fake trivial to implement).
// -------------------------------------------------------------------------------------------

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const READY_STATE_OPEN = 1;

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

// -------------------------------------------------------------------------------------------
// JSON-RPC frame shapes (mirrors packages/kernel/src/interfaces/ws/rpc.ts — duplicated as a
// narrow client-side type rather than imported, since that module lives under packages/kernel,
// out of this task's ownership and not published for cross-package import anyway).
// -------------------------------------------------------------------------------------------

interface JsonRpcResponseFrame {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface JsonRpcNotificationFrame {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

function isNotificationFrame(
  frame: JsonRpcResponseFrame | JsonRpcNotificationFrame,
): frame is JsonRpcNotificationFrame {
  return !('id' in frame) && typeof (frame as JsonRpcNotificationFrame).method === 'string';
}

// -------------------------------------------------------------------------------------------
// WsClient
// -------------------------------------------------------------------------------------------

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/** How many messages one `get_chat_history` page requests at a time while `subscribeChat` walks
 *  full history. Independent of the server's own `SUBSCRIBE_REPLAY_LIMIT` (interfaces/ws/
 *  server.ts) — this client always finishes the walk itself regardless of how much of it the
 *  server's own convenience replay already covered. */
const HISTORY_PAGE_LIMIT = 200;

/** Delay before a reconnect attempt after an unexpected socket close. `0` in tests for
 *  determinism; a real deployment keeps the default so a flapping connection does not spin. */
const DEFAULT_RECONNECT_DELAY_MS = 1000;

interface ActiveSubscription {
  readonly chatId: string;
  readonly handlers: ChatSubscriptionHandlers;
  readonly seenSequences: Set<number>;
  lastSeenSequence: number;
}

export interface WsClientOptions {
  readonly url: string;
  readonly createSocket?: WebSocketFactory;
  readonly reconnectDelayMs?: number;
}

export class WsClient {
  private readonly url: string;
  private readonly createSocket: WebSocketFactory;
  private readonly reconnectDelayMs: number;

  private socket: WebSocketLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private authenticated = false;
  private token: string | undefined;
  private manuallyClosed = false;
  private activeSubscription: ActiveSubscription | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // S2.10 principal-scoped push listeners — connection-lifetime, not tied to `activeSubscription`
  // or to any particular socket instance, so they survive a reconnect with no extra bookkeeping
  // (the *server* re-subscribes this principal on every fresh `authenticate`, per this file's own
  // module doc comment above `ActionPendingPush`).
  private readonly actionPendingListeners = new Set<(event: ActionPendingPush) => void>();
  private readonly actionUpdatedListeners = new Set<(event: ActionUpdatedPush) => void>();
  private readonly taskUpdatedListeners = new Set<(event: TaskUpdatedPush) => void>();

  constructor(options: WsClientOptions) {
    this.url = options.url;
    this.createSocket = options.createSocket ?? defaultWebSocketFactory;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  /** Opens the socket and resolves once it is open (or rejects on a connect-time error). Does not
   *  authenticate — call `authenticate()` next, as the first frame the server will accept. */
  connect(): Promise<void> {
    this.manuallyClosed = false;
    return new Promise((resolve, reject) => {
      const socket = this.createSocket(this.url);
      this.socket = socket;
      let settled = false;
      socket.onopen = () => {
        settled = true;
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('WsClient: connection error'));
        }
      };
      socket.onmessage = (event) => this.handleFrame(event.data);
      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          reject(new Error('WsClient: connection closed before open'));
        }
        this.handleClose(event);
      };
    });
  }

  /** Sends the mandatory first frame (§9.4) and, on success, unlocks every other `call()`. */
  async authenticate(token: string): Promise<void> {
    await this.rpc('authenticate', { token });
    this.authenticated = true;
    this.token = token;
  }

  /** One JSON-RPC request/response round trip. `method` must be a registered chat capability name
   *  (or `"authenticate"`, handled specially by the server) — see packages/shared/src/
   *  capabilities.ts for the `chat` group this client is scoped to. Rejects with `RpcError` (or
   *  its `TurnAlreadyRunningError` subclass) on a JSON-RPC error response. */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method !== 'authenticate' && !this.authenticated) {
      return Promise.reject(new Error('WsClient: call() before authenticate() succeeded'));
    }
    return this.rpc<T>(method, params);
  }

  private rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== READY_STATE_OPEN) {
      return Promise.reject(new Error('WsClient: not connected'));
    }
    const id = this.nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      socket.send(JSON.stringify(request));
    });
  }

  /**
   * Subscribes to one Chat's push events and walks its full persisted history, in the order
   * §9.4 requires: `subscribe_chat` is acknowledged *before* any `get_chat_history` page is
   * requested, so a message committed after subscription but before (or during) paging is
   * guaranteed to arrive — either inline in a page, or as a live push — and never both, thanks to
   * the `sequence`-keyed dedupe shared by both paths. Only one Chat subscription is active at a
   * time (mirrors the server's own "one active chat subscription per socket" — interfaces/ws/
   * server.ts); calling this again (e.g. switching chats) replaces the previous one.
   *
   * `startAfter` is the `sequence` cursor to resume from — `0` for a fresh open, or the last
   * `sequence` this client already knows about (e.g. re-opening the same chat in the same session).
   */
  async subscribeChat(
    chatId: string,
    startAfter: number,
    handlers: ChatSubscriptionHandlers,
  ): Promise<Unsubscribe> {
    const subscription: ActiveSubscription = {
      chatId,
      handlers,
      seenSequences: new Set<number>(),
      lastSeenSequence: startAfter,
    };
    this.activeSubscription = subscription;

    await this.call('subscribe_chat', { chatId, startAfter: String(startAfter) });
    await this.pageHistory(subscription);
    subscription.handlers.onCaughtUp?.();

    return () => {
      if (this.activeSubscription === subscription) this.activeSubscription = undefined;
    };
  }

  private async pageHistory(subscription: ActiveSubscription): Promise<void> {
    let cursor = String(subscription.lastSeenSequence);
    for (;;) {
      const page = await this.call<ChatHistoryResult>('get_chat_history', {
        chatId: subscription.chatId,
        cursor,
        limit: HISTORY_PAGE_LIMIT,
      });
      for (const message of page.messages) this.deliverMessage(subscription, message);
      if (page.nextCursor === undefined) return;
      cursor = page.nextCursor;
    }
  }

  private deliverMessage(subscription: ActiveSubscription, message: ChatMessage): void {
    if (subscription.seenSequences.has(message.sequence)) return;
    subscription.seenSequences.add(message.sequence);
    if (message.sequence > subscription.lastSeenSequence) {
      subscription.lastSeenSequence = message.sequence;
    }
    subscription.handlers.onMessage(message);
  }

  /** Sends a chat message and starts a Turn. Rejects with `TurnAlreadyRunningError` (not a plain
   *  `RpcError`) when the Chat already has a Turn running (§9.4). */
  sendChatMessage(chatId: string, text: string): Promise<SendChatMessageResult> {
    return this.call<SendChatMessageResult>('send_chat_message', { chatId, text });
  }

  stopAgent(chatId: string): Promise<{ stopped: boolean }> {
    return this.call('stop_agent', { chatId });
  }

  /** Registers a listener for this connection's own `action.pending` pushes (§9.4, S2.10
   *  deliverable 1) — every ActionRequest this principal holds approval scope for, regardless of
   *  which Chat (if any) it is currently subscribed to. Call at most once per authenticated
   *  session's lifetime per caller (e.g. once from `ApprovalQueuePage`'s mount effect); multiple
   *  registrations are all delivered independently. Returns an `Unsubscribe`. */
  onActionPending(handler: (event: ActionPendingPush) => void): Unsubscribe {
    this.actionPendingListeners.add(handler);
    return () => this.actionPendingListeners.delete(handler);
  }

  /** Registers a listener for this connection's own `action.updated` pushes (§9.4). */
  onActionUpdated(handler: (event: ActionUpdatedPush) => void): Unsubscribe {
    this.actionUpdatedListeners.add(handler);
    return () => this.actionUpdatedListeners.delete(handler);
  }

  /** Registers a listener for this connection's own `task.updated` pushes (§9.4). */
  onTaskUpdated(handler: (event: TaskUpdatedPush) => void): Unsubscribe {
    this.taskUpdatedListeners.add(handler);
    return () => this.taskUpdatedListeners.delete(handler);
  }

  private handleFrame(raw: string): void {
    let parsed: JsonRpcResponseFrame | JsonRpcNotificationFrame;
    try {
      parsed = JSON.parse(raw) as JsonRpcResponseFrame | JsonRpcNotificationFrame;
    } catch {
      return;
    }

    if (isNotificationFrame(parsed)) {
      this.handleNotification(parsed);
      return;
    }

    const id = typeof parsed.id === 'number' ? parsed.id : undefined;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (parsed.error) {
      pending.reject(toTypedError(parsed.error));
    } else {
      pending.resolve(parsed.result);
    }
  }

  private handleNotification(frame: JsonRpcNotificationFrame): void {
    // Principal-scoped pushes (S2.10) — dispatched by `method` alone, *before* any chatId check:
    // these frames carry no `chatId` at all (see the module doc comment above `ActionPendingPush`),
    // so folding them into the chatId-scoped switch below would silently drop every one of them.
    switch (frame.method) {
      case 'action.pending':
        for (const fn of this.actionPendingListeners) fn(frame.params as ActionPendingPush);
        return;
      case 'action.updated':
        for (const fn of this.actionUpdatedListeners) fn(frame.params as ActionUpdatedPush);
        return;
      case 'task.updated':
        for (const fn of this.taskUpdatedListeners) fn(frame.params as TaskUpdatedPush);
        return;
      default:
        break;
    }

    const subscription = this.activeSubscription;
    if (!subscription) return;

    const params = (frame.params ?? {}) as { chatId?: unknown };
    if (params.chatId !== subscription.chatId) return;

    switch (frame.method) {
      case 'chat.message': {
        const { message } = frame.params as { message: ChatMessage };
        this.deliverMessage(subscription, message);
        return;
      }
      case 'chat.stream': {
        const { turnId, payload } = frame.params as {
          turnId: string;
          payload: ChatStreamPayload;
        };
        subscription.handlers.onStream(turnId, payload);
        return;
      }
      case 'chat.metadata': {
        const { metadata } = frame.params as { metadata: Record<string, unknown> };
        subscription.handlers.onMetadata(metadata);
        return;
      }
      default:
        return;
    }
  }

  private handleClose(event: { code?: number; reason?: string }): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('WsClient: connection closed'));
    }
    this.pending.clear();
    this.authenticated = false;
    this.socket = undefined;
    void event;

    // Only a socket that has *previously* authenticated successfully (this.token set) is worth
    // auto-reconnecting: an initial connect()/authenticate() failure (bad URL, bad key, server
    // down) is the caller's own retry decision, not this client's — auto-reconnecting behind a
    // still-pending or already-rejected initial authenticate() would race a second socket against
    // whatever the caller does next (e.g. the login screen letting the user retry).
    if (this.manuallyClosed || this.token === undefined) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // Guarded here (not just at each call site) so a `close()` racing an in-flight reconnect
    // attempt — `reconnect()`'s own catch block below also calls this — can never schedule
    // another one: `close()` sets `manuallyClosed` synchronously before anything async happens.
    if (this.manuallyClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, this.reconnectDelayMs);
  }

  /**
   * Reconnects and, if a chat was subscribed, re-subscribes with `startAfter` set to the last
   * `sequence` this client already delivered — never re-delivering an already-seen message, and
   * never missing one committed while the socket was down (docs/development-tasks.md S1.8
   * deliverable 1: "reconnect with resubscribe from the last seen sequence"). Reuses the same
   * `seenSequences` set across the reconnect so a message replayed again by the server's own
   * catch-up (interfaces/ws/server.ts `handleSubscribeChat`) still dedupes correctly.
   */
  private async reconnect(): Promise<void> {
    const subscription = this.activeSubscription;
    const token = this.token;
    try {
      await this.connect();
      if (token) await this.authenticate(token);
      if (subscription) {
        await this.call('subscribe_chat', {
          chatId: subscription.chatId,
          startAfter: String(subscription.lastSeenSequence),
        });
        await this.pageHistory(subscription);
        subscription.handlers.onCaughtUp?.();
      }
    } catch {
      this.scheduleReconnect();
    }
  }

  /** Closes the socket and stops any pending reconnect attempt. */
  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
  }
}
