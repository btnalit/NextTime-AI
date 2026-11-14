-- module: core, version: 0060
--
-- Index for listing a workspace's Decisions newest first (legacy 429, review #493 on #700).
-- `decisions` carries only its primary key `(workspace_id, id)` (0002) and 0028's subject columns,
-- so `query_decisions` (the console's 推理链 picker and its 「最近的决定」 list, paged) and
-- `find_precedents` read every Decision of the workspace and sort them before returning the first
-- page — about 110 ms at 200 000 Decisions, again for every further page:
--
--   decisions (workspace_id, date_trunc('milliseconds', created_at at time zone 'UTC') desc, id desc)
--     the sort key both reads now order by (substrate/epistemic/decisions.ts,
--     `decisionOrderKey`), so the newest page is the first rows of the index and a cursor page
--     starts where the cursor points. The key is the millisecond keyset of S5.5 leftover 23 — the
--     cursor carries a JS `Date` — taken in UTC: `date_trunc` on a `timestamptz` depends on the
--     session's TimeZone and cannot be indexed, on a `timestamp` it is immutable. Same instants,
--     same order: truncating to the millisecond in UTC or in any other zone gives the same instant.
--
-- Additive only: no data, constraint or grant changes. `query_decisions` returns the order and
-- the pages it returned before; `find_precedents` now orders Decisions within one millisecond by
-- `id`, as `query_decisions` does, where it went by the microsecond. The previous release runs
-- unchanged on it (it never names the index).
--
-- Lock time: the runner applies each file in one transaction, so `create index concurrently` is
-- not available here. A plain `create index` takes a SHARE lock on `decisions` until this file
-- commits: reads go on, but every INSERT (an approval, a reconcile, a goal outcome, a conflict
-- ruling, `record_decision`) waits for the build — one sequential scan of `decisions` plus a sort.
-- Measure the table first (`select count(*) from decisions;`). Where that is too long for the
-- window, the index can be built ahead without blocking writes, outside a transaction, while the
-- previous release runs (same name and definition as below):
--
--   create index concurrently if not exists decisions_workspace_created_ms_idx
--     on decisions (workspace_id, (date_trunc('milliseconds', created_at at time zone 'UTC')) desc, id desc);
--
-- and this file then finds it and builds nothing. A concurrent build that fails or is cancelled
-- leaves an invalid index under that name, which `if not exists` alone would keep (and the planner
-- never uses); the block below drops such a leftover first, so the file always ends with a valid
-- index (0044's pattern).
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where i.indrelid = 'decisions'::regclass
       and c.relname = 'decisions_workspace_created_ms_idx'
       and not i.indisvalid
  ) then
    drop index decisions_workspace_created_ms_idx;
  end if;
end;
$$;

create index if not exists decisions_workspace_created_ms_idx
  on decisions (workspace_id, (date_trunc('milliseconds', created_at at time zone 'UTC')) desc, id desc);
