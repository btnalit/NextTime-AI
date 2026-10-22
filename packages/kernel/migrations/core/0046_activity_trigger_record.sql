-- module: core, version: 0046
--
-- 0046_activity_trigger_record (S11 GO4c: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §4.6; docs/global-roadmap-2026-10-16.md GO4). What an Activity is, and what it records as the
-- call that started it, is written when it starts and never changes afterwards.
--
-- A goal's `fact_predicate` acceptance check (goal/0007) takes a Fact as evidence only when the
-- observation that last confirmed it was not the goal's own doing, and reads that from the
-- Activity the Observation hangs on: its `kind` (a gate's observe, a gate's apply, a collector's
-- submission), and for a gate's observe `metadata.triggeredByTaskId` — the Task whose Worker called
-- it, or JSON null for a caller that is not a Worker (`application/gateway/request-action-handler.ts`
-- `runObserve`); for a gate's apply `metadata.actionRequestId`. An Activity of a gate's observe
-- without the key (one started before this release) proves nothing. Those three are what this
-- guard keeps:
--   - `kind` never changes (no code path changes it);
--   - `metadata.triggeredByTaskId` is never added, removed or changed after the insert — a record
--     added later could make an older observation look independent;
--   - `metadata.actionRequestId` is never added, removed or changed after the insert.
-- Every other metadata update goes through as before: a Turn's report (`metadata || patch`), its
-- recovery notes, the egress note, the raw-secret scrub (which rewrites credential-shaped values;
-- these keys hold ids).
--
-- Reversibility (release.md §6): the previous release never changes an Activity's kind or these
-- keys, so the guard never fires on what it writes.
--
-- Cross-process bootstrap lock: the core module's key (core/0001).
select pg_advisory_xact_lock(7241000101);

create or replace function activities_trigger_record_guard() returns trigger
language plpgsql as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'activities: an Activity''s kind never changes (% -> %)', old.kind, new.kind;
  end if;
  if (new.metadata ? 'triggeredByTaskId') is distinct from (old.metadata ? 'triggeredByTaskId')
     or (new.metadata -> 'triggeredByTaskId') is distinct from (old.metadata -> 'triggeredByTaskId')
     or (new.metadata ? 'actionRequestId') is distinct from (old.metadata ? 'actionRequestId')
     or (new.metadata -> 'actionRequestId') is distinct from (old.metadata -> 'actionRequestId') then
    raise exception 'activities: the Task or ActionRequest an Activity records as its trigger is written when it starts and never changes';
  end if;
  return new;
end;
$$;

create or replace trigger activities_trigger_record_guard
  before update of kind, metadata on activities
  for each row execute function activities_trigger_record_guard();
