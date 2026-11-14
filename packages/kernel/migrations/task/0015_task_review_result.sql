-- module: task, version: 0015
--
-- 0015_task_review_result (S11 GO18a follow-up; #493's review of #1102; goal/0019, task/0014): what
-- a review Task reported — its `result`, the scores goal/0019's `goal_review_assessments_guard`
-- recomputes an assessment from — is written once, by the update that completes the Task, and never
-- after. task/0014 already holds what the reviewer read (`input`) and whom it acts for; an assessment
-- rests on all three.
--
-- The kernel writes a Task's `result` only in completing it (`application/task/lifecycle.ts`:
-- status, completed_at and result in one update), so this changes nothing it does.
--
-- No column, no backfill. Reversibility (docs/runbooks/release.md §6): the previous release writes a
-- Task's result only with its completion, so its updates pass and code alone may roll back. To remove
-- it as well: `drop trigger tasks_review_result_guard on tasks`, `drop function
-- tasks_review_result_guard()`, then `delete from schema_migrations where module = 'task' and
-- version = 15`.
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0014.
select pg_advisory_xact_lock(7241000401);

create or replace function tasks_review_result_guard() returns trigger
language plpgsql as $$
begin
  if new.review_round is not null and new.result is distinct from old.result
     and (old.status = 'completed' or new.status is distinct from 'completed') then
    raise exception 'tasks: what a review Task reported is written once, when it completes';
  end if;
  return new;
end;
$$;

create or replace trigger tasks_review_result_guard
  before update of result on tasks
  for each row execute function tasks_review_result_guard();
