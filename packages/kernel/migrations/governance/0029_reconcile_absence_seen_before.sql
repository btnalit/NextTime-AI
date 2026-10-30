-- module: governance, version: 0029
--
-- 0029_reconcile_absence_seen_before (S11 「门确认不存在」 reconcile, after B-c's baselines,
-- goal/0012). A goal step may now reconcile an action that removes something with an absence call
-- (`application/goal/plan.ts`, `reconcile`): when such an action ends `failed` + `outcome_unknown`,
-- the gate confirming the thing is not there is taken as the removal having taken effect, and the
-- platform records `effect_seen` (governance/0024). "Not there" says nothing about whether the
-- thing ever was — params that name something that never existed are answered so at once — so, as
-- for an absence acceptance check (I-AB1, goal/0012), it counts only against a baseline that saw
-- the thing first. A plan makes a reconcile absence call only as the call of an `observe_absent`
-- acceptance check of the step or of the goal, whose baseline the platform takes before the step
-- starts (`absence-baselines.ts`):
--
--   1. `action_request_absence_seen_before(workspace, request, call)` — whether the run of the
--      request's step has a `seen_present` baseline — of that step or of the goal — with exactly
--      `call`, on an Observation of it (the gate answered with data) older than the request itself:
--      the thing was there before the action was raised. `reconcile-check.ts` asks it before
--      calling the gate, and settles the check `unavailable` (`never_seen_present`) without a call
--      when it says no.
--   2. `action_requests_reconciliation_seen_before` — on `action_requests`, beside governance/0024's
--      `action_requests_reconciliation_guard` (its own trigger, so a later redefinition of that
--      guard cannot drop it; it fires after it, by name): a reconciliation nobody decided (the
--      platform's `effect_seen`) resting on an Observation in which the gate answered "not there"
--      must rest on the request's own reconcile check making an absence call (no predicate), of the
--      Gatekeeper and Operation the Observation records, under a version whose answers a person
--      confirmed (`absentAnswersReview`, B-a), with the baseline of (1). A person's finding is
--      theirs to make, on whatever they saw.
--
-- No backfill: no release has let a reconcile check make an absence call, so no request rests on
-- one. Runner ordering: `goal` sorts before `governance`; `step_runs` and `goal_absence_baselines`
-- (goal/0012) exist when this runs. Rolling back (docs/runbooks/release.md §6): the previous
-- release never writes a reconciliation on a "not there" answer, so the trigger never fires for it
-- and it needs nothing undone.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

create or replace function action_request_absence_seen_before(
  p_workspace_id uuid, p_action_request_id uuid, p_call jsonb
) returns boolean
language sql stable as $$
  select exists (
    select 1 from action_requests a
      join step_runs s on s.workspace_id = a.workspace_id and s.id = a.step_run_id
      join goal_absence_baselines b
        on b.workspace_id = s.workspace_id and b.goal_run_id = s.goal_run_id
      join observations o on o.workspace_id = b.workspace_id and o.id = b.observation_id
     where a.workspace_id = p_workspace_id and a.id = p_action_request_id
       and (b.step_key is null or b.step_key = s.step_key)
       and b.observation_check = p_call and b.status = 'seen_present'
       and o.content ->> 'purpose' = 'absence_baseline' and not (o.content ? 'absent')
       and o.created_at < a.requested_at)
$$;

create or replace function action_requests_reconciliation_seen_before() returns trigger
language plpgsql as $$
declare
  finding record;
  evidence jsonb;
  declared jsonb;
begin
  select d.decided_by, d.rationale into finding
    from decisions d
   where d.workspace_id = new.workspace_id and d.id = new.reconciliation_decision_id;
  if not found or finding.decided_by is not null then
    return new;
  end if;
  select o.content into evidence
    from observations o
   where o.workspace_id = new.workspace_id and o.id::text = finding.rationale ->> 'observationId';
  if evidence is null or not (evidence ? 'absent') then
    return new;
  end if;
  select c.observation_check into declared
    from action_request_reconcile_checks c
   where c.workspace_id = new.workspace_id and c.action_request_id = new.id;
  if declared is null or declared ? 'expect' or evidence ? 'expect'
     or evidence ->> 'gatekeeperId' is distinct from declared ->> 'gatekeeperId'
     or evidence ->> 'operation' is distinct from declared ->> 'operation'
     or jsonb_typeof(evidence #> '{absentAnswersReview,reviewedBy}') is distinct from 'string'
     or jsonb_typeof(evidence #> '{absentAnswersReview,reviewedAt}') is distinct from 'string'
     or not coalesce(action_request_absence_seen_before(new.workspace_id, new.id, declared), false)
  then
    raise exception 'action_requests: the platform''s effect_seen on a "not there" answer rests on the request''s own reconcile check making that absence call, under a version whose answers a person confirmed, and on an earlier baseline of the call that saw the thing before the action (I-AB1)';
  end if;
  return new;
end;
$$;

create or replace trigger action_requests_reconciliation_seen_before
  before update on action_requests
  for each row
  when (old.reconciliation_decision_id is null and new.reconciliation_decision_id is not null)
  execute function action_requests_reconciliation_seen_before();
