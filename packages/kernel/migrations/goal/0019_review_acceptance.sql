-- module: goal, version: 0019
--
-- 0019_review_acceptance (S11 GO18; plan §4.6, I-G5; s11-w4/go18-default-plan.md): a goal's
-- acceptance may hold an independent review (`review`) — a reviewer Worker the kernel starts once
-- every check of the round the platform makes has passed, which scores what the steps named in
-- the check produced against the check's criteria (`application/goal/review.ts`). Whether the
-- review passes is the platform's arithmetic over those scores (`@nexttime/shared`
-- `reviewDerivation`), never the reviewer's word. What that means for the schema:
--
--   * `goal_acceptance_checks.review_check`: a review's declaration as the plan holds it, without
--     its `kind` and `key` (`subjects`, `criteria`, `passAt`, optionally `model`), matched against
--     the plan like every other kind; the kind and shape CHECKs take it, and a review is tried at
--     most once (no retry: a crashed reviewer leaves the review `unavailable`);
--   * `goal_review_assessments`: what a review came to, written once and never changed — the
--     reviewer Task, the model it ran on and the models of the steps it reviewed (and whether one
--     of them is the reviewer's: `same_model`), and the derivation line by line. Its guard
--     recomputes the derivation from the reviewer Task's own report and the check's criteria, so
--     no score the reviewer did not give and no verdict the arithmetic does not give can be
--     recorded; the reviewer model and the executors' are those their WorkerRuns record;
--   * `goal_acceptance_checks_guard` (redefined whole from goal/0011): a review is tried only by
--     starting its reviewer Task (task/0014); it passes or fails only on its assessment, with that
--     verdict, and is `unavailable` only without an assessment that decided — then under a code of
--     `REVIEW_UNAVAILABLE_CODE_VALUES` only (its last error reaches the goal planner, precedents
--     and outcome Decisions); a confirmation in a round with a review passes only after every
--     review of that round passed (F7: the requester's word comes after the review);
--   * `goal_runs_status_guard` (redefined whole from goal/0011; I-G5): `achieved` on
--     `reviewer_assessed` — refused until now — only out of `verifying`, every check of the
--     latest round passed on the current plan, at least one a review and none the requester's
--     confirmation; `verified_by_check` no longer for a round with a review (the review is a proxy
--     indicator and stays out of the platform-checked count). With a review and the requester's
--     confirmation, the outcome rests on the requester's word (`requester`), as before.
--
-- Nothing else in the redefined functions changes. No backfill: no row is a review before this
-- migration, so every existing row has `review_check` null and the new CHECKs hold for it.
--
-- Rolling back (docs/runbooks/release.md §6): the previous release's plan schema refuses a plan
-- declaring a review, so it advances no goal that holds one — it pauses it for a person
-- (`needs_decision`: the revision's acceptance is unreadable) — and its scans list only the kinds
-- it knows. Restoring goal/0011's two functions makes `reviewer_assessed` unrecordable again; a
-- run already completed on it keeps its row (the guard reads transitions, not rows at rest).
-- Count those first (`release.md`). The table and column may stay: nothing of the previous
-- release reads them.
--
-- Runner ordering: `goal` sorts before `task`, so `tasks.review_round` (task/0014) does not exist
-- yet when this runs; only function bodies name it, and they are read when they run. The
-- assessment's foreign key to its Task is task/0014's.
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0018.
select pg_advisory_xact_lock(7241000701);

-- ----- a goal's checks ------------------------------------------------------------------------

alter table goal_acceptance_checks add column if not exists review_check jsonb;

alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_kind,
  add constraint goal_acceptance_checks_kind
    check (kind in ('observe_predicate', 'observe_absent', 'fact_predicate', 'requester_confirm',
                    'review'));

-- As goal/0011, and: a review carries its declaration and nothing else — no call, no Fact, no
-- prompt, no evidence column (its evidence is its assessment) — and is tried at most once; every
-- other kind carries no review.
alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_shape,
  add constraint goal_acceptance_checks_shape check (
    case kind
      when 'observe_predicate' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and observation_check ? 'expect'
        and fact_check is null and fact_id is null and prompt is null and decision_id is null
        and review_check is null
      when 'observe_absent' then
        observation_check is not null and jsonb_typeof(observation_check) = 'object'
        and not (observation_check ? 'expect')
        and fact_check is null and fact_id is null and prompt is null and decision_id is null
        and review_check is null
      when 'fact_predicate' then
        fact_check is not null and jsonb_typeof(fact_check) = 'object'
        and observation_check is null and observation_id is null and prompt is null
        and decision_id is null and review_check is null
      when 'review' then
        review_check is not null and jsonb_typeof(review_check) = 'object'
        and jsonb_typeof(review_check -> 'criteria') = 'array'
        and jsonb_typeof(review_check -> 'subjects') = 'array'
        and jsonb_typeof(review_check -> 'passAt') = 'number'
        and observation_check is null and fact_check is null and prompt is null
        and observation_id is null and fact_id is null and decision_id is null and attempts <= 1
      else
        observation_check is null and fact_check is null and prompt is not null
        and char_length(prompt) > 0 and attempts = 0 and observation_id is null
        and fact_id is null and last_error is null and review_check is null
    end
  );

-- As goal/0011, and: a review fails, is unavailable or passes on its own evidence — its
-- assessment, or for `unavailable` the reason in `last_error` — which the guard holds it to.
alter table goal_acceptance_checks
  drop constraint if exists goal_acceptance_checks_evidence,
  add constraint goal_acceptance_checks_evidence check (
    (status <> 'failed'
     or (case kind when 'fact_predicate' then fact_id is not null
                   when 'review' then true
                   else observation_id is not null end))
    and (status not in ('failed', 'unavailable')
         or kind in ('observe_predicate', 'observe_absent', 'fact_predicate', 'review'))
    and (status <> 'unavailable' or kind <> 'review' or last_error is not null)
    -- A review's last error is a code of `@nexttime/shared` `REVIEW_UNAVAILABLE_CODE_VALUES` and
    -- nothing else: it reaches the goal planner, precedents and a person's outcome Decision, so it
    -- never carries a criterion, a score or a reviewer's words (F5).
    and (kind <> 'review' or last_error is null
         or last_error in ('review_unreadable', 'model_not_offered', 'model_not_allowed',
                           'reviewer_unpublished', 'subject_missing', 'no_budget',
                           'daily_cost_exceeded', 'depth_exceeded', 'requester_cannot_start',
                           'reviewer_task_missing', 'reviewer_failed', 'report_unreadable',
                           'criteria_unassessed'))
    and (status <> 'passed'
         or (case kind when 'observe_predicate' then observation_id is not null
                       when 'observe_absent' then observation_id is not null
                       when 'fact_predicate' then fact_id is not null
                       when 'review' then true
                       else decision_id is not null end))
  );

-- ----- what a review came to ------------------------------------------------------------------

create table if not exists goal_review_assessments (
  workspace_id uuid not null,
  goal_run_id uuid not null,
  round int not null,
  check_key text not null,
  -- The reviewer Task whose report this is (foreign key: task/0014).
  review_task_id uuid not null,
  -- The model the reviewer ran on, as its WorkerRun records it (null: the runtime's default).
  reviewer_model text,
  -- The steps it reviewed that ran: [{stepKey, attempt, model}] — each one's accepted attempt and
  -- the model its WorkerRun records.
  executor_models jsonb not null,
  -- Whether one of them ran on the reviewer's model: true when one names the same model (two
  -- defaults count as the same), null when that cannot be told (one ran on the runtime's default
  -- and the other names a model, which may be the default), false otherwise.
  same_model boolean,
  -- The derivation, in the check's criteria order: [{criterion, weight, score, reason, points,
  -- maxPoints}] (`@nexttime/shared` `ReviewDerivationLine`).
  lines jsonb not null,
  comment text,
  points int not null,
  max_points int not null,
  pass_at int not null,
  -- The criteria the reviewer could not judge, in order.
  unassessed jsonb not null,
  verdict text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, goal_run_id, round, check_key),
  foreign key (workspace_id, goal_run_id, round, check_key)
    references goal_acceptance_checks (workspace_id, goal_run_id, round, check_key),
  constraint goal_review_assessments_verdict check (verdict in ('passed', 'failed', 'unavailable')),
  constraint goal_review_assessments_shape check (
    jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) >= 1
    and jsonb_typeof(executor_models) = 'array' and jsonb_typeof(unassessed) = 'array'
    and points >= 0 and max_points > 0 and points <= max_points
    and pass_at between 1 and 100
    and (comment is null or char_length(comment) between 1 and 2000)
  )
);

