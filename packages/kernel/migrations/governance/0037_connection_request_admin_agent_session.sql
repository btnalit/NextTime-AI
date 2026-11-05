-- module: governance, version: 0037
--
-- 0037_connection_request_admin_agent_session (S11 AA5a-1: docs/goal-orchestration-and-admin-agent-
-- plan-2026-10-16.md §5.2 I-A7, §5.8 step 2; the AA5 plan's F1). An admin agent may now ask to connect
-- a system with `request_connection`, in its trial workspace only. The request names the
-- administrator's own human Principal as `requested_by` — the admin agent acts as its person — so
-- the Principal alone cannot tell the agent's request from one the person's own entry agent made.
-- This records the session it came through:
--
--   * `admin_agent_session_id` — the admin agent session (`sessions.kind = 'admin_agent'`) whose
--     `request_connection` made the request; NULL for every other request.
--
-- What the database holds to, whoever writes (`connection_requests_admin_agent_session_guard`):
--   * on insert, a recorded session is an `admin_agent` session of this workspace acting for
--     `requested_by`, and the workspace is a trial workspace (`purpose = 'admin_trial'`, core 0050) —
--     the rule the dispatcher and the handler hold (I-A6);
--   * it never changes after the insert (completing or cancelling the request leaves it as it is).
-- A foreign key to `sessions` as well (session rows are never deleted but by a workspace purge, whose
-- delete order follows foreign keys).
--
-- Nullable, no backfill: no request before this one came from an admin agent. Reversibility
-- (docs/runbooks/release.md §6): the previous release names its columns on every insert and select
-- of `connection_requests` and never writes this one, so its inserts pass the guard (NULL) and its
-- completions and cancellations leave it unchanged: code alone may roll back. To remove the column as
-- well: `drop trigger connection_requests_admin_agent_session_guard on connection_requests`,
-- `drop function connection_requests_admin_agent_session_guard()`, `alter table connection_requests
-- drop column admin_agent_session_id`, then
-- `delete from schema_migrations where module = 'governance' and version = 37`.
--
-- Cross-process bootstrap lock: same governance-module key as 0001–0036.
select pg_advisory_xact_lock(7241000201);

alter table connection_requests add column if not exists admin_agent_session_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'connection_requests_admin_agent_session_fk'
  ) then
    alter table connection_requests add constraint connection_requests_admin_agent_session_fk
      foreign key (workspace_id, admin_agent_session_id) references sessions (workspace_id, id);
  end if;
end
$$;

create or replace function connection_requests_admin_agent_session_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.admin_agent_session_id is distinct from old.admin_agent_session_id then
      raise exception 'connection_requests: the admin agent session a request came through is written when it is made and never changes'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.admin_agent_session_id is null then
    return new;
  end if;
  if not exists (
    select 1 from sessions s
     where s.workspace_id = new.workspace_id
       and s.id = new.admin_agent_session_id
       and s.kind = 'admin_agent'
       and s.on_behalf_of = new.requested_by
  ) then
    raise exception 'connection_requests: admin_agent_session_id must name an admin_agent session of this workspace acting for requested_by'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from workspaces w
     where w.id = new.workspace_id and w.purpose = 'admin_trial'
  ) then
    raise exception 'connection_requests: an admin agent asks for a connection only in a trial workspace (purpose admin_trial)'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists connection_requests_admin_agent_session_guard on connection_requests;
create trigger connection_requests_admin_agent_session_guard
  before insert or update of admin_agent_session_id on connection_requests
  for each row execute function connection_requests_admin_agent_session_guard();
