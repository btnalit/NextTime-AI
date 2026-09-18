-- module: core, version: 0028
--
-- S5.3 数据与代码分离 (docs/development-tasks.md §5b S5.3; STATUS leftovers 9 / 11).
--
-- 1. `sources.name` — a Source's identity within its `kind`. Until now the name lived only in
--    `metadata.name` (`register_source` folded it in on write) and nothing stopped two rows from
--    claiming it, so a collector had to cache the id of the row it registered in a local state
--    file — which the S3 acceptance script then had to delete between runs (leftover 9's second
--    half). From S5.3 `register_source` is idempotent on (kind, name): the same caller registering
--    the same name gets the same row back. Backfilled from `metadata.name`, but only where that
--    (workspace, kind, name) is unique among the rows carrying it — a duplicate set keeps `name`
--    null (those rows stay reachable by id exactly as before), so this migration can never fail on
--    a host with a pre-S5.3 history. The partial unique index below is the real guard;
--    `register_source` looks up first and maps a unique violation on insert (a same-named private
--    Source RLS hides from the caller) to the same 409 `source_identity_conflict`.
-- 2. `workspaces.purpose` / `workspaces.expires_at` — an `ephemeral` workspace (an acceptance run,
--    `make demo`) carries an expiry, so `scripts/delete-workspaces-matching.sh --expired` retires
--    it by policy instead of by name regex (leftover 11's "清理靠名字正则" half). A `standard`
--    workspace never expires (`expires_at` null). Read by the platform plane's `WORKSPACE_SELECT`
--    (already table-level `select`), written only on the bootstrap path (superuser) — no new grant.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table sources add column if not exists name text;

update sources s
   set name = s.metadata ->> 'name'
 where s.name is null
   and coalesce(s.metadata ->> 'name', '') <> ''
   and not exists (
     select 1 from sources o
      where o.workspace_id = s.workspace_id
        and o.kind = s.kind
        and o.id <> s.id
        and o.metadata ->> 'name' = s.metadata ->> 'name'
   );

create unique index if not exists sources_kind_name_uidx
  on sources (workspace_id, kind, name)
  where name is not null;

alter table workspaces
  add column if not exists purpose text not null default 'standard'
    check (purpose in ('standard', 'ephemeral'));

alter table workspaces add column if not exists expires_at timestamptz;
