-- module: governance, version: 0030
--
-- 0030_action_request_target (S11 GO12: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §4.10; the shared plan s11-w2/go12-default-plan.md). A Gatekeeper's queue was one line: every
-- request waited for every earlier one of its Gatekeeper (R-50, decision D-10), so one awaiting
-- approval held back the gate's calls on everything else. An Operation may now declare the one
-- instance a call acts on (`@nexttime/shared` `OperationTargetSchema`); a request records the
-- instance, and waits only for earlier requests on that instance and for those on the whole gate.
--
-- `target` is that record: `{"type": ObjectType, "params": [param names], "identity": [values]}`,
-- taken when the request is made from the Operation version then published and this request's own
-- params (`actionTargetOf`), or NULL — the request acts on the whole Gatekeeper, as every request
-- did before. Two requests of one Gatekeeper conflict when either is NULL or both carry the same
-- `type` and `identity` (I-Q1, `actionTargetsConflict`); `params` says where `identity` came from.
--
--   1. Its shape (a CHECK): two non-empty arrays of the same length, `params` all strings,
--      `identity` all strings or integers, `type` a non-empty string, no other key.
--   2. Written once, when the row is made (`action_requests_target_guard`, before insert or update
--      of `target`): an update that changes it is refused, so a revision published later never
--      moves a request already in the queue (I-Q2).
--   3. Its identity is this request's own: on insert, `params ->> params[i]` of the row, as jsonb,
--      is `identity[i]` — no code path can queue a request against an instance its call does not
--      name.
--
-- No backfill: a request made before this migration acts on the whole Gatekeeper, as it did. No
-- index: the queue is read whole per Gatekeeper (`listExecutableQueue`), its non-terminal rows,
-- and the conflicts are decided in `governance/approval/queue.ts`.
--
-- Rolling back (docs/runbooks/release.md §6). Code without this migration never names the column:
-- its inserts leave it NULL, which the guard takes, and it orders every request against every
-- earlier one of its Gatekeeper — stricter than this, so code alone may roll back at any time; a
-- request this code started beside another of its Gatekeeper is `executing`, which the older
-- drainer stops at. To drop the schema too: `drop trigger action_requests_target_guard on
-- action_requests`, `drop function action_requests_target_guard()`, `alter table action_requests
-- drop column target` (its CHECK goes with it), then `delete from schema_migrations where module =
-- 'governance' and version = 30`.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists target jsonb;

alter table action_requests drop constraint if exists action_requests_target_shape;
-- A CASE, not a chain of ANDs: SQL does not promise to evaluate an AND left to right, and
-- `jsonb_array_length` / `->` on a value of another type would raise instead of failing the CHECK.
alter table action_requests add constraint action_requests_target_shape
  check (
    target is null
    or case
      when jsonb_typeof(target) is distinct from 'object' then false
      when jsonb_typeof(target -> 'type') is distinct from 'string' then false
      when length(target ->> 'type') = 0 then false
      when jsonb_typeof(target -> 'params') is distinct from 'array' then false
      when jsonb_typeof(target -> 'identity') is distinct from 'array' then false
      when jsonb_array_length(target -> 'params') = 0 then false
      when jsonb_array_length(target -> 'params') <> jsonb_array_length(target -> 'identity') then false
      when jsonb_path_exists(target -> 'params', '$[*] ? (@.type() != "string")') then false
      when jsonb_path_exists(
        target -> 'identity',
        '$[*] ? (@.type() != "string" && (@.type() != "number" || @ != @.floor()))'
      ) then false
      else (target - 'type' - 'params' - 'identity') = '{}'::jsonb
    end
  );

create or replace function action_requests_target_guard() returns trigger
language plpgsql as $$
declare
  i int;
begin
  if tg_op = 'UPDATE' then
    if new.target is distinct from old.target then
      raise exception 'action_requests: the instance a request is queued against never changes';
    end if;
    return new;
  end if;
  if new.target is null then
    return new;
  end if;
  -- A shape the CHECK refuses is its to refuse (a BEFORE trigger runs first).
  if jsonb_typeof(new.target -> 'params') is distinct from 'array'
     or jsonb_typeof(new.target -> 'identity') is distinct from 'array' then
    return new;
  end if;
  if jsonb_array_length(new.target -> 'params') <> jsonb_array_length(new.target -> 'identity') then
    return new;
  end if;
  for i in 0 .. jsonb_array_length(new.target -> 'params') - 1 loop
    if (new.params -> (new.target -> 'params' ->> i)) is distinct from (new.target -> 'identity' -> i) then
      raise exception 'action_requests: a request is queued against the instance its own params name (param %)',
        new.target -> 'params' ->> i;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists action_requests_target_guard on action_requests;
create trigger action_requests_target_guard
  before insert or update of target on action_requests
  for each row execute function action_requests_target_guard();
