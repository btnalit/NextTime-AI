-- module: governance, version: 0042
--
-- 0042_session_revocation_revokes_handles (legacy 699 and 707; I-H1: a revoked session has no
-- valid Handle — valid meaning `revoked_at is null and expires_at > now()`).
--
-- Until now "the session is revoked" and "its Handles are revoked" were kept in step by each
-- caller, and two callers did not: disabling a workspace marked every session revoked and revoked
-- no Handle (707), and a role change on the platform plane marked the person's sessions revoked
-- but revoked only their entry / MCP / admin agent Handles (699). The kernel refuses such a
-- Handle on every call (it reads the workspace and the principal), but llm-proxy honours only the
-- revocation table, so it kept reaching the model until its ttl (an `mcp_session` Handle: up to
-- 30 days). Four parts:
--
-- 1. `sessions_revoked_revokes_handles`: AFTER UPDATE OF status, FOR EACH ROW, when a session
--    becomes `revoked`, revoke its Handles that are still valid (an expired one is invalid
--    already). `security definer`: a platform-plane caller (`set_workspace_status`) runs with
--    the platform's `app.workspace_id`, so under its own rights RLS would let this UPDATE touch
--    no row at all — the bug again, silently. The owner bypasses RLS on `capability_handles`
--    because that table only ENABLEs row level security: it must never FORCE it, or this trigger
--    stops revoking (the I-H1 check in substrate/audit/invariant-checks.ts would then report it).
--    `revoked_at = now()` is the revoking transaction's start: llm-proxy pages the revocation
--    table by `revoked_at` with a 60 s overlap, so a revoking transaction must stay far shorter
--    than that (governance/capability/handles.ts, module comment).
-- 2. `capability_handles_live_by_session_idx`: (session_id) where revoked_at is null. The table
--    had only its primary key, so each revoked session scanned the workspace's Handles, which are
--    revoked but never deleted. One column: a session id is globally unique, and `revokeSession`
--    filters on it without `workspace_id`.
-- 3. `capability_handles_enforce_inheritance` (0008) now reads the issuing session and the
--    parent Handle `for share` and refuses a revoked session, and a revoked parent of a child
--    issued under the parent's own session (`attenuate`) or under a new session of any kind but
--    `worker_run`. A child under a new `worker_run` session (a Worker's) names its parent as
--    lineage: a crash retry is minted from the failed run's Handle, revoked when that run failed,
--    and its authority is re-read by the caller. Only a Worker's run opens a session from a
--    parent Handle today; another kind that ever does is refused here until it is decided. The code refuses
--    first (`issueHandle`: `session_revoked` / `parent_revoked`); this is the wall behind it. The
--    row lock is what serialises issuing with revoking: an UPDATE of the session (part 1) or of
--    its Handles waits for an issuer holding it, and its next statement sees the new Handle; an
--    issuer that comes second reads `revoked`. Runs as the caller: `nexttime_app` holds UPDATE on
--    `sessions` and `capability_handles` (core 0001, governance 0001), which FOR SHARE needs.
-- 4. Remediation: Handles still valid under a session that is already revoked are revoked here,
--    with one audit record per principal they act for (governance 0018's shape). The kernel is
--    stopped during an upgrade, so llm-proxy's `since` is from before it and picks every one up.
--
-- Reversibility (release.md §6): the previous release's code never issues into a revoked session
-- (every reuse lookup filters on `expires_at > now()`, and every statement that revokes a session
-- pulls `expires_at` to now), so the refusal in part 3 does not reach it; the remediation only
-- sets `revoked_at` (0015's monotonic revocation allows it).
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

-- ---------------------------------------------------------------------------------------------
-- 2. The index the trigger and `revokeSession` look Handles up by
-- ---------------------------------------------------------------------------------------------

create index if not exists capability_handles_live_by_session_idx
  on capability_handles (session_id) where revoked_at is null;

-- ---------------------------------------------------------------------------------------------
-- 1. A session's revocation revokes its Handles
-- ---------------------------------------------------------------------------------------------

create or replace function sessions_revoke_handles() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update capability_handles
     set revoked_at = now()
   where workspace_id = new.workspace_id
     and session_id = new.id
     and revoked_at is null
     and expires_at > now();
  return null;
end;
$$;
revoke all on function sessions_revoke_handles() from public;

create or replace trigger sessions_revoked_revokes_handles
  after update of status on sessions
  for each row
  when (old.status is distinct from 'revoked' and new.status = 'revoked')
  execute function sessions_revoke_handles();

-- ---------------------------------------------------------------------------------------------
-- 3. No Handle is issued under a revoked session or from a revoked parent
-- ---------------------------------------------------------------------------------------------

create or replace function capability_handles_enforce_inheritance() returns trigger
language plpgsql as $$
declare
  session_on_behalf_of uuid;
  session_status text;
  session_kind text;
  parent_on_behalf_of uuid;
  parent_expires_at timestamptz;
  parent_revoked_at timestamptz;
  parent_session_id uuid;
begin
  -- FOR SHARE (governance 0042): waits for a transaction revoking this session, and makes one
  -- that comes later wait for this insert to commit.
  select on_behalf_of, status, kind into session_on_behalf_of, session_status, session_kind
  from sessions
  where workspace_id = new.workspace_id and id = new.session_id
  for share;

  if session_on_behalf_of is null then
    raise exception
      'capability_handles: no session % found in workspace % (I13)', new.session_id, new.workspace_id;
  end if;

  if session_status = 'revoked' then
    raise exception
      'capability_handles: session % is revoked; no Handle is issued under it (I-H1)', new.session_id;
  end if;

  if new.on_behalf_of is distinct from session_on_behalf_of then
    raise exception
      'capability_handles: on_behalf_of must match the issuing session''s own on_behalf_of (I13)';
  end if;

  if new.parent_jti is not null then
    select on_behalf_of, expires_at, revoked_at, session_id
      into parent_on_behalf_of, parent_expires_at, parent_revoked_at, parent_session_id
    from capability_handles
    where workspace_id = new.workspace_id and jti = new.parent_jti
    for share;

    if parent_on_behalf_of is null then
      raise exception
        'capability_handles: no parent handle % found in workspace % (I13)', new.parent_jti, new.workspace_id;
    end if;

    if parent_revoked_at is not null
       and (parent_session_id = new.session_id or session_kind <> 'worker_run') then
      raise exception
        'capability_handles: parent handle % is revoked; no child is issued from it under its session or a new session other than a Worker run''s (I-H1)',
        new.parent_jti;
    end if;

    if new.on_behalf_of is distinct from parent_on_behalf_of then
      raise exception
        'capability_handles: a child handle''s on_behalf_of must match its parent''s (I13)';
    end if;

    if new.expires_at > parent_expires_at then
      raise exception
        'capability_handles: a child handle''s expires_at cannot exceed its parent''s (I13)';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Remediation: Handles still valid under an already-revoked session
-- ---------------------------------------------------------------------------------------------

insert into audit_records (workspace_id, actor_principal_id, action, resource_type, resource_id, payload)
select
  h.workspace_id,
  h.on_behalf_of,
  'principal.revoked_session_handles_revoked',
  'principal',
  h.on_behalf_of,
  jsonb_build_object(
    'by', 'migration governance/0042_session_revocation_revokes_handles',
    'reason', 'a revoked session''s Handles are revoked with it from this release on; Handles that stayed valid under a session revoked earlier (a disabled workspace, a role change) are revoked',
    'revokedHandleCount', count(*)
  )
from capability_handles h
join sessions s on s.workspace_id = h.workspace_id and s.id = h.session_id
where s.status = 'revoked'
  and h.revoked_at is null
  and h.expires_at > now()
group by h.workspace_id, h.on_behalf_of;

update capability_handles h
   set revoked_at = now()
  from sessions s
 where s.workspace_id = h.workspace_id
   and s.id = h.session_id
   and s.status = 'revoked'
   and h.revoked_at is null
   and h.expires_at > now();
