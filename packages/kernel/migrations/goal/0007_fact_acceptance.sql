-- module: goal, version: 0007
--
-- 0007_fact_acceptance (S11 GO4c: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.3
-- I-G5, §4.6; docs/global-roadmap-2026-10-16.md GO4). An acceptance check — the goal's
-- (`goal_acceptance_checks`, goal/0005) or a step's (`step_acceptance_checks`, goal/0006) — may
-- judge a Fact of the graph instead of making an observation (`fact_predicate`,
-- `application/goal/plan.ts`): the Link of a type between two Objects, and a predicate over its own
-- properties (none: the Fact being there is the check). The platform makes no call for it; it
-- reads the graph as the requester (`application/goal/fact-check.ts`). What may serve as evidence
-- is the database's to hold, here:
--
--   1. `goal_fact_admissible(workspace, goal run, fact, fact_check, since)` — whether a Fact may be
--      the evidence of a check of that goal run whose round opened at `since`: the Link the check
--      names (its type, and its two ends as the check names them — by id, or by ObjectType and
--      identity), active (neither superseded nor invalidated, inside its validity), `observed`
--      (written by a Source that observes, not asserted by a person or inferred by an agent), and
--      the Observation that last confirmed it (its latest, else its first) recorded at or after
--      `since`, through a Source the requester does not own, on an Activity that says it was not
--      this goal's doing:
--        - a gate's observe (`gatekeeper_observe`) on that gate's Source, whose Activity records
--          `triggeredByTaskId` (core/0046): JSON null — no Worker called it — or a Task outside
--          this goal run. An Activity without the record (from before this release) is not
--          evidence: "not recorded" is never read as "not this goal's";
--        - a gate's apply (`gatekeeper_apply`) on that gate's Source, of an ActionRequest neither
--          raised in a StepRun of this goal run nor by a WorkerRun of one of its Tasks;
--        - a submission to a Source (`ingest.submit_observations`) that is not a gate's.
--      Anything else is not evidence. A Worker acts for the requester, so "a Source the requester
--      does not own" keeps every submission a goal's Worker could make out, whatever Activity it
--      names; the trigger record keeps out a gate's observe a goal's Worker called; the request's
--      StepRun keeps out the goal's own actions. Rows the requester cannot see (RLS: a private
--      Source, a hidden Fact) are not evidence either. plpgsql: its body names `tasks`,
--      `action_requests` and `worker_runs` (task/0001, governance/0003; sorting after `goal`),
--      resolved when it runs.
--   2. Both tables take `fact_check` (the check's `fact`, copied from the plan) and `fact_id` (the
--      Fact a settled check rests on, the latest one seen while it is retried) — the counterpart of
--      `observation_check` / `observation_id`; a row carries one pair or the other, by `kind`. A
--      `failed` fact check rests on a Fact it saw, of the Link it names: something was seen and it
--      was not what was expected. An `unavailable` one saw no Fact that may serve as evidence by
--      its last try (`last_error` `fact_not_observed`), or was refused — the two never read alike.
--   3. The two guards (`goal_acceptance_checks_guard`, `step_acceptance_checks_guard`) as in
--      goal/0005 and goal/0006 plus: a fact check is created with no Fact, `fact_check` never
--      changes, a fact check passes only on a Fact `goal_fact_admissible` takes (as of now, for its
--      round), and fails only on a Fact of the Link it names — an answer that comes out unknown
--      (null) refuses. A step's fact check is one of its
--      declared checks as declared (`fact` in the plan entry).
--   4. `goal_runs_status_guard` as in goal/0005 with one change, its comments aside (compare with
--      goal/0005; the goal-schema integration test does): a goal achieved by check needs at least
--      one check of its latest round that the platform made — an observation or a Fact
--      (`fact_predicate`).
--
-- Runner ordering: `core` sorts before `goal`; `links`, `objects`, `observations`, `sources` and
-- `activities` exist when this runs. Reversibility (release.md §6): the previous release never
-- reads or writes the new columns and never writes a `fact_predicate` row (its plan schema refuses
-- the kind), so the wider CHECKs accept every row it writes and the rebuilt guards apply to its
-- rows as before. After a code-only rollback a `fact_predicate` row a later release left pending
-- stays pending — the previous release never claims one (its claim is for `observe_predicate`) —
-- so its run or step waits for the next release; its advance reads a plan holding one as
-- unreadable and pauses the run. Nothing is completed or succeeds on it: the guards still hold.
--
-- Cross-process bootstrap lock: the goal module's key (goal/0001).
select pg_advisory_xact_lock(7241000701);

