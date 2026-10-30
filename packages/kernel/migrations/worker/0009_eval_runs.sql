-- module: worker, version: 0009
--
-- 0009_eval_runs (S10 E3-2a: docs/s10-evolution-plan-2026-10-04.md §3.1 EvalRun, §3.3 I-E1/I-E4,
-- §5.5 账本恒等式, §5.6 评测运行详情). Evaluation runs, their trials and every fixture call a
-- trial's Worker made (`@nexttime/shared` wire/eval.ts says what each holds). Owned by
-- `application/eval` (runs, trials, scoring) and `application/eval-session` (a trial's calls, as its
-- Worker makes them); read by people through human-channel capabilities only and never put in the
-- graph (I-E4), like 0007 and 0008.
--
--   * `eval_runs` — one row per run a person started: the suite version and the WorkerDefinition
--     version it ran, its arms, its case rows and `k`. `running` until every trial has ended, then
--     `finished`.
--   * `eval_trials` — one row per (run, arm, case row, try): the evaluation Task it ran as
--     (`tasks.purpose = 'evaluation'`, task/0011), then how it came out — `scored` with a verdict
--     and each assertion's outcome, or `errored` with how it ended. What its Worker reported and
--     what its model calls cost are kept with it.
--   * `eval_trial_calls` — one row per call the trial's Worker made to a fixture gate, in order:
--     what it asked, which rule of the case answered (none: `unanswered`) and how.
--
-- Guards (what the database refuses whoever writes):
--   * a run starts `running`; it changes once, to `finished`, and only when it holds exactly
--     arms × cases × k trials, every one of them ended (§5.5 账本恒等式, as goal 0005's
--     `goal_runs_status_guard` checks a verdict's evidence is whole); nothing else of a run changes;
--   * a trial belongs to a running run, its arm, case row and try within the run's; it starts
--     `running`, ends once — `scored` with a verdict, or `errored` with how — and never changes
--     after; what it ran as and for never changes;
--   * a call is added only to a running trial, numbered one after the last; a call never changes.
-- No DELETE grant. The workspace purge cascade (application/platform/purge-workspace.ts) runs as
-- the owning role with triggers off and finds these tables by their `workspace_id`.
--
-- Reversible: three new tables nothing earlier reads or writes; a release without evaluation runs
-- runs on this schema unchanged.
--
-- Advisory lock: same module key as 0001–0008.
select pg_advisory_xact_lock(7241000501);

-- ---------------------------------------------------------------------------------------------
-- eval_runs
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_runs (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  suite_id uuid not null,
  suite_version int not null,
  kind text not null,
  worker_definition_id uuid not null,
  worker_definition_version int not null,
  arms text[] not null,
  case_ids uuid[] not null,
  k int not null,
  status text not null default 'running',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (workspace_id, id),
  constraint eval_runs_kind check (kind in ('case_trial')),
  constraint eval_runs_suite_version check (suite_version >= 1),
  constraint eval_runs_arms check (
    cardinality(arms) >= 1
    and arms <@ array['baseline']::text[]
    and coalesce(array_ndims(arms), 1) = 1
  ),
  constraint eval_runs_cases check (
    cardinality(case_ids) >= 1
    and coalesce(array_ndims(case_ids), 1) = 1
    and array_position(case_ids, null) is null
  ),
  constraint eval_runs_k check (k between 1 and 100),
  constraint eval_runs_case_trial check (
    kind <> 'case_trial' or (cardinality(arms) = 1 and cardinality(case_ids) = 1 and k = 1)
  ),
  constraint eval_runs_status check (status in ('running', 'finished')),
  constraint eval_runs_finished check ((status = 'finished') = (finished_at is not null)),
  foreign key (workspace_id, suite_id) references eval_suites (workspace_id, id),
  foreign key (workspace_id, worker_definition_id, worker_definition_version)
    references worker_definitions (workspace_id, id, version),
  foreign key (workspace_id, created_by) references principals (workspace_id, id)
);

create index if not exists eval_runs_suite on eval_runs (workspace_id, suite_id, created_at desc);

alter table eval_runs enable row level security;
drop policy if exists eval_runs_workspace_isolation on eval_runs;
create policy eval_runs_workspace_isolation on eval_runs
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on eval_runs to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- eval_trials
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_trials (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  run_id uuid not null,
  arm text not null,
  case_id uuid not null,
  rep int not null,
  task_id uuid,
  status text not null default 'running',
  verdict text,
  error text,
  assertion_results jsonb not null default '[]'::jsonb,
  result jsonb,
  cost_usd numeric,
  tokens bigint not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (workspace_id, id),
  constraint eval_trials_status check (status in ('running', 'scored', 'errored')),
  constraint eval_trials_verdict check (
    (status = 'scored') = (verdict is not null) and (verdict is null or verdict in ('passed', 'failed'))
  ),
  constraint eval_trials_error check (
    (status = 'errored') = (error is not null) and (error is null or char_length(error) between 1 and 64)
  ),
  constraint eval_trials_finished check ((status = 'running') = (finished_at is null)),
  constraint eval_trials_assertions check (jsonb_typeof(assertion_results) = 'array'),
  constraint eval_trials_measures check (tokens >= 0 and (cost_usd is null or cost_usd >= 0)),
  foreign key (workspace_id, run_id) references eval_runs (workspace_id, id),
  foreign key (workspace_id, case_id) references eval_cases (workspace_id, id),
  foreign key (workspace_id, task_id) references tasks (workspace_id, id)
);

-- §5.5 账本恒等式: one trial per (run, arm, case row, try).
create unique index if not exists eval_trials_ledger
  on eval_trials (workspace_id, run_id, arm, case_id, rep);
-- One trial per evaluation Task.
create unique index if not exists eval_trials_task
  on eval_trials (workspace_id, task_id)
  where task_id is not null;
-- The trial runner's scan: running trials only.
create index if not exists eval_trials_running
  on eval_trials (workspace_id, started_at)
  where status = 'running';

alter table eval_trials enable row level security;
drop policy if exists eval_trials_workspace_isolation on eval_trials;
create policy eval_trials_workspace_isolation on eval_trials
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on eval_trials to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- eval_trial_calls
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_trial_calls (
  workspace_id uuid not null,
  trial_id uuid not null,
  seq int not null,
  gatekeeper_id uuid not null,
  gate_name text not null,
  operation text not null,
  mode text not null,
  params jsonb not null,
  rule_index int,
  answer text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, trial_id, seq),
  constraint eval_trial_calls_seq check (seq >= 1),
  constraint eval_trial_calls_mode check (mode in ('observe', 'execute')),
  constraint eval_trial_calls_params check (jsonb_typeof(params) = 'object'),
  constraint eval_trial_calls_answer check (
    answer in ('data', 'absent', 'error', 'unanswered')
    and (answer = 'unanswered') = (rule_index is null)
    and (rule_index is null or rule_index >= 0)
  ),
  foreign key (workspace_id, trial_id) references eval_trials (workspace_id, id)
);

