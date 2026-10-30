-- module: task, version: 0010
--
-- 0010_task_observe_scope (S11 GO11, docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
-- §4.11 "任务级观察范围"; S10 I-E1): the gates a Task's Workers may observe through.
--
--   * `observe_scope` — NULL: the Task sets no scope, its Workers observe what their member's agent
--     may (application/gates/observe-access.ts: AgentPolicy cap, AgentProfile exclusions). An array
--     (possibly empty): only these Gatekeepers — every other gate's observe-class Operations are
--     refused `excluded_by_policy` to the Task's Workers, and left out of their tool list. It only
--     narrows: it never lets a Worker observe a gate its member's agent may not.
--
-- Written once, when the Task is created (application/task/invoke.ts), never changed: a Worker's
-- observation is never widened while it runs. A Task that a Worker of a scoped Task invokes is
-- scoped too, within its caller's scope — the kernel copies the caller's scope (narrowed further
-- when asked); the trigger on `worker_runs` below refuses the run otherwise, so a nested Worker can
-- never observe beyond the Task that started it. The first producer of a scope is S10 E3's
-- evaluation Task; GO8's WorkerSpec declares one later.
--
-- Nullable, no backfill: every existing Task sets no scope, which is what they have always run
-- under. Reversibility: the previous release names its columns on every insert and select of
-- `tasks` and never writes this one; its inserts of `worker_runs` pass the inheritance check
-- whenever the caller's Task sets no scope, which holds for every Task it creates. A scoped Task —
-- one only this release creates — cannot have its Workers invoke another Worker under the previous
-- release (the check refuses it: fail closed), and its Workers' observations are not narrowed
-- there.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0009.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists observe_scope uuid[];

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_observe_scope') then
    alter table tasks add constraint tasks_observe_scope check (
      observe_scope is null
      or (
        coalesce(array_ndims(observe_scope), 1) = 1
        and array_position(observe_scope, null) is null
      )
    );
  end if;
end
$$;

create or replace function tasks_observe_scope_immutable() returns trigger
language plpgsql as $$
begin
  if new.observe_scope is distinct from old.observe_scope then
    raise exception 'tasks: a Task''s observation scope never changes after it is created';
  end if;
  return new;
end;
$$;

create or replace trigger tasks_observe_scope_immutable
  before update of observe_scope on tasks
  for each row execute function tasks_observe_scope_immutable();

-- A WorkerRun started by another WorkerRun (`parent_worker_run_id`: a Worker's `invoke_worker`)
-- runs a Task scoped within the Task of the run that started it. Checked on every insert and on any
-- change of the two columns that tie a run to its Task and its parent.
create or replace function worker_runs_observe_scope_inherited() returns trigger
language plpgsql as $$
declare
  parent_scope uuid[];
  child_scope uuid[];
begin
  if new.parent_worker_run_id is null then
    return new;
  end if;
  select t.observe_scope into parent_scope
    from worker_runs w
    join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
   where w.workspace_id = new.workspace_id and w.id = new.parent_worker_run_id;
  if parent_scope is null then
    return new;
  end if;
  select observe_scope into child_scope
    from tasks
   where workspace_id = new.workspace_id and id = new.task_id;
  if child_scope is null or not (child_scope <@ parent_scope) then
    raise exception 'worker_runs: a Worker started by a Worker of a scoped Task observes only within that Task''s observation scope';
  end if;
  return new;
end;
$$;

create or replace trigger worker_runs_observe_scope_inherited
  before insert or update of parent_worker_run_id, task_id on worker_runs
  for each row execute function worker_runs_observe_scope_inherited();
