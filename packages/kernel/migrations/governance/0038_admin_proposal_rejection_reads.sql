-- module: governance, version: 0038
--
-- 0038_admin_proposal_rejection_reads (S11 AA5a-2: docs/goal-orchestration-and-admin-agent-plan-
-- 2026-10-16.md §5.7 "刷屏、反复提同一个被拒的提议"; the AA5 plan's F6, legacy 595). F11 (0032) caps
-- how many admin proposals one administrator makes a day. This is the other half: once a target
-- workspace's owners have rejected an administrator's workspace segments a number of times within a
-- window (the kernel's `ADMIN_PROPOSAL_REJECTION_LIMIT` and `ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS`,
-- 3 in 7 days unless configured), that administrator's admin agent may not propose to that target
-- again until the oldest of those rejections has left the window.
--
-- The kernel counts from what the database already holds — a segment `rejected` by its target, and
-- when (`decided_at`) — never from anything kept in memory. It counts under the same per-administrator
-- advisory lock as F11 (`adminProposalQuota`), so a proposal reads the rejections committed before it.
--
--   * `admin_proposal_rejections_since(p_since)` — the workspace segments the transaction's own
--     platform user proposed (through any of their trial workspaces) that a target rejected after
--     `p_since` (the window's start, which is not in it): target, proposal, segment and when.
--     `security definer`, since RLS shows a workspace transaction its own trial workspace's
--     proposals only (0032), and an administrator's segments to one target may have been proposed
--     from another of their trial workspaces. Like `admin_proposals_proposed_today()` it answers
--     only for the transaction's own Principal (core 0042's rule for definer helpers): `p_since`
--     narrows the time, never whose rows. It returns no reason — what an owner wrote stays with
--     them and the platform's people (#916).
--
-- A function no earlier release calls: rolling back the code leaves it unused. To remove it too
-- (docs/runbooks/release.md §6): `drop function admin_proposal_rejections_since(timestamptz)`, then
-- `delete from schema_migrations where module = 'governance' and version = 38`.
--
-- Cross-process bootstrap lock: same governance-module key as 0001–0037.
select pg_advisory_xact_lock(7241000201);

create or replace function admin_proposal_rejections_since(p_since timestamptz)
returns table (
  target_workspace_id uuid,
  proposal_id uuid,
  segment_id uuid,
  decided_at timestamptz
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.target_workspace_id, s.proposal_id, s.id, s.decided_at
    from admin_proposal_segments s
    join admin_proposals c on c.workspace_id = s.workspace_id and c.id = s.proposal_id
   where c.proposed_by_user = (
           select p.user_id from principals p
            where p.workspace_id = app_workspace() and p.id = app_principal()
         )
     and s.authority = 'workspace'
     and s.status = 'rejected'
     and s.decided_at > p_since
   order by s.decided_at, s.id
$$;
revoke all on function admin_proposal_rejections_since(timestamptz) from public;
grant execute on function admin_proposal_rejections_since(timestamptz) to nexttime_app;
