-- module: goal, version: 0011
--
-- 0011_absence_acceptance (S11 「门确认不存在」 B, after part A's typed gate absence). An
-- acceptance check the platform makes — the goal's (`goal_acceptance_checks`, goal/0005) or a
-- step's (`step_acceptance_checks`, goal/0006) — may be met by the gate confirming that the thing
-- looked up is not there (`observe_absent`, `application/goal/plan.ts`), for a goal or a step that
-- deletes or removes something. Its row carries the call (`observation_check`: Gatekeeper,
-- Operation, params) and no predicate: nothing in a result can say a thing is not there. The only
-- evidence is the gate's own `absent` answer, which the kernel takes only when the published
-- Operation declares that answer means "does not exist" (`adapters/gatekeeper-client`
-- `gateAbsenceOf`, part A) and records on the check's Observation without a predicate
-- (`application/goal/platform-observation.ts`). What that means for the schema:
--
--   * the kind CHECKs take the new kind; the shape CHECKs tell the two observation kinds apart by
--     their call — an `observe_predicate` call carries its predicate (`expect`), an
--     `observe_absent` call none; the goal checks' evidence CHECK and the executor's due index
--     count it with the checks the platform makes;
--   * `goal_acceptance_checks_guard` matches a new `observe_absent` row against the plan's
--     declaration by its call, like an `observe_predicate` one (`step_acceptance_checks_guard`
--     already matches every observation by its call);
--   * both guards pass an `observe_absent` check only on an Observation of that check, recorded
--     with the gate's `absent` and without a predicate, of the Gatekeeper and Operation the check
--     calls, carrying who confirmed that version's answers and when (`absentAnswersReview`, B-a:
--     the kernel asks only a version a person confirmed, and records the confirmation it asked
--     under), whose outcome is `satisfied`; and an
--     `observe_predicate` check only on one that judged its predicate and recorded no absence (its
--     predicate is judged on null there, which no predicate the lint accepts is met by — the
--     schema now says so too);
--   * `goal_runs_status_guard` (as in goal/0007) counts an absence check as a check the platform
--     made (I-G5).
--
-- The functions are redefined whole; nothing else in them changes. No backfill: every existing row
-- is an `observe_predicate` whose call carries its predicate (the plan's schema requires one, and a
-- row matches its plan's declaration), a `fact_predicate` or a `requester_confirm`, so the new
-- CHECKs hold for them.
--
-- Rolling back (docs/runbooks/release.md §6): the previous release, v0.49.0, has no goal code, so
-- nothing reads or writes these tables; no release with the goal acceptance checks (GO4) but
-- without this one has been applied to a host. A release between the two would never claim an
-- `observe_absent` row (its scans list the kinds it knows), and its plan schema refuses a plan
-- declaring one, so its advance pauses such a goal for a person (`needs_decision`: the step's plan
-- entry, or the revision's acceptance, is unreadable) rather than act on it; resuming it waits
-- for this release.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0010.
select pg_advisory_xact_lock(7241000701);

-- ----- a goal's checks ------------------------------------------------------------------------

alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_kind,
  add constraint goal_acceptance_checks_kind
    check (kind in ('observe_predicate', 'observe_absent', 'fact_predicate', 'requester_confirm'));

-- An observation carries its call — with its predicate, or none for an absence — a fact check its
-- `fact`, and neither a prompt or a decision; a confirmation its prompt, and is never tried,
-- observed or judged on a Fact.
alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_shape,
  add constraint goal_acceptance_checks_shape check (
    case kind
      when 'observe_predicate' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and observation_check ? 'expect'
        and fact_check is null and fact_id is null and prompt is null and decision_id is null
      when 'observe_absent' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and not (observation_check ? 'expect')
        and fact_check is null and fact_id is null and prompt is null and decision_id is null
      when 'fact_predicate' then
        fact_check is not null and jsonb_typeof(fact_check) = 'object'
        and observation_check is null and observation_id is null and prompt is null
        and decision_id is null
      else
        observation_check is null and fact_check is null and prompt is not null
        and char_length(prompt) > 0 and attempts = 0 and observation_id is null
        and fact_id is null and last_error is null
    end
  );

alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_evidence,
  add constraint goal_acceptance_checks_evidence check (
    (status <> 'failed'
     or (case kind when 'fact_predicate' then fact_id is not null
                   else observation_id is not null end))
    and (status not in ('failed', 'unavailable')
         or kind in ('observe_predicate', 'observe_absent', 'fact_predicate'))
    and (status <> 'passed'
         or (case kind when 'observe_predicate' then observation_id is not null
                       when 'observe_absent' then observation_id is not null
                       when 'fact_predicate' then fact_id is not null
                       else decision_id is not null end))
  );

-- The executor's scan: due pending checks the platform makes, oldest first.
drop index if exists goal_acceptance_checks_due_idx;
create index if not exists goal_acceptance_checks_due_idx
  on goal_acceptance_checks (next_attempt_at)
  where status = 'pending' and kind in ('observe_predicate', 'observe_absent', 'fact_predicate');

create or replace function goal_acceptance_checks_guard() returns trigger
language plpgsql as $$
declare
  goal record;
  latest_round int;
begin
  select g.status, g.current_revision, g.on_behalf_of into goal
    from goal_runs g
   where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;
  select max(c.round) into latest_round
    from goal_acceptance_checks c
   where c.workspace_id = new.workspace_id and c.goal_run_id = new.goal_run_id;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0 or new.lease_until is not null
       or new.observation_id is not null or new.fact_id is not null
       or new.decision_id is not null or new.last_error is not null then
      raise exception 'goal_acceptance_checks: a check is created pending and untried';
    end if;
    if goal.status is distinct from 'verifying'
       or goal.current_revision is distinct from new.plan_revision then
      raise exception 'goal_acceptance_checks: a round is opened while its goal run is verifying, on the plan in force';
    end if;
    if not exists (
      select 1
        from jsonb_array_elements(goal_declared_acceptance(
               new.workspace_id, new.goal_run_id, new.plan_revision)) d
       where d ->> 'key' = new.check_key and d ->> 'kind' = new.kind
         and (case new.kind
                when 'observe_predicate' then d -> 'check' = new.observation_check
                when 'observe_absent' then d -> 'check' = new.observation_check
                when 'fact_predicate' then d -> 'fact' = new.fact_check
                else d ->> 'prompt' = new.prompt
              end)) then
      raise exception 'goal_acceptance_checks: a check is one of the acceptance checks its plan declares, as declared — with none declared, the requester''s confirmation of the goal';
    end if;
    if latest_round is not null and new.round < latest_round then
      raise exception 'goal_acceptance_checks: no check is added to a round older than round %', latest_round;
    end if;
    return new;
  end if;

  if (new.workspace_id, new.goal_run_id, new.round, new.check_key, new.plan_revision, new.kind,
      new.observation_check, new.fact_check, new.prompt, new.created_at)
     is distinct from
     (old.workspace_id, old.goal_run_id, old.round, old.check_key, old.plan_revision, old.kind,
      old.observation_check, old.fact_check, old.prompt, old.created_at) then
    raise exception 'goal_acceptance_checks: what a check verifies, and for which round, never changes';
  end if;
  if old.status <> 'pending' then
    raise exception 'goal_acceptance_checks: a settled check is not changed';
  end if;
  if new.attempts < old.attempts then
    raise exception 'goal_acceptance_checks: attempts only grow';
  end if;
  if old.first_attempt_at is not null
     and new.first_attempt_at is distinct from old.first_attempt_at then
    raise exception 'goal_acceptance_checks: when the first attempt was made never changes';
  end if;
  if old.decision_id is not null or (new.decision_id is not null and new.status <> 'passed') then
    raise exception 'goal_acceptance_checks: the requester''s decision is written as the confirmation passes';
  end if;

  if new.status = 'superseded' then
    if goal.status = 'verifying' and new.round >= latest_round then
      raise exception 'goal_acceptance_checks: a check of the current round is superseded only once its goal run left verifying';
    end if;
  elsif new.status <> 'pending' then
    if goal.status is distinct from 'verifying' or new.round < latest_round then
      raise exception 'goal_acceptance_checks: a check settles only in the current round of a verifying goal run';
    end if;
  end if;

  if new.status = 'passed' and new.kind = 'observe_predicate' and not exists (
    select 1 from observations o
     where o.workspace_id = new.workspace_id and o.id = new.observation_id
       and o.content ->> 'purpose' = 'acceptance_check'
       and o.content ->> 'goalRunId' = new.goal_run_id::text
       and o.content ->> 'round' = new.round::text
       and o.content ->> 'checkKey' = new.check_key
       and o.content ->> 'outcome' = 'satisfied'
       and o.content ? 'expect' and not (o.content ? 'absent')
  ) then
    raise exception 'goal_acceptance_checks: an observation passes only on an Observation of this check that satisfied its predicate';
  end if;
  if new.status = 'passed' and new.kind = 'observe_absent' and not exists (
    select 1 from observations o
     where o.workspace_id = new.workspace_id and o.id = new.observation_id
       and o.content ->> 'purpose' = 'acceptance_check'
       and o.content ->> 'goalRunId' = new.goal_run_id::text
       and o.content ->> 'round' = new.round::text
       and o.content ->> 'checkKey' = new.check_key
       and o.content ->> 'outcome' = 'satisfied'
       and o.content ? 'absent' and not (o.content ? 'expect')
       and o.content ->> 'gatekeeperId' = new.observation_check ->> 'gatekeeperId'
       and o.content ->> 'operation' = new.observation_check ->> 'operation'
       and jsonb_typeof(o.content #> '{absentAnswersReview,reviewedBy}') = 'string'
       and jsonb_typeof(o.content #> '{absentAnswersReview,reviewedAt}') = 'string'
       and o.content #>> '{absentAnswersReview,reviewedBy}' <> ''
       and o.content #>> '{absentAnswersReview,reviewedAt}' <> ''
  ) then
    raise exception 'goal_acceptance_checks: an absence check passes only on an Observation of this check in which the gate confirmed the thing is not there, under an Operation version whose answers a person confirmed';
  end if;
  if new.status = 'passed' and new.kind = 'fact_predicate' and not coalesce(goal_fact_admissible(
       new.workspace_id, new.goal_run_id, new.fact_id, new.fact_check, new.created_at), false) then
    raise exception 'goal_acceptance_checks: a fact check passes only on a Fact that may serve as its evidence — the one it names, observed since its round opened, not by this goal''s own doing';
  end if;
  if new.status = 'failed' and new.kind = 'fact_predicate'
     and not coalesce(goal_fact_is(new.workspace_id, new.fact_id, new.fact_check), false) then
    raise exception 'goal_acceptance_checks: a fact check fails only on a Fact it saw of the Link it names';
  end if;
  if new.status = 'passed' and new.kind = 'requester_confirm' and not exists (
    select 1 from decisions d
     where d.workspace_id = new.workspace_id and d.id = new.decision_id
       and d.decided_by = goal.on_behalf_of and d.status = 'approved'
       and d.rationale ->> 'decision' = 'goal_outcome'
       and d.rationale ->> 'outcome' = 'achieved'
       and d.rationale ->> 'goalRunId' = new.goal_run_id::text
       and d.rationale ->> 'round' = new.round::text
       and d.rationale ->> 'checkKey' = new.check_key
  ) then
    raise exception 'goal_acceptance_checks: a confirmation passes only on the requester''s own decision for this check';
  end if;
  return new;
end;
$$;

-- ----- a step's checks ------------------------------------------------------------------------

alter table step_acceptance_checks
  drop constraint if exists step_acceptance_checks_kind,
  add constraint step_acceptance_checks_kind
    check (kind in ('observe_predicate', 'observe_absent', 'fact_predicate'));

alter table step_acceptance_checks
  drop constraint if exists step_acceptance_checks_shape,
  add constraint step_acceptance_checks_shape check (
    case kind
      when 'observe_predicate' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and observation_check ? 'expect'
        and fact_check is null and fact_id is null
      when 'observe_absent' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and not (observation_check ? 'expect')
        and fact_check is null and fact_id is null
      else
        fact_check is not null and jsonb_typeof(fact_check) = 'object'
        and observation_check is null and observation_id is null
    end
  );

create or replace function step_acceptance_checks_guard() returns trigger
language plpgsql as $$
declare
  step record;
  goal_status text;
  latest_round int;
  open boolean;
begin
  select s.goal_run_id, s.step_key, s.status, s.waiting_reason, s.attempt_count,
         s.introduced_in_revision
    into step
    from step_runs s
   where s.workspace_id = new.workspace_id and s.id = new.step_run_id;
  select g.status into goal_status
    from goal_runs g
   where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;
  select max(c.round) into latest_round
    from step_acceptance_checks c
   where c.workspace_id = new.workspace_id and c.step_run_id = new.step_run_id;
  -- Whether the step's verification at this attempt is open: the step waits on it, at the
  -- attempt the row verifies, in a running run.
  open := step.status = 'waiting' and step.waiting_reason = 'acceptance'
          and step.attempt_count = new.step_attempt and goal_status = 'running';

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0 or new.lease_until is not null
       or new.observation_id is not null or new.fact_id is not null
       or new.last_error is not null then
      raise exception 'step_acceptance_checks: a check is created pending and untried';
    end if;
    if not coalesce(open, false) then
      raise exception 'step_acceptance_checks: a round is opened while its step waits on its acceptance, at its current attempt, in a running goal run';
    end if;
    if new.plan_revision is distinct from step.introduced_in_revision
       or not exists (
         select 1
           from jsonb_array_elements(step_declared_acceptance(
                  new.workspace_id, new.goal_run_id, step.introduced_in_revision, step.step_key)) d
          where d ->> 'key' = new.check_key and d ->> 'kind' = new.kind
            and (case new.kind
                   when 'fact_predicate' then d -> 'fact' = new.fact_check
                   else d -> 'check' = new.observation_check
                 end)) then
      raise exception 'step_acceptance_checks: a check is one of its step''s declared acceptance checks, as declared';
    end if;
    if latest_round is not null and new.round < latest_round then
      raise exception 'step_acceptance_checks: no check is added to a round older than round %', latest_round;
    end if;
    return new;
  end if;

  if (new.workspace_id, new.goal_run_id, new.step_run_id, new.step_attempt, new.round,
      new.check_key, new.plan_revision, new.kind, new.observation_check, new.fact_check,
      new.created_at)
     is distinct from
     (old.workspace_id, old.goal_run_id, old.step_run_id, old.step_attempt, old.round,
      old.check_key, old.plan_revision, old.kind, old.observation_check, old.fact_check,
      old.created_at) then
    raise exception 'step_acceptance_checks: what a check verifies, and for which round, never changes';
  end if;
  if old.status <> 'pending' then
    raise exception 'step_acceptance_checks: a settled check is not changed';
  end if;
  if new.attempts < old.attempts then
    raise exception 'step_acceptance_checks: attempts only grow';
  end if;
  if old.first_attempt_at is not null
     and new.first_attempt_at is distinct from old.first_attempt_at then
    raise exception 'step_acceptance_checks: when the first attempt was made never changes';
  end if;

  if new.status = 'superseded' then
    if coalesce(open, false) and new.round >= latest_round then
      raise exception 'step_acceptance_checks: a check of the current round is superseded only once its round ended';
    end if;
  elsif new.status <> 'pending' then
    if not coalesce(open, false) or new.round < latest_round then
      raise exception 'step_acceptance_checks: a check settles only in the current round of a step waiting on its acceptance';
    end if;
  end if;

  if new.status = 'passed' and new.kind = 'observe_predicate' and not exists (
    select 1 from observations o
     where o.workspace_id = new.workspace_id and o.id = new.observation_id
       and o.content ->> 'purpose' = 'step_acceptance_check'
       and o.content ->> 'goalRunId' = new.goal_run_id::text
       and o.content ->> 'stepRunId' = new.step_run_id::text
       and o.content ->> 'round' = new.round::text
       and o.content ->> 'checkKey' = new.check_key
       and o.content ->> 'outcome' = 'satisfied'
       and o.content ? 'expect' and not (o.content ? 'absent')
  ) then
    raise exception 'step_acceptance_checks: a check passes only on an Observation of this check that satisfied its predicate';
  end if;
  if new.status = 'passed' and new.kind = 'observe_absent' and not exists (
    select 1 from observations o
     where o.workspace_id = new.workspace_id and o.id = new.observation_id
       and o.content ->> 'purpose' = 'step_acceptance_check'
       and o.content ->> 'goalRunId' = new.goal_run_id::text
       and o.content ->> 'stepRunId' = new.step_run_id::text
       and o.content ->> 'round' = new.round::text
       and o.content ->> 'checkKey' = new.check_key
       and o.content ->> 'outcome' = 'satisfied'
       and o.content ? 'absent' and not (o.content ? 'expect')
       and o.content ->> 'gatekeeperId' = new.observation_check ->> 'gatekeeperId'
       and o.content ->> 'operation' = new.observation_check ->> 'operation'
       and jsonb_typeof(o.content #> '{absentAnswersReview,reviewedBy}') = 'string'
       and jsonb_typeof(o.content #> '{absentAnswersReview,reviewedAt}') = 'string'
       and o.content #>> '{absentAnswersReview,reviewedBy}' <> ''
       and o.content #>> '{absentAnswersReview,reviewedAt}' <> ''
  ) then
    raise exception 'step_acceptance_checks: an absence check passes only on an Observation of this check in which the gate confirmed the thing is not there, under an Operation version whose answers a person confirmed';
  end if;
  if new.status = 'passed' and new.kind = 'fact_predicate' and not coalesce(goal_fact_admissible(
       new.workspace_id, new.goal_run_id, new.fact_id, new.fact_check, new.created_at), false) then
    raise exception 'step_acceptance_checks: a fact check passes only on a Fact that may serve as its evidence — the one it names, observed since its round opened, not by this goal''s own doing';
  end if;
  if new.status = 'failed' and new.kind = 'fact_predicate'
     and not coalesce(goal_fact_is(new.workspace_id, new.fact_id, new.fact_check), false) then
    raise exception 'step_acceptance_checks: a fact check fails only on a Fact it saw of the Link it names';
  end if;
  return new;
end;
$$;

-- ----- what an outcome rests on ---------------------------------------------------------------

-- goal_runs_status_guard as in goal/0007, an absence the platform observed counting as a check it
-- made.
create or replace function goal_runs_status_guard() returns trigger
language plpgsql as $$
declare
  changed text;
  new_base int;
  latest_round int;
  declared jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'goal_runs: a goal run is created proposed, not %', new.status;
    end if;
    return new;
  end if;

  changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array[
    'status', 'pause_reason', 'cleanup_pending', 'outcome', 'outcome_basis', 'current_revision',
    'budget_max_tokens', 'budget_max_steps', 'budget_max_revisions',
    'budget_max_wall_clock_seconds', 'updated_at', 'confirmed_at', 'ended_at', 'next_tick_at',
    'paused_by', 'paused_by_authority', 'advance_failures', 'outcome_decision_id']);
  if changed is not null then
    raise exception 'goal_runs: the requester, the originating turn, the statement and created_at never change (%)',
      changed;
  end if;
  if new.status is distinct from old.status
     and not goal_run_transition_allowed(old.status, new.status) then
    raise exception 'goal_runs: illegal transition % -> %', old.status, new.status;
  end if;

  if old.status in ('completed', 'cancelled', 'failed') then
    changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array['updated_at', 'cleanup_pending']);
    if changed is not null then
      raise exception 'goal_runs: a % goal run is final; % cannot change', old.status, changed;
    end if;
    if new.cleanup_pending and not old.cleanup_pending then
      raise exception 'goal_runs: cleanup_pending is set by the transition into cancelled and only clears afterwards';
    end if;
    return new;
  end if;

  if old.status = 'paused' and new.status = 'paused'
     and new.pause_reason is distinct from old.pause_reason then
    raise exception 'goal_runs: the pause reason is set by the transition into paused (% -> %)',
      old.pause_reason, new.pause_reason;
  end if;

  -- goal/0004: while paused, who paused changes only to place a workspace owner's hold or to lift
  -- one; a run an owner holds does not resume until an owner lifts the hold. (`is not distinct
  -- from`: an advancer's pause names nobody, and a null must not make a refusal pass.)
  if old.status = 'paused' and new.status = 'paused'
     and (new.paused_by, new.paused_by_authority) is distinct from (old.paused_by, old.paused_by_authority)
     and not (new.paused_by_authority is not distinct from 'owner'
              and old.paused_by_authority is distinct from 'owner')
     and not (old.paused_by_authority is not distinct from 'owner' and new.paused_by is null) then
    raise exception 'goal_runs: while paused, who paused changes only to place an owner''s hold or to lift it (% -> %)',
      coalesce(old.paused_by_authority, 'advancer'), coalesce(new.paused_by_authority, 'advancer');
  end if;
  if old.status = 'paused' and new.status = 'running' and old.paused_by_authority = 'owner' then
    raise exception 'goal_runs: a workspace owner holds this goal run; it resumes only after an owner lifts the hold';
  end if;

  if new.current_revision is distinct from old.current_revision then
    if new.current_revision is null or new.current_revision < old.current_revision then
      raise exception 'goal_runs: the current revision never goes back (% -> %) (I-G2)',
        old.current_revision, new.current_revision;
    end if;
    if old.status not in ('proposed', 'running', 'paused') or new.status not in ('running', 'paused') then
      raise exception 'goal_runs: a revision takes effect only while the goal run is proposed, running or paused (% -> %)',
        old.status, new.status;
    end if;
    select pr.based_on_revision into new_base
      from plan_revisions pr
     where pr.workspace_id = new.workspace_id
       and pr.goal_run_id = new.id
       and pr.revision = new.current_revision
       and pr.status = 'accepted';
    if not found then
      raise exception 'goal_runs: revision % is not an accepted revision of this goal run (I-G2)',
        new.current_revision;
    end if;
    if new_base is distinct from old.current_revision then
      raise exception 'goal_runs: revision % is based on %, not on the current revision % (I-G3)',
        new.current_revision, coalesce(new_base::text, 'none'), coalesce(old.current_revision::text, 'none');
    end if;
  end if;

  if old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'goal_runs: confirmed_at is written once';
  end if;

  if (new.budget_max_tokens, new.budget_max_steps, new.budget_max_revisions, new.budget_max_wall_clock_seconds)
       is distinct from
     (old.budget_max_tokens, old.budget_max_steps, old.budget_max_revisions, old.budget_max_wall_clock_seconds)
     and old.status <> 'proposed'
     and new.current_revision is not distinct from old.current_revision then
    raise exception 'goal_runs: the budget changes before confirmation or with the revision that takes effect (I-G6)';
  end if;

  -- goal/0005: what a completed run's objective outcome rests on (I-G5). `achieved` by check only
  -- out of `verifying`, with every acceptance check of the run's latest round passed — at least
  -- one of them a check the platform made, an observation (goal/0011: an absence too) or a Fact
  -- (goal/0007) — on the current
  -- plan, and none it declares missing from that round (goal/0007); any outcome on the
  -- requester's word only with their own Decision saying so; `reviewer_assessed` not yet (W4). A
  -- missing or unknown basis is left to the CHECKs (`goal_runs_outcome`, the column's own).
  if new.outcome_decision_id is distinct from old.outcome_decision_id
     and not (new.status = 'completed' and old.status <> 'completed') then
    raise exception 'goal_runs: the outcome decision is written with the outcome, once';
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    if new.outcome_basis = 'verified_by_check' then
      if new.outcome <> 'achieved' or old.status <> 'verifying' or new.outcome_decision_id is not null then
        raise exception 'goal_runs: only verification achieves a goal by check — out of verifying, with no person''s decision (I-G5)';
      end if;
      select max(c.round) into latest_round
        from goal_acceptance_checks c
       where c.workspace_id = new.workspace_id and c.goal_run_id = new.id;
      if latest_round is null
         or exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round
              and (c.status <> 'passed' or c.plan_revision is distinct from new.current_revision))
         or not exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round
              and c.kind in ('observe_predicate', 'observe_absent', 'fact_predicate')) then
        raise exception 'goal_runs: achieved by check needs every acceptance check of the latest round passed on the current plan, at least one of them observed by the platform (I-G5)';
      end if;
      declared := goal_declared_acceptance(new.workspace_id, new.id, new.current_revision);
      if declared is null or exists (
        select 1 from jsonb_array_elements(declared) d
         where not exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round and c.check_key = d ->> 'key')) then
        raise exception 'goal_runs: achieved by check needs a check of the latest round for every acceptance check the current plan declares (I-G5)';
      end if;
    elsif new.outcome_basis = 'requester' then
      if new.outcome_decision_id is null or not exists (
        select 1 from decisions d
         where d.workspace_id = new.workspace_id and d.id = new.outcome_decision_id
           and d.decided_by = new.on_behalf_of and d.status = 'approved'
           and d.rationale ->> 'decision' = 'goal_outcome'
           and d.rationale ->> 'goalRunId' = new.id::text
           and d.rationale ->> 'outcome' = new.outcome) then
        raise exception 'goal_runs: an outcome on the requester''s word rests on their own decision saying so (I-G5)';
      end if;
    elsif new.outcome_basis = 'reviewer_assessed' then
      raise exception 'goal_runs: a reviewer_assessed outcome is not recorded yet';
    end if;
  end if;

  return new;
end;
$$;
