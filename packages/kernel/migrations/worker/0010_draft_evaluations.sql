-- module: worker, version: 0010
--
-- 0010_draft_evaluations (S10 E3-2b: docs/s10-evolution-plan-2026-10-04.md §3.2 EvalRun evaluated
-- / compared_to, §3.4 草稿的评测子状态, §5.5 四级漏斗 / 怎么判 / 账本恒等式, §5.6 评测运行详情).
-- A Skill draft evaluated against what it would replace, stage by stage (`@nexttime/shared`
-- wire/eval.ts `DraftEvaluationWire` says what one is; draft-evaluation.ts holds its rules). Owned
-- by `application/eval`; read by people through human-channel capabilities only and never put in
-- the graph (I-E4), like 0007–0009.
--
--   * `eval_draft_evaluations` — one row per evaluation a person started: the suite version and
--     WorkerDefinition version, the draft by family and version with what it said then (no foreign
--     key: a draft is deleted when discarded, rejected or expired, and the evaluation keeps what it
--     evaluated), the published version it is compared to (none for a new Skill), the other Skill
--     versions both arms load, the mechanism named and the case rows each stage runs — all fixed
--     when it starts. Then its state: the stage running, a note per stage (why it was skipped, what
--     it was estimated to cost), and once it ends the verdict, why and which stage decided it — or
--     who cancelled it.
--   * `eval_runs` take a second kind, `draft`: one stage of a draft evaluation, both arms
--     (`baseline`, `candidate`), at most one run per stage.
--   * `eval_trials` take a first status, `queued`: a draft run's trials wait for the kernel to start
--     their Task (the evaluation Principal runs only so many at once). A queued trial has no Task
--     and no start yet; it starts once (`running`, with its Task) or is cancelled
--     (`errored`/`cancelled`, never started).
--
-- Guards (what the database refuses whoever writes):
--   * an evaluation starts `running` at its first stage; what it compares and the case rows each
--     stage runs never change; its stage only moves forward; it ends once — `finished` with a
--     verdict, a reason that verdict can have and the stage that decided it, only when every stage
--     it ran is a finished run (§5.5 账本恒等式, as goal 0005's `goal_runs_status_guard` holds a
--     verdict's evidence whole) — or `cancelled` by a person, with no verdict; nothing changes
--     after; a note once written is kept; one running evaluation per draft;
--   * a draft run belongs to a running evaluation, holds both arms, and is that stage's only run;
--     a run finishes only when no trial is queued or running;
--   * a trial is queued without a Task or a start, or running with both; a queued trial starts
--     once or is cancelled; nothing a trial ran as changes after it started;
--   * a Skill draft a running evaluation names is not deleted (discard, reject, expiry).
-- No DELETE grant. The workspace purge cascade (application/platform/purge-workspace.ts) runs as
-- the owning role with triggers off and finds the new table by its `workspace_id`.
--
-- Reversible in schema: a new table, two columns nothing earlier writes, and checks that take what
-- the previous release wrote. Not in reads: a release without this migration cannot read a draft
-- run (`list_eval_runs` of a suite with one fails its result check) or a queued trial, so rolling
-- back past it after a draft evaluation ran degrades the suite's run list — release.md says so.
--
-- Advisory lock: same module key as 0001–0009.
select pg_advisory_xact_lock(7241000501);

-- ---------------------------------------------------------------------------------------------
-- eval_draft_evaluations
-- ---------------------------------------------------------------------------------------------

create table if not exists eval_draft_evaluations (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  suite_id uuid not null,
  suite_version int not null,
  worker_definition_id uuid not null,
  worker_definition_version int not null,
  skill_id uuid not null,
  skill_version int not null,
  draft_digest text not null,
  candidate_proposed_by uuid not null,
  candidate_name text not null,
  candidate_description text not null,
  candidate_markdown text not null,
  baseline_version int,
  other_skills jsonb not null,
  mechanism text,
  regression_case_ids uuid[] not null,
  mechanism_case_ids uuid[] not null,
  confirm_case_ids uuid[] not null,
  status text not null default 'running',
  stage text,
  verdict text,
  reason text,
  decided_by text,
  stage_notes jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  cancelled_by uuid,
  primary key (workspace_id, id),
  constraint eval_draft_evaluations_versions check (
    suite_version >= 1 and skill_version >= 1
    and (baseline_version is null or (baseline_version >= 1 and baseline_version <> skill_version))
  ),
  constraint eval_draft_evaluations_other_skills check (jsonb_typeof(other_skills) = 'array'),
  constraint eval_draft_evaluations_mechanism check (
    mechanism is null or char_length(mechanism) between 1 and 120
  ),
  constraint eval_draft_evaluations_cases check (
    coalesce(array_ndims(regression_case_ids), 1) = 1
    and coalesce(array_ndims(mechanism_case_ids), 1) = 1
    and coalesce(array_ndims(confirm_case_ids), 1) = 1
    and array_position(regression_case_ids, null) is null
    and array_position(mechanism_case_ids, null) is null
    and array_position(confirm_case_ids, null) is null
    and cardinality(regression_case_ids) + cardinality(mechanism_case_ids)
      + cardinality(confirm_case_ids) >= 1
    and (mechanism is not null or cardinality(mechanism_case_ids) = 0)
  ),
  constraint eval_draft_evaluations_status check (status in ('running', 'finished', 'cancelled')),
  constraint eval_draft_evaluations_stage check (
    (stage is null or stage in ('regression', 'mechanism', 'confirm'))
    and (status = 'running') = (stage is not null)
  ),
  constraint eval_draft_evaluations_verdict check (
    (status = 'finished') = (verdict is not null)
    and (verdict is null) = (reason is null)
    and (verdict is null) = (decided_by is null)
    and (decided_by is null or decided_by in ('regression', 'mechanism', 'confirm'))
    and (
      verdict is null
      or (verdict = 'regressed' and reason = 'regression_case_lost')
      or (verdict = 'refuted' and reason = 'mechanism_not_shown')
      or (verdict = 'worse' and reason = 'below_margin')
      or (verdict = 'better' and reason = 'above_baseline')
      or (verdict = 'non_inferior' and reason = 'within_margin')
      or (verdict = 'inconclusive' and reason in (
        'too_few_trials', 'holdout_disagrees', 'no_holdout_cases', 'no_confirm_cases',
        'errored_trials', 'budget'))
      or (verdict = 'unmeasured' and reason in ('environment_differs', 'environment_unknown'))
      or (verdict = 'contaminated' and reason in ('content_withheld', 'canary_reported'))
    )
  ),
  constraint eval_draft_evaluations_ended check (
    (status = 'running') = (finished_at is null)
    and (status = 'cancelled') = (cancelled_by is not null)
  ),
  constraint eval_draft_evaluations_notes check (jsonb_typeof(stage_notes) = 'object'),
  foreign key (workspace_id, suite_id) references eval_suites (workspace_id, id),
  foreign key (workspace_id, worker_definition_id, worker_definition_version)
    references worker_definitions (workspace_id, id, version),
  -- A published version is never deleted (skills_only_draft_delete), so the baseline stays.
  foreign key (workspace_id, skill_id, baseline_version)
    references skills (workspace_id, id, version),
  foreign key (workspace_id, candidate_proposed_by) references principals (workspace_id, id),
  foreign key (workspace_id, created_by) references principals (workspace_id, id),
  foreign key (workspace_id, cancelled_by) references principals (workspace_id, id)
);

-- One running evaluation per draft (§3.4: the draft's `evaluating` sub-state).
create unique index if not exists eval_draft_evaluations_one_running
  on eval_draft_evaluations (workspace_id, skill_id, skill_version)
  where status = 'running';
create index if not exists eval_draft_evaluations_skill
  on eval_draft_evaluations (workspace_id, skill_id, created_at desc);
create index if not exists eval_draft_evaluations_suite
  on eval_draft_evaluations (workspace_id, suite_id, created_at desc);

alter table eval_draft_evaluations enable row level security;
drop policy if exists eval_draft_evaluations_workspace_isolation on eval_draft_evaluations;
create policy eval_draft_evaluations_workspace_isolation on eval_draft_evaluations
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

grant select, insert, update on eval_draft_evaluations to nexttime_app;

-- ---------------------------------------------------------------------------------------------
-- eval_runs: the `draft` kind
-- ---------------------------------------------------------------------------------------------

alter table eval_runs add column if not exists draft_evaluation_id uuid;
alter table eval_runs add column if not exists stage text;

alter table eval_runs drop constraint if exists eval_runs_kind;
alter table eval_runs add constraint eval_runs_kind check (kind in ('case_trial', 'draft'));

alter table eval_runs drop constraint if exists eval_runs_arms;
alter table eval_runs add constraint eval_runs_arms check (
  cardinality(arms) >= 1
  and arms <@ array['baseline', 'candidate']::text[]
  and coalesce(array_ndims(arms), 1) = 1
);

alter table eval_runs drop constraint if exists eval_runs_draft;
alter table eval_runs add constraint eval_runs_draft check (
  (kind = 'draft') = (draft_evaluation_id is not null)
  and (kind = 'draft') = (stage is not null)
  and (stage is null or stage in ('regression', 'mechanism', 'confirm'))
  and (kind <> 'draft' or arms = array['baseline', 'candidate']::text[])
  and (kind = 'draft' or arms = array['baseline']::text[])
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_draft_evaluation_fk') then
    alter table eval_runs add constraint eval_runs_draft_evaluation_fk
      foreign key (workspace_id, draft_evaluation_id)
      references eval_draft_evaluations (workspace_id, id);
  end if;
end
$$;

-- One run per stage of an evaluation.
create unique index if not exists eval_runs_draft_stage
  on eval_runs (workspace_id, draft_evaluation_id, stage)
  where draft_evaluation_id is not null;

-- ---------------------------------------------------------------------------------------------
-- eval_trials: `queued`
-- ---------------------------------------------------------------------------------------------

alter table eval_trials alter column started_at drop not null;

alter table eval_trials drop constraint if exists eval_trials_status;
alter table eval_trials add constraint eval_trials_status check (
  status in ('queued', 'running', 'scored', 'errored')
);

alter table eval_trials drop constraint if exists eval_trials_finished;
alter table eval_trials add constraint eval_trials_finished check (
  (status in ('queued', 'running')) = (finished_at is null)
);

alter table eval_trials drop constraint if exists eval_trials_start;
alter table eval_trials add constraint eval_trials_start check (
  (task_id is null) = (started_at is null)
  and (status <> 'queued' or task_id is null)
  and (status not in ('running', 'scored') or task_id is not null)
);

-- The dispatcher's scan: queued trials, in their run's order.
create index if not exists eval_trials_queued
  on eval_trials (workspace_id, run_id)
  where status = 'queued';

-- ---------------------------------------------------------------------------------------------
-- guards
-- ---------------------------------------------------------------------------------------------

create or replace function eval_draft_evaluations_guard() returns trigger
language plpgsql as $$
declare
  stages constant text[] := array['regression', 'mechanism', 'confirm'];
  key text;
  unfinished int;
begin
  if tg_op = 'DELETE' then
    raise exception 'eval_draft_evaluations: an evaluation is kept, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'running' or new.verdict is not null or new.finished_at is not null
      or new.cancelled_by is not null then
      raise exception 'eval_draft_evaluations: an evaluation starts running, with no outcome yet';
    end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
    or new.id is distinct from old.id
    or new.suite_id is distinct from old.suite_id
    or new.suite_version is distinct from old.suite_version
    or new.worker_definition_id is distinct from old.worker_definition_id
    or new.worker_definition_version is distinct from old.worker_definition_version
    or new.skill_id is distinct from old.skill_id
    or new.skill_version is distinct from old.skill_version
    or new.draft_digest is distinct from old.draft_digest
    or new.candidate_proposed_by is distinct from old.candidate_proposed_by
    or new.candidate_name is distinct from old.candidate_name
    or new.candidate_description is distinct from old.candidate_description
    or new.candidate_markdown is distinct from old.candidate_markdown
    or new.baseline_version is distinct from old.baseline_version
    or new.other_skills is distinct from old.other_skills
    or new.mechanism is distinct from old.mechanism
    or new.regression_case_ids is distinct from old.regression_case_ids
    or new.mechanism_case_ids is distinct from old.mechanism_case_ids
    or new.confirm_case_ids is distinct from old.confirm_case_ids
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'eval_draft_evaluations: what an evaluation compares never changes';
  end if;
  if old.status <> 'running' then
    raise exception 'eval_draft_evaluations: an ended evaluation never changes';
  end if;
  for key in select jsonb_object_keys(old.stage_notes) loop
    if new.stage_notes -> key is distinct from old.stage_notes -> key then
      raise exception 'eval_draft_evaluations: a stage''s note is written once';
    end if;
  end loop;
  if new.status = 'running' then
    if array_position(stages, new.stage) < array_position(stages, old.stage) then
      raise exception 'eval_draft_evaluations: an evaluation''s stage only moves forward';
    end if;
    return new;
  end if;
  if new.status = 'finished' then
    select count(*)::int into unfinished
      from eval_runs
     where workspace_id = new.workspace_id and draft_evaluation_id = new.id
       and status <> 'finished';
    if unfinished <> 0 then
      raise exception 'eval_draft_evaluations: a verdict is written only when every stage it ran has finished (% still running)',
        unfinished;
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger eval_draft_evaluations_guard
  before insert or update or delete on eval_draft_evaluations
  for each row execute function eval_draft_evaluations_guard();

create or replace function eval_runs_guard() returns trigger
language plpgsql as $$
declare
  expected int;
  held int;
  open_trials int;
  evaluation_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'eval_runs: a run is kept, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'running' or new.finished_at is not null then
      raise exception 'eval_runs: a run starts running';
    end if;
    if new.kind = 'draft' then
      select status into evaluation_status
        from eval_draft_evaluations
       where workspace_id = new.workspace_id and id = new.draft_evaluation_id;
      if evaluation_status is distinct from 'running' then
        raise exception 'eval_runs: a draft run belongs to a running evaluation';
      end if;
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
    or new.draft_evaluation_id is distinct from old.draft_evaluation_id
    or new.stage is distinct from old.stage
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
  select count(*)::int, count(*) filter (where status in ('queued', 'running'))::int
    into held, open_trials
    from eval_trials
   where workspace_id = new.workspace_id and run_id = new.id;
  if held <> expected or open_trials <> 0 then
    raise exception 'eval_runs: a run finishes only with all % trials ended (it holds %, % still queued or running)',
      expected, held, open_trials;
  end if;
  return new;
end;
$$;

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
    if new.status not in ('queued', 'running') or new.finished_at is not null
      or new.verdict is not null or new.error is not null or new.result is not null
      or new.cost_usd is not null or new.tokens <> 0 or new.assertion_results <> '[]'::jsonb then
      raise exception 'eval_trials: a trial starts queued or running, with nothing recorded yet';
    end if;
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
    or new.id is distinct from old.id
    or new.run_id is distinct from old.run_id
    or new.arm is distinct from old.arm
    or new.case_id is distinct from old.case_id
    or new.rep is distinct from old.rep then
    raise exception 'eval_trials: what a trial ran for never changes';
  end if;
  if old.status = 'queued' then
    if new.status = 'running' then
      if new.task_id is null or new.started_at is null or new.result is not null
        or new.cost_usd is not null or new.tokens <> 0 or new.assertion_results <> '[]'::jsonb then
        raise exception 'eval_trials: a queued trial starts once, with its Task and nothing recorded yet';
      end if;
      return new;
    end if;
    if new.status = 'errored' and new.error = 'cancelled' and new.task_id is null
      and new.started_at is null then
      return new;
    end if;
    raise exception 'eval_trials: a queued trial starts or is cancelled';
  end if;
  if new.task_id is distinct from old.task_id or new.started_at is distinct from old.started_at then
    raise exception 'eval_trials: what a trial ran as never changes';
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

-- A Skill draft a running evaluation names stays until the evaluation ends (§3.4). The kernel
-- refuses first, with a reason (application/worker/draft-lifecycle.ts); this holds whoever deletes.
create or replace function skills_keep_evaluating_draft() returns trigger
language plpgsql as $$
begin
  if current_user = 'nexttime_app' and exists (
    select 1 from eval_draft_evaluations
     where workspace_id = old.workspace_id and skill_id = old.id
       and skill_version = old.version and status = 'running'
  ) then
    raise exception 'skills: draft %@% is being evaluated and is not deleted until the evaluation ends',
      old.id, old.version
      using errcode = '55006';
  end if;
  return old;
end;
$$;

create or replace trigger skills_keep_evaluating_draft
  before delete on skills
  for each row execute function skills_keep_evaluating_draft();