alter table eval_trial_calls enable row level security;
drop policy if exists eval_trial_calls_workspace_isolation on eval_trial_calls;
create policy eval_trial_calls_workspace_isolation on eval_trial_calls
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert on eval_trial_calls to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- guards
-- ---------------------------------------------------------------------------------------------

create or replace function eval_runs_guard() returns trigger
language plpgsql as $$
declare
  expected int;
  held int;
  open_trials int;
begin
  if tg_op = 'DELETE' then
    raise exception 'eval_runs: a run is kept, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'running' or new.finished_at is not null then
      raise exception 'eval_runs: a run starts running';
    end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
    or new.id is distinct from old.id
    or new.suite_id is distinct from old.suite_id
    or new.suite_version is distinct from old.suite_version
    or new.kind is distinct from old.kind
    or new.worker_definition_id is distinct from old.worker_definition_id
    or new.worker_definition_version is distinct from old.worker_definition_version
    or new.arms is distinct from old.arms
    or new.case_ids is distinct from old.case_ids
    or new.k is distinct from old.k
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'eval_runs: what a run ran never changes';
  end if;
  if new.status is not distinct from old.status then
    if new.finished_at is distinct from old.finished_at then
      raise exception 'eval_runs: a run''s end is recorded once, when it finishes';
    end if;
    return new;
  end if;
  if old.status <> 'running' or new.status <> 'finished' then
    raise exception 'eval_runs: a run goes from running to finished, once';
  end if;
  expected := cardinality(new.arms) * cardinality(new.case_ids) * new.k;
  select count(*)::int, count(*) filter (where status = 'running')::int
    into held, open_trials
    from eval_trials
   where workspace_id = new.workspace_id and run_id = new.id;
  if held <> expected or open_trials <> 0 then
    raise exception 'eval_runs: a run finishes only with all % trials ended (it holds %, % still running)',
      expected, held, open_trials;
  end if;
  return new;
