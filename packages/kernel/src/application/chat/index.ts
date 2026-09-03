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
 * governance/approval or application/task — enforced by .dependency-cruiser.cjs (extended by
 * S2.11 to also cover `application/linkage`, below).
 *
 * S2.11 update: the ActionRequestPending/ActionRequestUpdated/TaskUpdated → "write each holder's
 * system message" wiring described above turned out not to belong in this module after all — it
 * needs to *read* governance/approval (`getActionRequest`, to know a holder list and status
 * without re-deriving I14) and application/task (`readTask`/`getTaskWithWorkerRuns`, to know a
 * Task's `onBehalfOf`), both of which this module is contractually forbidden to import even via
 * their public `index.ts` (the depcruise rule matches the whole `governance/approval/` and
 * `application/task/` path trees, not just their internals — there is no "public reads are fine"
 * carve-out). `application/linkage` (a sibling `application/*` module, *not* subject to this
 * module's own import restriction) owns that wiring instead, calling back into this module's own
 * public surface — `insertChatMessage` to persist, `publishChatPushEvent`/
 * `publishPrincipalPushEvent` to push live — exactly the way `interfaces/ws` already does. See
 * `application/linkage/index.ts`'s own doc comment for the full design.
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

export { publishPrincipalPushEvent, subscribeToPrincipalPushEvents } from './push.js';
export type { PrincipalPushEvent, PrincipalPushListener } from './push.js';

export { DEFAULT_STALE_TURN_TIMEOUT_MS, interruptStaleRunningTurns } from './recovery.js';
export type { InterruptStaleRunningTurnsOptions } from './recovery.js';
