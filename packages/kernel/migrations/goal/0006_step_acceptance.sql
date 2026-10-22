-- module: goal, version: 0006
--
-- 0006_step_acceptance (S11 GO4b: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.4,
-- §4.5, §4.6; docs/global-roadmap-2026-10-16.md GO4). A step's own acceptance checks — what the
-- platform verifies once the step's work is done, before the step succeeds and the steps after it
-- may read its output:
--
--   1. `step_runs.waiting_reason` takes two more values: `acceptance` (the platform is making the
--      step's checks) and `acceptance_unavailable` (a check could not be made; the run is paused
--      and resuming it verifies the step again). A check that was made and did not pass fails the
--      step `verification_failed` (goal/0001) instead, so the two never read alike.
--   2. `step_acceptance_checks` — one row per check of a step's verification round. A round opens
--      each time the step starts waiting on its acceptance: after an attempt whose work is done
--      (`application/goal/advance.ts` phase A), and again when a paused run resumes for a step
--      whose round lost a check to the pause, never opened, or could not make one
--      (`acceptance_unavailable`); a round settled in full before the pause stands. Its rows are
--      the step's `acceptance` in the plan entry that defines the StepRun (the revision that
--      introduced it), copied for the reader; `step_attempt` the attempt whose work they verify.
--      The columns and the statuses are `goal_acceptance_checks`' (goal/0005) for an observation:
--      `pending` until it settles once into `passed`, `failed`, `unavailable` or `superseded`. The
--      guard: created `pending` and untried while the step waits on its acceptance at that attempt
--      in a running run, never into a round older than the step's latest, each row one of the
--      step's declared checks as declared; settled once, then frozen; `passed`, `failed` and
--      `unavailable` only while that still holds and the row is in the step's latest round; a
--      passed row rests on an Observation of this check that satisfied its predicate; `superseded`
--      only once the round ended (the step stopped waiting on it, the run stopped running, or a
--      newer round opened).
--   3. `step_runs_acceptance_guard`: a step whose plan entry declares acceptance checks succeeds
--      only out of `waiting(acceptance)`, with a row of its latest round for every declared check,
--      every one of them `passed` and made for its current attempt — never on its Worker's word
--      (§4.5: the steps after it read its output only then). A separate trigger, so
--      `step_runs_status_guard` (goal/0003) stays as it is.
--
-- Runner ordering: `core` sorts before `goal`; `observations` (core/0002) exists. Reversibility
-- (release.md §6): the previous release never reads or writes the new table, and its plans never
-- declare a step's acceptance (its plan schema refuses the field), so the new trigger never
-- applies to a step it moves; the wider CHECK accepts every value it writes. A step a later release
-- left waiting on its acceptance is one the previous release would mark succeeded — the new trigger
-- refuses that, the advance fails and the run pauses for a person after its failed advances in a
-- row (legacy 356), never succeeding unverified.
--
-- Cross-process bootstrap lock: the goal module's key (goal/0001).
select pg_advisory_xact_lock(7241000701);

alter table step_runs drop constraint if exists step_runs_waiting_reason_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'step_runs_waiting_reason_values') then
    alter table step_runs add constraint step_runs_waiting_reason_values check (
      waiting_reason in ('approval', 'reconcile', 'external', 'acceptance', 'acceptance_unavailable')
    );
  end if;
end
$$;

create table if not exists step_acceptance_checks (
  workspace_id uuid not null,
  goal_run_id uuid not null,
  step_run_id uuid not null,
  step_attempt int not null,
  round int not null,
  check_key text not null,
  plan_revision int not null,
  kind text not null,
  observation_check jsonb not null,
  status text not null default 'pending',
  attempts int not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  observation_id uuid,
  last_error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (workspace_id, step_run_id, round, check_key),
  foreign key (workspace_id, goal_run_id, step_run_id)
    references step_runs (workspace_id, goal_run_id, id),
  foreign key (workspace_id, goal_run_id, plan_revision)
    references plan_revisions (workspace_id, goal_run_id, revision),
  foreign key (workspace_id, observation_id) references observations (workspace_id, id),
  constraint step_acceptance_checks_round check (round >= 1),
  constraint step_acceptance_checks_step_attempt check (step_attempt >= 1),
  constraint step_acceptance_checks_key check (check_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint step_acceptance_checks_kind check (kind = 'observe_predicate'),
  constraint step_acceptance_checks_status
    check (status in ('pending', 'passed', 'failed', 'unavailable', 'superseded')),
  constraint step_acceptance_checks_attempts check (attempts >= 0),
  constraint step_acceptance_checks_first_attempt
    check ((attempts = 0) = (first_attempt_at is null)),
  constraint step_acceptance_checks_settled check ((status = 'pending') = (settled_at is null)),
  constraint step_acceptance_checks_lease check (status = 'pending' or lease_until is null),
  constraint step_acceptance_checks_shape check (jsonb_typeof(observation_check) = 'object'),
  constraint step_acceptance_checks_evidence
    check (status not in ('passed', 'failed') or observation_id is not null),
  constraint step_acceptance_checks_last_error
    check (last_error is null or char_length(last_error) <= 200)
);

-- The executor's scan: due pending observations, oldest first.
create index if not exists step_acceptance_checks_due_idx
  on step_acceptance_checks (next_attempt_at)
  where status = 'pending';

-- A run's rows: superseded together when the run stops running, read for its detail.
create index if not exists step_acceptance_checks_goal_idx
  on step_acceptance_checks (workspace_id, goal_run_id);

-- The observation compaction's reference probe (application/platform/compact-observations.ts,
-- condition (a)): an Observation a check rests on is never deleted.
create index if not exists step_acceptance_checks_observation_idx
  on step_acceptance_checks (workspace_id, observation_id)
  where observation_id is not null;

