-- module: governance, version: 0024
--
-- 0024_action_request_reconcile_checks (S11 GO3d:
-- docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.7 "结果未知", scenario S4).
--
-- A goal step may declare, for an action it raises, how the platform checks whether that action
-- took effect: an observe-class Operation and a predicate over its result
-- (`application/goal/plan.ts`, `reconcile`). When such an action ends `failed` + `outcome_unknown`,
-- the platform makes that observation itself instead of pausing the goal for a person first:
--
--   1. `action_request_reconcile_checks` — one row per request the platform checks: the declared
--      observation (copied from the step's plan entry when the check is created; the plan revision
--      is immutable, so this is a copy for the reader, not a second source), and where the check
--      stands (packages/shared enums.ts `ACTION_REQUEST_RECONCILE_CHECK_STATUS_VALUES`):
--      `pending` until it settles once into `seen` (the observation satisfied the predicate: the
--      platform recorded `effect_seen` on the request), `not_seen` (no observation showed the
--      effect by the last try), `unavailable` (refused, or no answer by the last try) or
--      `preempted` (a person recorded a finding first). `attempts`, `next_attempt_at` and
--      `lease_until` are the claim that keeps one kernel observing at a time
--      (`application/goal/reconcile-check.ts`); `first_attempt_at` when the first attempt was
--      claimed — the retries' duration cap counts from it; `observation_id` the latest
--      observation, the evidence `seen` and `not_seen` rest on (a pending check that observed
--      without seeing the effect keeps its latest too); `last_error` a short code for why it is
--      `unavailable` or was retried.
--      The guard: created `pending`, for a request whose outcome is unknown and that nobody has
--      reconciled; `first_attempt_at` set by the first claim and never changed; once settled,
--      frozen; `seen` only when the request carries the platform's `effect_seen` resting on this
--      check's observation, `preempted` only when it carries a finding.
--   2. The reconciliation guard of governance/0023, rebuilt with its "nobody decided" branch
--      narrowed (review #493 on #642): a Decision with no `decided_by` is the platform's
--      `effect_seen` only — never `effect_absent`, the platform does not record that an effect is
--      missing — `approved`, with the observation's Source as its `source_id`, and naming in
--      `rationale.observationId` an Observation of that Source about this request whose predicate
--      was satisfied (`content.actionRequestId`, `content.outcome = 'satisfied'`). A person's
--      Decision must say `rationale.basis = 'person'`. Everything else is governance/0023's,
--      unchanged.
--
-- Runner ordering: `goal` and `core` sort before `governance`; `action_requests` (0003) and
-- `observations` (core/0002) exist when this runs. Reversibility (release.md §6): the previous
-- release never reads or writes the new table; its reconciliations (GO3c) are people's, with
-- `basis = 'person'`, which the rebuilt guard accepts as before.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

create table if not exists action_request_reconcile_checks (
  workspace_id uuid not null,
  action_request_id uuid not null,
  status text not null default 'pending',
  observation_check jsonb not null,
  attempts int not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  observation_id uuid,
  last_error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (workspace_id, action_request_id),
  foreign key (workspace_id, action_request_id) references action_requests (workspace_id, id),
  foreign key (workspace_id, observation_id) references observations (workspace_id, id),
  constraint action_request_reconcile_checks_status
    check (status in ('pending', 'seen', 'not_seen', 'unavailable', 'preempted')),
  constraint action_request_reconcile_checks_attempts check (attempts >= 0),
  constraint action_request_reconcile_checks_first_attempt
    check ((attempts = 0) = (first_attempt_at is null)),
  constraint action_request_reconcile_checks_settled
    check ((status = 'pending') = (settled_at is null)),
  constraint action_request_reconcile_checks_lease check (status = 'pending' or lease_until is null),
  constraint action_request_reconcile_checks_evidence
    check (status not in ('seen', 'not_seen') or observation_id is not null),
  constraint action_request_reconcile_checks_shape
    check (jsonb_typeof(observation_check) = 'object'),
  constraint action_request_reconcile_checks_last_error
    check (last_error is null or char_length(last_error) <= 200)
);

-- The claim's scan: due pending checks, oldest first.
create index if not exists action_request_reconcile_checks_due_idx
  on action_request_reconcile_checks (next_attempt_at)
  where status = 'pending';

-- The observation compaction's reference probe (application/platform/compact-observations.ts,
-- condition (a)): an Observation a check settled on is never deleted.
create index if not exists action_request_reconcile_checks_observation_idx
  on action_request_reconcile_checks (workspace_id, observation_id)
  where observation_id is not null;

