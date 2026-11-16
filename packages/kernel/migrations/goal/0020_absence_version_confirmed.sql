-- module: goal, version: 0020
--
-- 0020_absence_version_confirmed (legacy 496, #780 review). An absence check (`observe_absent`,
-- goal/0011) passes only on an Observation that carries who confirmed the Operation version's
-- answers that mean "does not exist", and when (`absentAnswersReview`, S11 「门确认不存在」 B-a):
-- `platform-observation.ts` copies them from the published version it asks. goal/0011's guards
-- (and goal/0019's redefinition of the goal's) check only that the Observation carries two
-- non-empty strings there; nothing tied them to a version that holds that confirmation. Now an
-- absence check passes only when a version of the Operation it calls — of that Gatekeeper, under
-- that name, published or since deprecated — records the same confirmation
-- (`absentAnswersReviewedBy` / `absentAnswersReviewedAt`, written by `publish_operation` and
-- frozen once the version left draft, core/0047).
--
--   1. `goal_absence_version_confirmed(workspace, call, review)` — whether such a version exists.
--      Deprecated counts: the version asked may be superseded between the call and the record,
--      and a revision is published with its live version's confirmation
--      (`publishOperationRevision`), so both hold the same one. A draft or a discarded version
--      never holds one (`registerOperationDraftObject` strips it). governance/0046 asks the same
--      of a reconciliation resting on a "not there" answer.
--   2. `goal_acceptance_checks_version_confirmed` and `step_acceptance_checks_version_confirmed`,
--      one on each acceptance check table, beside its guard and the I-AB1 trigger (goal/0012):
--      their own triggers, as goal/0012's are, so a later redefinition of a guard cannot drop
--      them. They fire on the transition the guards check the Observation on (an absence check
--      passing), and by name after the guard and the I-AB1 trigger, so a check either of those
--      refuses is still refused with its reason. They only add this condition.
--
-- The kernel's audit checker for I-G5 (`substrate/audit/goal-invariant-checks.ts`
-- `absenceConfirmed`) asks the same of every passed absence check at rest.
--
-- No backfill: nothing changes for a check already passed, and every product path records the
-- confirmation of the version it asked, which that version still holds. Rolling back
-- (docs/runbooks/release.md §6): the previous release writes the Observation the same way, so it
-- passes these triggers unchanged. Dropping the two triggers and the three functions undoes this.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0019.
select pg_advisory_xact_lock(7241000701);

create or replace function goal_absence_version_confirmed(
  p_workspace_id uuid, p_call jsonb, p_review jsonb
) returns boolean
language sql stable as $$
  select jsonb_typeof(p_review -> 'reviewedBy') = 'string'
     and jsonb_typeof(p_review -> 'reviewedAt') = 'string'
     and exists (
       select 1 from objects op
        where op.workspace_id = p_workspace_id
          and op.object_type = 'Operation'
          and op.identity_key ->> 'gatekeeperId' = p_call ->> 'gatekeeperId'
          and op.identity_key ->> 'name' = p_call ->> 'operation'
          and op.properties ->> 'status' in ('published', 'deprecated')
          and op.properties ->> 'absentAnswersReviewedBy' = p_review ->> 'reviewedBy'
          and op.properties ->> 'absentAnswersReviewedAt' = p_review ->> 'reviewedAt')
$$;

create or replace function goal_acceptance_checks_version_confirmed() returns trigger
language plpgsql as $$
begin
  if not coalesce(goal_absence_version_confirmed(
       new.workspace_id, new.observation_check,
       (select o.content -> 'absentAnswersReview' from observations o
         where o.workspace_id = new.workspace_id and o.id = new.observation_id)), false) then
    raise exception 'goal_acceptance_checks: an absence check passes only under the confirmation a version of its Operation records — who confirmed that version''s "does not exist" answers, and when (legacy 496)';
  end if;
  return new;
end;
$$;

create or replace trigger goal_acceptance_checks_version_confirmed
  before update on goal_acceptance_checks
  for each row
  when (new.status = 'passed' and new.kind = 'observe_absent')
  execute function goal_acceptance_checks_version_confirmed();

create or replace function step_acceptance_checks_version_confirmed() returns trigger
language plpgsql as $$
begin
  if not coalesce(goal_absence_version_confirmed(
       new.workspace_id, new.observation_check,
       (select o.content -> 'absentAnswersReview' from observations o
         where o.workspace_id = new.workspace_id and o.id = new.observation_id)), false) then
    raise exception 'step_acceptance_checks: an absence check passes only under the confirmation a version of its Operation records — who confirmed that version''s "does not exist" answers, and when (legacy 496)';
  end if;
  return new;
end;
$$;

create or replace trigger step_acceptance_checks_version_confirmed
  before update on step_acceptance_checks
  for each row
  when (new.status = 'passed' and new.kind = 'observe_absent')
  execute function step_acceptance_checks_version_confirmed();
