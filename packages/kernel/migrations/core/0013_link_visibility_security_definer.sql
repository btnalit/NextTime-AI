-- module: core, version: 0013
--
-- Fix: 0010_link_visibility.sql's `links_visibility` policy (and the matching predicate in
-- substrate/graph/queries.ts) joined `observations`/`sources` directly inside the `links` policy
-- expression — but `nexttime_app` (the RLS-constrained role every ordinary request runs under,
-- core/0001_identity.sql) has no visibility into an `observations`/`sources` row it does not own,
-- per THOSE tables' own RLS policies (0002_substrate.sql). Postgres RLS is pervasive: a subquery
-- inside one table's policy is itself subject to the referenced tables' own RLS for the *current*
-- role, not exempted just because it is running "inside a policy". The practical effect: a
-- principal who is *not* the owner of the blocking private Source could not see the very
-- Observation row that should hide the Fact from them — so the `not exists (...)` check found no
-- matching row and (incorrectly) treated the Fact as visible. RLS on `observations`/`sources` was
-- hiding the evidence needed to enforce visibility on `links`.
--
-- Fix: move the check into a `security definer` function. A function's body runs with its
-- *owner's* privileges, not the caller's; every migration in this codebase runs over the
-- superuser login connection (0001_identity.sql's own module doc comment — "the compose Postgres
-- login user is a superuser... `nexttime_app`... nothing ever authenticates as it directly"), so
-- this function is owned by that superuser and therefore bypasses RLS entirely when it queries
-- `observations`/`sources` internally — the same "superuser bypasses RLS by design" escape hatch
-- this codebase already uses for admin/bootstrap paths (0001_identity.sql, application/outbox/
-- dispatcher.ts's own doc comment). It returns only a boolean — never row data — so no broader
-- read access is exposed through it than the single yes/no this policy already needed.
-- `set search_path` is pinned (defense-in-depth for a `security definer` function per Postgres's
-- own documented guidance, not because any other role could plant a same-named object here today).
select pg_advisory_xact_lock(7241000101);

create or replace function link_visible_to_caller(p_workspace_id uuid, p_activity_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select not exists (
    select 1
    from observations o
    join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
    where o.workspace_id = p_workspace_id
      and o.activity_id = p_activity_id
      and s.visibility = 'private'
      and s.owner_principal_id <> app_principal()
  )
$$;

grant execute on function link_visible_to_caller(uuid, uuid) to nexttime_app;

drop policy if exists links_visibility on links;

create policy links_visibility on links
  for all
  using (
    workspace_id = app_workspace()
    and link_visible_to_caller(workspace_id, activity_id)
  )
  with check (
    workspace_id = app_workspace()
    and link_visible_to_caller(workspace_id, activity_id)
  );
