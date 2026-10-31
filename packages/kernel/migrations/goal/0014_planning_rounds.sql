-- module: goal, version: 0014
--
-- 0014_planning_rounds (S11 GO9a; plan §4.1, §4.3, §10 F3; roadmap GO9). A step of a goal that
-- fails for a person — its rework done (`contract_violation`), its attempts used up (`transient`),
-- an action refused (`action_refused`) or its acceptance not met (`verification_failed`) — pauses
-- the run `needs_decision`. With the requester's leave, given when they confirm the goal, the
-- platform then asks a planner Worker for a revision of the plan; the planner only proposes, and
-- only the requester accepts (I-P1, I-P5: GO9a never accepts for them).
--
--   `goal_planner_delegations` — the leave: one row per GoalRun whose requester let the planner
--   propose (`mode = 'propose'`, the only mode GO9a has), written in the transaction that confirms
--   the run (`confirm_goal`'s `planner`), by the requester, while the run is still proposed. Never
--   changes and is never deleted: what the run was confirmed with.
--
--   `goal_planning_rounds` — one planner run at one judgment point: the failed attempt of a step
--   (`step_run_id`, `step_attempt`, `failure_category`) of a run paused `needs_decision`, on the
--   revision in force (`based_on_revision`). At most one per failed attempt (an advance that finds
--   the run paused again for the same attempt opens none) and one `running` per GoalRun. Opened by
--   the advancer (`application/goal/planner.ts`) with the planner Task (task/0012, `purpose =
--   'planning'`), or settled at once as `failed` when no planner can run for it (no revision or
--   token budget left, no planner definition, a requester who can no longer start Workers). A
--   running round settles once:
--     - `proposed`: the planner's revision is in `plan_revisions`, `proposed`, based on the round's
--       revision and proposed by the planner Principal (`revision`);
--     - `no_revision`: the planner found no plan change that helps (`detail`: its reason);
--     - `failed`: its Task ended without a usable result, or what it proposed no longer passes the
--       platform's checks (`outcome_reason`, `detail`);
--     - `abandoned`: the run left the pause the round was opened for — resumed, cancelled, held by
--       an owner — or its plan was revised (I-P4: a round belongs to one pause); its Task is
--       terminated and a late result moves nothing.
--   `outcome_reason` is a code the console names (`@nexttime/shared` `PlanningRoundOutcomeReason`),
--   `detail` the platform's sentence (at most 2000 characters, never a credential: the advancer
--   writes it from its own checks or from the planner's scrubbed report).
--
--   `plan_revisions` — a revision the planner Principal proposes (`proposed_by` a `service`
--   Principal named `__goal_planner__`) is created only while a round of its GoalRun on the same
--   base runs, and accepted only by the run's requester (`plan_revisions_planner` below). What the
--   guard of goal/0001 holds for every revision still holds (I-G3 on accept, content frozen).
--
-- No backfill: no release before this one has a planner.
--
-- Rolling back (docs/runbooks/release.md §6): code only. Code without this migration never reads or
-- writes these tables; a planner revision left `proposed` stays so (that code's `revise_goal`
-- does not reject it, and nothing accepts it: its I-G3 check refuses it once another revision is
-- in force). A round left `running` when rolled back stays so, and its Task (task/0012) is
-- terminated like any other Task of the run when the run is cancelled; release.md says to let a
-- run's planning end first. To drop the schema too: `drop table goal_planning_rounds,
-- goal_planner_delegations` (their triggers with them) after task/0012's `tasks.planning_round_id`
-- foreign key, `drop trigger plan_revisions_planner on plan_revisions`, the functions below, and
-- `delete from schema_migrations where module = 'goal' and version = 14`.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0013.
select pg_advisory_xact_lock(7241000701);

-- ---------------------------------------------------------------------------------------------
-- goal_planner_delegations
-- ---------------------------------------------------------------------------------------------

create table if not exists goal_planner_delegations (
  workspace_id uuid not null,
  goal_run_id uuid not null,
  mode text not null,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, goal_run_id),
  foreign key (workspace_id, goal_run_id) references goal_runs (workspace_id, id),
  foreign key (workspace_id, granted_by) references principals (workspace_id, id),
  constraint goal_planner_delegations_mode check (mode in ('propose'))
);

alter table goal_planner_delegations enable row level security;
drop policy if exists goal_planner_delegations_workspace_isolation on goal_planner_delegations;
create policy goal_planner_delegations_workspace_isolation on goal_planner_delegations
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Written once, with the confirmation: no update, no delete.
grant select, insert on goal_planner_delegations to nexttime_app;

create or replace function goal_planner_delegations_guard() returns trigger
language plpgsql as $$
declare
  goal record;
begin
  if tg_op = 'UPDATE' then
    raise exception 'goal_planner_delegations: the planner leave a goal run was confirmed with never changes';
  end if;
  select g.status, g.on_behalf_of into goal
    from goal_runs g
   where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
     for no key update;
  if goal.status is distinct from 'proposed' then
    raise exception 'goal_planner_delegations: the planner is let propose when the goal run is confirmed, not while it is %',
      coalesce(goal.status, 'missing');
  end if;
  if new.granted_by is distinct from goal.on_behalf_of then
    raise exception 'goal_planner_delegations: only the requester lets the planner propose revisions of their goal';
  end if;
  return new;
end;
$$;

create or replace trigger goal_planner_delegations_guard
  before insert or update on goal_planner_delegations
  for each row execute function goal_planner_delegations_guard();

-- ---------------------------------------------------------------------------------------------
-- goal_planning_rounds
-- ---------------------------------------------------------------------------------------------

create table if not exists goal_planning_rounds (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  goal_run_id uuid not null,
  based_on_revision int not null,
  step_run_id uuid not null,
  step_attempt int not null,
  failure_category text not null,
  status text not null default 'running',
  revision int,
  outcome_reason text,
  detail text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (workspace_id, id),
  -- What task/0012's `tasks.planning_round_id` points at, with the Task's GoalRun.
  unique (workspace_id, goal_run_id, id),
  foreign key (workspace_id, goal_run_id) references goal_runs (workspace_id, id),
  foreign key (workspace_id, goal_run_id, step_run_id)
    references step_runs (workspace_id, goal_run_id, id),
  foreign key (workspace_id, goal_run_id, based_on_revision)
    references plan_revisions (workspace_id, goal_run_id, revision),
  foreign key (workspace_id, goal_run_id, revision)
    references plan_revisions (workspace_id, goal_run_id, revision),
  constraint goal_planning_rounds_status
    check (status in ('running', 'proposed', 'no_revision', 'failed', 'abandoned')),
  constraint goal_planning_rounds_settled check ((status = 'running') = (settled_at is null)),
  constraint goal_planning_rounds_revision check ((status = 'proposed') = (revision is not null)),
  constraint goal_planning_rounds_outcome_reason check (
    (status = 'failed' and outcome_reason in (
       'revision_budget_exhausted', 'token_budget_exhausted', 'planner_unavailable',
       'requester_cannot_start', 'task_failed', 'invalid_revision'))
    or (status = 'abandoned' and outcome_reason in ('run_left_pause', 'plan_revised'))
    or (status not in ('failed', 'abandoned') and outcome_reason is null)
  ),
  constraint goal_planning_rounds_step_attempt check (step_attempt >= 1),
  constraint goal_planning_rounds_failure_category check (
    failure_category in ('contract_violation', 'transient', 'action_refused', 'verification_failed')
  ),
  constraint goal_planning_rounds_detail check (detail is null or char_length(detail) <= 2000)
);

-- One round per failed attempt of a step.
create unique index if not exists goal_planning_rounds_attempt_uidx
  on goal_planning_rounds (workspace_id, step_run_id, step_attempt);

-- One planner at a time per GoalRun.
create unique index if not exists goal_planning_rounds_running_uidx
  on goal_planning_rounds (workspace_id, goal_run_id)
  where status = 'running';

-- A run's rounds, oldest first (the advance, `get_goal`).
create index if not exists goal_planning_rounds_run_idx
  on goal_planning_rounds (workspace_id, goal_run_id, created_at);

alter table goal_planning_rounds enable row level security;
drop policy if exists goal_planning_rounds_workspace_isolation on goal_planning_rounds;
create policy goal_planning_rounds_workspace_isolation on goal_planning_rounds
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete grant, like goal_runs: a round is part of the run's history.
grant select, insert, update on goal_planning_rounds to nexttime_app;

-- Whether `principal_id` is the workspace's planner Principal (`application/goal/planner.ts`).
create or replace function goal_planner_principal(ws uuid, principal_id uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from principals p
     where p.workspace_id = ws and p.id = principal_id
       and p.kind = 'service' and p.display_name = '__goal_planner__');
$$;

create or replace function goal_planning_rounds_guard() returns trigger
language plpgsql as $$
declare
  goal record;
  step record;
begin
  if tg_op = 'INSERT' then
    select g.status, g.pause_reason, g.paused_by_authority, g.current_revision into goal
      from goal_runs g
     where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
       for no key update;
    if goal.status is distinct from 'paused' or goal.pause_reason is distinct from 'needs_decision'
       or goal.paused_by_authority is not distinct from 'owner' then
      raise exception 'goal_planning_rounds: a round opens while its goal run is paused for a decision and no owner holds it';
    end if;
    if new.based_on_revision is distinct from goal.current_revision then
      raise exception 'goal_planning_rounds: a round is based on the revision in force (%), not %',
        coalesce(goal.current_revision::text, 'none'), new.based_on_revision;
    end if;
    if not exists (
      select 1 from goal_planner_delegations d
       where d.workspace_id = new.workspace_id and d.goal_run_id = new.goal_run_id) then
      raise exception 'goal_planning_rounds: the requester did not let the planner propose revisions of this goal run';
    end if;
    select s.status, s.attempt_count, s.failure_category, s.superseded_in_revision into step
      from step_runs s
     where s.workspace_id = new.workspace_id and s.goal_run_id = new.goal_run_id
       and s.id = new.step_run_id;
    if step.status is distinct from 'failed' or step.superseded_in_revision is not null
       or step.attempt_count is distinct from new.step_attempt
       or step.failure_category is distinct from new.failure_category then
      raise exception 'goal_planning_rounds: a round is for the failed attempt of a live step, with its failure category';
    end if;
    if new.status = 'running' then
      if new.revision is not null or new.outcome_reason is not null or new.detail is not null
         or new.settled_at is not null then
        raise exception 'goal_planning_rounds: a running round has no result yet';
      end if;
      return new;
    end if;
    -- No planner can run for this pause: the round is recorded as failed, with why.
    if new.status <> 'failed' or new.outcome_reason not in (
         'revision_budget_exhausted', 'token_budget_exhausted', 'planner_unavailable',
         'requester_cannot_start') then
      raise exception 'goal_planning_rounds: a round is opened running, or recorded failed because no planner could run for it';
    end if;
    return new;
  end if;

  if (new.workspace_id, new.id, new.goal_run_id, new.based_on_revision, new.step_run_id,
      new.step_attempt, new.failure_category, new.created_at)
     is distinct from
     (old.workspace_id, old.id, old.goal_run_id, old.based_on_revision, old.step_run_id,
      old.step_attempt, old.failure_category, old.created_at) then
    raise exception 'goal_planning_rounds: what a round was opened for never changes';
  end if;
  if old.status <> 'running' then
    if (new.status, new.revision, new.outcome_reason, new.detail, new.settled_at)
       is distinct from (old.status, old.revision, old.outcome_reason, old.detail, old.settled_at) then
      raise exception 'goal_planning_rounds: a round settles once (it is %)', old.status;
    end if;
    return new;
  end if;
  if new.status = 'proposed' and not exists (
       select 1 from plan_revisions r
        where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
          and r.revision = new.revision and r.status = 'proposed'
          and r.based_on_revision = new.based_on_revision
          and goal_planner_principal(r.workspace_id, r.proposed_by)) then
    raise exception 'goal_planning_rounds: a round proposes a revision the planner proposed on the round''s base';
  end if;
  if new.status = 'failed' and new.outcome_reason not in ('task_failed', 'invalid_revision') then
    raise exception 'goal_planning_rounds: a running round fails because its Task gave no usable result (task_failed, invalid_revision)';
  end if;
  return new;
end;
$$;

create or replace trigger goal_planning_rounds_guard
  before insert or update on goal_planning_rounds
  for each row execute function goal_planning_rounds_guard();

-- ---------------------------------------------------------------------------------------------
-- plan_revisions: the planner's revisions
-- ---------------------------------------------------------------------------------------------

-- A revision the planner Principal proposes is created only while a round of its run on the same
-- base runs; one it proposed is accepted only by the run's requester (GO9a: the platform proposes,
-- a person decides). Rejected by the requester, or by the person whose own action declined it (a
-- revision of theirs, a resume, a cancel — `application/goal/planner.ts`), like any revision.
create or replace function plan_revisions_planner() returns trigger
language plpgsql as $$
begin
  if not goal_planner_principal(new.workspace_id, new.proposed_by) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from goal_planning_rounds pr
       where pr.workspace_id = new.workspace_id and pr.goal_run_id = new.goal_run_id
         and pr.status = 'running' and pr.based_on_revision = new.based_on_revision) then
      raise exception 'plan_revisions: the planner proposes a revision only from a running round on the same base';
    end if;
    return new;
  end if;
  if new.status = 'accepted' and old.status is distinct from 'accepted' and not exists (
       select 1 from goal_runs g
        where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
          and g.on_behalf_of = new.decided_by) then
    raise exception 'plan_revisions: a revision the planner proposed is accepted by the requester of its goal run';
  end if;
  return new;
end;
$$;

create or replace trigger plan_revisions_planner
  before insert or update of status on plan_revisions
  for each row execute function plan_revisions_planner();
