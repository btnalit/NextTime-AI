-- 0011_agent_policies_platform (P-A2 — docs/platform-admin-design.md §5 "工作区配置":
-- `set_allowed_models` / `update_workspace(entryModel)` are `scope:'platform'`).
--
-- `agent_policies` (0010) is the per-workspace AgentPolicy: `allowed_models` is the list "我的智能体"
-- narrows to and `default_model` is the entry model every member's entry agent takes until they
-- pick their own. The platform plane now writes both from the workspace-configuration page and
-- reads them for `list_workspaces`, across every workspace in one transaction — so, like
-- `principals` / `sessions` in core 0019, the table gets an `app_platform()` policy beside its
-- workspace-isolation one (`app_platform()` is defined by core 0019, which runs before every
-- governance migration — modules apply in name order, adapters/db/migrate.ts
-- `sortMigrationFiles`). Still `nexttime_app`; no superuser and no general RLS bypass.

drop policy if exists agent_policies_platform_admin on agent_policies;

create policy agent_policies_platform_admin on agent_policies
  for all
  using (app_platform())
  with check (app_platform());
