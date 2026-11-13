-- module: governance, version: 0043
--
-- 0043_authority_locks (legacy 702; I-H2: a disabled workspace, user or Principal has no valid
-- Handle acting for it — valid meaning `revoked_at is null and expires_at > now()`).
--
-- Until now an issuer checked the authority it issues under (the Principal not disabled, its role)
-- in one statement and inserted the Handle in a later one, and a writer changed that authority in
-- a transaction of its own: a disable or a role change committed between the two left a Handle
-- issued under the old authority that nothing revoked (legacy 702). governance 0042 closed it for a
-- revoked session (I-H1); this closes it for the authority above the session — the workspace, the
-- platform user and the Principal — with advisory locks, one per authority, taken shared by every
-- issuer and exclusive by every writer:
--
--   class 7241034 (`ADVISORY_LOCK_NAMESPACES.authority`), instance
--   `authority_lock_instance(kind, id)` = hashtext(kind || ':' || id), kind one of
--   'workspace', 'user', 'principal'. Global order: workspace, then user, then principal, each
--   level by id.
--
-- 1. `authority_lock_instance`, `lock_authority` (exclusive) and `lock_issuing_authority` (shared,
--    in the global order, returning the Principal's user as read before the locks). The issuer
--    (`issueHandle`, governance/capability/handles.ts) calls the last before it reads the session
--    `for share`, then re-reads the authority in a new statement: under READ COMMITTED (asserted
--    here) that statement sees every writer that committed before the lock was granted.
-- 2. BEFORE UPDATE triggers take the exclusive lock whenever the authority changes:
--    `principals` (disabled_at, role, user_id — merge_user moves a membership to another user),
--    `users` (status, platform_role), `workspaces` (status). Every writer is covered, whoever it is
--    — a capability, the operator CLI, an admin client, hand-written SQL. A writer that comes first
--    makes the issuer wait and refuse on its re-read; an issuer that comes first makes the writer
--    wait, and the writer's later statements see the Handle and revoke it.
-- 3. AFTER UPDATE triggers revoke the sessions acting for what was disabled — the workspace's, the
--    user's memberships' (across workspaces), the Principal's — and so, through 0042, their
--    Handles: a disabled workspace, user (`set_user_status`) or Principal (`disable_principal`,
--    `remove_membership`) revokes them in the database, not only in the handler that disabled
--    it (`disable_principal` and `remove_membership` keep their own revocation, which then finds
--    nothing live; `set_workspace_status` leaves it to the trigger). Each first takes the rows it
--    revokes in one statement ordered by id, then UPDATEs them (the lock order below). `security
--    definer` for the reason 0042 gives: a platform-plane caller would see no session under RLS.
--    Neither reads `users` (which FORCEs row level security): the users trigger uses only
--    `new.id`.
-- 4. Remediation: sessions still live under a disabled workspace, user or Principal are revoked
--    (their Handles with them, 0042), with one audit record per Principal whose Handles were still
--    valid.
--
-- The lock order that keeps this free of deadlocks (governance/capability/handles.ts, module
-- comment): the authority locks, then session rows by id, then Handle rows. Whoever changes an
-- authority takes its lock first, before it reads or locks any row (`lock_authorities`, several in
-- the global order); whoever issues takes its shared locks before it locks or inserts a row that
-- references the Principal; whoever revokes several sessions takes them in one statement ordered
-- by id (the triggers in 3 included). The triggers in 2 take the same lock again (re-entrant) and
-- are what covers a writer outside the kernel; one that locks rows first can deadlock with an
-- issuer, which Postgres detects by aborting one of the two — never by leaving a Handle valid.
--
-- Reversibility (release.md §6): the previous release's code does not call the functions; the
-- triggers take a lock nobody else holds and revoke what that code's handlers revoke anyway; the
-- remediation only marks sessions revoked (0042 then sets `revoked_at`).
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

-- ---------------------------------------------------------------------------------------------
-- 1. The locks
-- ---------------------------------------------------------------------------------------------

create or replace function authority_lock_instance(p_kind text, p_id uuid) returns integer
language sql immutable parallel safe
set search_path = public, pg_temp
as $$ select hashtext(p_kind || ':' || p_id::text) $$;

-- Exclusive: a writer about to change one authority.
create or replace function lock_authority(p_kind text, p_id uuid) returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_kind not in ('workspace', 'user', 'principal') then
    raise exception 'lock_authority: unknown authority kind %', p_kind;
  end if;
  perform pg_advisory_xact_lock(7241034, authority_lock_instance(p_kind, p_id));
end;
$$;

-- Exclusive, several at once, in the global order: a writer that changes more than one authority.
create or replace function lock_authorities(
  p_workspace_ids uuid[], p_user_ids uuid[], p_principal_ids uuid[]
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  for v_id in select distinct x from unnest(coalesce(p_workspace_ids, '{}')) as x where x is not null order by x loop
    perform pg_advisory_xact_lock(7241034, authority_lock_instance('workspace', v_id));
  end loop;
  for v_id in select distinct x from unnest(coalesce(p_user_ids, '{}')) as x where x is not null order by x loop
    perform pg_advisory_xact_lock(7241034, authority_lock_instance('user', v_id));
  end loop;
  for v_id in select distinct x from unnest(coalesce(p_principal_ids, '{}')) as x where x is not null order by x loop
    perform pg_advisory_xact_lock(7241034, authority_lock_instance('principal', v_id));
  end loop;
end;
$$;

-- Shared, the issuer's: the workspace, the Principal's user (as read before the lock; the issuer
-- refuses if it changed by the time it re-reads), the Principal. Runs as the caller, so RLS
-- applies to the read of `principals` as to the issuer's own reads.
create or replace function lock_issuing_authority(p_workspace_id uuid, p_principal_id uuid)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  -- "A statement after the lock sees every writer that committed before it" holds only there.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'lock_issuing_authority: a Handle is issued under READ COMMITTED only (governance 0043), not %',
      current_setting('transaction_isolation');
  end if;
  select user_id into v_user_id
  from principals
  where workspace_id = p_workspace_id and id = p_principal_id;
  perform pg_advisory_xact_lock_shared(7241034, authority_lock_instance('workspace', p_workspace_id));
  if v_user_id is not null then
    perform pg_advisory_xact_lock_shared(7241034, authority_lock_instance('user', v_user_id));
  end if;
  perform pg_advisory_xact_lock_shared(7241034, authority_lock_instance('principal', p_principal_id));
  return v_user_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Every change of an authority takes its lock
-- ---------------------------------------------------------------------------------------------

create or replace function principals_lock_authority() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform lock_authority('principal', new.id);
  return new;
end;
$$;

create or replace trigger principals_authority_lock
  before update of disabled_at, role, user_id on principals
  for each row
  when (old.disabled_at is distinct from new.disabled_at
        or old.role is distinct from new.role
        or old.user_id is distinct from new.user_id)
  execute function principals_lock_authority();

create or replace function users_lock_authority() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform lock_authority('user', new.id);
  return new;
end;
$$;

create or replace trigger users_authority_lock
  before update of status, platform_role on users
  for each row
  when (old.status is distinct from new.status or old.platform_role is distinct from new.platform_role)
  execute function users_lock_authority();

create or replace function workspaces_lock_authority() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform lock_authority('workspace', new.id);
  return new;
end;
$$;

create or replace trigger workspaces_authority_lock
  before update of status on workspaces
  for each row
  when (old.status is distinct from new.status)
  execute function workspaces_lock_authority();

-- ---------------------------------------------------------------------------------------------
-- 3. A disable revokes the sessions acting for what it disabled
-- ---------------------------------------------------------------------------------------------

create or replace function workspaces_disabled_revokes_sessions() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  -- The lock order (header): the rows in one statement by id, then the UPDATE.
  perform 1 from sessions
   where workspace_id = new.id
     and status <> 'revoked'
   order by id
   for no key update;
  update sessions
     set status = 'revoked', expires_at = least(expires_at, now())
   where workspace_id = new.id
     and status <> 'revoked';
  return null;
end;
$$;
revoke all on function workspaces_disabled_revokes_sessions() from public;

create or replace trigger workspaces_disabled_revokes_sessions
  after update of status on workspaces
  for each row
  when (old.status is distinct from 'disabled' and new.status = 'disabled')
  execute function workspaces_disabled_revokes_sessions();

create or replace function users_disabled_revokes_sessions() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  -- The lock order (header): the rows in one statement by id — across the user's workspaces — then
  -- the UPDATE.
  perform 1 from sessions s
   where s.status <> 'revoked'
     and exists (
       select 1 from principals p
        where p.user_id = new.id and p.workspace_id = s.workspace_id and p.id = s.on_behalf_of
     )
   order by s.id
   for no key update of s;
  update sessions s
     set status = 'revoked', expires_at = least(s.expires_at, now())
    from principals p
   where p.user_id = new.id
     and s.workspace_id = p.workspace_id
     and s.on_behalf_of = p.id
     and s.status <> 'revoked';
  return null;
end;
$$;
revoke all on function users_disabled_revokes_sessions() from public;

create or replace trigger users_disabled_revokes_sessions
  after update of status on users
  for each row
  when (old.status is distinct from 'disabled' and new.status = 'disabled')
  execute function users_disabled_revokes_sessions();

create or replace function principals_disabled_revokes_sessions() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  -- The lock order (header): the rows in one statement by id, then the UPDATE.
  perform 1 from sessions
   where workspace_id = new.workspace_id
     and on_behalf_of = new.id
     and status <> 'revoked'
   order by id
   for no key update;
  update sessions
     set status = 'revoked', expires_at = least(expires_at, now())
   where workspace_id = new.workspace_id
     and on_behalf_of = new.id
     and status <> 'revoked';
  return null;
end;
$$;
revoke all on function principals_disabled_revokes_sessions() from public;

create or replace trigger principals_disabled_revokes_sessions
  after update of disabled_at on principals
  for each row
  when (old.disabled_at is null and new.disabled_at is not null)
  execute function principals_disabled_revokes_sessions();

-- ---------------------------------------------------------------------------------------------
-- 4. Remediation: sessions still live under a disabled authority
-- ---------------------------------------------------------------------------------------------

insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
select
  h.workspace_id,
  h.on_behalf_of,
  'principal.disabled_authority_handles_revoked',
  'principal',
  h.on_behalf_of,
  jsonb_build_object(
    'by', 'migration governance/0043_authority_locks',
    'reason', 'a disabled workspace, user or Principal revokes the sessions acting for it from this release on; Handles that stayed valid under one disabled earlier are revoked',
    'revokedHandleCount', count(*)
  )
from capability_handles h
join principals p on p.workspace_id = h.workspace_id and p.id = h.on_behalf_of
join workspaces w on w.id = h.workspace_id
left join users u on u.id = p.user_id
where (p.disabled_at is not null or u.status = 'disabled' or w.status = 'disabled')
  and h.revoked_at is null
  and h.expires_at > now()
group by h.workspace_id, h.on_behalf_of;

update sessions s
   set status = 'revoked', expires_at = least(s.expires_at, now())
  from principals p
  join workspaces w on w.id = p.workspace_id
  left join users u on u.id = p.user_id
 where s.workspace_id = p.workspace_id
   and s.on_behalf_of = p.id
   and s.status <> 'revoked'
   and (p.disabled_at is not null or u.status = 'disabled' or w.status = 'disabled');
