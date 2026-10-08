-- module: task, version: 0006
--
-- S10 E1 结果归因 (docs/s10-evolution-plan-2026-10-04.md §3.1 / §3.4 / §5.3, development-tasks.md
-- §5h): the *objective outcome* ("做对了吗") — `achieved` / `not_achieved`, kept apart from the
-- execution status ("跑完了吗": `tasks.status`, `activities.status`). Absence is `unknown`, the
-- default for every Turn and Task, old or new: nothing here backfills, so an old row reads as "not
-- recorded", never as a guess.
--
-- Two subjects, two givers (maintainer decision 7, "两者都可"):
--   * a Turn — marked by the requester in the conversation (`mark_turn_outcome`, human channel).
--     A Turn is an `activities` row (core); core is not this module's to migrate, so the outcome
--     is a 1:1 side table keyed by the Turn, `turn_outcomes`, with real FKs (core sorts first).
--   * a Task — reported by the entry agent from a Procedure's `verify` step
--     (`report_task_outcome`, Handle channel, entry ceiling only — a Worker never grades its own
--     Task). Columns on `tasks` itself.
--
-- Lifecycle (§3.4): `unknown → achieved | not_achieved`; the same giver may correct it once
-- (revision 1 → 2, to the other value), the correction is audited through the capability call's
-- own AuditRecord and `previous_outcome` keeps what it was. Who may give it and that a correction
-- comes from the same giver are enforced in the one write path of each (application/task
-- `attribution.ts`, a guarded UPDATE); the CHECKs below make the shapes that path never
-- writes unrepresentable.
--
-- `worker_runs.skills_recorded`: `worker_run_skills` (worker/0004) has no row both for a run that
-- loaded no Skill and for a run from before E1; this flag says which. Existing rows stay `false`
-- ("未记录"); `spawnWorkerRun` sets it `true` in the same INSERT that creates the run, in the same
-- transaction as the `worker_run_skills` rows.
select pg_advisory_xact_lock(7241000401);

alter table tasks add column if not exists objective_outcome text;
alter table tasks add column if not exists outcome_given_by uuid;
alter table tasks add column if not exists outcome_given_at timestamptz;
alter table tasks add column if not exists outcome_revision int;
alter table tasks add column if not exists outcome_previous text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_objective_outcome_check') then
    alter table tasks add constraint tasks_objective_outcome_check check (
      (objective_outcome is null
        and outcome_given_by is null and outcome_given_at is null
        and outcome_revision is null and outcome_previous is null)
      or (objective_outcome in ('achieved', 'not_achieved')
        and outcome_given_by is not null and outcome_given_at is not null
        and outcome_revision between 1 and 2
        and ((outcome_revision = 1 and outcome_previous is null)
          or (outcome_revision = 2 and outcome_previous in ('achieved', 'not_achieved')
              and outcome_previous <> objective_outcome)))
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_outcome_given_by_fkey') then
    alter table tasks
      add constraint tasks_outcome_given_by_fkey
      foreign key (workspace_id, outcome_given_by) references principals (workspace_id, id);
  end if;
end
$$;

alter table worker_runs add column if not exists skills_recorded boolean not null default false;

create table if not exists turn_outcomes (
  workspace_id uuid not null,
  turn_id uuid not null,
  outcome text not null check (outcome in ('achieved', 'not_achieved')),
  given_by uuid not null,
  given_at timestamptz not null default now(),
  revision int not null default 1,
  previous_outcome text,
  primary key (workspace_id, turn_id),
  foreign key (workspace_id, turn_id) references activities (workspace_id, id),
  foreign key (workspace_id, given_by) references principals (workspace_id, id),
  check (
    (revision = 1 and previous_outcome is null)
    or (revision = 2 and previous_outcome in ('achieved', 'not_achieved')
        and previous_outcome <> outcome)
  )
);

alter table turn_outcomes enable row level security;

drop policy if exists turn_outcomes_workspace_isolation on turn_outcomes;

-- Workspace-only, the same choice `tasks` made (task/0001): a row is only ever read or written
-- through a capability that has already resolved the Turn under `activities`' own chat-visibility
-- RLS (`mark_turn_outcome`, `list_chat_turns`) or the Task under `taskVisibleTo` (`get_task`).
create policy turn_outcomes_workspace_isolation on turn_outcomes
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- No delete: an outcome is corrected, never withdrawn (§3.4).
grant select, insert, update on turn_outcomes to nexttime_app;
