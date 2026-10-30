-- module: goal, version: 0012
--
-- 0012_absence_baselines (S11 「门确认不存在」 B-c, after B-b's `observe_absent`, goal/0011). The
-- gate answering "not there" says the thing is not there now; it does not say it was there before.
-- Params that name something that never existed are answered "not there" at once, and an absence
-- check on them would pass without anything having been removed. So the platform first looks with
-- the same call before the goal's work starts — a baseline — and an absence check passes only on a
-- baseline that saw the thing:
--
--   1. `goal_absence_baselines` — one row per time the platform takes a check's baseline (`take`:
--      1, then one more for each retake). A check is named as the plan names it: the goal's own
--      (`step_key` null) or a step's (its key), and its `check_key`; `observation_check` is the
--      call (Gatekeeper, Operation, params — an absence call, so no predicate), copied from the
--      plan in force. `application/goal/absence-baselines.ts` creates a `pending` row for every
--      `observe_absent` check the plan in force declares — the goal's, and those of its steps that
--      have not ended — once the run is running and before any of its steps starts, and again for a
--      check whose call a revision changed (a revision that keeps the call keeps the baseline: the
--      thing may already be gone by the goal's own doing, and a new look would say it never was);
--      the requester's resume retakes one that did not see the thing. `absence-baseline.ts` makes
--      the observation as an acceptance observation is made (`platform-observation.ts`, the same
--      caps), and the row settles once: `seen_present` (the gate answered with data — the thing is
--      there), `never_seen_present` (the gate confirmed it is not there, in an answer the
--      published Operation declares means so — nothing a check on that call could ever show this
--      goal removed), `unavailable` (refused, or no answer by the last try; `last_error` says why)
--      or `superseded` (the run stopped running before it settled, or the plan in force no longer
--      declares that call). While a check's latest baseline is pending no step starts; one that is
--      `never_seen_present` or `unavailable` pauses the run for the requester (`advance.ts`).
--      The guard: created `pending` and untried, while the run is `running`, for a check the plan
--      in force declares with exactly that call, as the next take after a settled one; settled
--      once, then frozen; `seen_present`, `never_seen_present` and `unavailable` only while the run
--      is `running`; `seen_present` only on an Observation of this take of this check, of the
--      Gatekeeper and Operation it calls, in which the gate answered with data, and
--      `never_seen_present` only on one in which it answered absent.
--   2. I-AB1, on both acceptance-check tables (goal/0005, goal/0006): an `observe_absent` check
--      passes only when the same run has a `seen_present` baseline of the same check — the goal's,
--      or the same step key's — with the same call, whose Observation is older than the one the
--      check passes on. Its own trigger on each table, beside the tables' guards (goal/0011), so a
--      later redefinition of those guards cannot drop it.
--
-- No backfill: B-b (goal/0011) has not been on a host, so no run has an absence check pending or
-- passed. A run confirmed under goal/0011 and not ended has no baseline: its next advance takes
-- one before any step starts, and an absence check already waiting on its acceptance settles
-- `unavailable` (`never_seen_present`) — the requester resumes to look again.
--
-- Rolling back (docs/runbooks/release.md §6): the previous release, v0.49.0, has no goal code and
-- never reads or writes the new table; its observation compaction refuses to run on the new foreign
-- key into `observations` (its fail-closed guard, reversibility-deltas.json). A release with B-b
-- but not B-c — none has been on a host — would ignore baselines and pass absence checks without
-- one, and the new trigger refuses that: such a check would fail its settle and stay pending until
-- the run is resumed under this release.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0011.
select pg_advisory_xact_lock(7241000701);

create table if not exists goal_absence_baselines (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  goal_run_id uuid not null,
  step_key text,
  check_key text not null,
  take int not null,
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
  primary key (workspace_id, id),
  foreign key (workspace_id, goal_run_id) references goal_runs (workspace_id, id),
  foreign key (workspace_id, observation_id) references observations (workspace_id, id),
  constraint goal_absence_baselines_step_key
    check (step_key is null or step_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint goal_absence_baselines_check_key
    check (check_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint goal_absence_baselines_take check (take >= 1),
  -- An absence call: Gatekeeper, Operation and params, never a predicate.
  constraint goal_absence_baselines_call check (
    jsonb_typeof(observation_check) = 'object'
    and jsonb_typeof(observation_check -> 'gatekeeperId') = 'string'
    and jsonb_typeof(observation_check -> 'operation') = 'string'
    and not (observation_check ? 'expect')
  ),
  constraint goal_absence_baselines_status check (
    status in ('pending', 'seen_present', 'never_seen_present', 'unavailable', 'superseded')
  ),
  constraint goal_absence_baselines_attempts check (attempts >= 0),
  constraint goal_absence_baselines_first_attempt
    check ((attempts = 0) = (first_attempt_at is null)),
  constraint goal_absence_baselines_settled check ((status = 'pending') = (settled_at is null)),
  constraint goal_absence_baselines_lease check (status = 'pending' or lease_until is null),
  -- What the gate answered is kept exactly when the baseline settled on it.
  constraint goal_absence_baselines_evidence check (
    (status in ('seen_present', 'never_seen_present')) = (observation_id is not null)
  ),
  constraint goal_absence_baselines_last_error
    check (last_error is null or char_length(last_error) <= 200)
);

-- One row per take of a check; the goal's own checks under the empty key (a step key is never
-- empty).
create unique index if not exists goal_absence_baselines_take_idx
  on goal_absence_baselines (workspace_id, goal_run_id, coalesce(step_key, ''), check_key, take);

-- The executor's scan: due pending baselines, oldest first.
create index if not exists goal_absence_baselines_due_idx
  on goal_absence_baselines (next_attempt_at)
  where status = 'pending';

-- The observation compaction's reference probe (application/platform/compact-observations.ts,
-- condition (a)): an Observation a baseline rests on is never deleted.
create index if not exists goal_absence_baselines_observation_idx
  on goal_absence_baselines (workspace_id, observation_id)
  where observation_id is not null;

alter table goal_absence_baselines enable row level security;
drop policy if exists goal_absence_baselines_workspace_isolation on goal_absence_baselines;
create policy goal_absence_baselines_workspace_isolation on goal_absence_baselines
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant, like goal_runs: a baseline's history stays with its run.
grant select, insert, update on goal_absence_baselines to nexttime_app;

create or replace function goal_absence_baselines_guard() returns trigger
language plpgsql as $$
declare
  goal record;
  declared jsonb;
  latest record;
begin
  select g.status, g.current_revision into goal
    from goal_runs g
   where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0 or new.lease_until is not null
       or new.observation_id is not null or new.last_error is not null then
      raise exception 'goal_absence_baselines: a baseline is created pending and untried';
    end if;
    if goal.status is distinct from 'running' or goal.current_revision is null then
      raise exception 'goal_absence_baselines: a baseline is taken while its goal run is running';
    end if;
    declared := case when new.step_key is null
                     then goal_declared_acceptance(new.workspace_id, new.goal_run_id,
                                                   goal.current_revision)
                     else step_declared_acceptance(new.workspace_id, new.goal_run_id,
                                                   goal.current_revision, new.step_key)
                end;
    if not exists (
      select 1 from jsonb_array_elements(coalesce(declared, '[]'::jsonb)) d
       where d ->> 'key' = new.check_key and d ->> 'kind' = 'observe_absent'
         and d -> 'check' = new.observation_check) then
      raise exception 'goal_absence_baselines: a baseline is of an absence check the plan in force declares, with the call it declares';
    end if;
    select max(b.take) as take,
           count(*) filter (where b.status = 'pending') as pending
      into latest
      from goal_absence_baselines b
     where b.workspace_id = new.workspace_id and b.goal_run_id = new.goal_run_id
       and b.step_key is not distinct from new.step_key and b.check_key = new.check_key;
    if new.take <> coalesce(latest.take, 0) + 1 then
      raise exception 'goal_absence_baselines: a check''s next baseline is take %', coalesce(latest.take, 0) + 1;
    end if;
    if latest.pending > 0 then
      raise exception 'goal_absence_baselines: a check is retaken only once its last baseline settled';
    end if;
    return new;
  end if;

  if (new.workspace_id, new.id, new.goal_run_id, new.step_key, new.check_key, new.take,
      new.observation_check, new.created_at)
     is distinct from
     (old.workspace_id, old.id, old.goal_run_id, old.step_key, old.check_key, old.take,
      old.observation_check, old.created_at) then
    raise exception 'goal_absence_baselines: which check a baseline is of, and its call, never change';
  end if;
  if old.status <> 'pending' then
    raise exception 'goal_absence_baselines: a settled baseline is not changed';
  end if;
  if new.attempts < old.attempts then
    raise exception 'goal_absence_baselines: attempts only grow';
  end if;
  if old.first_attempt_at is not null
     and new.first_attempt_at is distinct from old.first_attempt_at then
    raise exception 'goal_absence_baselines: when the first attempt was made never changes';
  end if;

  if new.status in ('seen_present', 'never_seen_present', 'unavailable')
     and goal.status is distinct from 'running' then
    raise exception 'goal_absence_baselines: a baseline settles while its goal run is running';
  end if;
  if new.status in ('seen_present', 'never_seen_present') and not exists (
    select 1 from observations o
     where o.workspace_id = new.workspace_id and o.id = new.observation_id
       and o.content ->> 'purpose' = 'absence_baseline'
       and o.content ->> 'goalRunId' = new.goal_run_id::text
       and (case when new.step_key is null then not (o.content ? 'stepKey')
                 else o.content ->> 'stepKey' = new.step_key end)
       and o.content ->> 'checkKey' = new.check_key
       and o.content ->> 'take' = new.take::text
       and o.content ->> 'gatekeeperId' = new.observation_check ->> 'gatekeeperId'
       and o.content ->> 'operation' = new.observation_check ->> 'operation'
       and not (o.content ? 'expect')
       and (o.content ? 'absent') = (new.status = 'never_seen_present')
  ) then
    raise exception 'goal_absence_baselines: a baseline settles seen_present only on an Observation of it in which the gate answered with the thing, and never_seen_present only on one in which it answered the thing is not there';
  end if;
  return new;
end;
$$;

create or replace trigger goal_absence_baselines_guard
  before insert or update on goal_absence_baselines
  for each row execute function goal_absence_baselines_guard();

-- ----- I-AB1 ---------------------------------------------------------------------------------

-- Whether the run saw the thing a check looks for before `p_before`: a `seen_present` baseline of
-- the check (the goal's: `p_step_key` null; a step's: its key) with the call `p_call`, on an
-- Observation of it older than `p_before` in which the gate answered with data.
create or replace function goal_absence_seen_before(
  p_workspace_id uuid, p_goal_run_id uuid, p_step_key text, p_check_key text, p_call jsonb,
  p_before timestamptz
) returns boolean
language sql stable as $$
  select exists (
    select 1 from goal_absence_baselines b
      join observations o on o.workspace_id = b.workspace_id and o.id = b.observation_id
     where b.workspace_id = p_workspace_id and b.goal_run_id = p_goal_run_id
       and b.step_key is not distinct from p_step_key and b.check_key = p_check_key
       and b.observation_check = p_call and b.status = 'seen_present'
       and o.content ->> 'purpose' = 'absence_baseline' and not (o.content ? 'absent')
       and o.created_at < p_before)
$$;

create or replace function goal_acceptance_checks_seen_before() returns trigger
language plpgsql as $$
begin
  if not coalesce(goal_absence_seen_before(
       new.workspace_id, new.goal_run_id, null, new.check_key, new.observation_check,
       (select o.created_at from observations o
         where o.workspace_id = new.workspace_id and o.id = new.observation_id)), false) then
    raise exception 'goal_acceptance_checks: an absence check passes only once the platform saw the thing there before — an earlier baseline of this check''s call that found it (I-AB1)';
  end if;
  return new;
end;
$$;

create or replace trigger goal_acceptance_checks_seen_before
  before update on goal_acceptance_checks
  for each row
  when (new.status = 'passed' and new.kind = 'observe_absent')
  execute function goal_acceptance_checks_seen_before();

create or replace function step_acceptance_checks_seen_before() returns trigger
language plpgsql as $$
begin
  if not coalesce(goal_absence_seen_before(
       new.workspace_id, new.goal_run_id,
       (select s.step_key from step_runs s
         where s.workspace_id = new.workspace_id and s.id = new.step_run_id),
       new.check_key, new.observation_check,
       (select o.created_at from observations o
         where o.workspace_id = new.workspace_id and o.id = new.observation_id)), false) then
    raise exception 'step_acceptance_checks: an absence check passes only once the platform saw the thing there before — an earlier baseline of this check''s call that found it (I-AB1)';
  end if;
  return new;
end;
$$;

create or replace trigger step_acceptance_checks_seen_before
  before update on step_acceptance_checks
  for each row
  when (new.status = 'passed' and new.kind = 'observe_absent')
  execute function step_acceptance_checks_seen_before();
