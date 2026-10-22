-- module: goal, version: 0005
--
-- 0005_goal_acceptance (S11 GO4a: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.3
-- I-G5, §3.4, §4.6; docs/global-roadmap-2026-10-16.md GO4; scenario S6). The goal's acceptance
-- checks — what the platform verifies, and the requester confirms, before a GoalRun is achieved:
--
--   1. `goal_acceptance_checks` — one row per check of a verification round. A round starts each
--      time the run enters `verifying` (every step done): one row per acceptance check of the plan
--      in force (`application/goal/plan.ts` `acceptance`; a plan without any has one implicit
--      `requester_confirm`), the check copied from the plan (the revision is immutable, so this is
--      a copy for the reader, not a second source). `observe_predicate` rows are the platform's
--      observations (`application/goal/acceptance-check.ts`): `attempts`, `next_attempt_at`,
--      `lease_until` and `first_attempt_at` are the claim and the retry caps, as for a reconcile
--      check (governance/0024); `observation_id` the latest observation, the evidence a settled
--      row rests on. `requester_confirm` rows wait for the requester: `decision_id` is their
--      Decision. Status: `pending` until it settles once into `passed` (the observation satisfied
--      the predicate; the requester confirmed), `failed` (no observation satisfied it by the last
--      try), `unavailable` (refused, or no answer by the last try) or `superseded` (the round
--      ended before the row settled: the run left `verifying` — paused, cancelled, completed — or
--      a newer round began). `last_error` a short code for why it is `unavailable` or was retried.
--      The guard: created `pending` and untried, while the run is `verifying` on the plan the row
--      names, never into a round older than the run's latest; settled once, then frozen; `passed`,
--      `failed` and `unavailable` only while the run is `verifying` and the row is in its latest
--      round; a passed observation rests on an Observation of this check that satisfied the
--      predicate, a passed confirmation on the requester's own Decision; `superseded` only once the
--      run left `verifying` or a newer round exists.
--   2. `goal_runs.outcome_decision_id` — the requester's Decision an outcome on their word rests on.
--   3. `goal_runs_status_guard` as in goal/0004, with `outcome_decision_id` among the columns that
--      may change and one block added before the end (compare with goal/0004; the goal-schema
--      integration test does): `achieved` by check (`verified_by_check`) only out of `verifying`,
--      with every check of the latest round passed on the current plan and at least one of them an
--      observation the platform made; an outcome on the requester's word (`requester`) only with
--      their own approved Decision naming this run and that outcome; `reviewer_assessed` is not
--      written yet (W4). Neither a step's Worker nor the entry agent can give an outcome (I-G5).
--
-- Runner ordering: `core` sorts before `goal`; `observations` and `decisions` (core/0002) exist
-- when this runs. Reversibility (release.md §6): the previous release never reads or writes the new
-- table or column, and never completes a GoalRun (it has no verification), so the rebuilt guard's
-- new block never applies to what it writes; its other writes pass the guard as before. A row it
-- leaves pending by moving a run out of `verifying` is superseded by the next release's executor.
--
-- Cross-process bootstrap lock: the goal module's key (goal/0001).
select pg_advisory_xact_lock(7241000701);

alter table goal_runs add column if not exists outcome_decision_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goal_runs_outcome_decision_fk') then
    alter table goal_runs add constraint goal_runs_outcome_decision_fk
      foreign key (workspace_id, outcome_decision_id) references decisions (workspace_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'goal_runs_outcome_decision') then
    alter table goal_runs add constraint goal_runs_outcome_decision
      check (outcome_decision_id is null or outcome_basis = 'requester');
  end if;
end
$$;