create index if not exists goal_review_assessments_task_idx
  on goal_review_assessments (workspace_id, review_task_id);

alter table goal_review_assessments enable row level security;
drop policy if exists goal_review_assessments_workspace_isolation on goal_review_assessments;
create policy goal_review_assessments_workspace_isolation on goal_review_assessments
  for all
  using (workspace_id = app_workspace())
  with check (workspace_id = app_workspace());

-- Written once, never changed or deleted: a verification's history stays with its run.
grant select, insert on goal_review_assessments to nexttime_app;

create or replace function goal_review_assessments_guard() returns trigger
language plpgsql as $$
declare
  chk record;
  goal_status text;
  task record;
  criteria jsonb;
  reported jsonb;
  criterion jsonb;
  line jsonb;
  score jsonb;
  weight int;
  total int := 0;
  most int := 0;
  missing jsonb := '[]'::jsonb;
  executor jsonb;
  ran int;
  expected_verdict text;
  i int;
begin
  if tg_op <> 'INSERT' then
    raise exception 'goal_review_assessments: an assessment is written once and never changed';
  end if;
  select c.kind, c.status, c.review_check into chk
    from goal_acceptance_checks c
   where c.workspace_id = new.workspace_id and c.goal_run_id = new.goal_run_id
     and c.round = new.round and c.check_key = new.check_key;
  if chk.kind is distinct from 'review' or chk.status is distinct from 'pending' then
    raise exception 'goal_review_assessments: an assessment is of a pending review';
  end if;
  select g.status into goal_status
    from goal_runs g where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;
  if goal_status is distinct from 'verifying' then
    raise exception 'goal_review_assessments: a review is assessed while its goal run is verifying';
  end if;
  select t.purpose, t.goal_run_id, t.review_round, t.review_check_key, t.status, t.result
    into task
    from tasks t where t.workspace_id = new.workspace_id and t.id = new.review_task_id;
  if task.purpose is distinct from 'review' or task.goal_run_id is distinct from new.goal_run_id
     or task.review_round is distinct from new.round
     or task.review_check_key is distinct from new.check_key
     or task.status is distinct from 'completed' then
    raise exception 'goal_review_assessments: an assessment rests on the completed reviewer Task of its review';
  end if;

  -- The derivation, recomputed from the reviewer's own report and the check's criteria.
  criteria := chk.review_check -> 'criteria';
  reported := task.result -> 'output' -> 'scores';
  if jsonb_typeof(reported) is distinct from 'array'
     or jsonb_array_length(reported) <> jsonb_array_length(criteria)
     or jsonb_array_length(new.lines) <> jsonb_array_length(criteria)
     or (select count(distinct s ->> 'criterion') from jsonb_array_elements(reported) s)
        <> jsonb_array_length(criteria) then
    raise exception 'goal_review_assessments: the reviewer scored each criterion of the review once';
  end if;
  for i in 0 .. jsonb_array_length(criteria) - 1 loop
    criterion := criteria -> i;
    line := new.lines -> i;
    weight := (criterion ->> 'weight')::int;
    select s into score from jsonb_array_elements(reported) s
     where s ->> 'criterion' = criterion ->> 'key';
    if score is null
       or coalesce(jsonb_typeof(score -> 'score'), 'missing') not in ('null', 'number')
       or (jsonb_typeof(score -> 'score') = 'number'
           and ((score ->> 'score')::numeric not in (0, 1, 2, 3, 4))) then
      raise exception 'goal_review_assessments: criterion % has no score of 0 to 4, or null, in the reviewer''s report', criterion ->> 'key';
    end if;
    if jsonb_typeof(line) is distinct from 'object'
       or line ->> 'criterion' is distinct from criterion ->> 'key'
       or line -> 'weight' is distinct from criterion -> 'weight'
       or line -> 'score' is distinct from score -> 'score'
       or line -> 'reason' is distinct from score -> 'reason'
       or line -> 'maxPoints' is distinct from to_jsonb(4 * weight)
       or line -> 'points' is distinct from (
            case when jsonb_typeof(score -> 'score') = 'null' then 'null'::jsonb
                 else to_jsonb((score ->> 'score')::int * weight) end) then
      raise exception 'goal_review_assessments: line % is not criterion %, weighed and scored as the reviewer scored it', i, criterion ->> 'key';
    end if;
    most := most + 4 * weight;
    if jsonb_typeof(score -> 'score') = 'null' then
      missing := missing || jsonb_build_array(criterion ->> 'key');
    else
      total := total + (score ->> 'score')::int * weight;
    end if;
  end loop;
  expected_verdict := case when jsonb_array_length(missing) > 0 then 'unavailable'
                           when total * 100 >= (chk.review_check ->> 'passAt')::int * most then 'passed'
                           else 'failed' end;
  if new.points <> total or new.max_points <> most or new.unassessed <> missing
     or new.pass_at <> (chk.review_check ->> 'passAt')::int
     or new.verdict <> expected_verdict then
    raise exception 'goal_review_assessments: the points, the line and the verdict are the arithmetic of the scores (% of % points, pass line % per cent: %)',
      total, most, chk.review_check ->> 'passAt', expected_verdict;
  end if;
  if new.comment is distinct from (task.result -> 'output' ->> 'comment') then
    raise exception 'goal_review_assessments: the comment is the reviewer''s, as reported';
  end if;

  -- The models, as the WorkerRuns record them.
  if new.reviewer_model is distinct from (
       select w.run_spec ->> 'model' from worker_runs w
        where w.workspace_id = new.workspace_id and w.task_id = new.review_task_id
        order by w.started_at desc, w.id desc limit 1) then
    raise exception 'goal_review_assessments: the reviewer model is the one its WorkerRun records';
  end if;
  select count(*) into ran
    from step_runs s
   where s.workspace_id = new.workspace_id and s.goal_run_id = new.goal_run_id
     and s.status = 'succeeded' and s.attempt_count >= 1
     and s.step_key in (select jsonb_array_elements_text(chk.review_check -> 'subjects'));
  if jsonb_array_length(new.executor_models) <> ran
     or (select count(distinct e ->> 'stepKey') from jsonb_array_elements(new.executor_models) e)
        <> ran then
    raise exception 'goal_review_assessments: the executors are the reviewed steps that succeeded, each once';
  end if;
  for executor in select e from jsonb_array_elements(new.executor_models) e loop
    if not exists (
      select 1
        from step_runs s
        join tasks st on st.workspace_id = s.workspace_id and st.step_run_id = s.id
                     and st.step_attempt = s.attempt_count
       where s.workspace_id = new.workspace_id and s.goal_run_id = new.goal_run_id
         and s.status = 'succeeded'
         and s.step_key = executor ->> 'stepKey'
         and s.step_key in (select jsonb_array_elements_text(chk.review_check -> 'subjects'))
         and to_jsonb(s.attempt_count) = executor -> 'attempt'
         and (executor ->> 'model') is not distinct from (
               select w.run_spec ->> 'model' from worker_runs w
                where w.workspace_id = st.workspace_id and w.task_id = st.id
                order by w.started_at desc, w.id desc limit 1)
    ) then
      raise exception 'goal_review_assessments: executor % is a reviewed step''s accepted attempt, with the model its WorkerRun records', executor ->> 'stepKey';
    end if;
  end loop;
  if new.same_model is distinct from (
       case when exists (
              select 1 from jsonb_array_elements(new.executor_models) e
               where (e ->> 'model') is not distinct from new.reviewer_model) then true
            when exists (
              select 1 from jsonb_array_elements(new.executor_models) e
               where ((e ->> 'model') is null) <> (new.reviewer_model is null)) then null
            else false end) then
    raise exception 'goal_review_assessments: same_model says whether a reviewed step ran on the reviewer''s model (null: one ran on the default, which cannot be told apart)';
  end if;
  return new;