-- Whether Object `p_object_id` is the one `p_ref` names: `{objectId}`, or `{objectType, identity}`
-- (the identity as `objects.identity_key` holds it).
create or replace function goal_fact_endpoint_is(p_workspace_id uuid, p_object_id uuid, p_ref jsonb)
returns boolean
language sql stable as $$
  select case
    when jsonb_typeof(p_ref -> 'objectId') = 'string' then
      p_object_id::text = lower(p_ref ->> 'objectId')
    when jsonb_typeof(p_ref -> 'objectType') = 'string'
         and jsonb_typeof(p_ref -> 'identity') = 'object' then
      exists (select 1 from objects o
               where o.workspace_id = p_workspace_id and o.id = p_object_id
                 and o.object_type = p_ref ->> 'objectType'
                 and o.identity_key = p_ref -> 'identity')
    else false
  end
$$;

-- Whether Fact `p_fact_id` is the Link `p_fact_check` names (its type and its two ends).
create or replace function goal_fact_is(p_workspace_id uuid, p_fact_id uuid, p_fact_check jsonb)
returns boolean
language sql stable as $$
  select coalesce((
    select l.link_type = p_fact_check ->> 'linkType'
           and goal_fact_endpoint_is(p_workspace_id, l.source_object_id, p_fact_check -> 'source')
           and goal_fact_endpoint_is(p_workspace_id, l.target_object_id, p_fact_check -> 'target')
      from links l
     where l.workspace_id = p_workspace_id and l.id = p_fact_id), false)
$$;

-- Whether Fact `p_fact_id` may be the evidence of a check of goal run `p_goal_run_id` whose round
-- opened at `p_since` — see the header, 1.
create or replace function goal_fact_admissible(
  p_workspace_id uuid, p_goal_run_id uuid, p_fact_id uuid, p_fact_check jsonb, p_since timestamptz
) returns boolean
language plpgsql stable as $$
declare
  requester uuid;
  fact record;
  seen record;
  ref text;
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_fact_id is null or p_fact_check is null or p_since is null then
    return false;
  end if;
  select g.on_behalf_of into requester
    from goal_runs g
   where g.workspace_id = p_workspace_id and g.id = p_goal_run_id;
  if requester is null or not goal_fact_is(p_workspace_id, p_fact_id, p_fact_check) then
    return false;
  end if;

  select l.epistemic_status, l.superseded_at, l.invalidated_at, l.valid_from, l.valid_until,
         coalesce(l.last_observation_id, l.observation_id) as observation_id
    into fact
    from links l
   where l.workspace_id = p_workspace_id and l.id = p_fact_id;
  if fact.superseded_at is not null or fact.invalidated_at is not null
     or fact.valid_from > now()
     or (fact.valid_until is not null and fact.valid_until <= now())
     or fact.epistemic_status is distinct from 'observed'
     or fact.observation_id is null then
    return false;
  end if;

  select o.created_at, s.kind as source_kind, s.owner_principal_id, a.kind as activity_kind,
         a.metadata
    into seen
    from observations o
    join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
    join activities a on a.workspace_id = o.workspace_id and a.id = o.activity_id
   where o.workspace_id = p_workspace_id and o.id = fact.observation_id;
  if not found or seen.created_at < p_since or seen.owner_principal_id = requester then
    return false;
  end if;

  if seen.activity_kind = 'gatekeeper_observe' then
    if seen.source_kind is distinct from 'gatekeeper' or not (seen.metadata ? 'triggeredByTaskId') then
      return false;
    end if;
    if jsonb_typeof(seen.metadata -> 'triggeredByTaskId') = 'null' then
      return true;
    end if;
    ref := seen.metadata ->> 'triggeredByTaskId';
    return coalesce(ref ~ uuid_shape, false) and exists (
      select 1 from tasks t
       where t.workspace_id = p_workspace_id and t.id = ref::uuid
         and t.goal_run_id is distinct from p_goal_run_id);
  elsif seen.activity_kind = 'gatekeeper_apply' then
    ref := seen.metadata ->> 'actionRequestId';
    if seen.source_kind is distinct from 'gatekeeper' or ref is null or ref !~ uuid_shape then
      return false;
    end if;
    return exists (
      select 1 from action_requests ar
       where ar.workspace_id = p_workspace_id and ar.id = ref::uuid
         and (ar.step_run_id is null or exists (
               select 1 from step_runs s
                where s.workspace_id = ar.workspace_id and s.id = ar.step_run_id
                  and s.goal_run_id <> p_goal_run_id))
         and (ar.parent_worker_run_id is null or exists (
               select 1 from worker_runs w
                 join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
                where w.workspace_id = ar.workspace_id and w.id = ar.parent_worker_run_id
                  and t.goal_run_id is distinct from p_goal_run_id)));
  elsif seen.activity_kind = 'ingest.submit_observations' then
    return seen.source_kind is distinct from 'gatekeeper';
  end if;
  return false;
