-- module: core, version: 0064
--
-- Legacy 150 (#517 field inventory, "能选不打"): a workspace owner adds a person by login
-- (`add_member`), and today has to type the login blind. A platform administrator picks from
-- `list_users`, a platform read; an owner who is not one cannot, because a workspace transaction
-- sees only the users who already belong to its workspace (0021's `users_workspace_members`
-- policy). `lookup_user_by_login` (0021) is the one hole in that policy, and it answers an exact
-- login only.
--
-- `lookup_users_for_owner(p_query, p_limit)` is the second, as narrow as the members page needs
-- (`lookup_users`, application/gateway/members-handlers.ts):
--
--   * only for the transaction's own workspace and only when the transaction's Principal
--     (`app_principal()`) is an active (`disabled_at is null`) human or service owner there —
--     anything else is refused with 42501, the same code the 0042 identity lookups use;
--   * the query is trimmed and lowercased and must be at least 2 characters; it matches as a
--     plain substring (`strpos`, so `%` and `_` are ordinary characters, never wildcards) of the
--     login or the display name;
--   * only users `add_member` could add: active (`status = 'active'`), not already an active
--     member of this workspace (a removed membership does not count, as in `add_member`), and not
--     a *residual* user — awaiting activation with every live membership in a disabled or
--     `ephemeral` workspace (the platform users page hides those by default, `list_users`
--     `hideResidual`; they are acceptance-run residue);
--   * login and display name only — never the user id, the platform role, the status or any
--     membership;
--   * at most 21 rows whatever `p_limit` asks (the handler asks for 21 to show 20 and say there
--     are more), exact login first, then logins and then display names that start with the
--     query, then by login.
--
-- `security definer`, owned by the migration role like `lookup_user_by_login`, `search_path`
-- with `pg_temp` last (0035), no PUBLIC execute. Adds one function, changes no data and takes no
-- lock; the previous release never calls it.
--
-- Runner ordering / advisory lock: same module (`core`), same key as every other core migration
-- (see 0001_identity.sql's own comment for the rationale).
select pg_advisory_xact_lock(7241000101);

create or replace function lookup_users_for_owner(p_query text, p_limit integer)
returns table (login text, display_name text)
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare
  v_workspace uuid := app_workspace();
  v_query text := lower(trim(coalesce(p_query, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 21);
begin
  if v_workspace is null or not exists (
    select 1 from principals p
     where p.id = app_principal() and p.workspace_id = v_workspace
       and p.kind in ('human', 'service') and p.role = 'owner' and p.disabled_at is null
  ) then
    raise exception 'lookup_users_for_owner: only an active owner of this transaction''s workspace may look users up'
      using errcode = '42501';
  end if;
  if char_length(v_query) < 2 then
    return;
  end if;
  return query
    select u.login, u.display_name
      from users u
     where u.status = 'active'
       and (strpos(lower(u.login), v_query) > 0 or strpos(lower(u.display_name), v_query) > 0)
       and not exists (
         select 1 from principals m
          where m.user_id = u.id and m.workspace_id = v_workspace
            and m.kind = 'human' and m.disabled_at is null
       )
       and not (
         u.has_password = false
         and exists (select 1 from principals m where m.user_id = u.id and m.kind = 'human')
         and not exists (
           select 1 from principals m
             join workspaces w on w.id = m.workspace_id
            where m.user_id = u.id and m.kind = 'human' and m.disabled_at is null
              and w.status = 'active' and w.purpose <> 'ephemeral'
         )
       )
     order by
       case
         when lower(u.login) = v_query then 0
         when starts_with(lower(u.login), v_query) then 1
         when starts_with(lower(u.display_name), v_query) then 2
         else 3
       end,
       u.login
     limit v_limit;
end;
$$;

revoke all on function lookup_users_for_owner(text, integer) from public;
grant execute on function lookup_users_for_owner(text, integer) to nexttime_app;
