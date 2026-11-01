-- module: goal, version: 0015
--
-- 0015_planner_apply_minor (S11 GO9b; plan §4.3, §10 F3; roadmap GO9). GO9a's planner only
-- proposes, under a pause, and the requester decides. GO9b adds a second leave the requester may
-- give when they confirm a run: `apply_minor`. When a step of such a run fails for a person, the
-- run keeps running while the planner works out a revision; a revision the platform classes
-- `minor` (`application/goal/revision-class.ts`, the platform's rule over the plan, never the
-- planner's say) is accepted for the requester and the run goes on; a `major` one pauses the run
-- `needs_decision` for the requester to decide, as GO9a does. I-P5 still holds: the platform never
-- lifts a person's pause or an owner's hold — an `apply_minor` run never pauses for the failure in
-- the first place, and any pause ends its planning.
--
--   `goal_planner_delegations.mode` — `apply_minor` besides `propose`.
--
--   `goal_planning_rounds.kind` — when the round was opened, which decides who settles what it
--   proposes: `proposal` (the run paused `needs_decision`, GO9a: the requester decides) or
--   `autonomous` (the run kept running under an `apply_minor` leave). Existing rounds are
--   `proposal`, the column's default: GO9a opened them all under a pause. An `autonomous` round is
--   abandoned once its run stops running (`run_not_running`: paused, held, cancelled), or its plan
--   is revised.
--
--   `goal_planning_rounds.revision_class`, `class_reasons` — how the platform classed the revision
--   a round proposed, set once, when the round settles `proposed` or `applied`; `class_reasons`
--   lists, for a `major` one, why (`@nexttime/shared` `PlannerRevisionMajorReason`, with the step
--   key a reason is about and, when the platform found it in the step's Worker, the execute-class
--   `capabilities` or the added `gates` that made it so). A round settled before this migration
--   has none.
--
--   `goal_planning_rounds.status = 'applied'` — an `autonomous` round whose `minor` revision the
--   platform accepted for the requester: the revision is `accepted` (`decided_by` the requester,
--   whose leave it was — goal/0014's `plan_revisions_planner` already holds that), and the round
--   says it was the platform's acceptance, not the requester's own act.
--
--   New reasons: `step_keeps_failing` (failed at open: the step failed again after two revisions
--   the platform applied for it, so it stops changing the plan on its own and the run pauses for
--   the requester) and `run_not_running` (abandoned, above).
--
--   `plan_revisions_planner` — a revision the planner proposed is accepted while its run is
--   running only through a running `autonomous` round on the same base under an `apply_minor`
--   leave; while paused, only by the requester (GO9a, unchanged).
--
-- No backfill beyond the column defaults.
--
-- Rolling back (docs/runbooks/release.md §6): code only. Code without this migration reads every
-- leave as `propose` (it only asks whether there is one) and inserts rounds without a kind (so
-- `proposal`, which is what it opens), so an `apply_minor` run then pauses and proposes as GO9a
-- does. An `autonomous` round still running then is abandoned by that code `run_left_pause`,
-- which the guard below takes for either kind. GO9a's console has no `applied` in its round
-- statuses (the read is not validated in production, so the page shows such a round as an
-- unknown status, nothing fails), nor the two new reasons. To drop the schema too — only once no
-- round is `applied` and none carries a new reason, and no leave is `apply_minor`:
--   1. restore goal/0014's `goal_planning_rounds_guard` and `plan_revisions_planner` (re-run their
--      `create or replace` from 0014);
--   2. drop the constraints this file adds (`goal_planning_rounds_kind`, `_revision_class`,
--      `_class_reasons`) and the four it replaces, then re-add 0014's
--      (`goal_planning_rounds_status`, `_revision`, `_outcome_reason`,
--      `goal_planner_delegations_mode`);
--   3. `drop function goal_planning_class_reasons_valid(jsonb)` — after the `_class_reasons`
--      constraint that calls it;
--   4. drop the columns `kind`, `revision_class`, `class_reasons`;
--   5. `delete from schema_migrations where module = 'goal' and version = 15`.
--
-- Cross-process bootstrap lock: same `goal`-module key as 0001–0014.
select pg_advisory_xact_lock(7241000701);

-- ---------------------------------------------------------------------------------------------
-- goal_planner_delegations
-- ---------------------------------------------------------------------------------------------

alter table goal_planner_delegations drop constraint if exists goal_planner_delegations_mode;
alter table goal_planner_delegations add constraint goal_planner_delegations_mode
  check (mode in ('propose', 'apply_minor'));

-- ---------------------------------------------------------------------------------------------
-- goal_planning_rounds
-- ---------------------------------------------------------------------------------------------

alter table goal_planning_rounds add column if not exists kind text not null default 'proposal';
alter table goal_planning_rounds add column if not exists revision_class text;
alter table goal_planning_rounds add column if not exists class_reasons jsonb not null default '[]'::jsonb;

alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_kind;
alter table goal_planning_rounds add constraint goal_planning_rounds_kind
  check (kind in ('proposal', 'autonomous'));

alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_status;
alter table goal_planning_rounds add constraint goal_planning_rounds_status
  check (status in ('running', 'proposed', 'applied', 'no_revision', 'failed', 'abandoned'));

alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_revision;
alter table goal_planning_rounds add constraint goal_planning_rounds_revision
  check ((status in ('proposed', 'applied')) = (revision is not null));

alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_outcome_reason;
alter table goal_planning_rounds add constraint goal_planning_rounds_outcome_reason check (
  (status = 'failed' and outcome_reason in (
     'revision_budget_exhausted', 'token_budget_exhausted', 'planner_unavailable',
     'requester_cannot_start', 'step_keeps_failing', 'task_failed', 'invalid_revision'))
  or (status = 'abandoned' and outcome_reason in ('run_left_pause', 'run_not_running', 'plan_revised'))
  or (status not in ('failed', 'abandoned') and outcome_reason is null)
);

-- A class only for a round that proposed; an applied revision is a minor one; reasons exactly for
-- a major one, each a known code with the step it is about (or none).
alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_revision_class;
alter table goal_planning_rounds add constraint goal_planning_rounds_revision_class check (
  (revision_class is null or (revision_class in ('minor', 'major')
                              and status in ('proposed', 'applied')))
  and (status <> 'applied' or revision_class = 'minor')
);

create or replace function goal_planning_class_reasons_valid(reasons jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(reasons) = 'array'
     and jsonb_array_length(reasons) <= 200
     and not exists (
       select 1 from jsonb_array_elements(reasons) r
        where jsonb_typeof(r) <> 'object'
           or (r ->> 'code') is null
           or (r ->> 'code') not in (
                'goal_acceptance_changed', 'step_acceptance_changed', 'execution_step',
                'gate_added', 'admission_blocked', 'stops_live_work', 'unresolvable')
           or (r ? 'stepKey' and jsonb_typeof(r -> 'stepKey') not in ('string', 'null'))
           or exists (select 1 from jsonb_object_keys(r) k
                       where k not in ('code', 'stepKey', 'capabilities', 'gates'))
           or exists (select 1 from jsonb_each(r) e
                       where e.key in ('capabilities', 'gates')
                         and (jsonb_typeof(e.value) <> 'array'
                              or exists (select 1 from jsonb_array_elements(e.value) v
                                          where jsonb_typeof(v) <> 'string'))));
$$;

alter table goal_planning_rounds drop constraint if exists goal_planning_rounds_class_reasons;
alter table goal_planning_rounds add constraint goal_planning_rounds_class_reasons check (
  goal_planning_class_reasons_valid(class_reasons)
  and (revision_class is not distinct from 'major') = (jsonb_array_length(class_reasons) > 0)
);

create or replace function goal_planning_rounds_guard() returns trigger
language plpgsql as $$
declare
  goal record;
  step record;
  leave text;
begin
  if tg_op = 'INSERT' then
    select g.status, g.pause_reason, g.paused_by_authority, g.current_revision into goal
      from goal_runs g
     where g.workspace_id = new.workspace_id and g.id = new.goal_run_id
       for no key update;
    select d.mode into leave
      from goal_planner_delegations d
     where d.workspace_id = new.workspace_id and d.goal_run_id = new.goal_run_id;
    if leave is null then
      raise exception 'goal_planning_rounds: the requester did not let the planner propose revisions of this goal run';
    end if;
    if new.kind = 'proposal' then
      if goal.status is distinct from 'paused' or goal.pause_reason is distinct from 'needs_decision'
         or goal.paused_by_authority is not distinct from 'owner' then
        raise exception 'goal_planning_rounds: a round opens while its goal run is paused for a decision and no owner holds it';
      end if;
    else
      -- goal/0015: an autonomous round, while the run keeps running under an apply_minor leave.
      if goal.status is distinct from 'running' then
        raise exception 'goal_planning_rounds: an autonomous round opens while its goal run is running, not %',
          coalesce(goal.status, 'missing');
      end if;
      if leave <> 'apply_minor' then
        raise exception 'goal_planning_rounds: an autonomous round needs the requester''s apply_minor leave (this run has %)',
          leave;
      end if;
    end if;
    if new.based_on_revision is distinct from goal.current_revision then
      raise exception 'goal_planning_rounds: a round is based on the revision in force (%), not %',
        coalesce(goal.current_revision::text, 'none'), new.based_on_revision;
    end if;
    select s.status, s.attempt_count, s.failure_category, s.superseded_in_revision into step
      from step_runs s
     where s.workspace_id = new.workspace_id and s.goal_run_id = new.goal_run_id
       and s.id = new.step_run_id;
    if step.status is distinct from 'failed' or step.superseded_in_revision is not null
       or step.attempt_count is distinct from new.step_attempt
       or step.failure_category is distinct from new.failure_category then
      raise exception 'goal_planning_rounds: a round is for the failed attempt of a live step, with its failure category';
    end if;
    if new.revision_class is not null or new.class_reasons <> '[]'::jsonb then
      raise exception 'goal_planning_rounds: a round is classed when it settles, not when it opens';
    end if;
    if new.status = 'running' then
      if new.revision is not null or new.outcome_reason is not null or new.detail is not null
         or new.settled_at is not null then
        raise exception 'goal_planning_rounds: a running round has no result yet';
      end if;
      return new;
    end if;
    -- No planner can run for this judgment point: the round is recorded as failed, with why.
    if new.status <> 'failed' or new.outcome_reason not in (
         'revision_budget_exhausted', 'token_budget_exhausted', 'planner_unavailable',
         'requester_cannot_start', 'step_keeps_failing') then
      raise exception 'goal_planning_rounds: a round is opened running, or recorded failed because no planner could run for it';
    end if;
    if new.outcome_reason = 'step_keeps_failing' and new.kind <> 'autonomous' then
      raise exception 'goal_planning_rounds: only the platform''s own planning stops for a step that keeps failing';
    end if;
    return new;
  end if;

  if (new.workspace_id, new.id, new.goal_run_id, new.based_on_revision, new.step_run_id,
      new.step_attempt, new.failure_category, new.kind, new.created_at)
     is distinct from
     (old.workspace_id, old.id, old.goal_run_id, old.based_on_revision, old.step_run_id,
      old.step_attempt, old.failure_category, old.kind, old.created_at) then
    raise exception 'goal_planning_rounds: what a round was opened for never changes';
  end if;
  if old.status <> 'running' then
    if (new.status, new.revision, new.outcome_reason, new.detail, new.settled_at,
        new.revision_class, new.class_reasons)
       is distinct from
       (old.status, old.revision, old.outcome_reason, old.detail, old.settled_at,
        old.revision_class, old.class_reasons) then
      raise exception 'goal_planning_rounds: a round settles once (it is %)', old.status;
    end if;
    return new;
  end if;
  if new.status = 'proposed' and not exists (
       select 1 from plan_revisions r
        where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
          and r.revision = new.revision and r.status = 'proposed'
          and r.based_on_revision = new.based_on_revision
          and goal_planner_principal(r.workspace_id, r.proposed_by)) then
    raise exception 'goal_planning_rounds: a round proposes a revision the planner proposed on the round''s base';
  end if;
  if new.status = 'applied' then
    if old.kind <> 'autonomous' then
      raise exception 'goal_planning_rounds: only an autonomous round has its revision applied by the platform';
    end if;
    select d.mode into leave
      from goal_planner_delegations d
     where d.workspace_id = new.workspace_id and d.goal_run_id = new.goal_run_id;
    if leave is distinct from 'apply_minor' then
      raise exception 'goal_planning_rounds: the platform applies a planner revision only under the requester''s apply_minor leave';
    end if;
    if not exists (
         select 1 from plan_revisions r
          where r.workspace_id = new.workspace_id and r.goal_run_id = new.goal_run_id
            and r.revision = new.revision and r.status = 'accepted'
            and r.based_on_revision = new.based_on_revision
            and goal_planner_principal(r.workspace_id, r.proposed_by)) then
      raise exception 'goal_planning_rounds: an applied round''s revision is the planner''s, on the round''s base, accepted';
    end if;
  end if;
  if new.status = 'failed' and new.outcome_reason not in ('task_failed', 'invalid_revision') then
    raise exception 'goal_planning_rounds: a running round fails because its Task gave no usable result (task_failed, invalid_revision)';
  end if;
  -- An autonomous round is abandoned `run_not_running` by this release's code; `run_left_pause` is
  -- still taken for it, because code rolled back to GO9a's (which knows no kind) writes that for
  -- every round — refusing it would leave such a run's advance failing and its cancel refused
  -- (review #488 on #866).
  if new.status = 'abandoned' and new.outcome_reason not in ('plan_revised', 'run_left_pause')
     and not (old.kind = 'autonomous' and new.outcome_reason = 'run_not_running') then
    raise exception 'goal_planning_rounds: a % round is abandoned because %', old.kind,
      case old.kind when 'autonomous' then 'its run stopped running (run_not_running) or its plan was revised'
                    else 'its run left the pause (run_left_pause) or its plan was revised' end;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- plan_revisions: the planner's revisions
-- ---------------------------------------------------------------------------------------------

-- goal/0014 as it was, and: a planner revision accepted while its run runs (GO9b) is one an
-- autonomous round on the same base still has running, under the requester's apply_minor leave.
create or replace function plan_revisions_planner() returns trigger
language plpgsql as $$
declare
  goal record;
begin
  if not goal_planner_principal(new.workspace_id, new.proposed_by) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from goal_planning_rounds pr
       where pr.workspace_id = new.workspace_id and pr.goal_run_id = new.goal_run_id
         and pr.status = 'running' and pr.based_on_revision = new.based_on_revision) then
      raise exception 'plan_revisions: the planner proposes a revision only from a running round on the same base';
    end if;
    return new;
  end if;
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    select g.status, g.on_behalf_of into goal
      from goal_runs g
     where g.workspace_id = new.workspace_id and g.id = new.goal_run_id;
    if goal.on_behalf_of is distinct from new.decided_by then
      raise exception 'plan_revisions: a revision the planner proposed is accepted by the requester of its goal run';
    end if;
    if goal.status = 'running' and not exists (
         select 1 from goal_planning_rounds pr
           join goal_planner_delegations d
             on d.workspace_id = pr.workspace_id and d.goal_run_id = pr.goal_run_id
          where pr.workspace_id = new.workspace_id and pr.goal_run_id = new.goal_run_id
            and pr.status = 'running' and pr.kind = 'autonomous'
            and pr.based_on_revision = new.based_on_revision
            and d.mode = 'apply_minor') then
      raise exception 'plan_revisions: a running goal run takes a planner revision only from its autonomous round, under the requester''s apply_minor leave';
    end if;
  end if;
  return new;
end;
$$;
