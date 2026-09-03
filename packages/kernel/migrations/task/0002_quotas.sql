-- module: task, version: 0002
--
-- quotas (design doc §9.2 increment sketch "quotas(workspace_id, key, value jsonb) -- I18，工作区
-- 策略数据"; §5.4 I18; docs/development-tasks.md S2.7). One row per (workspace, quota key); a
-- missing row means "use the compiled-in default" (`application/task/quotas.ts`'s
-- `DEFAULT_QUOTA_VALUES`) — this table only ever holds a workspace's *overrides*, never a full
-- copy of every default. `set_quota` (human, owner — packages/shared/src/capabilities.ts
-- governance group) upserts one row.
--
-- Runner ordering: this file runs immediately after 0001_tasks.sql within the same `task` module
-- (lexicographic file order within one module directory), so `tasks`/`worker_runs` already exist,
-- though this migration does not reference either.
--
-- Cross-process bootstrap lock: same mechanism as every other module (see 0001_tasks.sql's header
-- comment) — `task`'s advisory-lock key is `7241000401`, shared by every file in this module
-- directory (locks are per-module, not per-file — see governance/0002 and 0003 both reusing
-- `7241000201`).
select pg_advisory_xact_lock(7241000401);

create table if not exists quotas (
  workspace_id uuid not null,
  key text not null,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key),
  foreign key (workspace_id, updated_by) references principals (workspace_id, id)
);

alter table quotas enable row level security;

drop policy if exists quotas_workspace_isolation on quotas;

-- Workspace-only (mirrors tasks/worker_runs, migrations/task/0001_tasks.sql — same reasoning: no
-- per-owner visibility rule is implied by §5.6 for workspace policy data, and every quota this
-- table can hold is itself owner-only to *write* — `set_quota`'s `minRole: 'owner'` — so there is
-- nothing further to narrow by read).
create policy quotas_workspace_isolation on quotas
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant — a quota override is superseded by a later `set_quota` call (upsert), not
-- deleted; the audit trail of "who set this and when" survives via `updated_by`/`updated_at` plus
-- the ordinary audit_records row every `set_quota` capability call writes (I11).
grant select, insert, update on quotas to nexttime_app;
