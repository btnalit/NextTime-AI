-- 0022_platform_workspaces (P-A2 — docs/platform-admin-design.md §2 "工作区配置归管理面", §5
-- "工作区配置"; development-tasks.md P-A2 deliverable 1).
--
-- The platform plane's workspace capabilities (`update_workspace` / `set_workspace_status` /
-- `set_allowed_models`, application/gateway/platform-handlers.ts) run as `nexttime_app` inside a
-- platform transaction (adapters/db/platform-context.ts) — never on the superuser path. `workspaces`
-- has no RLS of its own (0001: "the row *is* the workspace") and until now the application role
-- could only read it (every writer was the bootstrap CLI). 0019's comment reserved exactly this
-- change for when the platform capabilities arrived: a column-limited UPDATE grant, so the
-- application role can rename / disable / set the entry model of a workspace but still cannot
-- insert or delete one (`create_workspace` reuses the bootstrap path; deletion stays CLI-only,
-- design §11).

grant update (name, status, entry_model) on workspaces to nexttime_app;
