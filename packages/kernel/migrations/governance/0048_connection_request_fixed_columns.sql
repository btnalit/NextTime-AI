-- module: governance, version: 0048
--
-- 0048_connection_request_fixed_columns (legacy 254, #501 on #1521, S1). What a ConnectionRequest
-- is about is written when it is made and never changes, whoever updates the row afterwards:
-- its workspace, id, kind, target, gate instance, requester and when it was asked. Completing it
-- (`status`, `gatekeeper_id`, `completed_by`, `completed_at`) and cancelling it (`status`,
-- `cancel_reason`, `cancelled_at`) are the only updates the kernel makes (governance/connections'
-- service), and the only ones this allows.
--
-- Why a trigger: governance/0047 gave the platform plane (`app_platform()`) one edge on this
-- workspace table — an open gate instance enable request to `cancelled` / `gate_unavailable`
-- (`connection_requests_platform_cancel`). A policy's `with check` sees only the new row, so the
-- same statement could also have changed the requester, the gate, the kind, or moved the row to
-- another workspace. The workspace plane's own update policy (0005) holds the workspace but not
-- the rest. This guard compares the old row with the new one, for every plane, so the edge 0047
-- names is the only thing the platform can do here. `admin_agent_session_id` has its own guard
-- (0037). `completed_by` changes only with the move to `completed` (#493 on #1521): 0005's checks
-- keep `gatekeeper_id` and `completed_at` off a request that is not completed, not the person.
--
-- Reversibility (docs/runbooks/release.md §6): the previous release updates only the columns this
-- allows, so code alone may roll back. To remove it as well:
-- `drop trigger connection_requests_fixed_columns_guard on connection_requests`,
-- `drop function connection_requests_fixed_columns_guard()`, then
-- `delete from schema_migrations where module = 'governance' and version = 48`.
--
-- Cross-process bootstrap lock: same governance-module key as 0001–0047.
select pg_advisory_xact_lock(7241000201);

create or replace function connection_requests_fixed_columns_guard() returns trigger
language plpgsql as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.id is distinct from old.id
     or new.kind is distinct from old.kind
     or new.target is distinct from old.target
     or new.gate_instance_id is distinct from old.gate_instance_id
     or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at then
    raise exception 'connection_requests: what a request is about (workspace, id, kind, target, gate instance, requester, requested at) is written when it is made and never changes'
      using errcode = 'check_violation';
  end if;
  -- Who completed it is written by completing it, and by nothing else: 0005 already keeps the
  -- Gatekeeper and the time off a request that is not `completed`, not the person.
  if new.completed_by is distinct from old.completed_by and new.status <> 'completed' then
    raise exception 'connection_requests: completed_by is written only when a request is completed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists connection_requests_fixed_columns_guard on connection_requests;
create trigger connection_requests_fixed_columns_guard
  before update on connection_requests
  for each row execute function connection_requests_fixed_columns_guard();