alter table step_acceptance_checks enable row level security;
drop policy if exists step_acceptance_checks_workspace_isolation on step_acceptance_checks;
create policy step_acceptance_checks_workspace_isolation on step_acceptance_checks
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant, like step_runs: a verification's history stays with its step.
grant select, insert, update on step_acceptance_checks to nexttime_app;

-- The step's declared acceptance checks: the `acceptance` array of its entry in the plan of the
-- revision that introduced it — `null` when the entry declares none.
create or replace function step_declared_acceptance(
  p_workspace_id uuid, p_goal_run_id uuid, p_revision int, p_step_key text
) returns jsonb
language sql stable as $$
  select case when jsonb_typeof(s -> 'acceptance') = 'array'
                   and jsonb_array_length(s -> 'acceptance') > 0
              then s -> 'acceptance' end
    from plan_revisions p, jsonb_array_elements(p.plan -> 'steps') s
   where p.workspace_id = p_workspace_id and p.goal_run_id = p_goal_run_id
     and p.revision = p_revision and s ->> 'key' = p_step_key
   limit 1
$$;

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
       or new.observation_id is not null or new.last_error is not null then
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
            and d -> 'check' = new.observation_check) then
      raise exception 'step_acceptance_checks: a check is one of its step''s declared acceptance checks, as declared';
    end if;
    if latest_round is not null and new.round < latest_round then
      raise exception 'step_acceptance_checks: no check is added to a round older than round %', latest_round;
    end if;
    return new;
  end if;

  if (new.workspace_id, new.goal_run_id, new.step_run_id, new.step_attempt, new.round,
      new.check_key, new.plan_revision, new.kind, new.observation_check, new.created_at)
     is distinct from
     (old.workspace_id, old.goal_run_id, old.step_run_id, old.step_attempt, old.round,
      old.check_key, old.plan_revision, old.kind, old.observation_check, old.created_at) then
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

  if new.status = 'passed' and not exists (
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
  return new;
end;
$$;

create or replace trigger step_acceptance_checks_guard
  before insert or update on step_acceptance_checks
  for each row execute function step_acceptance_checks_guard();

-- A step with declared acceptance checks succeeds only on them (see the header, 3.).
create or replace function step_runs_acceptance_guard() returns trigger
language plpgsql as $$
declare
  declared jsonb;
  latest_round int;
begin
  if new.status is distinct from 'succeeded' or old.status = 'succeeded' then
    return new;
  end if;
  declared := step_declared_acceptance(
    new.workspace_id, new.goal_run_id, new.introduced_in_revision, new.step_key);
  if declared is null then
    return new;
  end if;
  if old.status <> 'waiting' or old.waiting_reason is distinct from 'acceptance' then
    raise exception 'step_runs: a step with acceptance checks succeeds only once they are made — out of waiting on its acceptance';
  end if;
  select max(c.round) into latest_round
    from step_acceptance_checks c
   where c.workspace_id = new.workspace_id and c.step_run_id = new.id;
  if latest_round is null
     or exists (
       select 1 from step_acceptance_checks c
        where c.workspace_id = new.workspace_id and c.step_run_id = new.id
          and c.round = latest_round
          and (c.status <> 'passed' or c.step_attempt <> new.attempt_count))
     or exists (
       select 1 from jsonb_array_elements(declared) d
        where not exists (
          select 1 from step_acceptance_checks c
           where c.workspace_id = new.workspace_id and c.step_run_id = new.id
             and c.round = latest_round and c.check_key = d ->> 'key')) then
    raise exception 'step_runs: a step with acceptance checks succeeds only with every one of them passed in its latest round, for its current attempt';
  end if;
  return new;
end;
$$;

create or replace trigger step_runs_acceptance_guard
  before update on step_runs
  for each row execute function step_runs_acceptance_guard();
