-- module: task, version: 0014
--
-- 0014_task_review (S11 GO18; plan §4.6, I-G5; goal/0019; s11-w4/go18-default-plan.md): the
-- reviewer's Task. When a verifying GoalRun's round reaches a `review` acceptance check — every
-- check the platform makes passed — the advancer starts one Task for it
-- (`application/task/review-task.ts`):
--
--   * `purpose = 'review'` with `review_round` and `review_check_key` — the check it reviews for
--     (goal/0019's `goal_acceptance_checks` row); set together, when the Task is created, never
--     changed. One Task per check: a review is tried once, never retried.
--   * It is a Task of the GoalRun (`goal_run_id`, and `plan_revision` = the check's revision) but
--     of no step and no planning round. A Task of a GoalRun is now a step's Task, a planning Task
--     or a review Task, exactly one.
--   * It acts for the GoalRun's requester (`on_behalf_of`), whom the review stands in for.
--   * Its Workers observe nothing (`observe_scope = '{}'`) and it carries an output contract
--     (`output_schema`: the reviewer's report, `@nexttime/shared` `REVIEWER_OUTPUT_SCHEMA`).
--   * Its WorkerRun is a root run: it neither starts under another run nor starts one (its Handle
--     has no `invoke_worker`; this is the backstop, as for an evaluation or a planning Task).
--   * `goal_review_assessments.review_task_id` (goal/0019) references it, and its `input` — what
--     the reviewer read: the reviewed steps' output and the check's criteria — never changes
--     (independent review N3: the record an assessment rests on).
--
-- Nullable, no backfill: no Task before this one reviews. Reversibility: the previous release
-- names its columns on every insert and select of `tasks` and never writes these; its goal Tasks
-- are step or planning Tasks, so its inserts pass every check here. A review Task left running
-- when rolled back is a Task of no step and no round to that release: its report moves nothing,
-- and it is not retried after a crash (that release retries only Tasks with no purpose), so it
-- never restarts outside the deny-all egress it was spawned with. release.md says to let a
-- verifying run's review end first.
--
-- Runner ordering: `goal` sorts before `task`, so goal/0019's checks and assessments exist when
-- this runs. Cross-process bootstrap lock: same `task`-module key as 0001–0013.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists review_round int;
alter table tasks add column if not exists review_check_key text;

do $$
begin
  -- task/0012's check, widened by one purpose.
  alter table tasks drop constraint if exists tasks_purpose;
  alter table tasks add constraint tasks_purpose
    check (purpose is null or purpose in ('evaluation', 'planning', 'review'));

  -- task/0012's check, rewritten: a Task of a GoalRun names the revision it runs under and is
  -- exactly one of a step's Task, a round's planning Task or a check's review Task; a Task of no
  -- GoalRun is none of them.
  alter table tasks drop constraint if exists tasks_goal_step_ref;
  alter table tasks add constraint tasks_goal_step_ref check (
    (goal_run_id is null) = (plan_revision is null)
    and (goal_run_id is null)
        = (step_run_id is null and planning_round_id is null and review_round is null)
    and num_nonnulls(step_run_id, planning_round_id, review_round) <= 1
  );

  -- task/0012's check, rewritten: an output contract is an attempt's, a planning Task's or a
  -- review Task's.
  alter table tasks drop constraint if exists tasks_output_schema;
  alter table tasks add constraint tasks_output_schema check (
    output_schema is null
    or (
      jsonb_typeof(output_schema) = 'object'
      and (step_attempt is not null or planning_round_id is not null or review_round is not null)
    )
  );

  if not exists (select 1 from pg_constraint where conname = 'tasks_review_shape') then
    alter table tasks add constraint tasks_review_shape check (
      (purpose is not distinct from 'review') = (review_round is not null)
      and (review_round is null) = (review_check_key is null)
      and (
        review_round is null
        or (
          review_round >= 1
          and observe_scope is not null and cardinality(observe_scope) = 0
          and output_schema is not null
        )
      )
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tasks_review_check_fkey') then
    alter table tasks
      add constraint tasks_review_check_fkey
      foreign key (workspace_id, goal_run_id, review_round, review_check_key)
      references goal_acceptance_checks (workspace_id, goal_run_id, round, check_key);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'goal_review_assessments_task_fkey'
  ) then
    alter table goal_review_assessments
      add constraint goal_review_assessments_task_fkey
      foreign key (workspace_id, review_task_id) references tasks (workspace_id, id);
  end if;
end
$$;

-- One Task per review check.
create unique index if not exists tasks_review_check_uidx
  on tasks (workspace_id, goal_run_id, review_round, review_check_key)
  where review_round is not null;

create or replace function tasks_review_guard() returns trigger
language plpgsql as $$
declare
  chk record;
begin
  if tg_op = 'UPDATE' then
    if new.review_round is distinct from old.review_round
       or new.review_check_key is distinct from old.review_check_key then
      raise exception 'tasks: the review check of a Task never changes after it is created';
    end if;
    if new.review_round is not null and new.on_behalf_of is distinct from old.on_behalf_of then
      raise exception 'tasks: a review Task acts for the requester it was created for';
    end if;
    -- What the reviewer read — the reviewed steps' output and the criteria — is the record its
    -- assessment rests on (independent review N3): written once, with the Task.
    if new.review_round is not null and new.input is distinct from old.input then
      raise exception 'tasks: what a review Task reads never changes after it is created';
    end if;
    return new;
  end if;
  if new.review_round is null then
    return new;
  end if;
  select c.kind, c.status, c.attempts, c.plan_revision, g.status as goal_status, g.on_behalf_of
    into chk
    from goal_acceptance_checks c
    join goal_runs g on g.workspace_id = c.workspace_id and g.id = c.goal_run_id
   where c.workspace_id = new.workspace_id and c.goal_run_id = new.goal_run_id
     and c.round = new.review_round and c.check_key = new.review_check_key;
  if chk.kind is distinct from 'review' or chk.status is distinct from 'pending'
     or chk.attempts <> 0 then
    raise exception 'tasks: a review Task starts for an untried, pending review check';
  end if;
  if chk.goal_status is distinct from 'verifying' then
    raise exception 'tasks: a review Task starts while its goal run is verifying';
  end if;
  if new.plan_revision is distinct from chk.plan_revision then
    raise exception 'tasks: a review Task runs under the revision its check was declared in';
  end if;
  if new.on_behalf_of is distinct from chk.on_behalf_of then
    raise exception 'tasks: a review Task acts for the requester of its goal run';
  end if;
  return new;
end;
$$;

create or replace trigger tasks_review_guard
  before insert or update of review_round, review_check_key, on_behalf_of, input on tasks
  for each row execute function tasks_review_guard();

-- A review Task's run is a root run, as a planning Task's is (task/0012).
create or replace function worker_runs_review_root() returns trigger
language plpgsql as $$
begin
  if new.parent_worker_run_id is not null and (
    exists (
      select 1 from tasks t
       where t.workspace_id = new.workspace_id and t.id = new.task_id and t.purpose = 'review'
    )
    or exists (
      select 1
        from worker_runs w
        join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
       where w.workspace_id = new.workspace_id and w.id = new.parent_worker_run_id
         and t.purpose = 'review'
    )
  ) then
    raise exception 'worker_runs: a review Task''s run neither starts under another run nor starts one';
  end if;
  return new;
end;
$$;

create or replace trigger worker_runs_review_root
  before insert or update of parent_worker_run_id, task_id on worker_runs
  for each row execute function worker_runs_review_root();