end;
$$;

-- ----- the goal's checks ----------------------------------------------------------------------

alter table goal_acceptance_checks add column if not exists fact_check jsonb;
alter table goal_acceptance_checks add column if not exists fact_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'goal_acceptance_checks_fact_fk') then
    alter table goal_acceptance_checks add constraint goal_acceptance_checks_fact_fk
      foreign key (workspace_id, fact_id) references links (workspace_id, id);
  end if;
end
$$;

alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_kind,
  add constraint goal_acceptance_checks_kind
    check (kind in ('observe_predicate', 'fact_predicate', 'requester_confirm'));

-- An observation carries its check, a fact check its `fact`, and neither a prompt or a decision; a
-- confirmation its prompt, and is never tried, observed or judged on a Fact.
alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_shape,
  add constraint goal_acceptance_checks_shape check (
    case kind
      when 'observe_predicate' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
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
    and (status not in ('failed', 'unavailable') or kind in ('observe_predicate', 'fact_predicate'))
    and (status <> 'passed'
         or (case kind when 'observe_predicate' then observation_id is not null
                       when 'fact_predicate' then fact_id is not null
                       else decision_id is not null end))
  );

-- The executor's scan: due pending checks the platform makes, oldest first.
drop index if exists goal_acceptance_checks_due_idx;
create index if not exists goal_acceptance_checks_due_idx
  on goal_acceptance_checks (next_attempt_at)
  where status = 'pending' and kind in ('observe_predicate', 'fact_predicate');

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
  ) then
    raise exception 'goal_acceptance_checks: an observation passes only on an Observation of this check that satisfied its predicate';
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

alter table step_acceptance_checks alter column observation_check drop not null;
alter table step_acceptance_checks add column if not exists fact_check jsonb;
alter table step_acceptance_checks add column if not exists fact_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'step_acceptance_checks_fact_fk') then
    alter table step_acceptance_checks add constraint step_acceptance_checks_fact_fk
      foreign key (workspace_id, fact_id) references links (workspace_id, id);
  end if;
end
$$;

alter table step_acceptance_checks
  drop constraint if exists step_acceptance_checks_kind,
  add constraint step_acceptance_checks_kind
    check (kind in ('observe_predicate', 'fact_predicate'));

alter table step_acceptance_checks
  drop constraint if exists step_acceptance_checks_shape,
  add constraint step_acceptance_checks_shape check (
    case kind
      when 'observe_predicate' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and fact_check is null and fact_id is null
      else
        fact_check is not null and jsonb_typeof(fact_check) = 'object'
        and observation_check is null and observation_id is null
    end
  );

alter table step_acceptance_checks
  drop constraint if exists step_acceptance_checks_evidence,
  add constraint step_acceptance_checks_evidence check (
    status not in ('passed', 'failed')
    or (case kind when 'fact_predicate' then fact_id is not null
                  else observation_id is not null end)
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
  ) then
    raise exception 'step_acceptance_checks: a check passes only on an Observation of this check that satisfied its predicate';
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

-- goal_runs_status_guard as in goal/0005, a Fact the platform judged counting as a check it made.
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
  -- one of them a check the platform made, an observation or a Fact (goal/0007) — on the current
  -- plan; any outcome on the requester's word only with their own Decision saying so;
  -- `reviewer_assessed` not yet (W4). A missing or unknown basis is left to the CHECKs
  -- (`goal_runs_outcome`, the column's own).
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
              and c.round = latest_round and c.kind in ('observe_predicate', 'fact_predicate')) then
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