end;
$$;

create or replace trigger eval_runs_guard
  before insert or update or delete on eval_runs
  for each row execute function eval_runs_guard();

create or replace function eval_trials_guard() returns trigger
language plpgsql as $$
declare
  run record;
begin
  if tg_op = 'DELETE' then
    raise exception 'eval_trials: a trial is kept, never deleted';
  end if;
  if tg_op = 'INSERT' then
    select status, arms, case_ids, k into run
      from eval_runs
     where workspace_id = new.workspace_id and id = new.run_id;
    if run.status is distinct from 'running' then
      raise exception 'eval_trials: a trial is added to a running run';
    end if;
    if not (new.arm = any(run.arms)) or not (new.case_id = any(run.case_ids))
      or new.rep < 1 or new.rep > run.k then
      raise exception 'eval_trials: a trial''s arm, case and try are the run''s own';
    end if;
    if new.status <> 'running' or new.finished_at is not null or new.verdict is not null
      or new.error is not null or new.result is not null or new.cost_usd is not null
      or new.tokens <> 0 or new.assertion_results <> '[]'::jsonb then
      raise exception 'eval_trials: a trial starts running, with nothing recorded yet';
    end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
    or new.id is distinct from old.id
    or new.run_id is distinct from old.run_id
    or new.arm is distinct from old.arm
    or new.case_id is distinct from old.case_id
    or new.rep is distinct from old.rep
    or new.task_id is distinct from old.task_id
    or new.started_at is distinct from old.started_at then
    raise exception 'eval_trials: what a trial ran as and for never changes';
  end if;
  if old.status <> 'running' then
    raise exception 'eval_trials: an ended trial never changes';
  end if;
  if new.status = 'running' then
    raise exception 'eval_trials: a running trial changes only by ending';
  end if;
  return new;
end;
$$;

create or replace trigger eval_trials_guard
  before insert or update or delete on eval_trials
  for each row execute function eval_trials_guard();

create or replace function eval_trial_calls_guard() returns trigger
language plpgsql as $$
declare
  trial_status text;
  last_seq int;
begin
  if tg_op <> 'INSERT' then
    raise exception 'eval_trial_calls: a call is kept as made, never changed or deleted';
  end if;
  select status into trial_status
    from eval_trials
   where workspace_id = new.workspace_id and id = new.trial_id
     for update;
  if trial_status is distinct from 'running' then
    raise exception 'eval_trial_calls: a call is recorded only while its trial runs';
  end if;
  select coalesce(max(seq), 0) into last_seq
    from eval_trial_calls
   where workspace_id = new.workspace_id and trial_id = new.trial_id;
  if new.seq <> last_seq + 1 then
    raise exception 'eval_trial_calls: calls are numbered in order (next is %)', last_seq + 1;
  end if;
  return new;
end;
$$;

create or replace trigger eval_trial_calls_guard
  before insert or update or delete on eval_trial_calls
  for each row execute function eval_trial_calls_guard();
