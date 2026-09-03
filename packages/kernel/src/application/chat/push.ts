import type { PlatformEvent } from '@nexttime/shared';

/**
 * application/chat/push: the in-process pub/sub `interfaces/ws` and `application/chat`'s own
 * `AgentRuntimeEventSink` share for a Chat's live push events — `chat.message` / `chat.stream` /
 * `chat.metadata` (design doc §9.4). Deliberately in-process only (one kernel instance, matching
 * every other S1.4 in-process mechanism — the outbox dispatcher, `application/host-bridge`'s
 * `TurnStarted` consumer): there is exactly one Fastify/Node process, so a plain `Map` of
 * listeners is sufficient; a multi-instance kernel would need this to become a real pub/sub
 * (Postgres LISTEN/NOTIFY, or a message broker) — out of S1.4 scope.
 *
 * Why this lives in `application/chat`, not `interfaces/ws`: `application` may not depend on
 * `interfaces` (.dependency-cruiser.cjs `kernel-application-may-not-depend-on-interfaces`), but
 * `application/chat`'s own event-sink (event-sink.ts) needs to publish into the same registry a
 * WS connection subscribes from — so the registry has to live at or below `application/chat`,
 * and `interfaces/ws` reaches into it as a normal application-layer service call (the same
 * direction every other `interfaces/*` module already depends on `application/*`).
 */

export type ChatPushEvent = Extract<
  PlatformEvent,
  { type: 'chat.message' | 'chat.stream' | 'chat.metadata' }
>;

export type ChatPushListener = (event: ChatPushEvent) => void;

const listenersByChatId = new Map<string, Set<ChatPushListener>>();

/** Registers `listener` for every push event published for `chatId`. Returns an unsubscribe
 *  function. Multiple listeners per chat are supported (not expected in S1.4's own WS server,
 *  which keeps at most one active subscription per socket — see interfaces/ws/server.ts — but
 *  nothing here assumes that). */
export function subscribeToChatPushEvents(chatId: string, listener: ChatPushListener): () => void {
  let listeners = listenersByChatId.get(chatId);
  if (!listeners) {
    listeners = new Set();
    listenersByChatId.set(chatId, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = listenersByChatId.get(chatId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByChatId.delete(chatId);
  };
}

/** Publishes `event` to every listener currently subscribed to `event.chatId`. A no-op if nobody
 *  is subscribed (the common case when no WS client is currently viewing that Chat). */
export function publishChatPushEvent(event: ChatPushEvent): void {
  const listeners = listenersByChatId.get(event.chatId);
  if (!listeners) return;
  for (const listener of listeners) listener(event);
}

/** Test-only escape hatch: clears every registered listener. Not exported from index.ts. */
export function _resetChatPushEventsForTests(): void {
  listenersByChatId.clear();
}

// -------------------------------------------------------------------------------------------
// Per-principal push bus (docs/development-tasks.md S2.11 deliverable 2: `action.pending` /
// `action.updated` / `task.updated`, §9.4). A second, independent registry alongside the
// per-chat one above — these three events are not scoped to one Chat (an ActionRequest's holders
// span however many Chats they each own; a Task's owner may be viewing any Chat, or none) but to
// a *principal*: "pushed to the connected sessions of the principals concerned" (S2.11 deliverable
// 2). `interfaces/ws/server.ts` subscribes every authenticated connection to its own resolved
// principal automatically (no separate `subscribe_principal` request — the task brief's own
// "(or reuse authenticate's session)" option), the same way `subscribeToChatPushEvents` above is
// driven by an explicit `subscribe_chat`.
//
// Lives here, not in `application/linkage` (the module that actually publishes into this bus for
// S2.11's three event kinds): the same reason the per-chat registry above lives in
// `application/chat` and not e.g. `application/host-bridge` — `interfaces/ws` needs one shared
// place to subscribe from regardless of which application module ends up publishing, and
// `application/chat` is already `interfaces/ws`'s existing push-bus dependency (kept a single
// import, not two near-identical ones).
// -------------------------------------------------------------------------------------------

export type PrincipalPushEvent = Extract<
  PlatformEvent,
  { type: 'action.pending' | 'action.updated' | 'task.updated' }
>;

export type PrincipalPushListener = (event: PrincipalPushEvent) => void;

const listenersByPrincipalId = new Map<string, Set<PrincipalPushListener>>();

/** Registers `listener` for every push event published for `principalId`. Returns an
 *  unsubscribe function — same shape as `subscribeToChatPushEvents` above. */
export function subscribeToPrincipalPushEvents(
  principalId: string,
  listener: PrincipalPushListener,
): () => void {
  let listeners = listenersByPrincipalId.get(principalId);
  if (!listeners) {
    listeners = new Set();
    listenersByPrincipalId.set(principalId, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = listenersByPrincipalId.get(principalId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByPrincipalId.delete(principalId);
  };
}

/** Publishes `event` to every listener currently subscribed to `principalId`. A no-op if that
 *  principal has no connected socket right now — the persisted `pending_context_items` row
 *  (`application/linkage`) is what makes the same information available on their next
 *  `get_entry_context`/reconnect regardless. `principalId` is a separate parameter (not read off
 *  `event`) because none of the three S2.11 wire events carry a principal id of their own — the
 *  same event object is typically published once per concerned principal (e.g. once per
 *  ActionRequest holder). */
export function publishPrincipalPushEvent(principalId: string, event: PrincipalPushEvent): void {
  const listeners = listenersByPrincipalId.get(principalId);
  if (!listeners) return;
  for (const listener of listeners) listener(event);
}

/** Test-only escape hatch: clears every registered listener. Not exported from index.ts. */
export function _resetPrincipalPushEventsForTests(): void {
  listenersByPrincipalId.clear();
}
