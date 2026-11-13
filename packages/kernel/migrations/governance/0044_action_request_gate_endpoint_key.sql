-- module: governance, version: 0044
--
-- Legacy 701, invariant I-A3: an ActionRequest runs only at the gate address it was made for. A
-- self-connected gate can now move to a new address (core 0057, `gate_address_changes`). Every
-- reference to it is by Gatekeeper id, and the executor reads the address when it runs, so a
-- request approved while the gate was at X would otherwise run at Y — approved for one host,
-- performed by another (the same shape as legacy K's "approved one definition, ran another").
--
-- `gate_endpoint_key` is the gate's address when the request was made, in the kernel's one
-- gate-address spelling (`normalizeGateEndpoint`). The executor compares it with the address it
-- is about to call (`resolveGateTarget`'s `endpointKey`) and refuses a different one before
-- sending anything (`failure_kind = 'refused'`, `gate_address_changed`); the reaper's replay asks
-- nobody and leaves such a row for a person (`outcome_unknown`). Written once, when the row is
-- made: an update that changes it is refused.
--
-- Backfill: every request still in flight on a gate the workspace connected itself gets that
-- connection's current `endpoint_key`, so a request made before the upgrade is bound like one made
-- after it. A request on a catalog gate, a final one, or one on a self connection backfilled
-- without a key (core 0045) stays NULL — the executor then has nothing to compare and runs it at
-- the current address, as before. An address change is refused while its gate has an in-flight
-- request with no key (`gate_address_change_blocked`), so that NULL never meets a change.
--
-- Rolling back: code without this migration never names the column; its inserts leave it NULL,
-- which the guard admits. To drop the schema too: `drop trigger action_requests_gate_endpoint_key_guard
-- on action_requests`, `drop function action_requests_gate_endpoint_key_guard()`, `alter table
-- action_requests drop column gate_endpoint_key`, then `delete from schema_migrations where module
-- = 'governance' and version = 44`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists gate_endpoint_key text;

update action_requests a
   set gate_endpoint_key = s.endpoint_key
  from workspace_self_connections s
 where s.workspace_id = a.workspace_id
   and s.gatekeeper_object_id = a.gatekeeper_id
   and s.endpoint_key is not null
   and a.gate_endpoint_key is null
   and a.status in (
     'proposed', 'policy_evaluated', 'auto_approved', 'pending_approval', 'approved', 'executing'
   );

create or replace function action_requests_gate_endpoint_key_guard() returns trigger
language plpgsql as $$
begin
  if new.gate_endpoint_key is distinct from old.gate_endpoint_key then
    raise exception 'action_requests: the gate address a request was made for never changes (I-A3, legacy 701)';
  end if;
  return new;
end;
$$;

drop trigger if exists action_requests_gate_endpoint_key_guard on action_requests;
create trigger action_requests_gate_endpoint_key_guard
  before update of gate_endpoint_key on action_requests
  for each row execute function action_requests_gate_endpoint_key_guard();
