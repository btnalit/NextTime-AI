-- module: task, version: 0011
--
-- 0011_task_purpose (S10 E3-2a, docs/s10-evolution-plan-2026-10-04.md §3.3 I-E1, §5.5 封闭): what a
-- Task is for, when it is not ordinary work.
--
--   * `purpose` — NULL: ordinary work, as every Task before this. `evaluation`: a run of an
--     evaluation case (application/eval's trial runner starts it). Its Worker's Handle is closed —
--     its own Task, its tool list, its gate calls and its report, and the kernel refuses anything
--     else for it again (application/eval-session); every gate call is answered from the case's
--     fixtures, never a gate; its container's egress is denied (worker-supervisor `egressDenyAll`).
--
-- What the database holds to, whoever writes:
--   * `purpose` is set when the Task is created and never changes;
--   * an evaluation Task acts for the workspace's evaluation service principal (a `service`
--     principal named `__evaluation_service__`), and that principal acts in evaluation Tasks only —
--     so no ordinary Task runs as it and no evaluation Task runs as a person or an agent;
--   * an evaluation Task names an observation scope (its suite's fixture gates, GO11) and is no
--     goal step's attempt;
--   * an evaluation Task's WorkerRun is a root run: it neither starts under another run nor starts
--     another one (its Handle has no `invoke_worker`; this is the backstop).
--
-- Nullable, no backfill: every existing Task is ordinary work. Reversibility: the previous release
-- names its columns on every insert and select of `tasks` and never writes this one, and it never
-- creates a Task for the evaluation principal (no release before this one creates that principal),
-- so its inserts pass every check here. An evaluation Task left running when rolled back runs under
-- a release that does not close its Handle — release.md says to let evaluation runs end first.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0010.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists purpose text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_purpose') then
    alter table tasks add constraint tasks_purpose check (purpose is null or purpose = 'evaluation');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_evaluation_shape') then
    alter table tasks add constraint tasks_evaluation_shape check (
      purpose is distinct from 'evaluation'
      or (observe_scope is not null and goal_run_id is null and step_run_id is null)
    );
  end if;
end
$$;

-- Evaluation Tasks of a workspace, for the trial runner and the budget sum.
create index if not exists tasks_evaluation
  on tasks (workspace_id, created_at)
  where purpose = 'evaluation';

create or replace function tasks_purpose_guard() returns trigger
language plpgsql as $$
declare
  acts_for_evaluation boolean;
begin
  if tg_op = 'UPDATE' and new.purpose is distinct from old.purpose then
    raise exception 'tasks: a Task''s purpose never changes after it is created';
  end if;
  if tg_op = 'UPDATE' and new.on_behalf_of is not distinct from old.on_behalf_of then
    return new;
  end if;
  select (p.kind = 'service' and p.display_name = '__evaluation_service__')
    into acts_for_evaluation
    from principals p
   where p.workspace_id = new.workspace_id and p.id = new.on_behalf_of;
  if coalesce(acts_for_evaluation, false) <> (new.purpose is not distinct from 'evaluation') then
    raise exception 'tasks: an evaluation Task acts for the evaluation service principal, and that principal acts in evaluation Tasks only';
  end if;
  return new;
end;
$$;

create or replace trigger tasks_purpose_guard
  before insert or update of purpose, on_behalf_of on tasks
  for each row execute function tasks_purpose_guard();

create or replace function worker_runs_evaluation_root() returns trigger
language plpgsql as $$
begin
  if new.parent_worker_run_id is not null and (
    exists (
      select 1 from tasks t
       where t.workspace_id = new.workspace_id and t.id = new.task_id and t.purpose = 'evaluation'
    )
    or exists (
      select 1
        from worker_runs w
        join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
       where w.workspace_id = new.workspace_id and w.id = new.parent_worker_run_id
         and t.purpose = 'evaluation'
    )
  ) then
    raise exception 'worker_runs: an evaluation Task''s run neither starts under another run nor starts one';
  end if;
  return new;
end;
$$;

create or replace trigger worker_runs_evaluation_root
  before insert or update of parent_worker_run_id, task_id on worker_runs
  for each row execute function worker_runs_evaluation_root();
