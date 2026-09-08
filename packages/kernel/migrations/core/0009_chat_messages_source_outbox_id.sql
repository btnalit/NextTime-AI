-- module: core, version: 0009
--
-- chat_messages.source_outbox_id (lane-4 P1 fix, docs/development-tasks.md S2.11 "known deviation"
-- #2 revisited; design doc §13 "outbox 派发器崩溃 ... 消费者幂等"): a nullable dedupe key mirroring
-- `pending_context_items.source_outbox_id` (migrations/linkage/0001_pending_context_items.sql) —
-- makes an outbox-driven system-message write durably idempotent instead of relying only on the
-- process-lifetime in-memory `Set<outboxId>` each of `application/linkage`'s consumers already
-- keeps (S2.11's own implementation notes flagged this exact gap: "chat_messages 那条系统消息没有等价
-- 的持久幂等保护"). A redelivered outbox row that reaches `insertChatMessage` a second time — a
-- dispatcher crash between this row's own INSERT commit and the outbox row's `dispatched_at`
-- UPDATE, or this process restarting and losing its in-memory dedupe Set — is now a no-op (the
-- second insert attempt returns the row already written), never a duplicate persisted message.
--
-- Nullable, not NOT NULL: only outbox-driven writes (application/linkage's task-consumer.ts /
-- action-request-consumer.ts) have an outboxId to record — `application/chat/service.ts`'s
-- `sendChatMessage` (the user's own message) and `application/chat/event-sink.ts` (the agent's
-- assistant/tool messages, driven directly by an AgentRuntime event, not an outbox row) have
-- nothing to put here and stay NULL, the same nullability precedent this table's own `turn_id`
-- column already set (0008_chat_messages.sql's comment).
--
-- Unique index scoped to (workspace_id, source_outbox_id, chat_id), not just (workspace_id,
-- source_outbox_id): `action-request-consumer.ts`'s ActionRequestPending/ActionRequestUpdated
-- consumers write one system message per *target principal* (every holder plus the requester) for
-- a single outbox row — every one of those legitimately shares the same source_outbox_id but lands
-- in a different principal's own Chat, so chat_id has to be part of the idempotency key. Same
-- three-column shape `pending_context_items_dedupe_uidx` uses for the identical reason
-- (`principal_id` there, `chat_id` here — a target principal's own Chat, resolved by
-- `application/linkage/chat-targets.ts`'s `resolveDefaultChat`/`resolveTaskChat`, is already
-- principal-scoped, so the two keys select the same fan-out in practice).
--
-- Cross-process bootstrap lock: see 0001_identity.sql's comment for the full rationale — the
-- same `pg_advisory_xact_lock` call is the first statement of every file in this module.
select pg_advisory_xact_lock(7241000101);

alter table chat_messages add column if not exists source_outbox_id bigint;

create unique index if not exists chat_messages_source_outbox_dedupe_uidx
  on chat_messages (workspace_id, source_outbox_id, chat_id)
  where source_outbox_id is not null;
