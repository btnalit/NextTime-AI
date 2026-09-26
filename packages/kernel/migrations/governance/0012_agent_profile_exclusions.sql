-- module: governance, version: 0012
--
-- 0012_agent_profile_exclusions (docs/console-redesign-plan-2026-09-25.md §2 / §7 D1 + D2, decided
-- by the maintainer 2026-09-25).
--
-- D1: an AgentProfile's three lists become *exclusion* lists. The effective set is now "everything
-- currently on offer (granted Gatekeepers / published Skills / published Worker definitions) minus
-- what the member excluded", capped by the workspace AgentPolicy — so a Gatekeeper granted, or a
-- Skill / Worker published, after the profile was last saved is picked up automatically. The old
-- `enabled_*` lists were allow-lists resolved as `explicit ?? available` (governance/agent-profile/
-- resolve.ts before this change): once saved they froze, silently excluding every later grant —
-- the production incident where a member granted a newly connected system could not use it from
-- chat.
-- The invariant is unchanged: a profile only ever narrows what the member's Grants and the
-- AgentPolicy allow, never widens.
--
-- D2: every existing explicit allow-list is reset to "follow grants", i.e. the new exclusion lists
-- start empty for every row. Resetting only widens *within* the member's own Grants (Grants stay
-- the authority), and each row that held an explicit list gets one audit record carrying the
-- previous lists, so the change can be reconstructed.
--
-- Reversibility: the old `enabled_*` columns are left in place and untouched (the new code neither
-- reads nor writes them), so rolling the kernel back to the previous release restores the previous
-- behaviour exactly; nothing here needs a down migration. A later migration may drop them.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table agent_profiles
  add column if not exists excluded_skills jsonb not null default '[]'::jsonb,
  add column if not exists excluded_gatekeepers jsonb not null default '[]'::jsonb,
  add column if not exists excluded_worker_definitions jsonb not null default '[]'::jsonb;

-- D2 audit: one record per profile that had at least one explicit allow-list. The actor is the
-- profile's own principal (audit_records.actor_principal_id is required and must be a principal of
-- the same workspace); the payload says it was this migration, not that principal, that acted.
-- Idempotent: skipped for a row that already has this migration's record.
insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
select
  ap.workspace_id,
  ap.principal_id,
  'agent_profile.lists_reset_to_follow_grants',
  'principal',
  ap.principal_id,
  jsonb_build_object(
    'by', 'migration governance/0012_agent_profile_exclusions',
    'reason', 'AgentProfile lists changed from allow-lists to exclusion lists; explicit allow-lists reset to follow grants (console redesign D1/D2)',
    'previousEnabledSkills', ap.enabled_skills,
    'previousEnabledGatekeepers', ap.enabled_gatekeepers,
    'previousEnabledWorkerDefinitions', ap.enabled_worker_definitions
  )
from agent_profiles ap
where (ap.enabled_skills is not null
       or ap.enabled_gatekeepers is not null
       or ap.enabled_worker_definitions is not null)
  and not exists (
    select 1 from audit_records ar
    where ar.workspace_id = ap.workspace_id
      and ar.action = 'agent_profile.lists_reset_to_follow_grants'
      and ar.resource_id = ap.principal_id
  );
