-- module: governance, version: 0035
--
-- 0035_admin_proposal_platform_dependency (S11 AA3c-2: docs/goal-orchestration-and-admin-agent-
-- plan-2026-10-16.md §3.1–§3.3, I-A8; the AA3 default plan F8; the AA3c plan F-c4). Every workspace
-- segment of an admin proposal that has a platform segment (0034) depends on it: it is applied only
-- while the platform segment is applied, and the platform segment is rolled back only while none of
-- them is applied. The kernel checks both (`application/change-plan/admin-proposal-segments.ts`,
-- `platform-segments.ts`); this file is the database's second wall, and the reads the kernel's
-- checks need.
--
-- The proposal's dependency lock: `pg_advisory_xact_lock(7241033, hashtext(proposal_id::text))`
-- (`ADVISORY_LOCK_NAMESPACES.adminProposalDependency`). Applying a workspace segment takes it
-- shared, so the workspace segments of one proposal apply side by side; rolling back the platform
-- change segment its platform segment recorded takes it exclusive. The kernel takes it before any
-- row lock on either path (a workspace apply holds its segment's row, a platform rollback the rows
-- of every workspace segment of the proposal), and the triggers below take it again before they
-- read — re-entrant in the kernel's transaction, and what serializes a write that does not come
-- from the kernel. Each check reads after the lock is held, so under read committed (the kernel's
-- isolation, and the default) it sees what the other side committed. A write that does not come
-- from the kernel takes the lock after its row lock (inside its trigger), so against a kernel path
-- it may deadlock; Postgres then aborts one of the two, and neither has written.
--
-- Guards:
--   * `admin_proposal_segments_platform_dependency` (before update, between 0032's guard and 0033's
--     record guard by name): a workspace segment moves to `applied` only while its proposal has no
--     platform segment, or that segment is `applied` and so is the platform change segment its
--     apply recorded. A rolled-back record refuses it even before the platform segment follows it
--     (a purged trial workspace takes both segments with it).
--   * `platform_change_segments_rollback_dependency` (before update, after 0034's guard by name): a
--     platform change segment moves from `applied` to `rolled_back` only while no workspace segment
--     of its proposal is applied — none `applied` among the proposal's segments, and no change
--     segment recorded from the proposal in any workspace (`change_segments.admin_proposal_id`,
--     0033) that is not rolled back. The second holds after the proposal's trial workspace is
--     purged: the records stay in the workspaces they were applied to. A platform segment is
--     rolled back only with its record (0034's record guard), so this is where its check sits.
--   Both run as the owner (`security definer`): a workspace transaction cannot read the platform's
--   rows, nor the platform plane a workspace's change segments.
--
-- Reads (`security definer`, core 0042's rule: each answers only for the caller it names):
--   * `admin_proposal_platform_change(proposal_id)`: for a workspace a segment of the proposal is
--     addressed to (0034's `admin_proposal_platform_segment` condition), what the proposal's applied
--     platform segment recorded — the record's id and reviewed digest, and each item's gate id,
--     connector and definition as created. The workspace compares them with the instances
--     (`gate_instances`, which every workspace reads) before it previews or applies (409
--     `platform_segment_changed`), and binds its own digest to the record (I-A8).
--   * `admin_proposal_applied_workspace_changes(proposal_id)`: on the platform plane only, the
--     change segments recorded from the proposal in any workspace and not rolled back — the
--     dependents a platform rollback refuses on (409 `dependent_segments_applied`), listed by
--     workspace and proposal segment, nothing else of the workspace.
--   * index `change_segments_admin_proposal` for that lookup.
--
-- Reversibility: functions, triggers and an index only; nothing is stored. A release before this
-- one never applies a workspace segment while its platform segment is not applied (0.60.0 has no
-- platform segment), so the guards refuse nothing it does. To take the migration out: drop the two
-- triggers and their functions, the two read functions and the index, then `delete from
-- schema_migrations where module = 'governance' and version = 35`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).

select pg_advisory_xact_lock(7241000201);

create index if not exists change_segments_admin_proposal
  on change_segments (admin_proposal_id)
  where admin_proposal_id is not null;

-- ---------------------------------------------------------------------------------------------
-- A workspace segment is applied while its platform segment is
-- ---------------------------------------------------------------------------------------------

create or replace function admin_proposal_segments_platform_dependency() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  platform_status text;
  record_status text;
begin
  if new.status is not distinct from old.status
     or old.authority <> 'workspace' or new.status <> 'applied' then
    return new;
  end if;
  perform pg_advisory_xact_lock_shared(7241033, hashtext(old.proposal_id::text));
  select s.status, c.status into platform_status, record_status
    from admin_proposal_segments s
    left join platform_change_segments c on c.id = s.applied_platform_segment_id
   where s.proposal_id = old.proposal_id and s.authority = 'platform';
  if found and (platform_status <> 'applied' or record_status is distinct from 'applied') then
    raise exception 'admin_proposal_segments: a workspace segment is applied while its proposal''s platform segment is applied (it is %, its record %)',
      platform_status, coalesce(record_status, 'none');
  end if;
  return new;
end;
$$;

create or replace trigger admin_proposal_segments_platform_dependency
  before update on admin_proposal_segments
  for each row execute function admin_proposal_segments_platform_dependency();

-- ---------------------------------------------------------------------------------------------
-- A platform change segment is rolled back while nothing of its proposal is applied
-- ---------------------------------------------------------------------------------------------

create or replace function platform_change_segments_rollback_dependency() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not (old.status = 'applied' and new.status = 'rolled_back') then
    return new;
  end if;
  perform pg_advisory_xact_lock(7241033, hashtext(old.admin_proposal_id::text));
  if exists (
    select 1 from admin_proposal_segments s
     where s.proposal_id = old.admin_proposal_id and s.authority = 'workspace'
       and s.status = 'applied'
  ) or exists (
    select 1 from change_segments c
     where c.admin_proposal_id = old.admin_proposal_id and c.source_kind = 'admin_proposal'
       and c.status <> 'rolled_back'
  ) then
    raise exception 'platform_change_segments: rolled back while no workspace segment of its proposal is applied (roll those back in their workspaces first)';
  end if;
  return new;
end;
$$;

create or replace trigger platform_change_segments_rollback_dependency
  before update on platform_change_segments
  for each row execute function platform_change_segments_rollback_dependency();

-- ---------------------------------------------------------------------------------------------
-- The reads (see the header)
-- ---------------------------------------------------------------------------------------------

create or replace function admin_proposal_platform_change(p_proposal_id uuid)
returns table (
  change_segment_id uuid,
  reviewed_digest text,
  ordinal int,
  gate_id text,
  connector text,
  definition jsonb
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select c.id, c.reviewed_digest, i.ordinal, i.gate_id, i.connector, i.definition
    from admin_proposal_segments s
    join platform_change_segments c
      on c.id = s.applied_platform_segment_id and c.status = 'applied'
    join platform_change_items i on i.change_segment_id = c.id
   where s.proposal_id = p_proposal_id
     and s.authority = 'platform'
     and s.status = 'applied'
     and exists (
       select 1 from admin_proposal_segments t
        where t.proposal_id = p_proposal_id
          and t.authority = 'workspace'
          and t.target_workspace_id = app_workspace()
     )
   order by i.ordinal
$$;
revoke all on function admin_proposal_platform_change(uuid) from public;
grant execute on function admin_proposal_platform_change(uuid) to nexttime_app;

create or replace function admin_proposal_applied_workspace_changes(p_proposal_id uuid)
returns table (workspace_id uuid, admin_proposal_segment_id uuid, change_segment_id uuid)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select c.workspace_id, c.admin_proposal_segment_id, c.id
    from change_segments c
   where app_platform()
     and c.admin_proposal_id = p_proposal_id
     and c.source_kind = 'admin_proposal'
     and c.status <> 'rolled_back'
   order by c.applied_at, c.id
$$;
revoke all on function admin_proposal_applied_workspace_changes(uuid) from public;
grant execute on function admin_proposal_applied_workspace_changes(uuid) to nexttime_app;
