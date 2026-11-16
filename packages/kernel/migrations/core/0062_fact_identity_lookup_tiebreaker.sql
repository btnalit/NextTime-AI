-- module: core, version: 0062
--
-- Legacy 143 (#514 audit): the two identity lookups `assertFact` makes (substrate/graph/sql-store.ts)
-- order by `recorded_at` alone. `recorded_at` defaults to `now()`, the transaction's start time, so
-- every Fact one transaction records has the same `recorded_at`, and keeps it. Two Facts of one
-- identity recorded in one transaction (two Sources disagreeing inside one batch: the Conflict path
-- keeps both active) are then tied for "newest" forever, and the order Postgres returns them in
-- depends on the plan and on where the rows sit in the table.
--
-- 1. `find_active_fact_for_identity` returns every active Fact of the identity, newest first.
--    `assertFact` builds on its own row (the first of the same origin) and otherwise pairs a new
--    disagreement with the first row. With a tie, which Fact a later Conflict names could differ
--    from one call to the next. Ties are now broken by `id desc`. `id` is a random uuid, so this
--    is a fixed order, not "the later insert first": one transaction's rows carry no record of
--    which came first. What it guarantees is that the same rows are always returned in the same
--    order.
--
-- 2. `latest_fact_invalidated_for_identity` answers "is the identity's newest row invalidated?",
--    and `assertFact`'s bounded re-read loop (0029) stops on yes and re-reads on no. With a tie
--    between an invalidated row and one that is not, the answer could be either. Ties now prefer
--    the row that is not invalidated: the answer is yes only when every newest row is invalidated.
--    A wrong yes ends the loop and inserts a fresh Fact (possibly a needless second active one); a
--    wrong no costs one more bounded re-read. So the tie goes to re-reading. The answer depends
--    only on the rows, so no `id` tiebreaker is needed after it.
--
-- Same signatures, same `security definer`, same workspace check as 0042; `create or replace`
-- keeps the owner and the grants. Rows without a tie are returned exactly as before. No data
-- changes, no locks beyond replacing two function bodies; the previous release runs unchanged on
-- it (it calls the same functions and does not depend on the order of tied rows).
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

create or replace function find_active_fact_for_identity(
  p_workspace_id uuid, p_link_type text, p_source_object_id uuid, p_target_object_id uuid
)
returns setof links
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_workspace_id is distinct from app_workspace() then
    raise exception 'find_active_fact_for_identity: workspace % is not this transaction''s',
      p_workspace_id using errcode = '42501';
  end if;
  return query
    select * from links
    where workspace_id = p_workspace_id
      and link_type = p_link_type
      and source_object_id = p_source_object_id
      and target_object_id = p_target_object_id
      and superseded_at is null
      and invalidated_at is null
    order by recorded_at desc, id desc
    for update;
end;
$$;

create or replace function latest_fact_invalidated_for_identity(
  p_workspace_id uuid, p_link_type text, p_source_object_id uuid, p_target_object_id uuid
)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if p_workspace_id is distinct from app_workspace() then
    raise exception 'latest_fact_invalidated_for_identity: workspace % is not this transaction''s',
      p_workspace_id using errcode = '42501';
  end if;
  -- No row → null, the same "stop" answer the 0029 `language sql` body gave. `false < true`, so
  -- among the newest rows one that is not invalidated comes first.
  return (
    select invalidated_at is not null
    from links
    where workspace_id = p_workspace_id
      and link_type = p_link_type
      and source_object_id = p_source_object_id
      and target_object_id = p_target_object_id
    order by recorded_at desc, invalidated_at is not null
    limit 1
  );
end;
$$;
