-- module: core, version: 0027
--
-- S5.2 (docs/development-tasks.md §5b S5.2 实现说明 "同源优先"): `find_active_fact_for_identity`
-- (0017) returns *every* still-active Fact of an identity, not only the newest.
--
-- 0017 deliberately returned `order by recorded_at desc limit 1`: after a Conflict has been opened,
-- two (or more) Facts are simultaneously `recorded` for one identity — that is the whole point of
-- "keep both" — and S3.2 accepted comparing a later assertion against the latest of them only
-- ("a third assertion is compared against the latest of those, not exhaustively"). Harmless while
-- the only consequence was which side a new disagreement was paired with. The S5.2 observation
-- window made it wrong: a collector re-observing an identity that another Source has since
-- contradicted found the *other* Source's newer row, saw a different origin, inserted a fresh Fact
-- and opened a second Conflict — and its own older row, never touched, was then retired
-- `not_reobserved` by the very run that re-observed it.
--
-- `SqlGraphStore.assertFact` (substrate/graph/sql-store.ts) now resolves the origin of each row
-- this returns and builds on the one that is its own (same origin → unchanged / touch / supersede);
-- only when no row is its own does it fall back to the newest for the corroboration / Conflict
-- branch, which is exactly 0017's behaviour whenever a single row exists. `for update` locks every
-- active row of the identity for the rest of the transaction instead of one — strictly more
-- serialization, never less. Same `security definer` reasoning as 0017 (the caller's own
-- `links_visibility` must not hide the prior side).
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

create or replace function find_active_fact_for_identity(
  p_workspace_id uuid, p_link_type text, p_source_object_id uuid, p_target_object_id uuid
)
returns setof links
language sql security definer
set search_path = public, pg_temp
as $$
  select * from links
  where workspace_id = p_workspace_id
    and link_type = p_link_type
    and source_object_id = p_source_object_id
    and target_object_id = p_target_object_id
    and superseded_at is null
    and invalidated_at is null
  order by recorded_at desc
  for update
$$;

grant execute on function find_active_fact_for_identity(uuid, text, uuid, uuid) to nexttime_app;