end;
$$;

create or replace trigger goal_review_assessments_guard
  before insert or update or delete on goal_review_assessments
  for each row execute function goal_review_assessments_guard();

create or replace function goal_acceptance_checks_guard() returns trigger
language plpgsql as $$
declare
  goal record;
  latest_round int;
begin
  select g.status, g.current_revision, g.on_behalf_of into goal
    from goal_runs g
   where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;
  select max(c.round) into latest_round
    from goal_acceptance_checks c
   where c.workspace_id = new.workspace_id and c.goal_run_id = new.goal_run_id;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0 or new.lease_until is not null
       or new.observation_id is not null or new.fact_id is not null
       or new.decision_id is not null or new.last_error is not null then
      raise exception 'goal_acceptance_checks: a check is created pending and untried';
    end if;
    if goal.status is distinct from 'verifying'
       or goal.current_revision is distinct from new.plan_revision then
      raise exception 'goal_acceptance_checks: a round is opened while its goal run is verifying, on the plan in force';
    end if;
    if not exists (
      select 1
        from jsonb_array_elements(goal_declared_acceptance(
               new.workspace_id, new.goal_run_id, new.plan_revision)) d
       where d ->> 'key' = new.check_key and d ->> 'kind' = new.kind
         and (case new.kind
                when 'observe_predicate' then d -> 'check' = new.observation_check
                when 'observe_absent' then d -> 'check' = new.observation_check
                when 'fact_predicate' then d -> 'fact' = new.fact_check
                when 'review' then (d - 'kind' - 'key') = new.review_check
                else d ->> 'prompt' = new.prompt
              end)) then
      raise exception 'goal_acceptance_checks: a check is one of the acceptance checks its plan declares, as declared — with none declared, the requester''s confirmation of the goal';
    end if;
    if latest_round is not null and new.round < latest_round then
      raise exception 'goal_acceptance_checks: no check is added to a round older than round %', latest_round;
    end if;
    return new;
  end if;

  if (new.workspace_id, new.goal_run_id, new.round, new.check_key, new.plan_revision, new.kind,
      new.observation_check, new.fact_check, new.prompt, new.review_check, new.created_at)
     is distinct from
     (old.workspace_id, old.goal_run_id, old.round, old.check_key, old.plan_revision, old.kind,
      old.observation_check, old.fact_check, old.prompt, old.review_check, old.created_at) then
    raise exception 'goal_acceptance_checks: what a check verifies, and for which round, never changes';
  end if;
  if old.status <> 'pending' then
    raise exception 'goal_acceptance_checks: a settled check is not changed';
  end if;
  if new.attempts < old.attempts then
    raise exception 'goal_acceptance_checks: attempts only grow';
  end if;
  if old.first_attempt_at is not null
     and new.first_attempt_at is distinct from old.first_attempt_at then
    raise exception 'goal_acceptance_checks: when the first attempt was made never changes';
  end if;
  if old.decision_id is not null or (new.decision_id is not null and new.status <> 'passed') then
    raise exception 'goal_acceptance_checks: the requester''s decision is written as the confirmation passes';
  end if;

  if new.status = 'superseded' then
    if goal.status = 'verifying' and new.round >= latest_round then
      raise exception 'goal_acceptance_checks: a check of the current round is superseded only once its goal run left verifying';
    end if;
  elsif new.status <> 'pending' then
    if goal.status is distinct from 'verifying' or new.round < latest_round then
      raise exception 'goal_acceptance_checks: a check settles only in the current round of a verifying goal run';
    end if;
  end if;

  if new.status = 'passed' and new.kind = 'observe_predicate' and not exists (
    select 1 from observations o
     where o.workspace_id = new.workspace_id and o.id = new.observation_id
       and o.content ->> 'purpose' = 'acceptance_check'
       and o.content ->> 'goalRunId' = new.goal_run_id::text
       and o.content ->> 'round' = new.round::text
       and o.content ->> 'checkKey' = new.check_key
       and o.content ->> 'outcome' = 'satisfied'
       and o.content ? 'expect' and not (o.content ? 'absent')
  ) then
    raise exception 'goal_acceptance_checks: an observation passes only on an Observation of this check that satisfied its predicate';
  end if;
  if new.status = 'passed' and new.kind = 'observe_absent' and not exists (
    select 1 from observations o
     where o.workspace_id = new.workspace_id and o.id = new.observation_id
       and o.content ->> 'purpose' = 'acceptance_check'
       and o.content ->> 'goalRunId' = new.goal_run_id::text
       and o.content ->> 'round' = new.round::text
       and o.content ->> 'checkKey' = new.check_key
       and o.content ->> 'outcome' = 'satisfied'
       and o.content ? 'absent' and not (o.content ? 'expect')
       and o.content ->> 'gatekeeperId' = new.observation_check ->> 'gatekeeperId'
       and o.content ->> 'operation' = new.observation_check ->> 'operation'
       and jsonb_typeof(o.content #> '{absentAnswersReview,reviewedBy}') = 'string'
       and jsonb_typeof(o.content #> '{absentAnswersReview,reviewedAt}') = 'string'
       and o.content #>> '{absentAnswersReview,reviewedBy}' <> ''
       and o.content #>> '{absentAnswersReview,reviewedAt}' <> ''
  ) then
    raise exception 'goal_acceptance_checks: an absence check passes only on an Observation of this check in which the gate confirmed the thing is not there, under an Operation version whose answers a person confirmed';
  end if;
  if new.status = 'passed' and new.kind = 'fact_predicate' and not coalesce(goal_fact_admissible(
       new.workspace_id, new.goal_run_id, new.fact_id, new.fact_check, new.created_at), false) then
    raise exception 'goal_acceptance_checks: a fact check passes only on a Fact that may serve as its evidence — the one it names, observed since its round opened, not by this goal''s own doing';
  end if;
  if new.status = 'failed' and new.kind = 'fact_predicate'
     and not coalesce(goal_fact_is(new.workspace_id, new.fact_id, new.fact_check), false) then
    raise exception 'goal_acceptance_checks: a fact check fails only on a Fact it saw of the Link it names';
  end if;
  -- goal/0019: a review is tried by starting its reviewer Task, once; it passes or fails only on
  -- its assessment, with that verdict, and is unavailable only without a verdict that decided.
  if new.kind = 'review' and new.attempts > old.attempts and not exists (
    select 1 from tasks t
     where t.workspace_id = new.workspace_id and t.goal_run_id = new.goal_run_id
       and t.purpose = 'review' and t.review_round = new.round and t.review_check_key = new.check_key
  ) then
    raise exception 'goal_acceptance_checks: a review is tried only by starting its reviewer Task';
  end if;
  if new.kind = 'review' and new.status in ('passed', 'failed') and not exists (
    select 1 from goal_review_assessments a
     where a.workspace_id = new.workspace_id and a.goal_run_id = new.goal_run_id
       and a.round = new.round and a.check_key = new.check_key and a.verdict = new.status
  ) then
    raise exception 'goal_acceptance_checks: a review passes or fails only on its assessment, with that verdict';
  end if;
  if new.kind = 'review' and new.status = 'unavailable' and exists (
    select 1 from goal_review_assessments a
     where a.workspace_id = new.workspace_id and a.goal_run_id = new.goal_run_id
       and a.round = new.round and a.check_key = new.check_key and a.verdict <> 'unavailable'
  ) then
    raise exception 'goal_acceptance_checks: a review whose assessment decided is not unavailable';
  end if;
  if new.status = 'passed' and new.kind = 'requester_confirm' and not exists (
    select 1 from decisions d
     where d.workspace_id = new.workspace_id and d.id = new.decision_id
       and d.decided_by = goal.on_behalf_of and d.status = 'approved'
       and d.rationale ->> 'decision' = 'goal_outcome'
       and d.rationale ->> 'outcome' = 'achieved'
       and d.rationale ->> 'goalRunId' = new.goal_run_id::text
       and d.rationale ->> 'round' = new.round::text
       and d.rationale ->> 'checkKey' = new.check_key
  ) then
    raise exception 'goal_acceptance_checks: a confirmation passes only on the requester''s own decision for this check';
  end if;
  -- goal/0019 (F7): a confirmation in a round with a review comes after it — the requester's word
  -- is on the review's verdict, so every review of the round has passed first.
  if new.status = 'passed' and new.kind = 'requester_confirm' and exists (
    select 1 from goal_acceptance_checks r
     where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
       and r.round = new.round and r.kind = 'review' and r.status <> 'passed'
  ) then
    raise exception 'goal_acceptance_checks: a confirmation passes only after every review of its round passed';
  end if;
  return new;
end;
$$;

-- ----- what an outcome rests on (I-G5) -----------------------------------------------------------

create or replace function goal_runs_status_guard() returns trigger
language plpgsql as $$
declare
  changed text;
  new_base int;
  latest_round int;
  declared jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'goal_runs: a goal run is created proposed, not %', new.status;
    end if;
    return new;
  end if;

  changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array[
    'status', 'pause_reason', 'cleanup_pending', 'outcome', 'outcome_basis', 'current_revision',
    'budget_max_tokens', 'budget_max_steps', 'budget_max_revisions',
    'budget_max_wall_clock_seconds', 'updated_at', 'confirmed_at', 'ended_at', 'next_tick_at',
    'paused_by', 'paused_by_authority', 'advance_failures', 'outcome_decision_id']);
  if changed is not null then
    raise exception 'goal_runs: the requester, the originating turn, the statement and created_at never change (%)',
      changed;
  end if;
  if new.status is distinct from old.status
     and not goal_run_transition_allowed(old.status, new.status) then
    raise exception 'goal_runs: illegal transition % -> %', old.status, new.status;
  end if;

  if old.status in ('completed', 'cancelled', 'failed') then
    changed := goal_changed_columns(to_jsonb(new), to_jsonb(old), array['updated_at', 'cleanup_pending']);
    if changed is not null then
      raise exception 'goal_runs: a % goal run is final; % cannot change', old.status, changed;
    end if;
    if new.cleanup_pending and not old.cleanup_pending then
      raise exception 'goal_runs: cleanup_pending is set by the transition into cancelled and only clears afterwards';
    end if;
    return new;
  end if;

  if old.status = 'paused' and new.status = 'paused'
     and new.pause_reason is distinct from old.pause_reason then
    raise exception 'goal_runs: the pause reason is set by the transition into paused (% -> %)',
      old.pause_reason, new.pause_reason;
  end if;

  -- goal/0004: while paused, who paused changes only to place a workspace owner's hold or to lift
  -- one; a run an owner holds does not resume until an owner lifts the hold. (`is not distinct
  -- from`: an advancer's pause names nobody, and a null must not make a refusal pass.)
  if old.status = 'paused' and new.status = 'paused'
     and (new.paused_by, new.paused_by_authority) is distinct from (old.paused_by, old.paused_by_authority)
     and not (new.paused_by_authority is not distinct from 'owner'
              and old.paused_by_authority is distinct from 'owner')
     and not (old.paused_by_authority is not distinct from 'owner' and new.paused_by is null) then
    raise exception 'goal_runs: while paused, who paused changes only to place an owner''s hold or to lift it (% -> %)',
      coalesce(old.paused_by_authority, 'advancer'), coalesce(new.paused_by_authority, 'advancer');
  end if;
  if old.status = 'paused' and new.status = 'running' and old.paused_by_authority = 'owner' then
    raise exception 'goal_runs: a workspace owner holds this goal run; it resumes only after an owner lifts the hold';
  end if;

  if new.current_revision is distinct from old.current_revision then
    if new.current_revision is null or new.current_revision < old.current_revision then
      raise exception 'goal_runs: the current revision never goes back (% -> %) (I-G2)',
        old.current_revision, new.current_revision;
    end if;
    if old.status not in ('proposed', 'running', 'paused') or new.status not in ('running', 'paused') then
      raise exception 'goal_runs: a revision takes effect only while the goal run is proposed, running or paused (% -> %)',
        old.status, new.status;
    end if;
    select pr.based_on_revision into new_base
      from plan_revisions pr
     where pr.workspace_id = new.workspace_id
       and pr.goal_run_id = new.id
       and pr.revision = new.current_revision
       and pr.status = 'accepted';
    if not found then
      raise exception 'goal_runs: revision % is not an accepted revision of this goal run (I-G2)',
        new.current_revision;
    end if;
    if new_base is distinct from old.current_revision then
      raise exception 'goal_runs: revision % is based on %, not on the current revision % (I-G3)',
        new.current_revision, coalesce(new_base::text, 'none'), coalesce(old.current_revision::text, 'none');
    end if;
  end if;

  if old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'goal_runs: confirmed_at is written once';
  end if;

  if (new.budget_max_tokens, new.budget_max_steps, new.budget_max_revisions, new.budget_max_wall_clock_seconds)
       is distinct from
     (old.budget_max_tokens, old.budget_max_steps, old.budget_max_revisions, old.budget_max_wall_clock_seconds)
     and old.status <> 'proposed'
     and new.current_revision is not distinct from old.current_revision then
    raise exception 'goal_runs: the budget changes before confirmation or with the revision that takes effect (I-G6)';
  end if;

  -- goal/0005: what a completed run's objective outcome rests on (I-G5). `achieved` by check only
  -- out of `verifying`, with every acceptance check of the run's latest round passed — at least
  -- one of them a check the platform made, an observation (goal/0011: an absence too) or a Fact
  -- (goal/0007), and (goal/0019) none of them a review — on the current
  -- plan, and none it declares missing from that round (goal/0007); any outcome on the
  -- requester's word only with their own Decision saying so; goal/0019: `achieved` on a review
  -- (`reviewer_assessed`) likewise out of `verifying`, every check of the latest round passed, at
  -- least one of them a review and none the requester's confirmation (with one, the outcome rests
  -- on their word: `requester`). A missing or unknown basis is left to the CHECKs
  -- (`goal_runs_outcome`, the column's own).
  if new.outcome_decision_id is distinct from old.outcome_decision_id
     and not (new.status = 'completed' and old.status <> 'completed') then
    raise exception 'goal_runs: the outcome decision is written with the outcome, once';
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    if new.outcome_basis = 'verified_by_check' then
      if new.outcome <> 'achieved' or old.status <> 'verifying' or new.outcome_decision_id is not null then
        raise exception 'goal_runs: only verification achieves a goal by check — out of verifying, with no person''s decision (I-G5)';
      end if;
      select max(c.round) into latest_round
        from goal_acceptance_checks c
       where c.workspace_id = new.workspace_id and c.goal_run_id = new.id;
      if latest_round is null
         or exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round
              and (c.status <> 'passed' or c.plan_revision is distinct from new.current_revision))
         or not exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round
              and c.kind in ('observe_predicate', 'observe_absent', 'fact_predicate'))
         or exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round and c.kind = 'review') then
        raise exception 'goal_runs: achieved by check needs every acceptance check of the latest round passed on the current plan, at least one of them observed by the platform and none of them a review (I-G5)';
      end if;
      declared := goal_declared_acceptance(new.workspace_id, new.id, new.current_revision);
      if declared is null or exists (
        select 1 from jsonb_array_elements(declared) d
         where not exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round and c.check_key = d ->> 'key')) then
        raise exception 'goal_runs: achieved by check needs a check of the latest round for every acceptance check the current plan declares (I-G5)';
      end if;
    elsif new.outcome_basis = 'requester' then
      if new.outcome_decision_id is null or not exists (
        select 1 from decisions d
         where d.workspace_id = new.workspace_id and d.id = new.outcome_decision_id
           and d.decided_by = new.on_behalf_of and d.status = 'approved'
           and d.rationale ->> 'decision' = 'goal_outcome'
           and d.rationale ->> 'goalRunId' = new.id::text
           and d.rationale ->> 'outcome' = new.outcome) then
        raise exception 'goal_runs: an outcome on the requester''s word rests on their own decision saying so (I-G5)';
      end if;
    elsif new.outcome_basis = 'reviewer_assessed' then
      if new.outcome <> 'achieved' or old.status <> 'verifying' or new.outcome_decision_id is not null then
        raise exception 'goal_runs: only verification achieves a goal on a review — out of verifying, with no person''s decision (I-G5)';
      end if;
      select max(c.round) into latest_round
        from goal_acceptance_checks c
       where c.workspace_id = new.workspace_id and c.goal_run_id = new.id;
      if latest_round is null
         or exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round
              and (c.status <> 'passed' or c.plan_revision is distinct from new.current_revision
                   or c.kind = 'requester_confirm'))
         or not exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round and c.kind = 'review') then
        raise exception 'goal_runs: achieved on a review needs every acceptance check of the latest round passed on the current plan, at least one of them a review and none the requester''s confirmation (I-G5)';
      end if;
      declared := goal_declared_acceptance(new.workspace_id, new.id, new.current_revision);
      if declared is null or exists (
        select 1 from jsonb_array_elements(declared) d
         where not exists (
           select 1 from goal_acceptance_checks c
            where c.workspace_id = new.workspace_id and c.goal_run_id = new.id
              and c.round = latest_round and c.check_key = d ->> 'key')) then
        raise exception 'goal_runs: achieved on a review needs a check of the latest round for every acceptance check the current plan declares (I-G5)';
      end if;
    end if;
  end if;

  return new;
end;
$$;
