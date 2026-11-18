-- module: core, version: 0063
--
-- Indexes for the two workspace-wide reads of active Facts that had none (legacy 146, #514
-- record). `links` had no index that starts with `link_type` or orders by `recorded_at`, so both
-- reads below took every active Fact of the workspace through 0026's
-- `links_source_object_active_idx`, checked each one's visibility, and sorted what was left to
-- return a page — locally, with 300 000 active Facts, about 1.2 s for `list_facts` and 3.3 s for
-- the recent Facts; with 1 200 000, 1.7 s and 15.8 s:
--
--   links (workspace_id, link_type, date_trunc('milliseconds', recorded_at at time zone 'UTC') desc, id desc)
--     where superseded_at is null and invalidated_at is null   links_workspace_type_active_idx
--     `list_facts` (every active Fact of one type, workspace-wide; `buildListFactsQuery` in
--     substrate/graph/queries.ts): the keyset it orders by, so its first page is the first rows of
--     the index for that type. The key is the millisecond keyset its cursor carries (a JS `Date`),
--     taken in UTC: `date_trunc` on a `timestamptz` depends on the session's TimeZone and cannot
--     be indexed, on a `timestamp` it is immutable (0060's note). The capability-catalog type-usage
--     count (`substrate/graph/type-usage.ts`, `link_type = any(…)` on active Facts) reads it too.
--   links (workspace_id, recorded_at desc, id desc)
--     where superseded_at is null and invalidated_at is null   links_workspace_recorded_active_idx
--     the recent Facts `get_entry_context` hands the entry agent before every LLM call
--     (`buildRecentFactsQuery`, ordered by `recorded_at desc, id desc`, a page of 20): the first
--     rows of the index.
--
-- Both are partial on the active filter, like 0026's index: no read takes superseded or
-- invalidated Facts by type or by recency. Both reads still check each row's visibility as they
-- walk the index, so a caller who can see few of the workspace's Facts walks many rows to fill a
-- page; the PR measures that case (10 visible among 1 200 000): no slower than before the index.
-- Row-level security keeps a `list_facts` cursor bound a filter rather than an index condition
-- (`date_trunc` and `at time zone` are not LEAKPROOF; 0061's note), so a later page walks the
-- type's rows newer than the cursor — no sort.
--
-- `countFactsByLinkType` (also once before every entry LLM call) uses neither and is not made
-- faster by them: it counts every active Fact of the workspace and checks each one's visibility,
-- which is where its time goes (the PR has both plans; a separate legacy item tracks it).
--
-- Additive only: no data, constraint or grant changes. `list_facts` returns the rows, order and
-- pages it returned before (the session-zone millisecond and the UTC millisecond are the same
-- instant: zone offsets are whole seconds); the recent Facts are read by the same query as before.
-- The previous release runs unchanged on it (it never names the indexes; its `list_facts` still
-- sorts, as before).
--
-- Lock time: the runner applies each file in one transaction, so `create index concurrently` is
-- not available here. A plain `create index` takes a SHARE lock on `links` until this file
-- commits: reads go on, but every Fact write (assert, supersede, invalidate, verify) waits for both
-- builds — each one scan of `links` plus a sort of its active rows (locally, for 1 600 000 rows of
-- which 1 200 000 active, a 284 MB table: 1.6 s and 0.8 s, indexes of 78 MB and 67 MB; about
-- 2.5 s per million active Facts together). Measure the table first
-- (`select count(*) from links where superseded_at is null and invalidated_at is null;`). Where
-- that is too long for the window, the indexes can be built ahead without blocking writes, outside
-- a transaction, while the previous release runs (same names and definitions as below):
--
--   create index concurrently if not exists links_workspace_type_active_idx
--     on links (workspace_id, link_type, (date_trunc('milliseconds', recorded_at at time zone 'UTC')) desc, id desc)
--     where superseded_at is null and invalidated_at is null;
--   create index concurrently if not exists links_workspace_recorded_active_idx
--     on links (workspace_id, recorded_at desc, id desc)
--     where superseded_at is null and invalidated_at is null;
--
-- and this file then finds them and builds nothing. A concurrent build that fails or is cancelled
-- leaves an invalid index under that name, which `if not exists` alone would keep (and the planner
-- never uses); the block below drops such a leftover first, so the file always ends with valid
-- indexes (0044's pattern).
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

do $$
declare
  leftover text;
begin
  for leftover in
    select c.relname
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where i.indrelid = 'links'::regclass
       and c.relname in ('links_workspace_type_active_idx', 'links_workspace_recorded_active_idx')
       and not i.indisvalid
  loop
    execute format('drop index %I', leftover);
  end loop;
end;
$$;

create index if not exists links_workspace_type_active_idx
  on links (workspace_id, link_type, (date_trunc('milliseconds', recorded_at at time zone 'UTC')) desc, id desc)
  where superseded_at is null and invalidated_at is null;

create index if not exists links_workspace_recorded_active_idx
  on links (workspace_id, recorded_at desc, id desc)
  where superseded_at is null and invalidated_at is null;
