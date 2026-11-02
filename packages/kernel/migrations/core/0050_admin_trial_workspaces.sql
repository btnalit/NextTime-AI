-- module: core, version: 0050
--
-- 0050_admin_trial_workspaces (S11 AA3a: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §3.1 "试验工作区", §5.2, I-A6; STATUS legacy 585). A trial workspace is where a platform
-- administrator's admin agent explores and tries things out: an ordinary workspace, isolated by
-- RLS like every other, with no privileges of its own. It is the only kind of workspace an admin
-- agent may act in — `application/admin-agent/identity.ts` refuses its Handle's issuance and every
-- call through one anywhere else (`not_trial_workspace`). Production workspaces change only through
-- an applied ChangePlan (AA3b/AA3c).
--
-- 1. `workspaces.purpose` gains `admin_trial` (0028's CHECK widened by that one value).
-- 2. `workspaces_admin_trial_fixed` (BEFORE UPDATE, every role): a workspace's `purpose` never
--    changes to or from `admin_trial`. That a workspace is a trial workspace is decided when it is
--    created (`create_workspace`'s `purpose`), never later: turning a production workspace into
--    one would let the agent explore production, and turning one back would leave what the agent
--    wrote there looking like a production workspace's own history. `standard` ↔ `ephemeral` is
--    left as it was (no code path changes it; an operator keeping a demo is not this rule's).
--    The platform default workspace — every new user joins it — is never a trial workspace either:
--    `update_platform_settings` refuses one (`trial_workspace`) and the startup adoption
--    (`application/platform/default-workspace.ts`) skips them; that rule lives in code because the
--    default is a platform setting, not a column.
--
-- Rolling back (docs/runbooks/release.md §6). Older code never writes `admin_trial` and reads
-- `purpose` as `standard | ephemeral` (the console's chip and the wire schema): code alone may roll
-- back only while `select count(*) from workspaces where purpose = 'admin_trial'` is 0. Otherwise
-- the older wire schema fails to parse those rows on the platform plane — disable those workspaces
-- and purge them first, or keep this release. With none: drop the trigger and its function,
-- re-add 0028's CHECK (`purpose in ('standard', 'ephemeral')`), then
-- `delete from schema_migrations where module = 'core' and version = 50`.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table workspaces drop constraint if exists workspaces_purpose_check;
alter table workspaces add constraint workspaces_purpose_check
  check (purpose in ('standard', 'ephemeral', 'admin_trial'));

create or replace function workspaces_admin_trial_fixed() returns trigger
language plpgsql as $$
begin
  if (old.purpose = 'admin_trial') is distinct from (new.purpose = 'admin_trial') then
    raise exception 'workspaces: a workspace never becomes a trial workspace or stops being one (purpose % -> %)',
      old.purpose, new.purpose
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_admin_trial_fixed on workspaces;
create trigger workspaces_admin_trial_fixed
  before update of purpose on workspaces
  for each row execute function workspaces_admin_trial_fixed();
