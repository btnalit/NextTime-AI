-- module: core, version: 0055
--
-- 0055_chat_message_idempotency_key (legacy 673). A person's message names itself to the kernel
-- with the key its client chose for it (`send_chat_message.idempotencyKey`), so that sending it
-- again is not a second message. A send the console gave up on (30 seconds without an answer) may
-- still reach the kernel once the network is back and start its Turn; the person, still seeing the
-- draft and the error, sends again, and a second Turn ran the same request: its tool calls and
-- approvals acted twice. With the key, the second send returns the first message and its Turn, and
-- starts nothing (application/chat/service.ts `sendChatMessage`).
--
-- 1. `idempotency_key` (nullable text): the key the message was sent with. Only a person's own
--    message carries one (`chat_messages_idempotency_key_shape`: role `user`, 1–200 characters —
--    `@nexttime/shared` `MAX_CHAT_MESSAGE_IDEMPOTENCY_KEY_CHARS`). `null` on every row from before
--    this migration and on every message sent without a key.
-- 2. `chat_messages_idempotency_key_uidx`: one message per key in a Chat. The kernel looks a key up
--    before it starts a Turn; this index is the guard behind that look-up, for two sends of one key
--    at the same moment — the one that loses rolls its Turn back and returns the winner's message.
--
-- Additive only: a nullable column, a CHECK every existing row passes, and a partial index that
-- holds none of them (every existing row is null). No row is changed: messages sent twice before
-- this release stay as they are — each was its own Turn, and nothing can say now which of two
-- equal texts the person meant once. `chat_messages` stays append-only (0008: `select, insert` only
-- for `nexttime_app`), so a key is written with its message and never filled in or changed later;
-- that grant covers the new column.
--
-- Lock: `add column` without a default is catalog-only. The CHECK is added `not valid`, as 0054
-- does: validating would read the whole transcript under the ACCESS EXCLUSIVE lock this file holds
-- until it commits, only to re-prove what holds by construction (the column was added just above,
-- so every existing row is null). The index build reads the table once under a SHARE lock (sends
-- wait for it, briefly); it finds no row to index.
--
-- Rolling back (docs/runbooks/release.md §6). The previous release never names the column (its
-- insert and reads list their columns), so code alone may roll back: its messages carry `null`, and
-- a resend is a second Turn again. To remove the migration as well: drop the index, the constraint
-- and the column, then `delete from schema_migrations where module = 'core' and version = 55`.
--
-- Cross-process bootstrap lock: the same `pg_advisory_xact_lock` call is the first statement of
-- every file in this module (0001_identity.sql).
select pg_advisory_xact_lock(7241000101);

alter table chat_messages add column if not exists idempotency_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_idempotency_key_shape'
  ) then
    alter table chat_messages
      add constraint chat_messages_idempotency_key_shape
      check (
        idempotency_key is null
        or (role = 'user' and char_length(idempotency_key) between 1 and 200)
      ) not valid;
  end if;
end;
$$;

create unique index if not exists chat_messages_idempotency_key_uidx
  on chat_messages (workspace_id, chat_id, idempotency_key)
  where idempotency_key is not null;
