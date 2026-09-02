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
