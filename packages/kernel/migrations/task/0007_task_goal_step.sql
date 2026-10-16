-- module: task, version: 0007
--
-- 0007_task_goal_step (S11 GO1: docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1,
-- §3.2 `Task executes StepRun`, §3.3 I-G1 / I-G2, §4.7 "一层重试 + 配置快照"). A Task that runs for
-- a GoalRun records which one, which StepRun, and under which plan revision it was started:
--
--   * `goal_run_id`, `step_run_id`, `plan_revision` — all three or none. The foreign keys carry the
--     GoalRun, so a Task cannot claim a step or a revision of another GoalRun. A nested child Task
--     (an `invoke_worker` call from a step's Worker) inherits all three from its caller's Task
--     (`application/task/invoke.ts`), so I-G4 and I-G9 can judge it by the same step.
--   * `step_attempt` — the StepRun attempt this Task is (1, 2, …). Only the Tasks the advancer
--     creates for a step have one; a nested child Task takes no attempt number. I-G1 is the unique
--     index below: one Task per (StepRun, attempt). Named apart from `worker_runs.attempt`, the
--     Task-internal crash retry, which the advancer turns off for the Tasks it creates (§3.1).
--   * `run_config_snapshot` — the configuration the attempt actually ran with (§3.1
--     RunConfigSnapshot: `definition@version`, Skill `id@version`, model, `instanceInstructions`
--     digest, runtime image digest, the step Handle's gates and capabilities, budget), a JSON object
--     written by the advancer when it creates the Task (GO2) and read instead of re-resolving on a
--     retry. Required on every attempt Task; whatever its content, never a credential.
--
-- Nullable, no backfill: existing Tasks and every Task outside a goal carry NULL in all five.
-- Reversibility: the previous release names its columns on every insert and select of `tasks` and
-- never sees these; the CHECKs hold for its rows (all NULL).
--
-- Runner ordering: `goal` sorts before `task`, so goal/0001's tables exist when this runs.
-- Cross-process bootstrap lock: same `task`-module key as 0001–0006.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists goal_run_id uuid;
alter table tasks add column if not exists step_run_id uuid;
alter table tasks add column if not exists plan_revision int;
alter table tasks add column if not exists step_attempt int;
alter table tasks add column if not exists run_config_snapshot jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_goal_step_ref') then
    alter table tasks add constraint tasks_goal_step_ref check (
      (goal_run_id is null) = (step_run_id is null)
      and (step_run_id is null) = (plan_revision is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_step_attempt') then
    alter table tasks add constraint tasks_step_attempt check (
      step_attempt is null
      or (step_attempt >= 1 and step_run_id is not null and run_config_snapshot is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_run_config_snapshot') then
    alter table tasks add constraint tasks_run_config_snapshot check (
      run_config_snapshot is null
      or (jsonb_typeof(run_config_snapshot) = 'object' and step_run_id is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_step_run_fkey') then
    alter table tasks
      add constraint tasks_step_run_fkey
      foreign key (workspace_id, goal_run_id, step_run_id)
      references step_runs (workspace_id, goal_run_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_plan_revision_fkey') then
    alter table tasks
      add constraint tasks_plan_revision_fkey
      foreign key (workspace_id, goal_run_id, plan_revision)
      references plan_revisions (workspace_id, goal_run_id, revision);
  end if;
end
$$;

-- I-G1: each attempt of a StepRun is at most one Task.
create unique index if not exists tasks_step_attempt_uidx
  on tasks (workspace_id, step_run_id, step_attempt)
  where step_attempt is not null;

-- A GoalRun's Tasks (budget sums, cancellation, the goal detail page).
create index if not exists tasks_goal_run_idx
  on tasks (workspace_id, goal_run_id)
  where goal_run_id is not null;

-- The step-goal reference is written once, when the Task is created.
create or replace function tasks_goal_step_immutable() returns trigger
language plpgsql as $$
begin
  if new.goal_run_id is distinct from old.goal_run_id
     or new.step_run_id is distinct from old.step_run_id
     or new.plan_revision is distinct from old.plan_revision
     or new.step_attempt is distinct from old.step_attempt
     or new.run_config_snapshot is distinct from old.run_config_snapshot then
    raise exception 'tasks: the goal, step, revision, attempt and run configuration of a task never change';
  end if;
  return new;
end;
$$;

create or replace trigger tasks_goal_step_immutable
  before update of goal_run_id, step_run_id, plan_revision, step_attempt, run_config_snapshot on tasks
  for each row execute function tasks_goal_step_immutable();
