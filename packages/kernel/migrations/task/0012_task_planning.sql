-- module: task, version: 0012
--
-- 0012_task_planning (S11 GO9a; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.1,
-- §4.3; goal/0014): the planner's Task. When a round of a GoalRun's planning opens (goal/0014
-- `goal_planning_rounds`), the advancer starts one Task for it (`application/task/planning-task.ts`):
--
--   * `purpose = 'planning'` and `planning_round_id` — the round it plans for; set together, when
--     the Task is created, never changed. One Task per round.
--   * It is a Task of the GoalRun (`goal_run_id`, and `plan_revision` = the round's base: the
--     revision the planner revises) but of no step: no `step_run_id`, no `step_attempt`, no run
--     configuration snapshot. A Task of a GoalRun is now either a step's Task (as since task/0007)
--     or a planning Task, never both.
--   * It acts for the GoalRun's requester (`on_behalf_of`): the planner proposes in their name and
--     within their authority, and only they accept what it proposes (goal/0014).
--   * Its Workers observe nothing (`observe_scope = '{}'`: every gate's observe-class Operations
--     are refused them, GO11) and it carries an output contract (`output_schema`: the planner's
--     report, `@nexttime/shared` `PLANNER_OUTPUT_SCHEMA`), which `report_task_result` holds it to
--     like a step's attempt (so `rejected_output` may be written for it too).
--   * Its WorkerRun is a root run: it neither starts under another run nor starts one (its Handle
--     has no `invoke_worker`; this is the backstop, as for an evaluation Task).
--
-- Nullable, no backfill: no Task before this one plans. Reversibility: the previous release names
-- its columns on every insert and select of `tasks` and never writes this one; its goal Tasks are
-- step Tasks (a step and no round), its purposes `NULL` or `evaluation`, so its inserts pass every
-- check here. A planning Task left running when rolled back is a Task of no step to that release:
-- its report moves no step, and its lifecycle may retry its Worker once after a crash —
-- release.md says to let a run's planning end first.
--
-- Runner ordering: `goal` sorts before `task`, so goal/0014's rounds exist when this runs.
-- Cross-process bootstrap lock: same `task`-module key as 0001–0011.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists planning_round_id uuid;

do $$
begin
  -- task/0011's check, widened by one purpose.
  alter table tasks drop constraint if exists tasks_purpose;
  alter table tasks add constraint tasks_purpose
    check (purpose is null or purpose in ('evaluation', 'planning'));

  -- task/0007's check, rewritten: a Task of a GoalRun names the revision it runs under and is
  -- either a step's Task or a round's planning Task; a Task of no GoalRun is neither.
  alter table tasks drop constraint if exists tasks_goal_step_ref;
  alter table tasks add constraint tasks_goal_step_ref check (
    (goal_run_id is null) = (plan_revision is null)
    and (goal_run_id is null) = (step_run_id is null and planning_round_id is null)
    and (step_run_id is null or planning_round_id is null)
  );

  -- task/0008's check, rewritten: an output contract is an attempt's or a planning Task's.
  alter table tasks drop constraint if exists tasks_output_schema;
  alter table tasks add constraint tasks_output_schema check (
    output_schema is null
    or (
      jsonb_typeof(output_schema) = 'object'
      and (step_attempt is not null or planning_round_id is not null)
    )
  );

  if not exists (select 1 from pg_constraint where conname = 'tasks_planning_shape') then
    alter table tasks add constraint tasks_planning_shape check (
      (purpose is not distinct from 'planning') = (planning_round_id is not null)
      and (
        planning_round_id is null
        or (
          observe_scope is not null and cardinality(observe_scope) = 0
          and output_schema is not null
        )
      )
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tasks_planning_round_fkey') then
    alter table tasks
      add constraint tasks_planning_round_fkey
      foreign key (workspace_id, goal_run_id, planning_round_id)
      references goal_planning_rounds (workspace_id, goal_run_id, id);
  end if;
end
$$;

-- One Task per round.
create unique index if not exists tasks_planning_round_uidx
  on tasks (workspace_id, planning_round_id)
  where planning_round_id is not null;

create or replace function tasks_planning_guard() returns trigger
language plpgsql as $$
declare
  round record;
begin
  if tg_op = 'UPDATE' then
    if new.planning_round_id is distinct from old.planning_round_id then
      raise exception 'tasks: the planning round of a Task never changes after it is created';
    end if;
    if new.planning_round_id is null or new.on_behalf_of is not distinct from old.on_behalf_of then
      return new;
    end if;
    raise exception 'tasks: a planning Task acts for the requester it was created for';
  end if;
  if new.planning_round_id is null then
    return new;
  end if;
  select pr.status, pr.based_on_revision, g.on_behalf_of into round
    from goal_planning_rounds pr
    join goal_runs g on g.workspace_id = pr.workspace_id and g.id = pr.goal_run_id
   where pr.workspace_id = new.workspace_id and pr.goal_run_id = new.goal_run_id
     and pr.id = new.planning_round_id;
  if round.status is distinct from 'running' then
    raise exception 'tasks: a planning Task starts for a running round (it is %)',
      coalesce(round.status, 'missing');
  end if;
  if new.plan_revision is distinct from round.based_on_revision then
    raise exception 'tasks: a planning Task runs under the revision its round revises';
  end if;
  if new.on_behalf_of is distinct from round.on_behalf_of then
    raise exception 'tasks: a planning Task acts for the requester of its goal run';
  end if;
  return new;
end;
$$;

create or replace trigger tasks_planning_guard
  before insert or update of planning_round_id, on_behalf_of on tasks
  for each row execute function tasks_planning_guard();

create or replace function worker_runs_planning_root() returns trigger
language plpgsql as $$
begin
  if new.parent_worker_run_id is not null and (
    exists (
      select 1 from tasks t
       where t.workspace_id = new.workspace_id and t.id = new.task_id and t.purpose = 'planning'
    )
    or exists (
      select 1
        from worker_runs w
        join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
       where w.workspace_id = new.workspace_id and w.id = new.parent_worker_run_id
         and t.purpose = 'planning'
    )
  ) then
    raise exception 'worker_runs: a planning Task''s run neither starts under another run nor starts one';
  end if;
  return new;
end;
$$;

create or replace trigger worker_runs_planning_root
  before insert or update of parent_worker_run_id, task_id on worker_runs
  for each row execute function worker_runs_planning_root();