create table if not exists goal_acceptance_checks (
  workspace_id uuid not null,
  goal_run_id uuid not null,
  round int not null,
  check_key text not null,
  plan_revision int not null,
  kind text not null,
  observation_check jsonb,
  prompt text,
  status text not null default 'pending',
  attempts int not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  observation_id uuid,
  decision_id uuid,
  last_error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (workspace_id, goal_run_id, round, check_key),
  foreign key (workspace_id, goal_run_id) references goal_runs (workspace_id, id),
  foreign key (workspace_id, goal_run_id, plan_revision)
    references plan_revisions (workspace_id, goal_run_id, revision),
  foreign key (workspace_id, observation_id) references observations (workspace_id, id),
  foreign key (workspace_id, decision_id) references decisions (workspace_id, id),
  constraint goal_acceptance_checks_round check (round >= 1),
  constraint goal_acceptance_checks_key check (check_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint goal_acceptance_checks_kind check (kind in ('observe_predicate', 'requester_confirm')),
  constraint goal_acceptance_checks_status
    check (status in ('pending', 'passed', 'failed', 'unavailable', 'superseded')),
  constraint goal_acceptance_checks_attempts check (attempts >= 0),
  constraint goal_acceptance_checks_first_attempt
    check ((attempts = 0) = (first_attempt_at is null)),
  constraint goal_acceptance_checks_settled check ((status = 'pending') = (settled_at is null)),
  constraint goal_acceptance_checks_lease check (status = 'pending' or lease_until is null),
  -- An observation carries its check and no decision; a confirmation its prompt, and is never
  -- tried or observed.
  constraint goal_acceptance_checks_shape check (
    case kind
      when 'observe_predicate' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and prompt is null and decision_id is null
      else
        observation_check is null and prompt is not null and char_length(prompt) > 0
        and attempts = 0 and observation_id is null and last_error is null
    end
  ),
  constraint goal_acceptance_checks_evidence check (
    (status <> 'failed' or observation_id is not null)
    and (status not in ('failed', 'unavailable') or kind = 'observe_predicate')
    and (status <> 'passed' or (case kind when 'observe_predicate' then observation_id is not null
                                          else decision_id is not null end))
  ),
  constraint goal_acceptance_checks_last_error
    check (last_error is null or char_length(last_error) <= 200)
);

-- The executor's scan: due pending observations, oldest first.
create index if not exists goal_acceptance_checks_due_idx
  on goal_acceptance_checks (next_attempt_at)
  where status = 'pending' and kind = 'observe_predicate';

-- The observation compaction's reference probe (application/platform/compact-observations.ts,
-- condition (a)): an Observation a check rests on is never deleted.
create index if not exists goal_acceptance_checks_observation_idx
  on goal_acceptance_checks (workspace_id, observation_id)
  where observation_id is not null;

alter table goal_acceptance_checks enable row level security;
drop policy if exists goal_acceptance_checks_workspace_isolation on goal_acceptance_checks;
create policy goal_acceptance_checks_workspace_isolation on goal_acceptance_checks
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant, like goal_runs: a verification's history stays with its run.
grant select, insert, update on goal_acceptance_checks to nexttime_app;

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
       or new.observation_id is not null or new.decision_id is not null
       or new.last_error is not null then
      raise exception 'goal_acceptance_checks: a check is created pending and untried';
    end if;
    if goal.status is distinct from 'verifying'
       or goal.current_revision is distinct from new.plan_revision then
      raise exception 'goal_acceptance_checks: a round is opened while its goal run is verifying, on the plan in force';
    end if;
    if latest_round is not null and new.round < latest_round then
      raise exception 'goal_acceptance_checks: no check is added to a round older than round %', latest_round;
    end if;
    return new;
  end if;

  if (new.workspace_id, new.goal_run_id, new.round, new.check_key, new.plan_revision, new.kind,
      new.observation_check, new.prompt, new.created_at)
     is distinct from
     (old.workspace_id, old.goal_run_id, old.round, old.check_key, old.plan_revision, old.kind,
      old.observation_check, old.prompt, old.created_at) then
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
  ) then
    raise exception 'goal_acceptance_checks: an observation passes only on an Observation of this check that satisfied its predicate';
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

create or replace trigger goal_acceptance_checks_guard
  before insert or update on goal_acceptance_checks
  for each row execute function goal_acceptance_checks_guard();

-- goal_runs_status_guard as in goal/0004, with `outcome_decision_id` among the columns that may
-- change, and the outcome rules (I-G5) before the end.
create or replace function goal_runs_status_guard() returns trigger
language plpgsql as $$
declare
  changed text;
  new_base int;
  latest_round int;
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
  -- one of them an observation the platform made — on the current plan; any outcome on the
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
              and c.round = latest_round and c.kind = 'observe_predicate') then
        raise exception 'goal_runs: achieved by check needs every acceptance check of the latest round passed on the current plan, at least one of them observed by the platform (I-G5)';
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
