-- module: core, version: 0042
--
-- S10 W1 K4 (docs/s10-evolution-plan-2026-10-04.md §7.1, review 2026-10-02 lane K4; STATUS
-- leftover 123): database isolation in depth, two P3 items.
--
-- 1. L4-11 remainder: the four `security definer` helpers take the workspace as a parameter and
--    trusted it. They run as the owner, so RLS does not apply inside them: a workspace transaction
--    calling `find_active_fact_for_identity(<another workspace>, …)` got that workspace's Fact rows
--    back, and `latest_fact_invalidated_for_identity` / the two visibility predicates answered
--    yes/no questions about another tenant's Facts. No kernel path passes a foreign id today (every
--    caller passes the row's own `workspace_id` or the transaction's), so this is defence in depth:
--    the database, not the caller, now decides which workspace a definer function may look at.
--      - `find_active_fact_for_identity` and `latest_fact_invalidated_for_identity` are called
--        directly by the graph store; a workspace that is not the transaction's (`app_workspace()`)
--        raises 42501 instead of answering. Raising, not an empty answer: "no active Fact" would
--        send the caller down its insert path.
--      - `link_visible_to_caller` and `conflict_visible_to_caller` are RLS predicates, evaluated
--        while a policy filters rows (possibly before the policy's own `workspace_id =
--        app_workspace()` conjunct), so they must never raise: for another workspace they answer
--        `false` (hidden) — fail closed, which is what the policy decides for that row anyway.
--    Every caller runs inside `withWorkspace`, which sets `app.workspace_id` for the login role
--    too, so the owner-run paths (purge, compaction) behave exactly as before.
--
-- 2. L4-13: one Gatekeeper, at most one platform gate instance link per workspace. The primary key
--    is (workspace_id, gate_id), so redeploying the same endpoint under a new GATE_ID could link the
--    same Gatekeeper twice, and `readGateLinkPolicy` then took whichever row came first — trust
--    and the disabled-Operation list undetermined. The non-unique index becomes unique;
--    `enable_gate_instance` refuses such a link up front (`gatekeeper_already_linked`), so the
--    index is the second wall, not the error path. Run the read-only precheck in
--    docs/runbooks/release.md §3.8 first: an existing duplicate makes this migration fail.
--    0035 left DELETE on `workspace_gate_links` granted "until L4-13": no kernel path deletes a
--    link (the runbook's manual unlink runs on the login role), so it is revoked here.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration.
select pg_advisory_xact_lock(7241000101);

-- ---------------------------------------------------------------------------------------------
-- 1. L4-11: definer helpers answer only about the transaction's own workspace
-- ---------------------------------------------------------------------------------------------

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
    order by recorded_at desc
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
  -- No row → null, the same "stop" answer the 0029 `language sql` body gave.
  return (
    select invalidated_at is not null
    from links
    where workspace_id = p_workspace_id
      and link_type = p_link_type
      and source_object_id = p_source_object_id
      and target_object_id = p_target_object_id
    order by recorded_at desc
    limit 1
  );
end;
$$;

create or replace function link_visible_to_caller(p_workspace_id uuid, p_activity_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p_workspace_id is not distinct from app_workspace()
    and not exists (
      select 1
      from observations o
      join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
      where o.workspace_id = p_workspace_id
        and o.activity_id = p_activity_id
        and s.visibility = 'private'
        and s.owner_principal_id <> app_principal()
    )
$$;

create or replace function conflict_visible_to_caller(
  p_workspace_id uuid, p_link_a_id uuid, p_link_b_id uuid
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p_workspace_id is not distinct from app_workspace()
    and coalesce(
      (
        select link_visible_to_caller(p_workspace_id, la.activity_id)
           and link_visible_to_caller(p_workspace_id, lb.activity_id)
        from links la, links lb
        where la.workspace_id = p_workspace_id and la.id = p_link_a_id
          and lb.workspace_id = p_workspace_id and lb.id = p_link_b_id
      ),
      false
    )
$$;

-- `create or replace` keeps the existing ACL (0035: no PUBLIC, `nexttime_app` granted).

-- ---------------------------------------------------------------------------------------------
-- 2. L4-13: one link per (workspace, Gatekeeper)
-- ---------------------------------------------------------------------------------------------

drop index if exists workspace_gate_links_gatekeeper_idx;
create unique index if not exists workspace_gate_links_gatekeeper_key
  on workspace_gate_links (workspace_id, gatekeeper_object_id);

revoke delete on workspace_gate_links from nexttime_app;
