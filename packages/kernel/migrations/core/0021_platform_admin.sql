-- 0021_platform_admin: P-A1 (docs/platform-admin-design.md §6.1 / §6.6 / §7; design doc §7.11
-- "`scope:'platform'`"). What the platform-management capabilities need beyond 0019:
--
--   * `platform_settings` — the one-row, versioned settings document (site name, announcement,
--     agent instance instructions, default workspace / model / budgets, password policy) plus a
--     history table so a bad edit can be rolled back. Compiled-in defaults are projected by the
--     kernel when the row has never been written (see application/platform/settings.ts).
--   * `users.daily_call_limit` / `users.monthly_token_budget` — per-user budget overrides
--     (`null` = inherit the platform default). Stored from P-A1; llm-proxy enforces them in P-D.
--   * Row-level security on `users` and `user_sessions`, and the column grants the application
--     role needs to run the platform capabilities *as `nexttime_app` under `app.platform = on`*
--     rather than as the superuser. 0019 kept these two tables reachable only through the identity
--     module's admin client; P-A1's capability handlers run inside the same gateway transaction
--     model as every other capability, so the tables get the narrowest policy set that admits
--     exactly that path:
--       - platform transactions (`app_platform()`) see and write every row;
--       - a workspace transaction sees only the users who hold a membership in *its* workspace
--         (the members page shows logins), and never writes `users` at all — `create_principal`
--         no longer accepts `kind = 'human'` (memberships come from `add_membership` /
--         `add_member`), so the one nexttime_app INSERT path 0019 granted for is gone;
--       - `password_hash` is write-only for the application role (UPDATE without SELECT): the
--         login path that reads it stays on the identity module's admin client.
--     Superuser (the identity module, CLI bootstrap) bypasses RLS as before.

begin;

-- ---------------------------------------------------------------------------------------------
-- users: budget overrides
-- ---------------------------------------------------------------------------------------------

alter table users add column if not exists daily_call_limit integer
  check (daily_call_limit is null or daily_call_limit >= 0);
alter table users add column if not exists monthly_token_budget bigint
  check (monthly_token_budget is null or monthly_token_budget >= 0);
-- "待激活" is `password_hash is null`; exposed as a generated column so the application role can
-- read the *fact* without ever holding SELECT on the hash itself.
alter table users add column if not exists has_password boolean
  generated always as (password_hash is not null) stored;

-- ---------------------------------------------------------------------------------------------
-- platform_settings (+ history)
-- ---------------------------------------------------------------------------------------------

create table if not exists platform_settings (
  singleton boolean primary key default true check (singleton),
  settings jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz,
  updated_by uuid references users (id)
);
insert into platform_settings (singleton) values (true) on conflict do nothing;

create table if not exists platform_settings_history (
  version integer primary key,
  settings jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);

grant select, update on platform_settings to nexttime_app;
grant select, insert on platform_settings_history to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- users / user_sessions: RLS + grants for the platform transaction
-- ---------------------------------------------------------------------------------------------

alter table users enable row level security;
alter table users force row level security;

drop policy if exists users_platform_admin on users;
create policy users_platform_admin on users
  for all to nexttime_app
  using (app_platform())
  with check (app_platform());

-- A workspace transaction may read the users who are members of *its* workspace (the members
-- page shows login / display name), nothing else. Read-only: no INSERT/UPDATE/DELETE policy.
drop policy if exists users_workspace_members on users;
create policy users_workspace_members on users
  for select to nexttime_app
  using (
    exists (
      select 1 from principals p
       where p.user_id = users.id and p.workspace_id = app_workspace()
    )
  );

-- Column grants: everything the platform capabilities read or write, never a SELECT on
-- password_hash (the login path reads it on the admin client).
revoke all on users from nexttime_app;
grant select (
  id, login, display_name, platform_role, status, must_change_password, has_password,
  failed_login_count, locked_until, daily_call_limit, monthly_token_budget, created_at, updated_at
) on users to nexttime_app;
grant insert (
  login, display_name, password_hash, platform_role, status, must_change_password,
  daily_call_limit, monthly_token_budget
) on users to nexttime_app;
grant update (
  display_name, password_hash, platform_role, status, must_change_password,
  failed_login_count, locked_until, daily_call_limit, monthly_token_budget, updated_at
) on users to nexttime_app;
-- `merge_user` deletes the empty source row (no password, no sessions) after re-pointing its
-- memberships; the policy above restricts this to platform transactions.
grant delete on users to nexttime_app;

-- `add_member` (workspace scope, owner): look a platform user up by login from inside a workspace
-- transaction, which the `users_workspace_members` policy would otherwise not let see a
-- non-member. Security definer, owned by the migration role (superuser), exposing only what the
-- members page needs. Never the hash, never the platform role.
create or replace function lookup_user_by_login(p_login text)
  returns table (id uuid, display_name text, status text)
  language sql security definer set search_path = public stable
as $$
  select u.id, u.display_name, u.status from users u where u.login = lower(trim(p_login))
$$;
revoke all on function lookup_user_by_login(text) from public;
grant execute on function lookup_user_by_login(text) to nexttime_app;

alter table user_sessions enable row level security;
alter table user_sessions force row level security;

drop policy if exists user_sessions_platform_admin on user_sessions;
create policy user_sessions_platform_admin on user_sessions
  for all to nexttime_app
  using (app_platform())
  with check (app_platform());

-- set_user_status / reset_user_password revoke sessions; list_users shows the last login.
grant select (id, user_id, created_at, expires_at, revoked_at) on user_sessions to nexttime_app;
grant update (revoked_at) on user_sessions to nexttime_app;
grant delete on user_sessions to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- workspaces: platform transactions list and count every workspace (0001 granted SELECT
-- already; no RLS on this table). `entry_model` / `status` came with 0019.
-- ---------------------------------------------------------------------------------------------

commit;