alter table action_request_reconcile_checks enable row level security;

drop policy if exists action_request_reconcile_checks_workspace_isolation
  on action_request_reconcile_checks;

-- Workspace-only, like action_requests (governance/0003): whoever may see the request may see how
-- the platform checked it.
create policy action_request_reconcile_checks_workspace_isolation
  on action_request_reconcile_checks
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on action_request_reconcile_checks to nexttime_app;

create or replace function action_request_reconcile_checks_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0 or new.lease_until is not null
       or new.observation_id is not null or new.last_error is not null then
      raise exception 'action_request_reconcile_checks: a check is created pending and untried';
    end if;
    if not exists (
      select 1 from action_requests a
       where a.workspace_id = new.workspace_id and a.id = new.action_request_id
         and a.status = 'failed' and a.failure_kind = 'outcome_unknown'
         and a.reconciliation is null and a.step_run_id is not null
    ) then
      raise exception 'action_request_reconcile_checks: only a goal step''s request whose outcome is unknown and that nobody reconciled is checked';
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.action_request_id is distinct from old.action_request_id
     or new.observation_check is distinct from old.observation_check
     or new.created_at is distinct from old.created_at then
    raise exception 'action_request_reconcile_checks: what a check observes, and for which request, never changes';
  end if;
  if old.status <> 'pending' then
    raise exception 'action_request_reconcile_checks: a settled check is not changed';
  end if;
  if new.attempts < old.attempts then
    raise exception 'action_request_reconcile_checks: attempts only grow';
  end if;
  if old.first_attempt_at is not null
     and new.first_attempt_at is distinct from old.first_attempt_at then
    raise exception 'action_request_reconcile_checks: when the first attempt was made never changes';
  end if;
  if new.status = 'seen' and not exists (
    select 1 from action_requests a
      join decisions d on d.workspace_id = a.workspace_id and d.id = a.reconciliation_decision_id
     where a.workspace_id = new.workspace_id and a.id = new.action_request_id
       and a.reconciliation = 'effect_seen' and d.decided_by is null
       and d.rationale ->> 'observationId' = new.observation_id::text
  ) then
    raise exception 'action_request_reconcile_checks: a check is seen only when the request carries the platform''s effect_seen from its observation';
  end if;
  if new.status = 'preempted' and not exists (
    select 1 from action_requests a
     where a.workspace_id = new.workspace_id and a.id = new.action_request_id
       and a.reconciliation is not null
  ) then
    raise exception 'action_request_reconcile_checks: a check is preempted only by a finding on the request';
  end if;
  return new;
end;
$$;

create or replace trigger action_request_reconcile_checks_guard
  before insert or update on action_request_reconcile_checks
  for each row execute function action_request_reconcile_checks_guard();

create or replace function action_requests_reconciliation_guard() returns trigger
language plpgsql as $$
declare
  finding record;
begin
  if tg_op = 'INSERT' then
    if new.reconciliation is not null or new.reconciliation_decision_id is not null
       or new.reexecute_decision_id is not null then
      raise exception 'action_requests: a request is created unreconciled; a finding and a re-execute decision are recorded on it afterwards';
    end if;
    return new;
  end if;

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
    select d.decided_by, d.rationale, d.status, d.source_id into finding
      from decisions d
     where d.workspace_id = new.workspace_id and d.id = new.reconciliation_decision_id;
    if finding.rationale ->> 'actionRequestId' is distinct from new.id::text
       or finding.rationale ->> 'decision' is distinct from 'reconcile'
       or finding.rationale ->> 'verdict' is distinct from new.reconciliation then
      raise exception 'action_requests: the reconciliation Decision must name this request and its finding';
    end if;
    if finding.decided_by is null then
      if finding.rationale ->> 'basis' is distinct from 'observation'
         or new.reconciliation is distinct from 'effect_seen'
         or finding.status is distinct from 'approved'
         or finding.source_id is null
         or not exists (
           select 1 from observations o
            where o.workspace_id = new.workspace_id
              and o.id::text = finding.rationale ->> 'observationId'
              and o.source_id = finding.source_id
              and o.content ->> 'actionRequestId' = new.id::text
              and o.content ->> 'outcome' = 'satisfied'
         ) then
        raise exception 'action_requests: a reconciliation nobody decided is the platform''s effect_seen, resting on an observation of this request that satisfied its predicate';
      end if;
    elsif finding.rationale ->> 'basis' is distinct from 'person' then
      raise exception 'action_requests: a reconciliation a person decided says so (basis person)';
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
