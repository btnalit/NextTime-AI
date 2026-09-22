-- module: core, version: 0030
--
-- S6 A1 / A6 — workspace purge retention (docs/console-completion-plan.md §4 "Workspace 生命周期",
-- §5.2 `purge_workspace`, §12 决定 3): a disabled workspace becomes purgeable once it has been
-- disabled for 7 days (the same 7 days an ephemeral workspace's TTL uses). Until now `workspaces`
-- recorded *that* a workspace was disabled (`status`, 0019) but not *when*; `set_workspace_status`
-- (application/gateway/platform-handlers.ts) now stamps `disabled_at` on `disabled` and clears it
-- on `active`, and `purge_workspace` reads it.
--
-- Backfill — deliberately none (决定 3, "既有 disabled 行回填 null、视为立即可清"): a row that is
-- already `disabled` keeps `disabled_at = null`, which `purge_workspace` treats as "retention has
-- elapsed" — the acceptance-run residue a host accumulated before this migration is purgeable
-- straight away instead of waiting a further week. A workspace disabled *after* this migration
-- always carries the timestamp.
--
-- Additive and nullable: a kernel from before this migration runs unchanged on the new schema.
-- Same column-limited grant shape as 0022 / 0025: the platform plane's `set_workspace_status`
-- runs as `nexttime_app` and may write exactly this one new column; inserting or deleting a
-- workspace row stays off the application role (purge's cascade runs on the superuser path after
-- the platform transaction commits, like `create_workspace`'s bootstrap does).
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
select pg_advisory_xact_lock(7241000101);

alter table workspaces add column if not exists disabled_at timestamptz;

grant update (disabled_at) on workspaces to nexttime_app;
