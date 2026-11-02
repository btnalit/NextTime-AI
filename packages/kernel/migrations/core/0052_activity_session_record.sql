-- module: core, version: 0052
--
-- 0052_activity_session_record (S11 AA4-0: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §5.2, I-A7; STATUS legacy 584). A gate observation made through an admin agent's Handle records
-- the session it came through on its Activity: `metadata.sessionKind` (`admin_agent`) and
-- `metadata.sessionId` (`application/gateway/request-action-handler.ts` `runObserve`). The Activity's
-- Principal is the administrator's own — the admin agent acts as its person — so these two keys are
-- what tell the agent's observation, and the Facts it confirmed, from the person's own; until now
-- only the audit row did.
--
-- 0046's guard (`activities_trigger_record_guard`) keeps the keys an Activity records about the call
-- that started it from changing after the insert. This adds the two to it, the same rule: never
-- added, removed or changed by an update. A record added later could make an admin agent's
-- observation read as its person's, or the other way round. Everything 0046 already guarded is
-- unchanged (`kind`, `metadata.triggeredByTaskId`, `metadata.actionRequestId`).
--
-- Rolling back (docs/runbooks/release.md §6). The previous release never writes these keys, on an
-- insert or an update, so the guard never fires on what it writes and code alone may roll back. To
-- remove the guard as well: re-run 0046's `create or replace function activities_trigger_record_guard`
-- body, then `delete from schema_migrations where module = 'core' and version = 52`.
--
-- Cross-process bootstrap lock: see 0001_identity.sql — the first statement of every file in this
-- module.
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
  if (new.metadata ? 'sessionKind') is distinct from (old.metadata ? 'sessionKind')
     or (new.metadata -> 'sessionKind') is distinct from (old.metadata -> 'sessionKind')
     or (new.metadata ? 'sessionId') is distinct from (old.metadata ? 'sessionId')
     or (new.metadata -> 'sessionId') is distinct from (old.metadata -> 'sessionId') then
    raise exception 'activities: the session an Activity records it was started through is written when it starts and never changes';
  end if;
  return new;
end;
$$;
