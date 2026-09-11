-- module: core, version: 0019
--
-- S4.1 平台用户目录与登录 (docs/graph-ai-middle-platform-design.md §7.11; docs/development-tasks.md
-- S4.1). Identity moves up one level: a *user* is a platform-level row (login + password, platform
-- role admin|user); a human Principal is that user's membership in one workspace and keeps the
-- five workspace roles. API keys on human principals stay valid (the acceptance harness, e2e and
-- driver.mjs all authenticate that way) — this migration adds, it does not take away.
--
-- Platform-level tables (`users`, `user_sessions`, `platform_setup`) have no workspace_id and no
-- RLS: only the kernel's identity module (application/identity) reads and writes them, on the
-- admin / skip-role-switch path. The application role gets exactly one narrow grant: inserting a
-- passwordless user row + reading `(id, login)` — what `create_principal` (a workspace capability,
-- running as `nexttime_app`) needs to keep every human Principal pointing at a user. It never sees
-- `password_hash`, `user_sessions` or `platform_setup`. `app_platform()` is the *only* new
-- setting: platform-scope capabilities set `app.platform = on` for their own transaction, and the
-- handful of policies below let that transaction read (never bypass) across workspaces. There is
-- no generic RLS bypass switch.
--
-- audit_records: platform actions (create user, change role, create workspace, …) have no
-- workspace. `workspace_id` and `actor_principal_id` become nullable, `actor_user_id` is added,
-- and a CHECK keeps every row either a workspace row (workspace + principal) or a platform row
-- (no workspace + user). The primary key moves from (workspace_id, id) to (id) — nothing
-- references audit_records by composite key (grep migrations/ for `references audit_records`).
--
-- Cross-process bootstrap lock: same `core`-module key as every other file in this module.
select pg_advisory_xact_lock(7241000101);

create or replace function app_platform() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.platform', true), '') = 'on'
$$;

-- ---------------------------------------------------------------------------------------------
-- users / user_sessions / platform_setup
-- ---------------------------------------------------------------------------------------------

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  login text not null,
  display_name text not null,
  -- scrypt (node:crypto), `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`; null = no password set yet
  -- (backfilled users, or an admin-created user before its temporary password is applied).
  password_hash text,
  platform_role text not null default 'user' check (platform_role in ('admin', 'user')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  must_change_password boolean not null default false,
  -- login throttle (S4.1: 5 failures lock the login for 5 minutes)
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (login)
);
grant select (id, login, display_name, platform_role, status, created_at) on users to nexttime_app;
grant insert (login, display_name) on users to nexttime_app;

create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text
);
create index if not exists user_sessions_user_id_idx on user_sessions (user_id);

-- One row at most (`singleton` check): the current one-time setup token, hashed. Consumed by
-- `POST /api/platform/setup` (used_at) or invalidated after 5 failures (failed_count); a fresh
-- token is generated at kernel start whenever no active platform admin exists.
create table if not exists platform_setup (
  singleton boolean primary key default true check (singleton),
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  failed_count integer not null default 0
);

-- ---------------------------------------------------------------------------------------------
-- principals.user_id — a human Principal is a user's membership in one workspace
-- ---------------------------------------------------------------------------------------------

alter table principals add column if not exists user_id uuid references users (id);
create unique index if not exists principals_workspace_user_key
  on principals (workspace_id, user_id) where user_id is not null;

-- Backfill: one user per existing human principal. Login = slug of the display name (lower-cased,
-- runs of anything but [a-z0-9] collapsed to '-', leading/trailing '-' trimmed, capped at 50
-- chars — the same shape application/identity's `derivedLogin` produces) + '-' + the first 8
-- hex of the principal id (always suffixed, so the backfill can never collide with itself); no
-- password — an admin sets a temporary one when that person should start logging in. Disabled
-- principals become disabled users.
create temporary table backfill_users on commit drop as
select
  p.workspace_id,
  p.id as principal_id,
  gen_random_uuid() as user_id,
  coalesce(
    nullif(left(trim(both '-' from regexp_replace(lower(coalesce(p.display_name, '')), '[^a-z0-9]+', '-', 'g')), 50), ''),
    'user'
  ) || '-' || left(p.id::text, 8) as login,
  coalesce(nullif(p.display_name, ''), 'user-' || left(p.id::text, 8)) as display_name,
  case when p.disabled_at is null then 'active' else 'disabled' end as status,
  p.created_at
from principals p
where p.kind = 'human' and p.user_id is null;

insert into users (id, login, display_name, password_hash, platform_role, status, created_at)
select user_id, login, display_name, null, 'user', status, created_at from backfill_users;

update principals p
set user_id = b.user_id
from backfill_users b
where p.workspace_id = b.workspace_id and p.id = b.principal_id;

-- Platform-scope reads/writes across workspaces (add_membership, revoke a disabled user's
-- sessions everywhere): only inside a transaction that set `app.platform = on`.
drop policy if exists principals_platform_admin on principals;
create policy principals_platform_admin on principals
  for all
  using (app_platform())
  with check (app_platform());

drop policy if exists sessions_platform_admin on sessions;
create policy sessions_platform_admin on sessions
  for all
  using (app_platform())
  with check (app_platform());

-- ---------------------------------------------------------------------------------------------
-- workspaces.status / entry_model
-- ---------------------------------------------------------------------------------------------

alter table workspaces add column if not exists status text not null default 'active'
  check (status in ('active', 'disabled'));
alter table workspaces add column if not exists entry_model text;
-- No new grant on `workspaces` for the application role: `workspaces` has no RLS of its own
-- (0001), and every current writer (the bootstrap CLI) runs on the admin path. S4.2's platform
-- capabilities add exactly the scoped access they need when they arrive.

-- ---------------------------------------------------------------------------------------------
-- audit_records: platform rows
-- ---------------------------------------------------------------------------------------------

alter table audit_records drop constraint if exists audit_records_pkey;
alter table audit_records add primary key (id);
create index if not exists audit_records_workspace_created_idx on audit_records (workspace_id, created_at);
alter table audit_records alter column workspace_id drop not null;
alter table audit_records alter column actor_principal_id drop not null;
alter table audit_records add column if not exists actor_user_id uuid references users (id);
alter table audit_records drop constraint if exists audit_records_actor_shape;
alter table audit_records add constraint audit_records_actor_shape check (
  (workspace_id is not null and actor_principal_id is not null)
  or (workspace_id is null and actor_principal_id is null and actor_user_id is not null)
);

drop policy if exists audit_records_workspace_isolation on audit_records;
create policy audit_records_workspace_isolation on audit_records
  for all
  using (workspace_id = app_workspace() or (workspace_id is null and app_platform()))
  with check (workspace_id = app_workspace() or (workspace_id is null and app_platform()));
