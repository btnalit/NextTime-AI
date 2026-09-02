/**
 * application/chat: Chat/Turn persistence; the AgentRuntime event sink that turns a runtime's
 * platform events into persisted chat_messages rows and live pushes; the in-process chat push
 * bus `interfaces/ws` subscribes from (design doc §7.1, §7.10; docs/development-tasks.md S1.4).
 * This module owns its own table (`chat_messages`, migrations/core/0008_chat_messages.sql) and
 * exposes only this service interface — it must not be reached into from another module's
 * internal files, and other modules must not query its table directly; cross-module coordination
 * happens through domain events (see packages/shared) and, for the WS push path specifically,
 * `push.ts`'s in-process registry.
 *
 * Contract: this module consumes events and read-only views only. It must never import
 * governance/approval or application/task — enforced by .dependency-cruiser.cjs. Approval
 * routing is governance/approval publishing events; chat subscribes and writes each holder's
 * system message (not yet wired — S2.3/S2.11 scope; this module's own outbox consumption today is
 * limited to what S1.4 needs).
 */

export {
  ChatNotFoundError,
  DEFAULT_CHAT_HISTORY_LIMIT,
  TurnAlreadyRunningError,
  chatMessageText,
  currentPrincipalId,
  findRunningTurn,
  getChatHistory,
  insertChatMessage,
  listChats,
  newChat,
  requireChatAccess,
  sendChatMessage,
} from './service.js';
export type {
  ChatHistoryPage,
  ChatMessageRole,
  ChatMessageRow,
  ChatRow,
  GetChatHistoryInput,
  InsertChatMessageInput,
  NewChatInput,
  RunningTurn,
  SendChatMessageInput,
  SendChatMessageResult,
} from './service.js';

export { createChatEventSink } from './event-sink.js';
export type { ChatEventSinkDeps } from './event-sink.js';

export { publishChatPushEvent, subscribeToChatPushEvents } from './push.js';
export type { ChatPushEvent, ChatPushListener } from './push.js';

export { DEFAULT_STALE_TURN_TIMEOUT_MS, interruptStaleRunningTurns } from './recovery.js';
export type { InterruptStaleRunningTurnsOptions } from './recovery.js';
