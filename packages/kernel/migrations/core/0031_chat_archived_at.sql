-- module: core, version: 0031
--
-- S6-A chat lifecycle (docs/console-completion-plan.md §4 "Chat 生命周期", §5.1 "归档与改名", §6
-- `archive_chat` / `unarchive_chat`): `chats.archived_at` — `active → archived` is a visibility
-- change only. `list_chats` hides rows with `archived_at is not null` unless asked
-- (`includeArchived`); every other read (`get_chat_history`, `subscribe_chat`, `explain` over a
-- Turn of the chat) is untouched, so the Chat / Turn / Decision / Fact provenance chain keeps
-- resolving for an archived chat exactly as before. `unarchive_chat` sets it back to null.
-- Physical deletion only ever happens with the workspace purge (§4), never here.
--
-- Nullable, no default, no backfill: every existing row reads as `active`. `title` (0003, never
-- written by application code until now) is filled by `send_chat_message`'s auto-title on the
-- first user message and by `rename_chat` — no schema change needed for that half.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table chats add column if not exists archived_at timestamptz;
