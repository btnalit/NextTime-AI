-- module: governance, version: 0023
--
-- 0023_action_request_reconciliation (S11 GO3c:
-- docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.3 I-G4, §4.7 "结果未知").
--
-- A `failed` + `outcome_unknown` request may or may not have run. Before anything else of its step
-- runs, someone checks the target system and records what they found; and only a decision of the
-- requester's runs the same request again. Both are Decisions (`decisions`, core/0002 — insert-only
-- for the application role since core/0035, so a recorded one cannot be edited), and the request
-- points at them:
--
--   1. `reconciliation` — what was found: `effect_seen` (the request counts as executed) or
--      `effect_absent` (no effect; the step needs a person). Values from packages/shared enums.ts
--      `ACTION_REQUEST_RECONCILIATION_VALUES`. `reconciliation_decision_id` is the Decision behind
--      it: a person's (`decided_by`), or the platform's reconcile observation (GO3d: no
--      `decided_by`, `rationale.basis = 'observation'`).
--   2. `reexecute_decision_id` — the requester decided to run the same request again: the step's
--      next request with the same identity (I-G4) is a new ActionRequest, evaluated and approved
--      like any other. Only after `effect_absent`.
--
-- The guard trigger makes both write-once (a finding that turns out wrong is answered by a later
-- decision about the step — re-execute, retry, revise — never by rewriting the row) and checks who
-- decided, from the Decision and `principals`, not from what the writer says: a reconciliation by
-- a person is the requester's (`on_behalf_of`) or a workspace owner's, a human principal still
-- enabled; a re-execute is the requester's alone, as a person. Each Decision must name this request
-- and its own kind (`rationale.actionRequestId`, `rationale.decision`), so one cannot be attached
-- to another request or stand for the other kind.
--
-- No backfill: every existing row carries NULL. Reversibility (release.md §6): the previous release
-- reads and writes `action_requests` with an explicit column list and never sees these columns; the
-- CHECKs hold trivially on its rows, and the trigger fires only when one of the three columns is
-- written.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

alter table action_requests add column if not exists reconciliation text;
alter table action_requests add column if not exists reconciliation_decision_id uuid;
alter table action_requests add column if not exists reexecute_decision_id uuid;

alter table action_requests drop constraint if exists action_requests_reconciliation_check;
alter table action_requests add constraint action_requests_reconciliation_check
  check (reconciliation is null or reconciliation in ('effect_seen', 'effect_absent'));

-- A finding always has its Decision, and only a request whose outcome is unknown has one. It is
-- recorded on a `failed` row (the guard below); the row may be compensated afterwards and keeps its
-- kind (governance/0021), hence `compensated` here.
alter table action_requests drop constraint if exists action_requests_reconciliation_decision;
alter table action_requests add constraint action_requests_reconciliation_decision
  check ((reconciliation is null) = (reconciliation_decision_id is null));

alter table action_requests drop constraint if exists action_requests_reconciliation_outcome_unknown;
alter table action_requests add constraint action_requests_reconciliation_outcome_unknown
  check (
    reconciliation is null
    or (status in ('failed', 'compensated') and failure_kind = 'outcome_unknown')
  );

alter table action_requests drop constraint if exists action_requests_reexecute_after_effect_absent;
alter table action_requests add constraint action_requests_reexecute_after_effect_absent
  check (reexecute_decision_id is null or reconciliation = 'effect_absent');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'action_requests_reconciliation_decision_fkey'
  ) then
    alter table action_requests
      add constraint action_requests_reconciliation_decision_fkey
      foreign key (workspace_id, reconciliation_decision_id) references decisions (workspace_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'action_requests_reexecute_decision_fkey'
  ) then
    alter table action_requests
      add constraint action_requests_reexecute_decision_fkey
      foreign key (workspace_id, reexecute_decision_id) references decisions (workspace_id, id);
  end if;
end
$$;

create or replace function action_requests_reconciliation_guard() returns trigger
language plpgsql as $$
declare
  finding record;
begin
  if old.reconciliation_decision_id is not null
     and (new.reconciliation is distinct from old.reconciliation
          or new.reconciliation_decision_id is distinct from old.reconciliation_decision_id) then
    raise exception 'action_requests: a reconciliation is recorded once; a later decision about the step answers a wrong one';
  end if;
  if old.reexecute_decision_id is not null
     and new.reexecute_decision_id is distinct from old.reexecute_decision_id then
    raise exception 'action_requests: a re-execute decision is recorded once';
  end if;

  if (old.reconciliation_decision_id is null and new.reconciliation_decision_id is not null)
     or (old.reexecute_decision_id is null and new.reexecute_decision_id is not null) then
    if new.status is distinct from 'failed' or new.failure_kind is distinct from 'outcome_unknown' then
      raise exception 'action_requests: only a failed request whose outcome is unknown is reconciled';
    end if;
  end if;

  if old.reconciliation_decision_id is null and new.reconciliation_decision_id is not null then
    select d.decided_by, d.rationale into finding
      from decisions d
     where d.workspace_id = new.workspace_id and d.id = new.reconciliation_decision_id;
    if finding.rationale ->> 'actionRequestId' is distinct from new.id::text
       or finding.rationale ->> 'decision' is distinct from 'reconcile'
       or finding.rationale ->> 'verdict' is distinct from new.reconciliation then
      raise exception 'action_requests: the reconciliation Decision must name this request and its finding';
    end if;
    if finding.decided_by is null then
      if finding.rationale ->> 'basis' is distinct from 'observation' then
        raise exception 'action_requests: a reconciliation nobody decided must come from an observation';
      end if;
    elsif not exists (
      select 1 from principals p
       where p.workspace_id = new.workspace_id and p.id = finding.decided_by
         and p.kind = 'human' and p.disabled_at is null
         and (p.id = new.on_behalf_of or p.role = 'owner')
    ) then
      raise exception 'action_requests: only the requester or a workspace owner, as a person, reconciles a request';
    end if;
  end if;

  if old.reexecute_decision_id is null and new.reexecute_decision_id is not null then
    if not exists (
      select 1 from decisions d
        join principals p on p.workspace_id = d.workspace_id and p.id = d.decided_by
       where d.workspace_id = new.workspace_id and d.id = new.reexecute_decision_id
         and d.rationale ->> 'actionRequestId' = new.id::text
         and d.rationale ->> 'decision' = 'reexecute'
         and p.id = new.on_behalf_of and p.kind = 'human' and p.disabled_at is null
    ) then
      raise exception 'action_requests: only the requester, as a person, decides to run a request again';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger action_requests_reconciliation_guard
  before update of reconciliation, reconciliation_decision_id, reexecute_decision_id
  on action_requests
  for each row execute function action_requests_reconciliation_guard();
