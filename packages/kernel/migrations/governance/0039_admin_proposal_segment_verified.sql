-- module: governance, version: 0039
--
-- 0039_admin_proposal_segment_verified (S11 AA5d-2: docs/goal-orchestration-and-admin-agent-plan-
-- 2026-10-16.md §5.8; the AA5 plan's F7(a); the AA5d plan's fork 6, coordinator 2026-11-05). A
-- platform administrator exports an applied workspace segment of an admin proposal as a capability
-- pack (`export_admin_proposal_pack`, `application/packs/export.ts`) only once what it applied has
-- been verified in the workspace it was applied to — the system's check, not the administrator's
-- word. The platform plane cannot read a workspace's change segments (0025's RLS), and §5.8 gave it
-- only "applied, not rolled back" (0035's `admin_proposal_applied_workspace_changes`); this adds one
-- more answer, a boolean, and nothing else of the workspace.
--
--   * `admin_proposal_segment_verified(p_segment_id)`: on the platform plane only (`app_platform()`;
--     false for any other caller), whether the change segment that the workspace segment
--     `p_segment_id`'s apply recorded in its target workspace (0033: `applied_segment_id`, one
--     record per proposal segment) is `verified` now — its latest verification run passed and it is
--     not rolled back (0025's status). False for a segment that is not a workspace segment, is not
--     applied, has no such record, or is unknown. `security definer`, since RLS shows the platform
--     plane no workspace's change segments; it returns no id, item, result or time (core 0042's rule
--     for definer helpers: it answers only what its caller may know). Never on an agent's wire: the
--     one capability that calls it is a platform administrator's, human channel.
--
-- A function no earlier release calls: rolling back the code leaves it unused. To remove it too
-- (docs/runbooks/release.md §6): `drop function admin_proposal_segment_verified(uuid)`, then
-- `delete from schema_migrations where module = 'governance' and version = 39`.
--
-- Cross-process bootstrap lock: same governance-module key as 0001–0038.
select pg_advisory_xact_lock(7241000201);

create or replace function admin_proposal_segment_verified(p_segment_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select app_platform() and exists (
    select 1
      from admin_proposal_segments s
      join change_segments c
        on c.workspace_id = s.target_workspace_id
       and c.id = s.applied_segment_id
       and c.admin_proposal_segment_id = s.id
     where s.id = p_segment_id
       and s.authority = 'workspace'
       and s.status = 'applied'
       and c.source_kind = 'admin_proposal'
       and c.status = 'verified'
  )
$$;
revoke all on function admin_proposal_segment_verified(uuid) from public;
grant execute on function admin_proposal_segment_verified(uuid) to nexttime_app;
