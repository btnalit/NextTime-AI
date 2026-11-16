-- module: governance, version: 0046
--
-- 0046_reconcile_absence_version_confirmed (legacy 496, with goal/0020). The platform's
-- `effect_seen` on a reconciled action that rests on the gate answering "not there"
-- (governance/0029) needs the Observation to carry who confirmed the Operation version's answers
-- that mean "does not exist", and when (`absentAnswersReview`, S11 「门确认不存在」 B-a) — and,
-- like goal/0011's guards before goal/0020, checked only that it carries two non-empty strings.
-- `reconcile-check.ts` copies them from the published version it asks, exactly as an acceptance
-- check does, so the same rule holds here: the reconciliation passes only when a version of the
-- Operation the request's reconcile check calls, published or since deprecated, records that
-- same confirmation (`goal_absence_version_confirmed`, goal/0020).
--
-- `action_requests_reconciliation_version_confirmed` — on `action_requests`, beside
-- governance/0024's guard and governance/0029's I-AB1 trigger: its own trigger, firing on the
-- same transition as 0029's (a reconciliation written) and by name after it, so what 0029 refuses
-- is still refused with its reason. It looks at the same reconciliation 0029 does — one nobody
-- decided, resting on an Observation in which the gate answered "not there" — and only adds this
-- condition. A person's finding is theirs to make, on whatever they saw, as in 0029. The kernel's
-- audit checker (`substrate/audit/goal-invariant-checks.ts` `reconciled-absent-unbaselined`) asks
-- the same of every such reconciliation at rest.
--
-- No backfill: nothing changes for a reconciliation already written. Runner ordering: `goal`
-- sorts before `governance`, so goal/0020's function exists when this runs. Rolling back
-- (docs/runbooks/release.md §6): the previous release records the Observation the same way, so
-- its reconciliations pass this trigger unchanged. Dropping the trigger and its function undoes
-- this.
--
-- Cross-process bootstrap lock: same governance-module advisory lock key as every other file in
-- this module (core/0001_identity.sql's header comment has the full rationale).
select pg_advisory_xact_lock(7241000201);

create or replace function action_requests_reconciliation_version_confirmed() returns trigger
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
  if not coalesce(goal_absence_version_confirmed(
       new.workspace_id, declared, evidence -> 'absentAnswersReview'), false) then
    raise exception 'action_requests: the platform''s effect_seen on a "not there" answer rests on the confirmation a version of the reconcile check''s Operation records — who confirmed that version''s "does not exist" answers, and when (legacy 496)';
  end if;
  return new;
end;
$$;

create or replace trigger action_requests_reconciliation_version_confirmed
  before update on action_requests
  for each row
  when (old.reconciliation_decision_id is null and new.reconciliation_decision_id is not null)
  execute function action_requests_reconciliation_version_confirmed();
