-- module: governance, version: 0031
--
-- 0031_action_request_execution_guard (STATUS legacy 565; review #493 on #876). I-Q1 (R-50 /
-- D-10, narrowed by S11 GO12 to what conflicts) says two requests of one Gatekeeper that conflict
-- never run at the same time. The drainer kept that by reading the queue in `requested_at` order
-- and starting a row only when nothing ahead of it conflicts (`governance/approval/queue.ts`) —
-- which a read cannot promise:
--
--   - `requested_at` is the inserting transaction's start time, and a row is seen only once it
--     commits. A row A stamped before a conflicting row B can commit after B has started: the next
--     read plans A *ahead* of the `executing` B, finds nothing ahead of A, and starts it.
--   - Two drains read at different moments: one starts B having not yet seen A; the other, having
--     seen both but not yet that start, starts A.
--
-- `startActionRequestExecution` locked only its own row, so both starts went through. Any order
-- key taken before commit has the first gap; only a check where a row enters `executing` closes
-- the second. This migration is that check, so the database, not the drainer's read, keeps it:
--
--   1. `action_request_targets_conflict(a, b)`: I-Q1's conflict rule, the SQL twin of
--      `@nexttime/shared` `actionTargetsConflict` — either NULL (the whole Gatekeeper); else the
--      same `type` and, by the same `params`, the same `identity` compared as text (`5` and `"5"`
--      are one instance); the same `type` by other `params` conflicts (the platform cannot tell
--      the two instances apart). `governance/approval/target-conflict.integration.test.ts` runs one
--      table of cases through both — change one, change the other, the test fails otherwise.
--   2. `action_request_execution_lock(workspace, gatekeeper)`: the transaction-scoped advisory
--      lock every start on one Gatekeeper takes, so starts on a Gatekeeper go one at a time and
--      each sees the ones before it committed. Its key space is `src/adapters/db/
--      advisory-lock-namespaces.ts`'s registry (two-key form, its own class id), checked by that
--      file's test.
--   3. `action_requests_execution_guard`, before a row enters `executing`: takes that lock, then
--      refuses (SQLSTATE `NTQ01`) when another row of the same workspace and Gatekeeper is
--      `executing` and conflicts with it. `startActionRequestExecution` turns the refusal into an
--      `IllegalTransition`, so the drainer reads the queue again, where `planGatekeeperQueue` now
--      holds a row back by any conflicting `executing` row, ahead of it or behind.
--
-- What this keeps and what it does not: two conflicting requests of one Gatekeeper are never
-- `executing` together (mutual exclusion). It does not make them run in `requested_at` order: a
-- row that commits after a conflicting later-stamped one has started runs after it. No Gatekeeper
-- relies on that order today; a stricter one would need its own design, not this guard.
--
-- Cost: starts on one Gatekeeper serialize on the lock, conflicting or not — a start is one short
-- transaction (lock row, update, audit). Rows already `executing` before this migration are not
-- checked against each other; only a new start is.
--
-- Rolling back (docs/runbooks/release.md §6). Code without this migration keeps the trigger's
-- guarantee if the trigger stays: an older drainer that plans a row ahead of a conflicting
-- `executing` one gets the refusal as an unexpected database error, and the row starts once the
-- other ends — never both at once. On the background drains (outbox consumer, tick) that is an
-- error line and a drain that stops. On the inline drain of a `request_action` call, that call
-- returns an internal error although its request is queued and runs once its turn comes; a retry
-- with an explicit idempotency key, or from a goal step, gets that request back, one without gets
-- it back only while it has not finished (R-53 / D-12, as for any retry).
--
-- To drop the schema too, drop this migration before governance/0030: the guard's plpgsql body
-- reads `action_requests.target`, a use Postgres does not record, so 0030's `drop column target`
-- goes through with this trigger still in place and every later start then fails on the missing
-- column. Rolling back past v0.56.0 takes both, in one transaction, this one first: `drop trigger
-- action_requests_execution_guard on action_requests`, `drop function
-- action_requests_execution_guard()`, `drop function action_request_execution_lock(uuid, uuid)`,
-- `drop function action_request_targets_conflict(jsonb, jsonb)`, `drop function
-- action_request_identity_text(jsonb)`, `delete from schema_migrations where module =
-- 'governance' and version = 31`; then governance/0030's own steps.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

-- An identity value as `String()` writes it: a string as itself, a number without trailing zeros
-- (`5` for 5 and 5.0, as JavaScript reads both), so the comparison below is the TypeScript one.
create or replace function action_request_identity_text(value jsonb) returns text
language sql immutable as $$
  select case jsonb_typeof(value)
    when 'number' then trim_scale(value::text::numeric)::text
    else value #>> '{}'
  end
$$;

create or replace function action_request_targets_conflict(a jsonb, b jsonb) returns boolean
language sql immutable as $$
  select case
    when a is null or b is null then true
    when (a ->> 'type') is distinct from (b ->> 'type') then false
    when (a -> 'params') is distinct from (b -> 'params') then true
    when jsonb_array_length(a -> 'identity') <> jsonb_array_length(b -> 'identity') then true
    else not exists (
      select 1
        from generate_series(0, jsonb_array_length(a -> 'identity') - 1) as i
       where action_request_identity_text(a -> 'identity' -> i)
             is distinct from action_request_identity_text(b -> 'identity' -> i)
    )
  end
$$;

-- Class id 7241031 (`ADVISORY_LOCK_NAMESPACES.actionRequestExecution`, src/adapters/db/
-- advisory-lock-namespaces.ts): the two-key form, a key space of its own — no one-key lock
-- (`hashtext(...)`, the module bootstrap keys) can take it.
create or replace function action_request_execution_lock(p_workspace_id uuid, p_gatekeeper_id uuid)
returns void
language sql volatile as $$
  select pg_advisory_xact_lock(7241031, hashtext(p_workspace_id::text || ':' || p_gatekeeper_id::text))
$$;

create or replace function action_requests_execution_guard() returns trigger
language plpgsql as $$
declare
  running uuid;
begin
  -- Only a row entering `executing`: an update of a row already there starts nothing.
  if tg_op = 'UPDATE' and old.status = 'executing' then
    return new;
  end if;
  perform action_request_execution_lock(new.workspace_id, new.gatekeeper_id);
  -- Read after the lock: every start on this Gatekeeper before this one has committed.
  select r.id into running
    from action_requests r
   where r.workspace_id = new.workspace_id
     and r.gatekeeper_id = new.gatekeeper_id
     and r.status = 'executing'
     and r.id <> new.id
     and action_request_targets_conflict(r.target, new.target)
   order by r.requested_at, r.id
   limit 1;
  if running is not null then
    raise exception 'action_requests: % may not start while % on the same gatekeeper is executing and conflicts with it',
      new.id, running
      using errcode = 'NTQ01';
  end if;
  return new;
end;
$$;

drop trigger if exists action_requests_execution_guard on action_requests;
create trigger action_requests_execution_guard
  before insert or update of status on action_requests
  for each row
  when (new.status = 'executing')
  execute function action_requests_execution_guard();
