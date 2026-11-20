-- module: governance, version: 0047
--
-- 0047_connection_request_gate_instance (legacy 254, coordinator decision 2026-11-19: choice A).
-- A member who may not enable a platform gate instance asks the workspace owner to, and the ask
-- is a ConnectionRequest — the owner keeps one queue (`list_connection_requests`), and the
-- request's lifecycle (`requested → completed | cancelled`, `CONNECTION_REQUEST_TRANSITIONS`) and
-- its audit are the ones governance/0005 already has. Two kinds of request, one table:
--
--   * a self connection (`request_connection`, 0005): `target` names the system, the owner
--     completes it with `create_connection`;
--   * a gate instance enable (`request_gate_instance_enable`): `gate_instance_id` names the
--     platform's gate instance (`gate_instances.gate_id`, core 0023), the owner completes it with
--     `enable_gate_instance`. `kind` is the instance's transport kind when it was asked for.
--
-- What the database holds to, whoever writes:
--
--   * `connection_requests_one_subject`: exactly one of `target` and `gate_instance_id` is set
--     (`target` loses its `not null` for that).
--   * `connection_requests_one_open_gate_enable`: one person has at most one open request per gate
--     instance in a workspace (partial unique index over `status = 'requested'`). A second ask
--     while the first is open is the first (the kernel returns it); after it ends, a new one may
--     be made.
--   * `connection_requests_gate_enable_not_admin_agent`: an admin agent never asks for a gate
--     instance (`request_gate_instance_enable` is human-channel; governance/0037's session column
--     stays null on such a row).
--   * `cancel_reason` / `cancelled_at`: why and when a request ended `cancelled` — `withdrawn` (its
--     requester), `declined` (the owner, someone else's), `gate_unavailable` (the platform deleted
--     or disabled the gate instance, or took its connector out of platform-preset mode). Only a
--     `cancelled` row carries them; a row cancelled before this migration carries neither (no
--     backfill: who cancelled it is in its `connection.request_cancelled` audit row).
--   * `connection_requests_platform_cancel` (+ `_platform_read`): the platform plane
--     (`app_platform()`, core 0019) reads gate-instance requests and moves an open one to
--     `cancelled` / `gate_unavailable` — that edge and nothing else (its `with check`). It is how
--     `update_gate_instance` / `delete_gate_instance` / `set_connector_mode` end the requests for a
--     gate no workspace can enable any more, in the same transaction, instead of leaving them open.
--
-- `gate_instance_id` has no foreign key: a gate-host instance can be deleted
-- (`delete_gate_instance`), and a request that asked for it keeps saying which one it was — the
-- deletion first cancels the open ones (above). The display name is read live
-- (`list_connection_requests`), none once the instance is gone.
--
-- Rolling back (docs/runbooks/release.md §6): the previous release never writes these columns and
-- reads `target` as a string, so a gate-instance request (null `target`) breaks its owner queue —
-- before rolling back, `delete from connection_requests where gate_instance_id is not null`
-- (requests only; nothing else refers to them), then the columns, index, constraints and policies
-- below can stay or be dropped.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table connection_requests add column if not exists gate_instance_id text;
alter table connection_requests alter column target drop not null;
alter table connection_requests add column if not exists cancel_reason text;
alter table connection_requests add column if not exists cancelled_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'connection_requests_one_subject'
  ) then
    alter table connection_requests add constraint connection_requests_one_subject
      check ((target is null) <> (gate_instance_id is null));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'connection_requests_gate_enable_not_admin_agent'
  ) then
    alter table connection_requests add constraint connection_requests_gate_enable_not_admin_agent
      check (gate_instance_id is null or admin_agent_session_id is null);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'connection_requests_cancel_reason'
  ) then
    alter table connection_requests add constraint connection_requests_cancel_reason
      check (
        cancel_reason is null or cancel_reason in ('withdrawn', 'declined', 'gate_unavailable')
      );
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'connection_requests_cancel_fields'
  ) then
    alter table connection_requests add constraint connection_requests_cancel_fields
      check (
        (status = 'cancelled' or (cancel_reason is null and cancelled_at is null))
        and ((cancel_reason is null) = (cancelled_at is null))
      );
  end if;
end
$$;

create unique index if not exists connection_requests_one_open_gate_enable
  on connection_requests (workspace_id, requested_by, gate_instance_id)
  where status = 'requested' and gate_instance_id is not null;

-- The owner's queue and the platform's cancel both look requests up by gate instance.
create index if not exists connection_requests_gate_instance_idx
  on connection_requests (gate_instance_id, status)
  where gate_instance_id is not null;

drop policy if exists connection_requests_platform_read on connection_requests;
create policy connection_requests_platform_read on connection_requests
  for select
  using (app_platform() and gate_instance_id is not null);

drop policy if exists connection_requests_platform_cancel on connection_requests;
create policy connection_requests_platform_cancel on connection_requests
  for update
  using (app_platform() and gate_instance_id is not null and status = 'requested')
  with check (
    app_platform()
    and gate_instance_id is not null
    and status = 'cancelled'
    and cancel_reason = 'gate_unavailable'
  );
