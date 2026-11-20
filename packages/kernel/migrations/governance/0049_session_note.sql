-- module: governance, version: 0049
--
-- Legacy 168: a person's Handles are listed by session (`list_handles`), and a session is what
-- `revoke_handle` ends — but two sessions of one kind ("平台外客户端"), or of two service accounts
-- with one name, read the same, and ending the wrong one cuts off a collector or a script. A person
-- who issues a session (`issue_handle`, `issue_service_handle`) may now say what it is for: `note`,
-- shown beside it in the list with its short id (`@nexttime/shared` `sessionShortId`, derived from
-- the id, so not stored).
--
-- `note` is null without one, and always for a session no person issues (entry, Worker run, admin
-- agent, web). The kernel trims it, stores blank as null and refuses one that looks like a
-- credential; the cap here is the wire cap (`HANDLE_NOTE_MAX_LENGTH`, 200 UTF-16 code units, so
-- at most 200 characters), so a note the kernel accepts always fits. Written once, when the session
-- is inserted: nothing updates it.
--
-- Pure addition, no backfill: existing sessions have no note. Rolling back: code alone (the
-- previous release inserts sessions by column list and never reads `note`); to remove it as well,
-- `alter table sessions drop column note`, then
-- `delete from schema_migrations where module = 'governance' and version = 49`.
--
-- Runner ordering / advisory lock: same module (`governance`), same key as every other governance
-- migration.
select pg_advisory_xact_lock(7241000201);

alter table sessions add column if not exists note text;

alter table sessions drop constraint if exists sessions_note_bounded;
alter table sessions add constraint sessions_note_bounded
  check (note is null or (char_length(note) between 1 and 200 and note = btrim(note)));
