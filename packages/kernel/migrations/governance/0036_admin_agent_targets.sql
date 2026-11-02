-- module: governance, version: 0036
--
-- 0036_admin_agent_targets (S11 AA4c: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §3.1, §5.9; the AA4 plan's F5 and the AA4c plan's D1/D2, decided by the coordinating thread
-- 2026-11-02). The workspaces a platform administrator lets their admin agent propose changes to.
-- A person chooses them, on the platform plane, for their own admin agent in one trial workspace;
-- every admin agent Chat they hold there shares the choice (it belongs to the agent's session and
-- Handle, which are one per person and trial workspace, not to a Chat). The agent reads the ids
-- and never changes them: nothing an admin agent's Handle may call writes this table.
--
-- `admin_agent_targets`, one row per (trial workspace, the administrator's Principal there, target
-- workspace):
--   * `workspace_id` is the trial workspace (`purpose = 'admin_trial'`), so purging it takes the
--     rows with it; `target_workspace_id` an active standard workspace when chosen, and purging that
--     workspace deletes the row (`on delete cascade`).
--   * written on the platform plane only (RLS), by the administrator for their own Principal
--     (`chosen_by_user` is the Principal's user and a platform administrator when the row is written
--     — the guard below); the kernel also writes one platform audit row per change
--     (`set_admin_agent_targets`). Rows are inserted and deleted, never updated: a row says when the
--     target was chosen and by whom.
--
-- Reads (`security definer`, core 0042's rule: each answers only for the caller it names):
--   * `admin_agent_chosen_targets()`: in a trial workspace, the targets the transaction's own
--     Principal chose — what `propose_admin_proposal` checks a proposal's targets against (400
--     `admin_proposal_target_not_chosen`) and what `agent_list_proposal_targets` gives the agent.
--   * `admin_proposal_target_chosen(proposal_id)`: in a target workspace, whether the proposal's
--     proposer still has this workspace among their targets. A proposal keeps the targets it was
--     made with (each workspace segment names its own); a workspace segment whose target was
--     dropped since is shown with a blocker and refused on apply (409
--     `admin_proposal_target_no_longer_chosen`), so the administrator proposes it again. `false`
--     for a workspace no segment of the proposal is addressed to.
--
-- Guard `admin_proposal_segments_target_chosen` (before insert or update; on update the last of
-- the table's update triggers by name, after 0033's `…_record_guard`): a workspace segment is
-- written, and later moves to `applied`, only while its target is among its proposer's targets —
-- the database's second wall behind the kernel's two checks, as 0035's is for the platform segment.
-- The platform segment (no target workspace) is not concerned.
--
-- Rolling back (docs/runbooks/release.md §6). The previous release does not know the table and
-- proposes and applies a workspace segment without it, while the guard here refuses both unless
-- the target is chosen: code alone may roll back only after dropping the guard (`drop trigger
-- admin_proposal_segments_target_chosen on admin_proposal_segments` and its function). To take the
-- migration out entirely: drop the guard, the two read functions and the table, then `delete from
-- schema_migrations where module = 'governance' and version = 36`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

create table if not exists admin_agent_targets (
  -- The trial workspace (see the header).
  workspace_id uuid not null references workspaces (id),
  -- The administrator's own Principal there: an admin agent's session acts on its behalf.
  principal_id uuid not null,
  target_workspace_id uuid not null references workspaces (id) on delete cascade,
  chosen_by_user uuid not null references users (id),
  chosen_at timestamptz not null default now(),
  primary key (workspace_id, principal_id, target_workspace_id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id),
  check (target_workspace_id <> workspace_id)
);

create index if not exists admin_agent_targets_target on admin_agent_targets (target_workspace_id);

alter table admin_agent_targets enable row level security;
alter table admin_agent_targets force row level security;
drop policy if exists admin_agent_targets_platform on admin_agent_targets;
create policy admin_agent_targets_platform on admin_agent_targets
  for all
  using (app_platform())
  with check (app_platform());
grant select, insert, delete on admin_agent_targets to nexttime_app;

create or replace function admin_agent_targets_guard() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  trial_purpose text;
  target record;
  chooser record;
begin
  if tg_op = 'UPDATE' then
    raise exception 'admin_agent_targets: a chosen target is removed and chosen again, never changed';
  end if;
  select w.purpose into trial_purpose from workspaces w where w.id = new.workspace_id;
  if trial_purpose is distinct from 'admin_trial' then
    raise exception 'admin_agent_targets: targets are chosen for an admin agent in a trial workspace only'
      using errcode = 'check_violation';
  end if;
  select w.purpose, w.status into target from workspaces w where w.id = new.target_workspace_id;
  if target.purpose is distinct from 'standard' or target.status is distinct from 'active' then
    raise exception 'admin_agent_targets: a target is an active standard workspace'
      using errcode = 'check_violation';
  end if;
  select p.kind, p.user_id, u.platform_role into chooser
    from principals p left join users u on u.id = p.user_id
   where p.workspace_id = new.workspace_id and p.id = new.principal_id;
  if chooser.kind is distinct from 'human'
     or chooser.user_id is distinct from new.chosen_by_user
     or chooser.platform_role is distinct from 'admin' then
    raise exception 'admin_agent_targets: a platform administrator chooses the targets of their own admin agent'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists admin_agent_targets_guard on admin_agent_targets;
create trigger admin_agent_targets_guard
  before insert or update on admin_agent_targets
  for each row execute function admin_agent_targets_guard();

create or replace function admin_agent_chosen_targets()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select t.target_workspace_id
    from admin_agent_targets t
   where t.workspace_id = app_workspace()
     and t.principal_id = app_principal()
   order by t.target_workspace_id
$$;
revoke all on function admin_agent_chosen_targets() from public;
grant execute on function admin_agent_chosen_targets() to nexttime_app;

create or replace function admin_proposal_target_chosen(p_proposal_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from admin_proposals p
      join admin_proposal_segments s
        on s.proposal_id = p.id
       and s.authority = 'workspace'
       and s.target_workspace_id = app_workspace()
      join admin_agent_targets t
        on t.workspace_id = p.workspace_id
       and t.principal_id = p.proposed_by
       and t.target_workspace_id = app_workspace()
     where p.id = p_proposal_id
  )
$$;
revoke all on function admin_proposal_target_chosen(uuid) from public;
grant execute on function admin_proposal_target_chosen(uuid) to nexttime_app;

create or replace function admin_proposal_segments_target_chosen() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.authority <> 'workspace' then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.status <> 'applied' or old.status = 'applied') then
    return new;
  end if;
  if not exists (
    select 1
      from admin_proposals p
      join admin_agent_targets t
        on t.workspace_id = p.workspace_id
       and t.principal_id = p.proposed_by
       and t.target_workspace_id = new.target_workspace_id
     where p.id = new.proposal_id
  ) then
    raise exception 'admin_proposal_segments: the workspace segment''s target is not among its proposer''s targets'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists admin_proposal_segments_target_chosen on admin_proposal_segments;
create trigger admin_proposal_segments_target_chosen
  before insert or update on admin_proposal_segments
  for each row execute function admin_proposal_segments_target_chosen();
